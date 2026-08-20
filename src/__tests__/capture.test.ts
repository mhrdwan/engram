// See no-embed.test.ts for why env is set before any dynamic import.
process.env.ENGRAM_NO_EMBED = '1'

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type * as CaptureModule from '../capture.js'
import type * as DbModule from '../store/db.js'
import type * as StoreModule from '../store/memory-store.js'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-capture-'))
  return path.join(dir, 'test.db')
}

// A realistic Claude Code transcript (JSONL): a request, edits, commands, commit.
const TRANSCRIPT = [
  { type: 'user', message: { role: 'user', content: 'add auto-save capture feature' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'ok, building it' },
    { type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/capture.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/index.ts' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/capture.ts' } }, // dup file
    { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "feat: capture"' } },
  ] } },
].map(o => JSON.stringify(o)).join('\n')

let parseTranscript: typeof CaptureModule.parseTranscript
let buildDigest: typeof CaptureModule.buildDigest
let openDb: typeof DbModule.openDb
let closeDb: typeof DbModule.closeDb
let createSession: typeof StoreModule.createSession
let getRecentContext: typeof StoreModule.getRecentContext

beforeAll(async () => {
  const cap = await import('../capture.js')
  const db = await import('../store/db.js')
  const store = await import('../store/memory-store.js')
  parseTranscript = cap.parseTranscript
  buildDigest = cap.buildDigest
  openDb = db.openDb
  closeDb = db.closeDb
  createSession = store.createSession
  getRecentContext = store.getRecentContext
})

describe('capture.parseTranscript', () => {
  it('extracts edited files (deduped, basename), commands, commits, first request', () => {
    const f = parseTranscript(TRANSCRIPT)
    expect(f.firstRequest).toBe('add auto-save capture feature')
    expect(f.editedFiles).toEqual(['capture.ts', 'index.ts']) // deduped, order preserved
    expect(f.commandCount).toBe(2)
    expect(f.commits).toEqual(['feat: capture'])
  })

  it('ignores tool_result user echoes when picking the first request', () => {
    const t = [
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }] } },
      { type: 'user', message: { role: 'user', content: 'the real ask' } },
    ].map(o => JSON.stringify(o)).join('\n')
    expect(parseTranscript(t).firstRequest).toBe('the real ask')
  })

  it('survives malformed lines without throwing', () => {
    const t = 'not json\n{"broken":\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })
    expect(() => parseTranscript(t)).not.toThrow()
    expect(parseTranscript(t).firstRequest).toBe('hi')
  })
})

describe('capture.buildDigest', () => {
  it('returns null when nothing was changed (pure Q&A) — stays token-frugal', () => {
    const digest = buildDigest({ firstRequest: 'what is a monad?', editedFiles: [], commandCount: 3, commits: [] })
    expect(digest).toBeNull()
  })

  it('builds a compact [auto] digest when files changed', () => {
    const digest = buildDigest(parseTranscript(TRANSCRIPT))
    expect(digest).toContain('[auto]')
    expect(digest).toContain('edited 2 file(s): capture.ts, index.ts')
    expect(digest).toContain('commits: feat: capture')
    expect(digest!.length).toBeLessThanOrEqual(400)
  })

  it('caps the file list and reports the overflow count', () => {
    const many = Array.from({ length: 9 }, (_, i) => `f${i}.ts`)
    const digest = buildDigest({ firstRequest: '', editedFiles: many, commandCount: 0, commits: [] })
    expect(digest).toContain('edited 9 file(s)')
    expect(digest).toContain('+4 more')
  })
})

describe('capture → store integration', () => {
  beforeEach(() => openDb(tmpDb()))
  afterEach(() => closeDb())

  it('a captured digest surfaces as the "Last session" on next load', () => {
    const digest = buildDigest(parseTranscript(TRANSCRIPT))!
    createSession({ project: 'p', summary: digest, started_at: Date.now() })
    const ctx = getRecentContext('p')
    expect(ctx).toContain('Last session:')
    expect(ctx).toContain('[auto]')
  })
})
