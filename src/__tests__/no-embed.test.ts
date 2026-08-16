// ENGRAM_NO_EMBED is read at module-load time in ../store/embedder.js
// (`const EMBEDDING_DISABLED = process.env.ENGRAM_NO_EMBED === '1'`).
//
// IMPORTANT: static `import` bindings are hoisted per the ES module spec, so
// imported modules are evaluated BEFORE any of this file's own top-level
// statements run — even ones that appear textually above the import
// declarations. Setting `process.env` above a `import ... from '../store/db.js'`
// line does NOT reliably run before embedder.js's module body executes.
//
// Workaround: set the env var synchronously at the top of this file (which
// has no static imports of db.js/memory-store.js), then dynamically
// `import()` those modules inside `beforeAll`. Dynamic import() defers
// evaluation to that point in program execution, so embedder.js observes
// ENGRAM_NO_EMBED=1 when its top-level `const EMBEDDING_DISABLED = ...`
// line runs. This relies on Vitest's default `isolate: true`, which gives
// each test file a fresh module registry — otherwise embedder.js could
// already be cached (with the flag evaluated differently) from another file.
process.env.ENGRAM_NO_EMBED = '1'

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type * as DbModule from '../store/db.js'
import type * as StoreModule from '../store/memory-store.js'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'))
  return path.join(dir, 'test.db')
}

let openDb: typeof DbModule.openDb
let closeDb: typeof DbModule.closeDb
let getDb: typeof DbModule.getDb
let createMemory: typeof StoreModule.createMemory
let searchMemories: typeof StoreModule.searchMemories

describe('reliability: ENGRAM_NO_EMBED fallback', () => {
  let dbPath: string

  beforeAll(async () => {
    const db = await import('../store/db.js')
    const store = await import('../store/memory-store.js')
    openDb = db.openDb
    closeDb = db.closeDb
    getDb = db.getDb
    createMemory = store.createMemory
    searchMemories = store.searchMemories
  })

  beforeEach(() => {
    dbPath = tmpDb()
    openDb(dbPath)
  })

  afterEach(() => {
    closeDb()
  })

  it('stores a memory with a NULL embedding and stays keyword-searchable', async () => {
    const result = await createMemory({
      content: 'Keyword only mode fact about quokkas',
      type: 'fact', tags: [], project: 'p', scope: 'project',
    })

    const row = getDb()
      .prepare('SELECT embedding FROM memories WHERE id = ?')
      .get(result.memory.id) as { embedding: Buffer | null }

    expect(row.embedding).toBeNull()

    const found = await searchMemories({ query: 'quokkas', project: 'p', scope: 'all' })
    expect(found.some(r => r.id === result.memory.id)).toBe(true)
  })
})
