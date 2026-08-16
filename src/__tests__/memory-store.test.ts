import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, closeDb } from '../store/db.js'
import {
  createMemory,
  getMemoryById,
  listMemories,
  searchMemories,
  deleteMemory,
  createSession,
  listSessions,
  pruneMemories,
  getRecentContext,
  getStats,
} from '../store/memory-store.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'))
  return path.join(dir, 'test.db')
}

describe('memory store', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    openDb(dbPath)
  })

  afterEach(() => {
    closeDb()
  })

  it('creates and retrieves a memory', async () => {
    const result = await createMemory({
      content: 'We use PostgreSQL as primary database',
      type: 'decision',
      tags: ['database'],
      project: 'my-project',
      scope: 'project',
    })
    const m = result.memory

    expect(m.id).toBeTruthy()
    expect(m.content).toBe('We use PostgreSQL as primary database')
    expect(m.type).toBe('decision')
    expect(m.tags).toEqual(['database'])
    expect(m.project).toBe('my-project')
    expect(m.scope).toBe('project')
    expect(result.deduplicated).toBe(false)

    const fetched = getMemoryById(m.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(m.id)
  })

  it('returns null for unknown ID', () => {
    expect(getMemoryById('nonexistent')).toBeNull()
  })

  it('deduplicates similar memories', async () => {
    const r1 = await createMemory({ content: 'Stack: Next.js + Prisma + PostgreSQL', type: 'architecture', tags: ['stack'], project: 'p', scope: 'project' })
    const r2 = await createMemory({ content: 'Tech stack is Next.js, Prisma, PostgreSQL database', type: 'architecture', tags: ['stack', 'db'], project: 'p', scope: 'project' })
    const r3 = await createMemory({ content: 'We use Redis for caching, completely different', type: 'architecture', tags: ['cache'], project: 'p', scope: 'project' })

    expect(r1.deduplicated).toBe(false)
    expect(r2.deduplicated).toBe(true)         // similar → merged
    expect(r2.mergedInto).toBe(r1.memory.id)   // merged into first
    expect(r3.deduplicated).toBe(false)         // different content → new entry

    const all = listMemories({ project: 'p', scope: 'all' })
    expect(all.length).toBe(2)                 // 1 merged + 1 new, not 3
  })

  it('merges tags on dedup', async () => {
    await createMemory({ content: 'Auth uses JWT tokens for authentication', type: 'decision', tags: ['auth'], project: 'p', scope: 'project' })
    // Nearly identical content — should dedup
    const r2 = await createMemory({ content: 'Auth uses JWT tokens for authentication security', type: 'decision', tags: ['security', 'auth'], project: 'p', scope: 'project' })

    expect(r2.deduplicated).toBe(true)
    expect(r2.memory.tags).toContain('auth')
    expect(r2.memory.tags).toContain('security')
  })

  it('lists memories filtered by type', async () => {
    await createMemory({ content: 'Use TypeScript', type: 'decision', tags: [], project: 'p', scope: 'project' })
    await createMemory({ content: 'Dark mode preferred', type: 'preference', tags: [], project: 'p', scope: 'project' })
    await createMemory({ content: 'API at /api/v2', type: 'fact', tags: [], project: 'p', scope: 'project' })

    const decisions = listMemories({ project: 'p', type: 'decision' })
    expect(decisions).toHaveLength(1)
    expect(decisions[0].content).toBe('Use TypeScript')
  })

  it('searches memories via FTS5', async () => {
    await createMemory({ content: 'We use Next.js for frontend', type: 'architecture', tags: ['frontend'], project: 'p', scope: 'project' })
    await createMemory({ content: 'Auth uses JWT tokens', type: 'decision', tags: ['auth'], project: 'p', scope: 'project' })
    await createMemory({ content: 'Database is PostgreSQL', type: 'decision', tags: ['db'], project: 'p', scope: 'project' })

    const results = await searchMemories({ query: 'JWT auth', project: 'p', scope: 'all' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('JWT')
  })

  it('ranks by access_count in recall', async () => {
    const r1 = await createMemory({ content: 'Fact A — rarely accessed', type: 'fact', tags: [], project: 'p', scope: 'project' })
    const r2 = await createMemory({ content: 'Fact B — frequently accessed', type: 'fact', tags: [], project: 'p', scope: 'project' })

    // Simulate r2 being accessed many times
    await searchMemories({ query: 'frequently', project: 'p', scope: 'all' })
    await searchMemories({ query: 'frequently', project: 'p', scope: 'all' })
    await searchMemories({ query: 'frequently', project: 'p', scope: 'all' })

    const list = listMemories({ project: 'p', scope: 'all' })
    // r2 should rank higher due to access_count
    expect(list[0].id).toBe(r2.memory.id)
    void r1
  })

  it('deletes a memory', async () => {
    const result = await createMemory({ content: 'temp fact', type: 'fact', tags: [], project: 'p', scope: 'project' })
    expect(getMemoryById(result.memory.id)).not.toBeNull()

    const deleted = deleteMemory(result.memory.id)
    expect(deleted).toBe(true)
    expect(getMemoryById(result.memory.id)).toBeNull()
  })

  it('returns false when deleting nonexistent memory', () => {
    expect(deleteMemory('ghost-id')).toBe(false)
  })

  it('prunes old never-accessed memories', async () => {
    const r1 = await createMemory({ content: 'Old fact nobody cared about unique xyz', type: 'fact', tags: [], project: 'p', scope: 'project', skipDedup: true })
    const r2 = await createMemory({ content: 'Critical decision: use TypeScript always', type: 'decision', tags: [], project: 'p', scope: 'project', skipDedup: true })

    // maxAge = -1 means cutoff = now + 1ms → everything is "old"
    // keepMinAccess = 1 means access_count < 1 (never accessed) gets evicted
    const evicted = pruneMemories({ project: 'p', maxAge: -1, keepMinAccess: 1 })

    expect(evicted).toBeGreaterThan(0)
    expect(getMemoryById(r1.memory.id)).toBeNull()    // fact evicted
    expect(getMemoryById(r2.memory.id)).not.toBeNull() // decision preserved
  })

  it('global memories visible from any project', async () => {
    await createMemory({ content: 'Global coding standard: ESLint + Prettier', type: 'preference', tags: [], project: 'project-a', scope: 'global' })
    await createMemory({ content: 'Local fact for project-b', type: 'fact', tags: [], project: 'project-b', scope: 'project' })

    const fromA = listMemories({ project: 'project-a', scope: 'all' })
    const fromB = listMemories({ project: 'project-b', scope: 'all' })

    expect(fromB.some(m => m.content.includes('ESLint'))).toBe(true)
    expect(fromA.some(m => m.content.includes('Local fact for project-b'))).toBe(false)
  })

  it('creates and lists sessions', () => {
    const id = createSession({
      project: 'p',
      summary: 'Set up auth, chose JWT, scaffolded routes',
      started_at: Date.now() - 3600_000,
    })

    expect(id).toBeTruthy()
    const sessions = listSessions('p')
    expect(sessions.length).toBe(1)
    expect((sessions[0] as any).summary).toContain('JWT')
  })

  it('getRecentContext returns session + top memories', async () => {
    await createMemory({ content: 'Stack: Next.js', type: 'architecture', tags: [], project: 'p', scope: 'project' })
    createSession({ project: 'p', summary: 'Built auth module, fixed JWT bug', started_at: Date.now() - 3600_000 })

    const ctx = getRecentContext('p')
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('Built auth module')
    expect(ctx).toContain('Next.js')
  })

  it('getStats returns correct counts', async () => {
    await createMemory({ content: 'Fact 1', type: 'fact', tags: [], project: 'p', scope: 'project' })
    await createMemory({ content: 'Decision 1', type: 'decision', tags: [], project: 'p', scope: 'project' })
    createSession({ project: 'p', summary: 'test session', started_at: Date.now() - 3600_000 })

    const stats = getStats('p')
    expect(stats.total).toBe(2)
    expect(stats.sessions).toBe(1)
  })
})
