#!/usr/bin/env node
/**
 * Benchmark 4-arah pada project NYATA yang besar: NEUROX (warungbungapagi).
 * NAKED · RTK · Engram · RTK+Engram — token per sesi, angka nyata.
 *
 * RTK   → kompres OUTPUT perintah (di sini: ls node_modules besar + git).
 * Engram → ganti baca-ulang docs onboarding dengan recall memory.
 */
import { execSync } from 'node:child_process'
import { openDb, closeDb } from '../build/store/db.js'
import { createMemory, createSession, getRecentContext, searchMemories } from '../build/store/memory-store.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TARGET = '/Users/apple/Desktop/warungbungapagi'
const tokens = (s) => Math.ceil(Buffer.byteLength(s ?? '', 'utf8') / 4)

function run(cmd) {
  try {
    return execSync(cmd, { cwd: TARGET, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

// ── 1. OUTPUT PERINTAH: raw vs rtk (angka nyata di project ini) ──────────────
const COMMANDS = [
  { label: 'git status + log',        raw: 'git status && git log --oneline -20',   rtk: 'rtk git status && rtk git log --oneline -20' },
  { label: 'ls -la be/node_modules',  raw: 'ls -la neurox/be/node_modules',         rtk: 'rtk ls -la neurox/be/node_modules' },
  { label: 'ls -la fe/node_modules',  raw: 'ls -la neurox/fe/node_modules',         rtk: 'rtk ls -la neurox/fe/node_modules' },
  { label: 'ls -la landing/node_mod', raw: 'ls -la landing/node_modules',           rtk: 'rtk ls -la landing/node_modules' },
]
let cmdRaw = 0, cmdRtk = 0
const cmdRows = []
for (const c of COMMANDS) {
  const tr = tokens(run(c.raw))
  const tk = tokens(run(c.rtk))
  cmdRaw += tr; cmdRtk += tk
  cmdRows.push({ label: c.label, raw: tr, rtk: tk })
}

// ── 2. PENGETAHUAN: docs onboarding nyata vs recall memory NEUROX ────────────
const DOCS = ['README.md', 'AGENTS.md', 'DESIGN.md', 'Prompt_AI_Design_HRIS_FnB.md', 'System_Architecture_Overall.mermaid']
let knowledgeDocs = 0
for (const d of DOCS) { try { knowledgeDocs += tokens(fs.readFileSync(path.join(TARGET, d), 'utf8')) } catch { /* skip */ } }

// Memory NEUROX yang faithful (yang akan Engram simpan sekali, pakai lintas sesi).
const MEMS = [
  ['architecture', 'NEUROX: enterprise superapp Warung BungaPagi. FE React18 super-app (Vite, neurox/fe) → API Gateway NestJS BFF /api/v1 → 9 microservice NestJS via TCP, tiap service punya Prisma schema di MySQL. Redis+BullMQ untuk antrian CV-scan.', ['arch']],
  ['architecture', 'Dua produk terpisah: (1) Landing page brand F&B (spec di DESIGN.md), (2) HRIS F&B enterprise (BE+FE scaffolded). Jangan dicampur.', ['scope']],
  ['fact', 'Ports microservice: Gateway HTTP 3000, Auth 3001, Employee 3002, Shift 3003, Attendance 3004, Recruitment 3005.', ['ports']],
  ['decision', 'Prisma: pakai schema gabungan be/prisma/schema.prisma untuk db push (source of truth). JANGAN db push dari schema service sendiri — bakal drop tabel service lain.', ['prisma','gotcha']],
  ['fact', 'PrismaClient tiap service di-generate ke output custom be/node_modules/.prisma/{service}-client (bukan @prisma/client). Seed pakai combined-client.', ['prisma']],
  ['decision', 'RBAC: RolesGuard di API Gateway cek request.user.role.name; @Roles(\'admin\') batasi endpoint. Gateway validasi JWT; microservice percaya gateway, tak validasi token sendiri.', ['auth','rbac']],
  ['decision', 'RPC errors: microservice HARUS throw RpcException (@nestjs/microservices), bukan HttpException — kalau tidak, pesan tersembunyi jadi "Internal server error". Gateway sendRpc+RpcExceptionFilter konversi balik ke HTTP.', ['gotcha','rpc']],
  ['fact', 'AI Recruitment (port 3005): Upload CV → extract → match Job Requirement → score. Pakai OpenAI API (OPENAI_API_KEY di be/services/recruitment/.env). File CV di be/uploads/.', ['ai','recruitment']],
  ['fact', 'Attendance: geofence check-in/out. attendance_types: Normal (geofence on), Perjalanan Dinas / Dinas Luar Kota / WFH (bypassGeofence=true). Validasi jam shift hanya untuk Normal + ada scheduleId. Shift malam 22:00-06:00 lintas hari didukung.', ['attendance']],
  ['fact', 'DB dev: MySQL localhost:3306 user root tanpa password, database hris_fnb. Login seed: admin@hrisfnb.com / maya@warungbungapagi.com / andi@warungbungapagi.com, semua password123.', ['db','seed']],
  ['decision', 'Stack BE: NestJS microservice + Prisma + MySQL + TCP. FE: Vite+React+TS+Ant Design+Zustand+TanStack Query+RHF+Zod. AI: OpenAI. Belum di MVP: Redis, BullMQ, OpenSearch, MinIO/S3. Mobile (RN) deferred.', ['stack']],
  ['preference', 'Semua dokumen desain ditulis Bahasa Indonesia dengan istilah teknis English; kode English. Pertahankan konvensi ini.', ['lang']],
  ['fact', 'Dev commands (dari be/): npm run db:setup (push+generate+seed), db:push, db:seed, start:dev (semua service). @hris/shared HARUS di-build (npm run build -w @hris/shared) sebelum service compile.', ['commands']],
  ['fact', 'Route order Attendance: /my dan /geofence ditaruh SEBELUM /:id agar tak bentrok match route NestJS. FE pakai @Req() bukan @Request().', ['gotcha']],
]

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neurox-4way-')), 'bench.db')
openDb(tmp)
for (const [type, content, tags] of MEMS) {
  await createMemory({ content, type, tags, project: 'warungbungapagi', scope: 'project', skipDedup: true })
}
createSession({ project: 'warungbungapagi', summary: 'Onboarding NEUROX: arsitektur microservice, ports, gotcha Prisma & RPCException, RBAC gateway, AI recruitment, attendance geofence.', started_at: Date.now() - 3600_000 })

const loadCtx = getRecentContext('warungbungapagi') ?? ''
const recallRes = await searchMemories({ query: 'arsitektur, prisma, ports, auth, recruitment, attendance', project: 'warungbungapagi', scope: 'all', limit: 6 })
const knowledgeRecall = tokens(loadCtx + '\n' + recallRes.map(m => `[${m.type}] ${m.content}`).join('\n'))
closeDb()
fs.rmSync(path.dirname(tmp), { recursive: true, force: true })

// ── 3. Matriks ────────────────────────────────────────────────────────────────
const cfg = {
  naked:      { knowledge: knowledgeDocs,   cmd: cmdRaw },
  rtk:        { knowledge: knowledgeDocs,   cmd: cmdRtk },
  engram:    { knowledge: knowledgeRecall, cmd: cmdRaw },
  rtkCacheai: { knowledge: knowledgeRecall, cmd: cmdRtk },
}
const total = (c) => c.knowledge + c.cmd
const T = { naked: total(cfg.naked), rtk: total(cfg.rtk), engram: total(cfg.engram), rtkCacheai: total(cfg.rtkCacheai) }
const save = (v) => `${Math.round((1 - v / T.naked) * 100)}%`
const f = (n) => n.toLocaleString().padStart(9)

console.log('\n╔════════════════════════════════════════════════════════════════════════════╗')
console.log('║   NEUROX (warungbungapagi) — token per sesi: NAKED·RTK·Engram·RTK+Engram  ║')
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n')
console.log(['Komponen'.padEnd(22), 'NAKED'.padStart(9), 'RTK'.padStart(9), 'Engram'.padStart(9), 'RTK+Engram'.padStart(11)].join(' │ '))
const sep = '─'.repeat(22) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(9) + '─┼─' + '─'.repeat(11)
console.log(sep)
console.log(['Pengetahuan (onboarding)'.padEnd(22), f(cfg.naked.knowledge), f(cfg.rtk.knowledge), f(cfg.engram.knowledge), f(cfg.rtkCacheai.knowledge).padStart(11)].join(' │ '))
for (const r of cmdRows) console.log([`  ↳ ${r.label}`.padEnd(22), f(r.raw), f(r.rtk), f(r.raw), f(r.rtk).padStart(11)].join(' │ '))
console.log(['Subtotal perintah'.padEnd(22), f(cfg.naked.cmd), f(cfg.rtk.cmd), f(cfg.engram.cmd), f(cfg.rtkCacheai.cmd).padStart(11)].join(' │ '))
console.log(sep)
console.log(['TOTAL / sesi'.padEnd(22), f(T.naked), f(T.rtk), f(T.engram), f(T.rtkCacheai).padStart(11)].join(' │ '))
console.log(['Hemat vs NAKED'.padEnd(22), '     —   ', save(T.rtk).padStart(9), save(T.engram).padStart(9), save(T.rtkCacheai).padStart(11)].join(' │ '))
console.log(`\nCatatan: "Pengetahuan" = 5 docs onboarding (README/AGENTS/DESIGN/Prompt/architecture).`)
console.log(`Kalau agent sampai baca source (1.337 file, ~2,1 JUTA token), hemat Engram jauh lebih ekstrem.`)
console.log(`Estimasi token = ceil(bytes/4). Semua angka nyata dari project ini.\n`)
