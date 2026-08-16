import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, closeDb, migrateLegacyDb } from '../store/db.js'
import {
  createMemory,
  getMemoryById,
  listMemories,
  searchMemories,
  deleteMemory,
  createSession,
  getRecentContext,
} from '../store/memory-store.js'
import type { CreateResult } from '../store/memory-store.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'))
  return path.join(dir, 'test.db')
}

describe('reliability: non-destructive dedup merge', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    openDb(dbPath)
  })

  afterEach(() => {
    closeDb()
  })

  it('keeps the NEW content when it is longer than the existing near-duplicate', async () => {
    const shortContent = 'Auth uses JWT tokens for sessions'
    const longContent = 'Auth uses JWT tokens for sessions and refresh'

    const r1 = await createMemory({
      content: shortContent, type: 'decision', tags: ['auth'], project: 'p', scope: 'project',
    })
    const r2 = await createMemory({
      content: longContent, type: 'decision', tags: ['security'], project: 'p', scope: 'project',
    })

    expect(r2.deduplicated).toBe(true)
    expect(r2.mergedInto).toBe(r1.memory.id)
    expect(r2.memory.content).toBe(longContent)

    const fetched = getMemoryById(r1.memory.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.content).toBe(longContent)
    expect(fetched!.tags.sort()).toEqual(['auth', 'security'])

    const all = listMemories({ project: 'p', scope: 'all' })
    expect(all.length).toBe(1)
    expect(all[0].content).toBe(longContent)
  })

  it('keeps the EXISTING content when it is longer than the new near-duplicate', async () => {
    const longContent = 'Auth uses JWT tokens for sessions and refresh'
    const shortContent = 'Auth uses JWT tokens for sessions'

    const r1 = await createMemory({
      content: longContent, type: 'decision', tags: ['auth'], project: 'p', scope: 'project',
    })
    const r2 = await createMemory({
      content: shortContent, type: 'decision', tags: ['security'], project: 'p', scope: 'project',
    })

    expect(r2.deduplicated).toBe(true)
    expect(r2.mergedInto).toBe(r1.memory.id)
    // Non-destructive: the shorter incoming content must NOT overwrite the longer existing one.
    expect(r2.memory.content).toBe(longContent)

    const fetched = getMemoryById(r1.memory.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.content).toBe(longContent)
    expect(fetched!.tags.sort()).toEqual(['auth', 'security'])

    const all = listMemories({ project: 'p', scope: 'all' })
    expect(all.length).toBe(1)
    expect(all[0].content).toBe(longContent)
  })
})

describe('reliability: ranking respects access_count over pure recency', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    openDb(dbPath)
  })

  afterEach(() => {
    closeDb()
  })

  it('ranks an older, frequently-accessed memory above a newer, never-accessed memory', async () => {
    const older = await createMemory({
      content: 'Zephyr module uses custom protocol codeword XQZ99KILO',
      type: 'fact', tags: [], project: 'p', scope: 'project',
    })

    // Ensure a real, measurable time gap so "newer" is unambiguously newer.
    await new Promise(resolve => setTimeout(resolve, 10))

    const newer = await createMemory({
      content: 'We redesigned the marketing landing page yesterday',
      type: 'fact', tags: [], project: 'p', scope: 'project',
    })

    // Bump only the older memory's access_count via a keyword unique to it.
    await searchMemories({ query: 'XQZ99KILO', project: 'p', scope: 'all' })
    await searchMemories({ query: 'XQZ99KILO', project: 'p', scope: 'all' })
    await searchMemories({ query: 'XQZ99KILO', project: 'p', scope: 'all' })

    const refreshedOlder = getMemoryById(older.memory.id)!
    const refreshedNewer = getMemoryById(newer.memory.id)!
    expect(refreshedOlder.access_count).toBeGreaterThanOrEqual(3)
    expect(refreshedOlder.access_count).toBeGreaterThan(refreshedNewer.access_count)

    // Regression guard: under the old `access_count*2 + created_at/1e6` formula,
    // the created_at term dominated and the newer, never-accessed memory would
    // always win. The new formula normalizes recency to 0..1 so access_count
    // actually matters.
    const list = listMemories({ project: 'p', scope: 'all' })
    expect(list[0].id).toBe(older.memory.id)
  })
})

describe('reliability: migrateLegacyDb', () => {
  afterEach(() => {
    closeDb()
  })

  it('migrates legacy rows under a new project key, is idempotent, and no-ops for a missing file', async () => {
    // Build a standalone legacy DB using the same schema (via openDb + createMemory).
    const legacyPath = tmpDb()
    openDb(legacyPath)
    const m1 = await createMemory({
      content: 'Legacy fact about zircon compilers',
      type: 'fact', tags: ['legacy'], project: 'old-proj', scope: 'project', skipDedup: true,
    })
    const m2 = await createMemory({
      content: 'Legacy decision to use Postgres over Mongo',
      type: 'decision', tags: [], project: 'old-proj', scope: 'project', skipDedup: true,
    })
    closeDb()

    // Fresh unified DB — separate file.
    const unifiedPath = tmpDb()
    openDb(unifiedPath)

    const migrated = migrateLegacyDb(legacyPath, 'new-key')
    expect(migrated).toBe(2)

    const listed = listMemories({ project: 'new-key', scope: 'all' })
    expect(listed.some(m => m.id === m1.memory.id)).toBe(true)
    expect(listed.some(m => m.id === m2.memory.id)).toBe(true)

    const found = await searchMemories({ query: 'zircon', project: 'new-key', scope: 'all' })
    expect(found.some(r => r.id === m1.memory.id)).toBe(true)

    // Idempotent: re-running the migration must not duplicate rows.
    const again = migrateLegacyDb(legacyPath, 'new-key')
    expect(again).toBe(0)

    // Missing legacy file → 0, no throw.
    const missing = migrateLegacyDb('/nonexistent/path/does-not-exist.db', 'whatever')
    expect(missing).toBe(0)
  })
})

