// See no-embed.test.ts for why env is set before any dynamic import.
process.env.ENGRAM_NO_EMBED = '1'

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type * as CaptureModule from '../capture.js'
import type * as DbModule from '../store/db.js'
import type * as StoreModule from '../store/memory-store.js'

let cap: typeof CaptureModule
let openDb: typeof DbModule.openDb
let closeDb: typeof DbModule.closeDb
let listSessions: typeof StoreModule.listSessions

beforeAll(async () => {
  cap = await import('../capture.js')
  const db = await import('../store/db.js')
  openDb = db.openDb
  closeDb = db.closeDb
  listSessions = (await import('../store/memory-store.js')).listSessions
})

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] }, ...extra })

describe('commitMessage', () => {
  const cm = (c: string, cwd?: string) => cap.commitMessage(c, cwd)

  it('returns null for non-commit git commands', () => {
    expect(cm('git status')).toBeNull()
    expect(cm('git log --grep commit')).toBeNull()
    expect(cm('npm test')).toBeNull()
  })

  it('reads -m / -am / --message= with either quote style', () => {
    expect(cm('git commit -m "feat: a"')).toBe('feat: a')
    expect(cm("git add . && git commit -am 'fix: b'")).toBe('fix: b')
    expect(cm('git commit --message="docs: c"')).toBe('docs: c')
    expect(cm('git -C /repo commit -m "chore: d"')).toBe('chore: d')
    expect(cm('git commit -m "say \\"hi\\""')).toBe('say "hi"')
  })

  it('with multiple -m takes the first one as the subject', () => {
    expect(cm('git commit -m "feat: subject" -m "body paragraph"')).toBe('feat: subject')
    expect(cm(`git commit -m 'feat: s2' -m "b"`)).toBe('feat: s2')
  })

  it('reads -m "$(cat <<\'EOF\' … EOF)" (Claude Code style)', () => {
    const c = `git commit -m "$(cat <<'EOF'\nfeat(cms): slider JXPass 1536×1216\n\nBody with "quotes" and -m text\nEOF\n)"`
    expect(cm(c)).toBe('feat(cms): slider JXPass 1536×1216')
  })

  it('reads -F - with a heredoc (first line after the marker)', () => {
    const c = `git commit -q -F - <<'EOF'\n\nfix: offset anti-duplikat\n\nmore -m lines\nEOF`
    expect(cm(c)).toBe('fix: offset anti-duplikat')
    expect(cm(`git commit --file=- <<EOF\nperf: x\nEOF`)).toBe('perf: x')
  })

  it('reads -F <file> relative to cwd, skipping # comments; "(commit)" when missing', () => {
    const dir = tmp('engram-commitmsg-')
    fs.writeFileSync(path.join(dir, 'msg.txt'), '# comment\n\nrefactor: dari berkas\nbody\n')
    expect(cm('git commit -F msg.txt', dir)).toBe('refactor: dari berkas')
    expect(cm(`git commit -F ${path.join(dir, 'msg.txt')}`)).toBe('refactor: dari berkas')
    expect(cm('git commit -F /no/such/file.txt')).toBe('(commit)')
  })

  it('falls back to "(commit)" when the message is unknowable', () => {
    expect(cm('git commit --amend --no-edit')).toBe('(commit)')
  })

  it('does not mistake "-m" inside a heredoc body for an option', () => {
    const c = `git commit -F - <<'EOF'\nfeat: real subject\n\nuse -m "fake"\nEOF`
    expect(cm(c)).toBe('feat: real subject')
  })
})

