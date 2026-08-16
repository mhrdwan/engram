#!/usr/bin/env node
/**
 * Benchmark token: "PAKAI Engram" vs "TANPA Engram".
 *
 * Skenario nyata: sesi Claude baru dibuka di project ini dan perlu tahu
 * stack, keputusan arsitektur, bug yang diketahui, dan preferensi user
 * sebelum mulai kerja.
 *
 *  - TANPA Engram  → Claude harus MEMBACA ULANG file project tiap sesi untuk
 *                     merekonstruksi pengetahuan itu (biaya dibayar SETIAP sesi).
 *  - DENGAN Engram → Claude memuat blob memory ringkas via `context_status load`
 *                     + satu `recall` bertarget (disimpan sekali, murah tiap sesi).
 *
 * Estimasi token memakai konvensi repo ini: ceil(bytes / 4).
 */
import { openDb, closeDb } from '../build/store/db.js'
import { createMemory, createSession, getRecentContext, searchMemories } from '../build/store/memory-store.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tokens = (str) => Math.ceil(Buffer.byteLength(str ?? '', 'utf8') / 4)
const PROJECT = 'Engram'

function readIfExists(rel) {
  const p = path.join(ROOT, rel)
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function walkTs(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'build', '.git', '.engram'].includes(entry.name)) continue
      out.push(...walkTs(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// ── 1. Seed memory realistis (yang sekali disimpan lalu dipakai lintas sesi) ──
async function seedMemories() {
  const mems = [
    ['architecture', 'Engram: MCP server memory persisten. SQLite (better-sqlite3) + FTS5 keyword + vektor embedding all-MiniLM-L6-v2 (@xenova/transformers). Hybrid RAG rerank.', ['stack', 'rag']],
    ['decision', 'Semua memory hidup di satu unified DB ~/.engram/memory.db, dipartisi kolom `project`. Scope global terlihat lintas project.', ['db', 'scope']],
    ['decision', 'Embedding pakai safeEmbedText: kalau model gagal/dimatikan, degradasi ke keyword-only (FTS), jangan crash remember/recall.', ['reliability']],
    ['decision', 'Dedup Jaccard >= 0.65 pada token, merge non-destruktif (pertahankan konten lebih panjang + union tags).', ['dedup']],
    ['decision', 'Ranking pakai memoryScore JS: access_count + recency ternormalisasi (half-life ~14 hari) + bobot tipe. Rumus SQL lama bikin access_count jadi noise.', ['ranking']],
    ['architecture', 'Tool MCP: remember, recall, forget, list_memories, session_summary, context_status(load|stats|prune).', ['tools']],
    ['bug', 'Bug lama: global DB dihitung di config tapi tak pernah dibuka → memory global tak lintas project. Sudah diperbaiki via unified DB + migrateLegacyDb.', ['fixed']],
    ['decision', 'SessionStart hook menjalankan `engram-mcp load` → inject memory otomatis di awal sesi (deterministik, hemat token, tak bergantung model).', ['hook']],
    ['preference', 'User (Ridwan) menulis dalam Bahasa Indonesia; fokus hemat token & keandalan.', ['user']],
    ['fact', 'Registrasi init pakai path node absolut (bukan `npx -y`) supaya stabil terhadap PATH/nvm.', ['config']],
    ['fact', 'Build: `npm run build` (tsc → build/). Test: `npm test` (vitest).', ['build']],
    ['preference', 'Override tersedia: ENGRAM_DB (path DB), ENGRAM_PROJECT (kunci project), ENGRAM_NO_EMBED=1 (keyword-only).', ['config']],
  ]
  for (const [type, content, tags] of mems) {
    await createMemory({ content, type, tags, project: PROJECT, scope: type === 'preference' ? 'global' : 'project', skipDedup: true })
  }
  createSession({
    project: PROJECT,
    summary: 'Perbaikan reliability Engram: fallback embedding, unified DB + migrasi global scope, dedup non-destruktif, ranking access-aware, output recall ringkas, SessionStart hook auto-load.',
    started_at: Date.now() - 3600_000,
  })
}

// ── 2. Korpus "TANPA Engram" = file yang dibaca ulang untuk belajar project ──
function withoutCacheCorpus() {
  const skim = ['README.md', 'package.json', 'tsconfig.json']
  const skimText = skim.map(readIfExists).join('\n')

  const srcFiles = walkTs(path.join(ROOT, 'src'))
  const srcText = srcFiles.map(f => readIfExists(path.relative(ROOT, f))).join('\n')

  return {
    skim: { files: skim, text: skimText },
    full: { files: [...skim, ...srcFiles.map(f => path.relative(ROOT, f))], text: skimText + '\n' + srcText },
  }
}

function bar(pct) {
  const n = Math.round(pct / 5)
  return '█'.repeat(n) + '░'.repeat(20 - n)
}

;(async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bench-')), 'bench.db')
  openDb(tmp)
  await seedMemories()

  // DENGAN Engram
  const loadCtx = getRecentContext(PROJECT) ?? ''
  const recallRes = await searchMemories({ query: 'bagaimana database dan embedding dikonfigurasi', project: PROJECT, scope: 'all', limit: 5 })
  const recallOut = recallRes.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n')
  const withCache = loadCtx + '\n' + recallOut
  const tWith = tokens(withCache)

  // TANPA Engram
  const corpus = withoutCacheCorpus()
  const tSkim = tokens(corpus.skim.text)
  const tFull = tokens(corpus.full.text)

  closeDb()
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true })

  const pct = (a, b) => Math.round((1 - a / b) * 100)

  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║   BENCHMARK TOKEN — Engram: PAKAI vs TANPA (per sesi)            ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
  console.log('Skenario: sesi baru butuh tahu stack + keputusan + bug + preferensi\n')

  console.log('TANPA Engram (baca ulang file tiap sesi):')
  console.log(`  • Skim  (README+package.json+tsconfig) : ${tSkim.toLocaleString()} token  (${corpus.skim.files.length} file)`)
  console.log(`  • Full  (+ semua src/*.ts)             : ${tFull.toLocaleString()} token  (${corpus.full.files.length} file)`)
  console.log('')
  console.log('DENGAN Engram (load + 1 recall bertarget):')
  console.log(`  • context_status load + recall         : ${tWith.toLocaleString()} token`)
  console.log('')
  console.log('── Penghematan ─────────────────────────────────────────────────────')
  console.log(`  vs Skim : ${bar(pct(tWith, tSkim))}  ${pct(tWith, tSkim)}%  (${tSkim.toLocaleString()} → ${tWith.toLocaleString()})`)
  console.log(`  vs Full : ${bar(pct(tWith, tFull))}  ${pct(tWith, tFull)}%  (${tFull.toLocaleString()} → ${tWith.toLocaleString()})`)
  console.log('')
  console.log(`Hemat ~${(tFull - tWith).toLocaleString()} token / sesi (vs baca ulang penuh),`)
  console.log(`berulang tiap sesi. Biaya simpan memory dibayar SEKALI.`)
  console.log('\nCatatan: estimasi token = ceil(bytes/4), konvensi repo ini. Angka absolut')
  console.log('bergantung isi project; rasionya yang jadi intinya.\n')
})().catch(e => { console.error(e); process.exit(1) })