describe('reliability: dedup preserves BOTH distinct facts (no silent loss)', () => {
  beforeEach(() => { openDb(tmpDb()) })
  afterEach(() => { closeDb() })

  it('merges two distinct facts by combining content instead of discarding one', async () => {
    // High token overlap (jaccard ~0.71) but genuinely different facts.
    const a = 'Login fails on Safari due to cookie SameSite'
    const b = 'Login fails on Chrome due to cookie SameSite'

    const r1 = await createMemory({ content: a, type: 'bug', tags: ['safari'], project: 'p', scope: 'project' })
    const r2 = await createMemory({ content: b, type: 'bug', tags: ['chrome'], project: 'p', scope: 'project' })

    expect(r2.deduplicated).toBe(true)
    expect(r2.mergedInto).toBe(r1.memory.id)

    // Neither fact may be silently dropped — both browsers must survive the merge.
    const kept = getMemoryById(r1.memory.id)!
    expect(kept.content).toContain('Safari')
    expect(kept.content).toContain('Chrome')
    expect(kept.tags.sort()).toEqual(['chrome', 'safari'])
  })

  it('still collapses a true duplicate (contained content) into the longer text', async () => {
    const short = 'Database is PostgreSQL for the main store'
    const long = 'Database is PostgreSQL for the main store and analytics'

    const r1 = await createMemory({ content: short, type: 'fact', tags: [], project: 'p', scope: 'project' })
    const r2 = await createMemory({ content: long, type: 'fact', tags: [], project: 'p', scope: 'project' })

    expect(r2.deduplicated).toBe(true)
    const kept = getMemoryById(r1.memory.id)!
    // Contained → collapse to the longer text, NOT concatenate (no " | " duplication).
    expect(kept.content).toBe(long)
    expect(kept.content).not.toContain('|')
  })
})

describe('reliability: forget survives re-migration (no resurrection)', () => {
  afterEach(() => { closeDb() })

  it('does not resurrect a forgotten memory when migration runs again', async () => {
    // Legacy DB with one memory.
    const legacyPath = tmpDb()
    openDb(legacyPath)
    const m = await createMemory({
      content: 'Legacy secret to forget later', type: 'fact', tags: [], project: 'old', scope: 'project', skipDedup: true,
    })
    closeDb()

    // Unified DB: migrate, then forget the migrated row.
    const unified = tmpDb()
    openDb(unified)
    expect(migrateLegacyDb(legacyPath, 'k')).toBe(1)
    expect(getMemoryById(m.memory.id)).not.toBeNull()

    deleteMemory(m.memory.id)
    expect(getMemoryById(m.memory.id)).toBeNull()

    // Simulate the next session start: migration runs again. The marker must
    // prevent the forgotten row from coming back (the HIGH bug this guards).
    expect(migrateLegacyDb(legacyPath, 'k')).toBe(0)
    expect(getMemoryById(m.memory.id)).toBeNull()
  })
})

describe('reliability: getRecentContext', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    openDb(dbPath)
  })

  afterEach(() => {
    closeDb()
  })

  it('includes the session summary and surfaces the high-access memory in Key facts', async () => {
    const contents = [
      'Memory one about nothing special',
      'Memory two about something else',
      'Memory three unrelated topic here',
      'Memory four also unrelated stuff',
      'Special memory with keyword BARNACLE77 unique',
      'Memory six the last one created',
    ]

    const created: CreateResult[] = []
    for (const c of contents) {
      created.push(await createMemory({
        content: c, type: 'fact', tags: [], project: 'p', scope: 'project', skipDedup: true,
      }))
    }
    const special = created[4]

    await searchMemories({ query: 'BARNACLE77', project: 'p', scope: 'all' })
    await searchMemories({ query: 'BARNACLE77', project: 'p', scope: 'all' })

    const refreshedSpecial = getMemoryById(special.memory.id)!
    expect(refreshedSpecial.access_count).toBeGreaterThanOrEqual(2)

    createSession({
      project: 'p',
      summary: 'Wrapped up sprint planning and backlog grooming',
      started_at: Date.now() - 1000,
    })

    const ctx = getRecentContext('p')
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('Wrapped up sprint planning and backlog grooming')
    expect(ctx).toContain('Key facts')
    expect(ctx).toContain('BARNACLE77')
  })
})
