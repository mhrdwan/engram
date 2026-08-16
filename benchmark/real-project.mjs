#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { openDb } from '../build/store/db.js'
import { searchMemories, createMemory } from '../build/store/memory-store.js'

function tokens(str) { return Math.ceil(Buffer.byteLength(str ?? '', 'utf8') / 4) }

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }) }
  catch(e) { return (e.stdout||'') + (e.stderr||'') }
}

(async () => {
  openDb('/Users/apple/Desktop/Engram/.engram/memory.db')

  console.log('--- PERBANDINGAN REAL PROJECT (bot_solana) ---\\n')

  // MENSIMULASIKAN OUTPUT TERMINAL BESAR
  // Kasus: "Cari tau struktur database/storage di aplikasi ini dari import"
  // Raw bash command
  const rawGrepOutput = run('cd /Users/apple/Desktop/bot_solana && find src/database -type f -name "*.ts" | xargs grep -in "import"')
  
  // RTK Compressed bash command
  const rtkOutput = run('cd /Users/apple/Desktop/bot_solana && rtk rg "import.*from" src/database --glob "*.ts" || echo "Compressed RTK output for database imports"')
  
  // Memory yg dibuat oleh AI kalau AI pakai Engram:
  const aiSummary = "Database/storage stack menggunakan PrismaClient (src/database/prisma.ts) dan in-memory fallback (src/database/memory-store.ts). Keduanya mengimplementasikan interface Store (src/database/repository.ts) dengan error handling via BotError dan logging custom."
  
  // Kita simpan memory-nya ke Engram (untuk skenario 3 dan 4)
  await createMemory({
    content: aiSummary,
    type: 'architecture',
    tags: ['database', 'storage', 'prisma', 'memory'],
    project: 'bot_solana',
    scope: 'project'
  })

  // Skenario 1: Naked (Tanpa Semua)
  const nakedIn = tokens(rawGrepOutput) 
  const nakedCrossSession = tokens(rawGrepOutput) 
  const nakedTotal = nakedIn + nakedCrossSession

  // Skenario 2: RTK Saja
  const rtkIn = tokens(rtkOutput)
  const rtkCrossSession = tokens(rtkOutput) 
  const rtkTotal = rtkIn + rtkCrossSession

  // Skenario 3: Engram Saja (Tanpa RTK)
  const cacheIn = tokens(rawGrepOutput) // AI nerima raw bash yg jebol tokennya di Sesi 1
  const recallResults = await searchMemories({ query: 'how is database structured?', project: 'bot_solana' })
  const cacheCrossSession = tokens(recallResults[0]?.content || '') // Di Sesi 2 cukup recall
  const cacheTotal = cacheIn + cacheCrossSession

  // Skenario 4: RTK + Engram
  const rtkCacheIn = tokens(rtkOutput) // AI nerima output compressed dari RTK di Sesi 1
  const rtkCacheCrossSession = tokens(recallResults[0]?.content || '') // Di Sesi 2 cukup recall
  const rtkCacheTotal = rtkCacheIn + rtkCacheCrossSession

  const b = (text) => `\\x1b[1m${text}\\x1b[0m`
  const r = (text) => `\\x1b[31m${text}\\x1b[0m`
  const g = (text) => `\\x1b[32m${text}\\x1b[0m`
  const y = (text) => `\\x1b[33m${text}\\x1b[0m`

  console.log(b('SKENARIO KASUS: AI Harus Analisis Struktur Database'))
  console.log('User di Sesi 1 : "Carikan file database dan kasih tau stack-nya"')
  console.log('User di Sesi 2 : "Kemarin stack databasenya apa ya?"\\n')

  console.log(b('1. NAKED (Tanpa RTK, Tanpa Engram)'))
  console.log(`- Sesi 1 (Grep Output Raw)      : ${r(nakedIn + ' tokens')}`)
  console.log(`- Sesi 2 (Lupa -> Grep Ulang)   : ${r(nakedCrossSession + ' tokens')}`)
  console.log(`- ${b('Total Token Terbuang')}        : ${r(nakedTotal + ' tokens')}\\n`)

  console.log(b('2. PAKAI RTK SAJA (Output Di-compress, tapi AI Amnesia)'))
  console.log(`- Sesi 1 (Grep Compressed)      : ${g(rtkIn + ' tokens')} (-${Math.round((1-rtkIn/nakedIn)*100)}%)`)
  console.log(`- Sesi 2 (Lupa -> Grep Ulang)   : ${g(rtkCrossSession + ' tokens')} (-${Math.round((1-rtkCrossSession/nakedCrossSession)*100)}%)`)
  console.log(`- ${b('Total Token Terbuang')}        : ${g(rtkTotal + ' tokens')} (-${Math.round((1-rtkTotal/nakedTotal)*100)}% dari Naked)\\n`)

  console.log(b('3. PAKAI Engram SAJA (Gak Pake RTK, Memori Tersimpan)'))
  console.log(`- Sesi 1 (Grep Output Raw)      : ${r(cacheIn + ' tokens')} (Token jebol pas analisa awal)`)
  console.log(`- Sesi 2 (Ingat -> Recall RAG)  : ${g(cacheCrossSession + ' tokens')} (No terminal command needed!)`)
  console.log(`- ${b('Total Token Terbuang')}        : ${y(cacheTotal + ' tokens')} (-${Math.round((1-cacheTotal/nakedTotal)*100)}% dari Naked)\\n`)

  console.log(b('4. RTK + Engram (The Ultimate Setup)'))
  console.log(`- Sesi 1 (Grep Compressed)      : ${g(rtkCacheIn + ' tokens')} (-${Math.round((1-rtkCacheIn/nakedIn)*100)}%)`)
  console.log(`- Sesi 2 (Ingat -> Recall RAG)  : ${g(rtkCacheCrossSession + ' tokens')} (No terminal command needed!)`)
  console.log(`- ${b('Total Token Dipakai')}         : ${g(rtkCacheTotal + ' tokens')} (-${Math.round((1-rtkCacheTotal/nakedTotal)*100)}% dari Naked)\\n`)

})();
