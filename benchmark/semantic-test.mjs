#!/usr/bin/env node
import { openDb, closeDb } from '../build/store/db.js'
import { createMemory, searchMemories } from '../build/store/memory-store.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Membantu memastikan model lokal diload tanpa error saat fetch ke HF gagal
import { env } from '@xenova/transformers'
env.allowLocalModels = true

;(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bench3-'))
  const dbPath = path.join(tmpDir, 'bench.db')
  openDb(dbPath)

  console.log('Simulating Semantic Gap (FTS vs Vector RAG)...\\n')

  await createMemory({
    content: 'We use PostgreSQL as our primary database.', 
    type: 'architecture', tags: ['db'], project: 'bench', scope: 'project'
  })
  
  await createMemory({
    content: 'Frontend is built with React.', 
    type: 'architecture', tags: ['frontend'], project: 'bench', scope: 'project'
  })

  // Query ini TIDAK match secara keyword (FTS) dengan "PostgreSQL"
  // Karena kata-katanya "sql db storage" vs "PostgreSQL as our primary database"
  // FTS murni bakal miss.
  const query = 'sql db storage backend'
  
  const results = await searchMemories({ query, project: 'bench', scope: 'all' })
  
  console.log(`QUERY: "${query}"`)
  console.log('RESULTS:')
  results.forEach(r => console.log(` - [${r.relevance_hint}] ${r.content}`))

  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})();