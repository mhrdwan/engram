#!/usr/bin/env node
// Entry CLI Engram. Modul berat (embedding/transformers, server MCP) diimpor
// DINAMIS per perintah supaya hook murah (mis. Stop → sync-memory, terpicu tiap
// giliran) tidak memuat apa pun yang tak dibutuhkannya.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveConfig, findGitRoot, type Config } from './config.js'
import { openDb, migrateLegacyDb, getDb } from './store/db.js'
import { readHookPayload } from './hook-input.js'
import {
  findMemoryDir, memoryDirSignature, isUnchangedSinceLastSync, recordSync,
} from './cc-memory.js'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const COMMANDS = ['init', 'load', 'capture', 'sync-memory', 'merge-project'] as const
type Command = (typeof COMMANDS)[number] | 'serve'

function parseArgs(): { project?: string; command: Command; positional: string[]; force: boolean } {
  const args = process.argv.slice(2)
  const first = args[0]
  const command: Command = (COMMANDS as readonly string[]).includes(first) ? (first as Command) : 'serve'
  const idx = args.indexOf('--project')
  const positional: string[] = []
  for (let i = command === 'serve' ? 0 : 1; i < args.length; i++) {
    if (args[i] === '--project') { i++; continue }
    if (args[i].startsWith('--')) continue
    positional.push(args[i])
  }
  return { project: idx !== -1 ? args[idx + 1] : undefined, command, positional, force: args.includes('--force') }
}

/** Buka DB unified + jalankan migrasi legacy sekali. Dipakai serve & load. */
function bootStore(projectArg?: string): Config {
  const config = resolveConfig(projectArg)
  openDb(config.dbPath)
  try {
    migrateLegacyDb(config.legacyDbPath, config.projectKey)
  } catch (err) {
    console.error('[engram] migration error (non-fatal):', errMsg(err))
  }
  return config
}

/**
 * Subcommand `load`: cetak konteks terbaru ke stdout.
 * Dipakai sebagai Claude Code SessionStart hook supaya memory ke-inject
 * otomatis di awal sesi — tanpa bergantung pada model memanggil tool sendiri
 * (dan jauh lebih hemat token daripada re-scan project).
 */
async function runLoad(projectArg?: string) {
  const config = bootStore(projectArg)
  const { getRecentContext } = await import('./store/memory-store.js')
  const ctx = getRecentContext(config.projectKey)
  if (ctx) {
    process.stdout.write(`# Engram memory — ${config.projectName}\n\n${ctx}\n`)
  }
}

/**
 * Subcommand `sync-memory`: impor memori bawaan Claude Code ke Engram.
 * Jalur hook (ada payload di stdin) diam & tidak pernah melempar; jalur CLI
 * mencetak ringkasan. Keluar seketika — tanpa membuka DB — bila sidik folder
 * memori sama dengan sinkron sukses terakhir (kecuali --force).
 */
async function runSyncMemory(projectArg: string | undefined, force: boolean) {
  const payload = readHookPayload()
  const say = (msg: string) => { if (!payload) console.log(msg) }
  try {
    const config = resolveConfig(projectArg)
    const memDir = findMemoryDir({
      transcriptPath: payload?.transcript_path,
      candidates: [payload?.cwd, config.projectDir, findGitRoot(config.projectDir)],
    })
    if (!memDir) { say(`[engram] tidak ada folder memori Claude Code untuk ${config.projectDir}`); return }

    const sig = memoryDirSignature(memDir)
    const stateFile = path.join(path.dirname(config.dbPath), 'cc-memory-sync.json')
    if (!force && isUnchangedSinceLastSync(stateFile, memDir, config.projectKey, sig)) {
      say(`[engram] ${memDir}: tidak ada perubahan sejak sinkron terakhir (pakai --force untuk paksa)`)
      return
    }

    openDb(config.dbPath)
    const { syncMemoryDir } = await import('./sync-memory.js')
    const r = await syncMemoryDir(memDir, config.projectKey)
    recordSync(stateFile, memDir, config.projectKey, sig)
    say(`[engram] sync-memory → project "${config.projectKey}" dari ${r.dir}\n` +
      `  baru ${r.added}, diperbarui ${r.updated}, tetap ${r.unchanged}, dihapus ${r.removed}, dilewati ${r.skipped}`)
  } catch (e) {
    if (!payload) console.error('[engram] sync-memory gagal:', errMsg(e))
  }
}

