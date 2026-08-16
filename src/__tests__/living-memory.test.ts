import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, closeDb } from '../store/db.js'
import {
  createMemory,
  getMemoryById,
  searchMemories,
  getRecentContext,
  getStats,
  pruneMemories,
  estTokens,
} from '../store/memory-store.js'
import { computeAnchorHash, isStale } from '../store/anchor.js'
import { rememberHandler } from '../tools/remember.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-living-'))
  return path.join(dir, 'test.db')
}
function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-anchor-'))
  const p = path.join(dir, 'src.txt')
  fs.writeFileSync(p, content)
  return p
}

describe('living-memory: self-invalidating anchor', () => {
  beforeEach(() => { openDb(tmpDb()) })
  afterEach(() => { closeDb() })

  it('flags a memory STALE once its anchored source file changes', async () => {
    const file = tmpFile('export const PORT = 3000')
    await createMemory({
      content: 'Auth service listens on PORT 3000 keyword ZEBRA',
      type: 'fact', tags: [], project: 'p', scope: 'project', anchor: file,
    })

    // Fresh: file unchanged → not stale.
    let res = await searchMemories({ query: 'ZEBRA', project: 'p', scope: 'all' })
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].stale).toBe(false)
    expect(res[0].anchor_path).toBe(path.resolve(file))

    // Source file changes → the fact may be outdated → stale.
    fs.writeFileSync(file, 'export const PORT = 4000')
    res = await searchMemories({ query: 'ZEBRA', project: 'p', scope: 'all' })
    expect(res[0].stale).toBe(true)
  })

  it('does not flag un-anchored memories as stale', async () => {
    await createMemory({ content: 'Plain fact keyword YETI no anchor', type: 'fact', tags: [], project: 'p', scope: 'project' })
    const res = await searchMemories({ query: 'YETI', project: 'p', scope: 'all' })
    expect(res[0].stale).toBe(false)
    expect(res[0].anchor_path).toBeNull()
  })

  it('anchor hash helpers behave', () => {
    const file = tmpFile('hello')
    const h1 = computeAnchorHash(file)
    expect(h1).toMatch(/^[0-9a-f]{16}$/)
    expect(isStale(file, h1)).toBe(false)
    fs.writeFileSync(file, 'changed')
    expect(isStale(file, h1)).toBe(true)
    expect(computeAnchorHash('/no/such/file/xyz')).toBe('MISSING')
  })
})

describe('living-memory: ROI ledger', () => {
  beforeEach(() => { openDb(tmpDb()) })
  afterEach(() => { closeDb() })

  it('credits tokens_saved on recall and tokens_spent on load', async () => {
    const r = await createMemory({ content: 'Deploy uses Docker Compose keyword QUARTZ', type: 'fact', tags: [], project: 'p', scope: 'project' })
    expect(getMemoryById(r.memory.id)!.tokens_saved).toBe(0)
    expect(getMemoryById(r.memory.id)!.tokens_spent).toBe(0)

    // Recall → tokens_saved grows by ~est*SAVE_FACTOR.
    await searchMemories({ query: 'QUARTZ', project: 'p', scope: 'all' })
    const afterRecall = getMemoryById(r.memory.id)!
    expect(afterRecall.tokens_saved).toBeGreaterThanOrEqual(estTokens(r.memory.content))
    expect(afterRecall.access_count).toBe(1)

    // Load (getRecentContext injects it) → tokens_spent grows.
    getRecentContext('p')
    expect(getMemoryById(r.memory.id)!.tokens_spent).toBeGreaterThan(0)

    const stats = getStats('p')
    expect(stats.tokensSaved).toBeGreaterThan(0)
    expect(stats.tokensSpent).toBeGreaterThan(0)
    expect(stats.netTokens).toBe(stats.tokensSaved - stats.tokensSpent)
  })

  it('getStats counts anchored + stale memories', async () => {
    const file = tmpFile('v1')
    await createMemory({ content: 'anchored fact keyword OPAL', type: 'fact', tags: [], project: 'p', scope: 'project', anchor: file })
    await createMemory({ content: 'plain fact no anchor', type: 'fact', tags: [], project: 'p', scope: 'project' })

    let stats = getStats('p')
    expect(stats.anchored).toBe(1)
    expect(stats.stale).toBe(0)

    fs.writeFileSync(file, 'v2-changed')
    stats = getStats('p')
    expect(stats.stale).toBe(1)
  })

  it('keeps/updates the anchor when a dedup-merge supplies one', async () => {
    const file = tmpFile('x')
    await createMemory({ content: 'Fact about widgets keyword MANGO', type: 'fact', tags: [], project: 'p', scope: 'project' })
    const r2 = await createMemory({ content: 'Fact about widgets keyword MANGO extended', type: 'fact', tags: [], project: 'p', scope: 'project', anchor: file })

    expect(r2.deduplicated).toBe(true)
    // Anchor supplied on the merging call must NOT be silently dropped.
    expect(getMemoryById(r2.memory.id)!.anchor_path).toBe(path.resolve(file))
  })

  it('prune evicts a pure-cost memory before a high-ROI one', async () => {
    // valuable: recalled repeatedly → high tokens_saved
    const valuable = await createMemory({ content: 'Valuable recalled fact keyword TOPAZ', type: 'fact', tags: [], project: 'p', scope: 'project', skipDedup: true })
    // deadweight: never recalled → net cost only
    const deadweight = await createMemory({ content: 'Never useful fact keyword NOBODY', type: 'fact', tags: [], project: 'p', scope: 'project', skipDedup: true })

    for (let i = 0; i < 3; i++) await searchMemories({ query: 'TOPAZ', project: 'p', scope: 'all' })

    // Force secondary eviction (total 2 > maxTotal 1). maxAge huge so primary delete never fires.
    const evicted = pruneMemories({ project: 'p', maxTotal: 1, maxAge: 10 ** 12, keepMinAccess: 0 })
    expect(evicted).toBeGreaterThanOrEqual(1)
    expect(getMemoryById(valuable.memory.id)).not.toBeNull()   // kept — high ROI
    expect(getMemoryById(deadweight.memory.id)).toBeNull()     // evicted — pure cost
  })
})

describe('living-memory: anchor is confined to the project root (security)', () => {
  beforeEach(() => { openDb(tmpDb()) })
  afterEach(() => { closeDb() })

  it('accepts an in-project anchor and rejects an out-of-project one', async () => {
    const handler = rememberHandler('p')

    // process.cwd() is the repo root during tests; package.json lives inside it.
    const ok = await handler({ content: 'in-project fact APPLE', type: 'fact', tags: [], scope: 'project', anchor: 'package.json' })
    expect(JSON.stringify(ok)).toContain('anchored to')

    // Absolute path outside the project must be rejected (no arbitrary file read).
    const bad = await handler({ content: 'out-of-project fact BANANA', type: 'fact', tags: [], scope: 'project', anchor: '/etc/passwd' })
    expect(JSON.stringify(bad)).toContain('anchor ignored')
  })
})