describe('human requests: first AND last, skipping harness messages', () => {
  it('records the last human request and skips compact summaries, reminders and <command-…>', () => {
    const t = [
      user('first ask'),
      tool('Edit', { file_path: '/r/a.ts' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
      user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
      user('This session is being continued from a previous conversation …'), // even without the flag
      user([{ type: 'text', text: '<system-reminder>noise</system-reminder>' }]),
      user('<command-name>/model</command-name>\n<command-args></command-args>'),
      user('<local-command-stdout>Set model</local-command-stdout>'),
      user('meta skill text', { isMeta: true }),
      user([{ type: 'tool_result', content: 'ok' }]),
      user([{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'the latest ask' }]),
      user('[Request interrupted by user]'),
    ].join('\n')
    const f = cap.parseTranscript(t)
    expect(f.firstRequest).toBe('first ask')
    expect(f.lastRequest).toBe('the latest ask')
    expect(cap.buildDigest(f)).toContain('first ask → terakhir: the latest ask')
  })

  it('skips isCompactSummary messages even when the text has no known prefix', () => {
    const t = [
      user('Ringkasan percakapan sebelumnya: banyak hal dikerjakan.', { isCompactSummary: true }),
      user('real ask'),
      tool('Edit', { file_path: '/r/x.ts' }),
    ].join('\n')
    expect(cap.parseTranscript(t).firstRequest).toBe('real ask')
  })

  it('a segment that starts with a compact summary uses the next real request as first', () => {
    const t = [
      user('This session is being continued from a previous conversation. Summary: …', { isCompactSummary: true }),
      user('continue with the tests'),
      tool('Write', { file_path: '/r/t.test.ts' }),
    ].join('\n')
    const f = cap.parseTranscript(t)
    expect(f.firstRequest).toBe('continue with the tests')
    expect(f.lastRequest).toBe('')
  })
})

describe('runCapture: PreCompact repeated → no duplicate writes', () => {
  let dir: string
  let tPath: string

  beforeEach(() => {
    dir = tmp('engram-capseg-')
    openDb(path.join(dir, 'test.db'))
    tPath = path.join(dir, 'session.jsonl')
  })
  afterEach(() => closeDb())

  it('captures each transcript segment once across PreCompact, PreCompact, SessionEnd', () => {
    fs.writeFileSync(tPath, [user('part one'), tool('Edit', { file_path: '/r/a.ts' })].join('\n') + '\n')
    cap.runCapture('p', { transcript_path: tPath }) // PreCompact #1
    cap.runCapture('p', { transcript_path: tPath }) // PreCompact again, nothing new
    expect(listSessions('p')).toHaveLength(1)

    // Same edit pattern again later (identical digest text would also be deduped,
    // so use a distinct segment to prove the offset — not the text dedupe — works).
    fs.appendFileSync(tPath, [user('part two'), tool('Edit', { file_path: '/r/b.ts' })].join('\n') + '\n')
    cap.runCapture('p', { transcript_path: tPath }) // SessionEnd
    const s = listSessions('p') as Array<{ summary: string }>
    expect(s).toHaveLength(2)
    expect(s.map(x => x.summary).join('\n')).toContain('part two — edited 1 file(s): b.ts')
    expect(s.some(x => x.summary.includes('a.ts') && x.summary.includes('b.ts'))).toBe(false)
  })

  it('re-running on an unchanged transcript after the same segment repeats does not duplicate', () => {
    const seg = [user('same'), tool('Edit', { file_path: '/r/a.ts' })].join('\n') + '\n'
    fs.writeFileSync(tPath, seg)
    cap.runCapture('p', { transcript_path: tPath })
    fs.appendFileSync(tPath, seg) // identical new segment → identical digest → text dedupe
    cap.runCapture('p', { transcript_path: tPath })
    expect(listSessions('p')).toHaveLength(1)
  })

  it('defers a half-written last line to the next capture', () => {
    const full = tool('Edit', { file_path: '/r/late.ts' })
    fs.writeFileSync(tPath, user('ask') + '\n' + full.slice(0, 20))
    const seg1 = cap.readNewSegment(tPath, 0)
    expect(seg1.text).toBe(user('ask') + '\n')
    fs.writeFileSync(tPath, user('ask') + '\n' + full) // finished, no trailing newline (end of session)
    const seg2 = cap.readNewSegment(tPath, seg1.end)
    expect(seg2.text).toBe(full)
    expect(seg2.end).toBe(fs.statSync(tPath).size)
  })

  it('restarts from 0 if the transcript shrank (rotated/replaced)', () => {
    fs.writeFileSync(tPath, user('x') + '\n')
    expect(cap.readNewSegment(tPath, 10_000).text).toBe(user('x') + '\n')
  })

  it('never throws on missing payload / missing file', () => {
    expect(() => cap.runCapture('p', null)).not.toThrow()
    expect(() => cap.runCapture('p', { transcript_path: path.join(dir, 'nope.jsonl') })).not.toThrow()
  })
})