/** Subcommand `capture`: tangkap segmen transcript baru (hook PreCompact/SessionEnd). */
async function runCaptureCmd(projectArg?: string) {
  const payload = readHookPayload()
  try {
    const config = bootStore(projectArg)
    const { runCapture } = await import('./capture.js')
    runCapture(config.projectKey, payload)
  } catch {
    /* diam: jalur hook */
  }
}

/** Subcommand `merge-project <dari> <ke>`: cadangkan DB, lalu pindahkan semua baris. */
async function runMergeProject(positional: string[]) {
  const [from, to] = positional
  if (!from || !to || from === to) {
    console.error('Pemakaian: engram merge-project <dari> <ke>   (dua kunci project berbeda)')
    process.exitCode = 1
    return
  }
  const config = resolveConfig()
  openDb(config.dbPath)
  const stamp = new Date().toISOString().slice(0, 10)
  let backup = `${config.dbPath}.bak-${stamp}`
  if (fs.existsSync(backup)) backup = `${config.dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await getDb().backup(backup) // salinan konsisten (WAL ikut terlipat)
  const { mergeProject } = await import('./store/memory-store.js')
  const r = mergeProject(from, to)
  console.log(`[engram] cadangan: ${backup}`)
  console.log(`[engram] "${from}" → "${to}": ${r.memories} catatan, ${r.sessions} sesi dipindahkan`)
}

async function runInitCmd() {
  const { runInitSteps } = await import('./init.js')
  console.log('🧠 Initializing Engram globally...')
  // Path absolut ke entrypoint ini + node yang sedang berjalan → registrasi
  // yang stabil (tidak bergantung PATH/nvm/registry seperti `npx -y`).
  const results = runInitSteps({
    home: os.homedir(),
    nodePath: process.execPath,
    indexPath: fileURLToPath(import.meta.url),
  })
  const icon: Record<string, string> = { added: '✅', updated: '🔄', unchanged: '·', skipped: '–', error: '❌' }
  for (const r of results) {
    const extra = [r.note, r.backup ? `cadangan: ${r.backup}` : ''].filter(Boolean).join(' — ')
    console.log(`${icon[r.status]} ${r.client.padEnd(26)} ${r.status.padEnd(9)} ${r.file}${extra ? `  (${extra})` : ''}`)
  }
  console.log('\n🎉 Engram global initialization complete!')
  if (results.some(r => r.status === 'error')) process.exitCode = 1
}

async function runServe(projectArg?: string) {
  const config = bootStore(projectArg)
  const { warmupEmbedder } = await import('./store/embedder.js')
  const { createServer } = await import('./server.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  // Hangatkan model embedding di background supaya call pertama tidak lambat.
  warmupEmbedder()

  const server = createServer(config.projectKey)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`engram-mcp running — project: ${config.projectName} (key: ${config.projectKey})`)
  console.error(`  DB: ${config.dbPath}`)
}

async function main() {
  const { project, command, positional, force } = parseArgs()
  switch (command) {
    case 'init': await runInitCmd(); break
    case 'load': await runLoad(project); break
    case 'capture': await runCaptureCmd(project); break
    case 'sync-memory': await runSyncMemory(project, force); break
    case 'merge-project': await runMergeProject(positional); break
    default: await runServe(project); return // server tetap hidup
  }
  process.exit(process.exitCode ?? 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
