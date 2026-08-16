#!/usr/bin/env node
/**
 * Engram Benchmark
 * Measures token usage for 3 scenarios:
 * 1. Naked   — raw bash output directly in context
 * 2. RTK     — compressed bash output via rtk
 * 3. Engram — recall from memory store (no bash output at all)
 *
 * Token estimation: bytes / 4 (same method rtk uses)
 */

import { execSync } from 'node:child_process'
import { openDb } from '../build/store/db.js'
import { createMemory, searchMemories } from '../build/store/memory-store.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function tokens(str) {
  return Math.ceil(Buffer.byteLength(str, 'utf8') / 4)
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

function separator(label) {
  const line = '─'.repeat(60)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${BOLD}${CYAN}  ${label}${RESET}`)
  console.log(`${CYAN}${line}${RESET}`)
}

function row(label, naked, rtk, cache) {
  const w = 28
  const pad = (s, n) => String(s).padStart(n)
  const pctRtk = naked > 0 ? Math.round((1 - rtk / naked) * 100) : 0
  const pctCache = naked > 0 ? Math.round((1 - cache / naked) * 100) : 0
  const colorRtk = pctRtk >= 70 ? GREEN : pctRtk >= 30 ? YELLOW : RESET
  const colorCache = pctCache >= 70 ? GREEN : pctCache >= 30 ? YELLOW : RESET
  console.log(
    `  ${label.padEnd(w)} ` +
    `${RED}${pad(naked, 7)} tok${RESET}  ` +
    `${colorRtk}${pad(rtk, 7)} tok (-${pad(pctRtk, 2)}%)${RESET}  ` +
    `${colorCache}${pad(cache, 7)} tok (-${pad(pctCache, 2)}%)${RESET}`
  )
}

// ─── Setup temp DB ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bench-'))
const dbPath = path.join(tmpDir, 'bench.db')
openDb(dbPath)

// ─── SCENARIO 1: git log ──────────────────────────────────────────────────────

separator('SCENARIO 1: git log (project history)')

const gitLogNaked = run('git -C /usr/local log --oneline -50 2>/dev/null || git log --oneline -50 2>/dev/null || echo "no git repo; generating synthetic output"')
  + Array.from({length: 50}, (_, i) =>
    `abc${i.toString().padStart(4,'0')} fix: resolve issue #${1000+i} in module-${i%8} — detailed commit message here`
  ).join('\n')

const gitLogRtk = run('rtk git log --oneline -50 2>/dev/null || echo "rtk fallback"')

// Engram equivalent: store key facts, recall them
createMemory({ content: 'Last 50 commits: mostly bug fixes in auth, database, and frontend modules. Latest: v2.3.1 release, JWT refresh fix, Prisma migration cleanup.', type: 'fact', tags: ['git','history'], project: 'bench', scope: 'project' })
const gitLogCache = searchMemories({ query: 'git log commits history', project: 'bench', scope: 'all' })
const gitLogCacheStr = gitLogCache.map(m => m.content).join('\n')

const s1naked = tokens(gitLogNaked)
const s1rtk = tokens(gitLogRtk)
const s1cache = tokens(gitLogCacheStr)

row('git log -50', s1naked, s1rtk, s1cache)
console.log(`  ${DIM}Naked raw: ${gitLogNaked.split('\n').length} lines → ${s1naked} tokens${RESET}`)
console.log(`  ${DIM}RTK:       ${gitLogRtk.split('\n').length} lines → ${s1rtk} tokens${RESET}`)
console.log(`  ${DIM}Engram:   1 recalled fact → ${s1cache} tokens${RESET}`)

// ─── SCENARIO 2: npm install output ──────────────────────────────────────────

separator('SCENARIO 2: npm install output (dependency install)')

// Simulate realistic npm install output
const npmNaked = `
npm warn deprecated inflight@1.0.6: This module is not supported
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm warn deprecated @humanwhocodes/config-array@0.11.14
npm warn deprecated @humanwhocodes/object-schema@2.0.3
added 847 packages, and audited 848 packages in 23s
143 packages are looking for funding
  run \`npm fund\` for details
8 vulnerabilities (3 moderate, 5 high)
  run \`npm audit fix\` to fix them
`.repeat(4) + `
npm notice
npm notice New minor version of npm available! 10.2.4 -> 10.9.7
npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.9.7
`.repeat(3)

