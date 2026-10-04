// See no-embed.test.ts for why env is set before any dynamic import.
process.env.ENGRAM_NO_EMBED = '1'

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type * as DbModule from '../store/db.js'
import type * as StoreModule from '../store/memory-store.js'
import type * as SyncModule from '../sync-memory.js'

let openDb: typeof DbModule.openDb
let closeDb: typeof DbModule.closeDb
let getDb: typeof DbModule.getDb
let store: typeof StoreModule
let syncMemoryDir: typeof SyncModule.syncMemoryDir

beforeAll(async () => {
  const db = await import('../store/db.js')
  openDb = db.openDb
  closeDb = db.closeDb
  getDb = db.getDb
  store = await import('../store/memory-store.js')
  syncMemoryDir = (await import('../sync-memory.js')).syncMemoryDir
})

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function note(dir: string, file: string, type: string, desc: string, body: string) {
  fs.writeFileSync(path.join(dir, file),
    `---\nname: ${file.replace('.md', '')}\ndescription: "${desc}"\nmetadata:\n  type: ${type}\n---\n\n${body}\n`)
}

function ccRows(project = 'API') {
  return getDb().prepare(
    `SELECT id, content, type, tags, anchor_path FROM memories WHERE project = ? AND tags LIKE '%"cc-memory"%' ORDER BY anchor_path`
  ).all(project) as { id: string; content: string; type: string; tags: string; anchor_path: string }[]
}

describe('syncMemoryDir', () => {
  let memDir: string

  beforeEach(() => {
    openDb(path.join(tmp('engram-sync-db-'), 'test.db'))
    memDir = tmp('engram-sync-mem-')
    note(memDir, 'jxb_hero.md', 'project', 'Slider JXPass hero 1536x1216', 'Ruang atas ±25%.')
    note(memDir, 'jawab_indo.md', 'feedback', 'Jawab Bahasa Indonesia', 'Selalu Indonesia.')
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [x](jxb_hero.md) index only')
  })
  afterEach(() => closeDb())

  it('imports new files (MEMORY.md ignored) with mapped types, tags and anchor', async () => {
    const r = await syncMemoryDir(memDir, 'API')
    expect(r).toMatchObject({ added: 2, updated: 0, unchanged: 0, removed: 0 })
    const rows = ccRows()
    expect(rows).toHaveLength(2)
    const hero = rows.find(x => x.anchor_path.endsWith('jxb_hero.md'))!
    expect(hero.type).toBe('fact')
    expect(JSON.parse(hero.tags)).toEqual(['cc-memory', 'cc-memory:jxb_hero', 'cc-type:project'])
    expect(hero.content).toContain('Slider JXPass hero')
    expect(rows.find(x => x.anchor_path.endsWith('jawab_indo.md'))!.type).toBe('preference')
  })

  it('second run with no changes writes nothing (unchanged)', async () => {
    await syncMemoryDir(memDir, 'API')
    const before = ccRows().map(r => r.id)
    const r = await syncMemoryDir(memDir, 'API')
    expect(r).toMatchObject({ added: 0, updated: 0, unchanged: 2, removed: 0 })
    expect(ccRows().map(r => r.id)).toEqual(before)
  })

  it('a changed file updates its copy in place (same id, new content)', async () => {
    await syncMemoryDir(memDir, 'API')
    const id = ccRows().find(x => x.anchor_path.endsWith('jxb_hero.md'))!.id
    note(memDir, 'jxb_hero.md', 'project', 'Slider JXPass hero 1536x1216', 'Ruang atas sekarang 30%.')
    const r = await syncMemoryDir(memDir, 'API')
    expect(r).toMatchObject({ added: 0, updated: 1, unchanged: 1 })
    const row = ccRows().find(x => x.anchor_path.endsWith('jxb_hero.md'))!
    expect(row.id).toBe(id)
    expect(row.content).toContain('30%')
  })

  it('a deleted file removes only its cc-memory copy — never model-written memories', async () => {
    await syncMemoryDir(memDir, 'API')
    await store.createMemory({ content: 'model wrote this', type: 'fact', tags: [], project: 'API', scope: 'project', skipDedup: true })
    fs.unlinkSync(path.join(memDir, 'jawab_indo.md'))
    const r = await syncMemoryDir(memDir, 'API')
    expect(r.removed).toBe(1)
    expect(ccRows()).toHaveLength(1)
    const all = getDb().prepare('SELECT content FROM memories WHERE project = ?').all('API') as { content: string }[]
    expect(all.map(x => x.content)).toContain('model wrote this')
  })

  it('does not delete copies that came from a DIFFERENT memory folder of the same project', async () => {
    const other = tmp('engram-sync-other-')
    note(other, 'other.md', 'project', 'Dari folder lain', 'x')
    await syncMemoryDir(other, 'API')
    await syncMemoryDir(memDir, 'API')
    expect(ccRows()).toHaveLength(3)
  })

  it('copies are recallable by keyword and survive prune', async () => {
    await syncMemoryDir(memDir, 'API')
    const hits = await store.searchMemories({ query: 'JXPass hero', project: 'API' })
    expect(hits[0]?.content).toContain('JXPass hero')
    expect(hits[0]?.stale).toBe(false)
    getDb().prepare('UPDATE memories SET created_at = 0, access_count = 0').run()
    store.pruneMemories({ project: 'API', maxTotal: 0 })
    expect(ccRows()).toHaveLength(2)
  })
})

describe('mergeProject', () => {
  beforeEach(() => openDb(path.join(tmp('engram-merge-'), 'test.db')))
  afterEach(() => closeDb())

  it('moves memories and sessions from one key to another', async () => {
    await store.createMemory({ content: 'order fact', type: 'fact', tags: [], project: 'order-service', scope: 'project', skipDedup: true })
    store.createSession({ project: 'order-service', summary: 's1', started_at: Date.now() })
    store.createSession({ project: 'dashboard-hms', summary: 's2', started_at: Date.now() })
    expect(store.mergeProject('order-service', 'API')).toEqual({ memories: 1, sessions: 1 })
    expect(store.mergeProject('dashboard-hms', 'API')).toEqual({ memories: 0, sessions: 1 })
    expect(store.listSessions('API')).toHaveLength(2)
    expect(store.listSessions('order-service')).toHaveLength(0)
  })

  it('is a no-op for identical or empty keys', () => {
    expect(store.mergeProject('API', 'API')).toEqual({ memories: 0, sessions: 0 })
    expect(store.mergeProject('', 'API')).toEqual({ memories: 0, sessions: 0 })
  })
})
