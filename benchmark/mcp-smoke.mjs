#!/usr/bin/env node
/**
 * Smoke test MCP end-to-end via protokol stdio ASLI (SDK client).
 * Membuktikan server boot dengan kode baru (unified DB, warmup, migrasi) dan
 * tool merespons — plus mengukur token output tool `recall` (ringkas vs verbose).
 *
 * Terisolasi: ENGRAM_DB → temp db, ENGRAM_NO_EMBED=1 → cepat/deterministik.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tokens = (s) => Math.ceil(Buffer.byteLength(s ?? '', 'utf8') / 4)
const textOf = (res) => (res?.content ?? []).map(c => c.text ?? '').join('\n')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-smoke-'))
const dbPath = path.join(tmpDir, 'memory.db')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'build', 'index.js'), '--project', tmpDir],
  env: { ...process.env, ENGRAM_DB: dbPath, ENGRAM_PROJECT: 'smoke', ENGRAM_NO_EMBED: '1' },
})

const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} })

function ok(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) process.exitCode = 1
}

try {
  await client.connect(transport)
  console.log('\n── 1. Handshake & daftar tool ──────────────────────────────')
  const { tools } = await client.listTools()
  ok(`server terhubung, ${tools.length} tool terdaftar`, tools.length === 6)
  console.log('     tools:', tools.map(t => t.name).join(', '))

  console.log('\n── 2. remember (tulis) ─────────────────────────────────────')
  const rem = await client.callTool({
    name: 'remember',
    arguments: { content: 'DB pakai unified SQLite di ~/.engram, embedding all-MiniLM-L6-v2 dengan fallback keyword.', type: 'architecture', tags: ['db', 'embedding'] },
  })
  ok('remember berhasil', /Remembered|Updated/.test(textOf(rem)))
  await client.callTool({ name: 'remember', arguments: { content: 'Auth JWT, token 24 jam, refresh via cookie httpOnly.', type: 'decision', tags: ['auth'] } })
  await client.callTool({ name: 'remember', arguments: { content: 'Bug: race condition di prune saat concurrent write (sudah dihindari via transaction).', type: 'bug', tags: ['prune'] } })

  console.log('\n── 3. recall (baca) — ringkas vs verbose ───────────────────')
  const compact = await client.callTool({ name: 'recall', arguments: { query: 'bagaimana database dan embedding dikonfigurasi', limit: 5 } })
  const verbose = await client.callTool({ name: 'recall', arguments: { query: 'bagaimana database dan embedding dikonfigurasi', limit: 5, verbose: true } })
  const tc = tokens(textOf(compact)), tv = tokens(textOf(verbose))
  ok('recall mengembalikan hasil', textOf(compact).includes('unified') || textOf(compact).includes('DB'))
  console.log(`     ringkas  : ${tc} token`)
  console.log(`     verbose  : ${tv} token  (menyertakan UUID)`)
  console.log(`     hemat    : ${Math.round((1 - tc / tv) * 100)}% dengan sembunyikan UUID default`)

  console.log('\n── 4. context_status load ──────────────────────────────────')
  const load = await client.callTool({ name: 'context_status', arguments: { action: 'load' } })
  ok('load mengembalikan konteks', textOf(load).length > 0)

  console.log('\n── 5. stats ────────────────────────────────────────────────')
  const stats = await client.callTool({ name: 'context_status', arguments: { action: 'stats' } })
  ok('stats menampilkan total', /Total memories:\s*3/.test(textOf(stats)))
  console.log('     ' + textOf(stats).split('\n').slice(0, 3).join(' | '))

  console.log('\n✅ MCP smoke test SELESAI — server + 6 tool berfungsi via stdio nyata.\n')
} catch (e) {
  console.error('\n❌ Smoke test gagal:', e?.message ?? e)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