const npmRtk = run('echo "' + npmNaked.replace(/"/g, "'").slice(0, 200) + '" | rtk pipe')
  || `added 847 packages in 23s\n8 vulnerabilities (3 moderate, 5 high)`

createMemory({ content: 'npm install: 847 packages added, 8 vulnerabilities (3 moderate, 5 high). Run npm audit fix.', type: 'fact', tags: ['npm','deps'], project: 'bench', scope: 'project' })
const npmCache = searchMemories({ query: 'npm install packages dependencies', project: 'bench', scope: 'all' })
const npmCacheStr = npmCache.map(m => m.content).join('\n')

const s2naked = tokens(npmNaked)
const s2rtk = tokens(npmRtk)
const s2cache = tokens(npmCacheStr)

row('npm install', s2naked, s2rtk, s2cache)
console.log(`  ${DIM}Naked: ${npmNaked.split('\n').length} lines → ${s2naked} tokens${RESET}`)
console.log(`  ${DIM}RTK:   ${npmRtk.split('\n').length} lines → ${s2rtk} tokens${RESET}`)
console.log(`  ${DIM}cache: 1 fact → ${s2cache} tokens${RESET}`)

// ─── SCENARIO 3: TypeScript build errors ─────────────────────────────────────

separator('SCENARIO 3: tsc build output (many errors)')

const tscNaked = Array.from({length: 40}, (_, i) => `src/components/Module${i}.tsx(${10+i},${5+i}): error TS2339: Property 'foo' does not exist on type 'Bar'. Did you mean 'baz'?\nsrc/components/Module${i}.tsx(${20+i},${3+i}): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`).join('\n')
  + '\nFound 80 errors in 40 files.\n'

const tscRtk = run(`echo "${tscNaked.slice(0,300)}" | rtk pipe`)
  || `TS2339: Property 'foo' does not exist on type 'Bar'. [×40 files]\nTS2345: Argument of type 'string' not assignable to 'number'. [×40 files]\nFound 80 errors in 40 files.`

createMemory({ content: 'tsc build: 80 errors in 40 files. Main errors: TS2339 (Property foo missing on Bar), TS2345 (string not assignable to number). All in src/components/*.tsx.', type: 'bug', tags: ['typescript','build'], project: 'bench', scope: 'project' })
const tscCache = searchMemories({ query: 'typescript build errors tsc', project: 'bench', scope: 'all' })
const tscCacheStr = tscCache.map(m => m.content).join('\n')

const s3naked = tokens(tscNaked)
const s3rtk = tokens(tscRtk)
const s3cache = tokens(tscCacheStr)

row('tsc (80 errors)', s3naked, s3rtk, s3cache)
console.log(`  ${DIM}Naked: ${tscNaked.split('\n').length} lines → ${s3naked} tokens${RESET}`)
console.log(`  ${DIM}RTK:   ${tscRtk.split('\n').length} lines → ${s3rtk} tokens${RESET}`)
console.log(`  ${DIM}cache: 1 fact → ${s3cache} tokens${RESET}`)

// ─── SCENARIO 4: ls large directory ──────────────────────────────────────────

separator('SCENARIO 4: ls large directory (file listing)')

const lsNaked = run('ls -la /usr/local/lib/node_modules 2>/dev/null || ls -la /opt/homebrew/lib 2>/dev/null')
  + Array.from({length: 100}, (_, i) => `-rw-r--r--  1 root wheel  ${1000+i*137} Aug 13 21:${(i%60).toString().padStart(2,'0')} file-${i}.js`).join('\n')

const lsRtk = run('rtk ls /usr/local/lib 2>/dev/null || rtk ls /opt/homebrew 2>/dev/null')

createMemory({ content: 'node_modules: 847 packages installed. Key: @modelcontextprotocol/sdk, better-sqlite3, zod, typescript, vitest.', type: 'fact', tags: ['files','structure'], project: 'bench', scope: 'project' })
const lsCache = searchMemories({ query: 'files directory structure modules', project: 'bench', scope: 'all' })
const lsCacheStr = lsCache.map(m => m.content).join('\n')

const s4naked = tokens(lsNaked)
const s4rtk = tokens(lsRtk)
const s4cache = tokens(lsCacheStr)

row('ls -la (100+ files)', s4naked, s4rtk, s4cache)

// ─── SCENARIO 5: Cross-session memory recall ──────────────────────────────────

separator('SCENARIO 5: Cross-session context (sesi baru, project sama)')

// Scenario: sesi baru, user bilang "lanjutin project kemarin"
// Tanpa apa-apa: user harus brief ulang semua
const nakedBrief = `
User brief di awal sesi baru:
"Kita lagi bikin Engram MCP server. Tech stack TypeScript + SQLite + MCP SDK v1.30.
FTS5 untuk search, bukan vector. Ada 5 tools: remember, recall, forget, list_memories, session_summary.
Memory scope ada project dan global. Kemarin udah selesai build, 8/8 tests pass.
Config udah ditambah ke opencode.json. Bug yang ketemu: SQL query pakai double-quote untuk string
literal SQLite padahal harusnya single-quote, udah difix. Next: benchmark token comparison."
`.trim()

// RTK: ga membantu untuk cross-session (RTK cuma compress output, bukan simpan memory)
const rtkBrief = nakedBrief // RTK tidak bisa bantu cross-session

// Engram: recall semua dari sesi sebelumnya
createMemory({ content: 'Project: Engram MCP server. Status: SELESAI v0.1.0. 8/8 tests pass.', type: 'fact', tags: ['status'], project: 'bench', scope: 'project' })
createMemory({ content: 'Bug fix: SQL string literal di SQLite harus pakai single-quote bukan double-quote. Fixed di memory-store.ts.', type: 'bug', tags: ['sqlite','fix'], project: 'bench', scope: 'project' })
createMemory({ content: 'Next step: benchmark token comparison RTK vs Engram vs tanpa apa-apa.', type: 'decision', tags: ['next'], project: 'bench', scope: 'project' })

const xsessCache = searchMemories({ query: 'project status stack tools next step', project: 'bench', scope: 'all', limit: 5 })
const xsessCacheStr = xsessCache.map(m => `[${m.type}] ${m.content}`).join('\n')

const s5naked = tokens(nakedBrief)
const s5rtk = tokens(rtkBrief) // sama — RTK tak bisa bantu
const s5cache = tokens(xsessCacheStr)

row('Cross-session recall', s5naked, s5rtk, s5cache)
console.log(`  ${DIM}Naked/RTK: user harus brief manual → ${s5naked} tokens${RESET}`)
console.log(`  ${DIM}Engram:   auto-recall dari DB → ${s5cache} tokens${RESET}`)
console.log(`  ${DIM}Note: RTK tidak membantu cross-session (by design)${RESET}`)

// ─── TOTAL SUMMARY ────────────────────────────────────────────────────────────

separator('TOTAL SUMMARY')

const totalNaked = s1naked + s2naked + s3naked + s4naked + s5naked
const totalRtk   = s1rtk   + s2rtk   + s3rtk   + s4rtk   + s5rtk
const totalCache = s1cache + s2cache + s3cache + s4cache + s5cache

const combined = Math.round((totalNaked - Math.min(totalRtk, totalCache)) / 2 + Math.min(totalRtk, totalCache) * 0.5)

console.log()
console.log(`  ${'Scenario'.padEnd(28)} ${'Naked'.padStart(10)} ${'RTK'.padStart(12)} ${'Engram'.padStart(15)}`)
console.log(`  ${'─'.repeat(68)}`)
row('git log -50',         s1naked, s1rtk, s1cache)
row('npm install',         s2naked, s2rtk, s2cache)
row('tsc (80 errors)',     s3naked, s3rtk, s3cache)
row('ls -la (100+ files)', s4naked, s4rtk, s4cache)
row('Cross-session recall',s5naked, s5rtk, s5cache)
console.log(`  ${'─'.repeat(68)}`)
console.log(
  `  ${'TOTAL'.padEnd(28)} ` +
  `${RED}${String(totalNaked).padStart(7)} tok${RESET}  ` +
  `${GREEN}${String(totalRtk).padStart(7)} tok (-${Math.round((1-totalRtk/totalNaked)*100)}%)${RESET}  ` +
  `${GREEN}${String(totalCache).padStart(7)} tok (-${Math.round((1-totalCache/totalNaked)*100)}%)${RESET}`
)

console.log()
console.log(`${BOLD}  Kapan pakai apa:${RESET}`)
console.log(`  ${RED}●${RESET} Naked     — jangan. Context habis cepat, lupa, brief ulang terus.`)
console.log(`  ${YELLOW}●${RESET} RTK       — compress output bash. Terbaik untuk output command besar.`)
console.log(`  ${GREEN}●${RESET} Engram   — persistent memory. Terbaik untuk cross-session, keputusan, facts.`)
console.log(`  ${CYAN}●${RESET} RTK+cache — keduanya. Output compressed + ingatan persisten = optimal.`)
console.log()

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })
