#!/usr/bin/env node
/**
 * Benchmark 4-arah: NAKED · RTK · Engram · RTK+Engram (token per sesi).
 *
 * Dua tool menyerang biaya token yang BERBEDA (jadi saling melengkapi):
 *   - RTK      → mengompres OUTPUT perintah shell (git/test/grep/ls) sebelum masuk context.
 *   - Engram  → menghindari baca-ulang file untuk belajar project (recall memory).
 *
 * Matriks 2×2:
 *                 Pengetahuan project     Output perintah
 *   NAKED         baca file               mentah
 *   RTK           baca file               dikompres (rtk)
 *   Engram       recall memory           mentah
 *   RTK+Engram   recall memory           dikompres (rtk)
 *
 * Semua angka NYATA: perintah dijalankan raw vs `rtk <cmd>`; file benar-benar dibaca;
 * recall benar-benar dari store. Estimasi token = ceil(bytes/4) (konvensi repo ini).
 */
import { execSync } from 'node:child_process'
import { openDb, closeDb } from '../build/store/db.js'
import { createMemory, createSession, getRecentContext, searchMemories } from '../build/store/memory-store.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tokens = (s) => Math.ceil(Buffer.byteLength(s ?? '', 'utf8') / 4)

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

// ── 1. Biaya OUTPUT PERINTAH: raw vs rtk (angka nyata) ───────────────────────
// Mix perintah dengan output substansial (kondisi nyata orang memakai RTK).
// RTK bersifat output-dependent: menang di output besar, passthrough di yang kecil.
const COMMANDS = [
  { label: 'git status + log',  raw: 'git status && git log --oneline -20',  rtk: 'rtk git status && rtk git log --oneline -20' },
  { label: 'git diff',          raw: 'git diff',                             rtk: 'rtk git diff' },
  { label: 'ls -la node_modules', raw: 'ls -la node_modules',                rtk: 'rtk ls -la node_modules' },
  { label: 'npm test',          raw: 'npm test',                             rtk: 'rtk npm test' },
]

let cmdRaw = 0, cmdRtk = 0
const cmdRows = []
for (const c of COMMANDS) {
  const tr = tokens(run(c.raw))
  const tk = tokens(run(c.rtk))
  cmdRaw += tr
  cmdRtk += tk
  cmdRows.push({ label: c.label, raw: tr, rtk: tk })
}

// ── 2. Biaya PENGETAHUAN PROJECT: baca file vs recall memory (angka nyata) ────
function walkTs(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['node_modules', 'build', '.git', '.engram'].includes(e.name)) out.push(...walkTs(full)) }
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}
function readFilesTokens() {
  const files = ['README.md', 'package.json', 'tsconfig.json'].map(f => path.join(ROOT, f)).concat(walkTs(path.join(ROOT, 'src')))
  let t = 0
  for (const f of files) { try { t += tokens(fs.readFileSync(f, 'utf8')) } catch { /* skip */ } }
  return t
}

const KNOWLEDGE_MEMS = [
  ['architecture', 'Engram: MCP memory persisten. SQLite+FTS5 keyword + vektor all-MiniLM-L6-v2, hybrid RAG.', ['stack']],
  ['decision', 'Semua memory di unified DB ~/.engram/memory.db, dipartisi kolom project. Global lintas project.', ['db']],
  ['decision', 'safeEmbedText: kalau embedding gagal → keyword-only, jangan crash. Warmup saat boot.', ['reliability']],
  ['decision', 'Dedup Jaccard>=0.65 non-destruktif (preserve both / keep longer). Ranking memoryScore access+recency.', ['dedup']],
  ['architecture', 'Tool: remember, recall, forget, list_memories, session_summary, context_status(load|stats|prune).', ['tools']],
  ['bug', 'Fixed: global DB tak pernah dibuka → skope global tak lintas project. Migrasi sekali via marker.', ['fixed']],
  ['decision', 'SessionStart hook `engram load` inject memory otomatis tiap sesi.', ['hook']],
  ['preference', 'User Ridwan: Bahasa Indonesia, fokus hemat token + keandalan.', ['user']],
]

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-4way-')), 'bench.db')
openDb(tmp)
for (const [type, content, tags] of KNOWLEDGE_MEMS) {
  await createMemory({ content, type, tags, project: 'Engram', scope: 'project', skipDedup: true })
}
createSession({ project: 'Engram', summary: 'Perbaikan reliability + token: fallback embedding, unified DB, dedup non-destruktif, ranking, recall ringkas, SessionStart hook.', started_at: Date.now() - 3600_000 })

const knowledgeFiles = readFilesTokens()
const loadCtx = getRecentContext('Engram') ?? ''
const recallRes = await searchMemories({ query: 'stack, database, embedding, dedup config', project: 'Engram', scope: 'all', limit: 5 })
const knowledgeRecall = tokens(loadCtx + '\n' + recallRes.map(m => `[${m.type}] ${m.content}`).join('\n'))

closeDb()
fs.rmSync(path.dirname(tmp), { recursive: true, force: true })

// ── 3. Rakit matriks 4-arah ──────────────────────────────────────────────────
const cfg = {
  naked:       { knowledge: knowledgeFiles,  cmd: cmdRaw },
  rtk:         { knowledge: knowledgeFiles,  cmd: cmdRtk },
  engram:     { knowledge: knowledgeRecall, cmd: cmdRaw },
  rtkCacheai:  { knowledge: knowledgeRecall, cmd: cmdRtk },
}
const total = (c) => c.knowledge + c.cmd
const T = { naked: total(cfg.naked), rtk: total(cfg.rtk), engram: total(cfg.engram), rtkCacheai: total(cfg.rtkCacheai) }
const save = (v) => `${Math.round((1 - v / T.naked) * 100)}%`
const f = (n) => n.toLocaleString().padStart(9)

console.log('\n╔════════════════════════════════════════════════════════════════════════════╗')
console.log('║   BENCHMARK 4-ARAH — token per sesi (angka nyata: rtk + file + recall)      ║')
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n')

const H = ['Komponen'.padEnd(22), 'NAKED'.padStart(9), 'RTK'.padStart(9), 'Engram'.padStart(9), 'RTK+Engram'.padStart(11)]
console.log(H.join(' │ '))
console.log('─'.repeat(22) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(11))

console.log(['Pengetahuan project'.padEnd(22), f(cfg.naked.knowledge), f(cfg.rtk.knowledge), f(cfg.engram.knowledge), f(cfg.rtkCacheai.knowledge).padStart(11)].join(' │ '))
for (const r of cmdRows) {
  console.log([`  ↳ ${r.label}`.padEnd(22), f(r.raw), f(r.rtk), f(r.raw), f(r.rtk).padStart(11)].join(' │ '))
}
console.log(['Subtotal perintah'.padEnd(22), f(cfg.naked.cmd), f(cfg.rtk.cmd), f(cfg.engram.cmd), f(cfg.rtkCacheai.cmd).padStart(11)].join(' │ '))
console.log('─'.repeat(22) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(11))
console.log(['TOTAL / sesi'.padEnd(22), f(T.naked), f(T.rtk), f(T.engram), f(T.rtkCacheai).padStart(11)].join(' │ '))
console.log(['Hemat vs NAKED'.padEnd(22), '     —   ', save(T.rtk).padStart(9), save(T.engram).padStart(9), save(T.rtkCacheai).padStart(11)].join(' │ '))

console.log('\nBaca: RTK memangkas biaya OUTPUT perintah; Engram memangkas biaya PENGETAHUAN')
console.log('(baca-ulang file). Dipakai bareng, keduanya menumpuk → penghematan maksimum.')
console.log('Catatan: estimasi token = ceil(bytes/4). Angka absolut ikut isi project & perintah.\n')
