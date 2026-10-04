import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  claudeProjectSlug, findMemoryDir, parseFrontmatter, readMemoryFile, listMemoryFiles,
  memoryDirSignature, isUnchangedSinceLastSync, recordSync, mapCcType,
} from '../cc-memory.js'

function tmp(prefix = 'engram-ccmem-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('claudeProjectSlug', () => {
  it('matches real Claude Code folder names (every non-alphanumeric → "-")', () => {
    expect(claudeProjectSlug('/Users/apple/Ridwan World/Kerjaan/JXB/API')).toBe('-Users-apple-Ridwan-World-Kerjaan-JXB-API')
    expect(claudeProjectSlug('/Users/apple/.claudegauge-probe')).toBe('-Users-apple--claudegauge-probe')
    expect(claudeProjectSlug('/Users/apple/Ridwan World/Kerjaan/JXB/My Drive/Source Code/MOBILE'))
      .toBe('-Users-apple-Ridwan-World-Kerjaan-JXB-My-Drive-Source-Code-MOBILE')
    expect(claudeProjectSlug('/a/b_c.d')).toBe('-a-b-c-d')
  })
})

describe('findMemoryDir', () => {
  it('prefers dirname(transcript_path)/memory over slug candidates', () => {
    const claudeDir = tmp()
    const sessDir = path.join(claudeDir, 'projects', '-x-session')
    fs.mkdirSync(path.join(sessDir, 'memory'), { recursive: true })
    const slugDir = path.join(claudeDir, 'projects', claudeProjectSlug('/repo/api'), 'memory')
    fs.mkdirSync(slugDir, { recursive: true })

    expect(findMemoryDir({ transcriptPath: path.join(sessDir, 'abc.jsonl'), candidates: ['/repo/api'], claudeDir }))
      .toBe(path.join(sessDir, 'memory'))
  })

  it('falls back to the first candidate whose slug folder exists (e.g. git root)', () => {
    const claudeDir = tmp()
    const gitRootMem = path.join(claudeDir, 'projects', claudeProjectSlug('/repo/api'), 'memory')
    fs.mkdirSync(gitRootMem, { recursive: true })
    expect(findMemoryDir({
      transcriptPath: path.join(claudeDir, 'nope', 't.jsonl'),
      candidates: [undefined, '/repo/api/order-service', '/repo/api'],
      claudeDir,
    })).toBe(gitRootMem)
  })

  it('returns null when nothing exists', () => {
    expect(findMemoryDir({ candidates: ['/definitely/not/here'], claudeDir: tmp() })).toBeNull()
  })
})

describe('parseFrontmatter / readMemoryFile', () => {
  it('reads nested metadata.type and an escaped double-quoted description', () => {
    const { fm, body } = parseFrontmatter([
      '---',
      'name: jxb-auth-tahan-restart',
      'description: "Deploy me-logout — 310 \\"Invalid Token\\" untuk koneksi gagal"',
      'metadata:',
      '  node_type: memory',
      '  type: project',
      '---',
      '',
      'Badan catatan.',
    ].join('\n'))
    expect(fm.name).toBe('jxb-auth-tahan-restart')
    expect(fm.description).toBe('Deploy me-logout — 310 "Invalid Token" untuk koneksi gagal')
    expect(fm.metadata).toEqual({ node_type: 'memory', type: 'project' })
    expect(body.trim()).toBe('Badan catatan.')
  })

  it('accepts top-level `type:`, unquoted values and block scalars', () => {
    const { fm } = parseFrontmatter('---\nname: X model\ntype: feedback\ndescription: >\n  baris satu\n  baris dua\n---\nbody')
    expect(fm.type).toBe('feedback')
    expect(fm.description).toBe('baris satu baris dua')
  })

  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseFrontmatter('just text').body).toBe('just text')
  })

  it('maps Claude Code types: user/feedback→preference, project/reference→fact', () => {
    expect(mapCcType('user')).toBe('preference')
    expect(mapCcType('feedback')).toBe('preference')
    expect(mapCcType('project')).toBe('fact')
    expect(mapCcType('reference')).toBe('fact')
    expect(mapCcType('weird')).toBe('fact')
  })

  it('builds content = name — description + body, keyed by file basename', () => {
    const dir = tmp()
    const f = path.join(dir, 'jawab_bahasa.md')
    fs.writeFileSync(f, '---\nname: jawab_bahasa\ndescription: "Jawab Indonesia"\nmetadata:\n  type: feedback\n---\n\nSelalu Indonesia.\n')
    const m = readMemoryFile(f)!
    expect(m.key).toBe('jawab_bahasa')
    expect(m.type).toBe('preference')
    expect(m.content).toBe('jawab_bahasa — Jawab Indonesia\n\nSelalu Indonesia.')
  })
})

describe('listMemoryFiles / signature / sync state', () => {
  it('ignores MEMORY.md and non-.md files', () => {
    const dir = tmp()
    for (const n of ['MEMORY.md', 'a.md', 'b.md', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x')
    expect(listMemoryFiles(dir).map(f => path.basename(f))).toEqual(['a.md', 'b.md'])
  })

  it('signature changes when a file is edited, added or removed — but not for MEMORY.md', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'one')
    const s1 = memoryDirSignature(dir)
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'index changed')
    expect(memoryDirSignature(dir)).toBe(s1)
    fs.writeFileSync(path.join(dir, 'a.md'), 'one plus more')
    const s2 = memoryDirSignature(dir)
    expect(s2).not.toBe(s1)
    fs.writeFileSync(path.join(dir, 'b.md'), 'two')
    expect(memoryDirSignature(dir)).not.toBe(s2)
  })

  it('records and checks the last successful sync per (project, dir)', () => {
    const state = path.join(tmp(), 'state.json')
    expect(isUnchangedSinceLastSync(state, '/m', 'API', 'sig1')).toBe(false)
    recordSync(state, '/m', 'API', 'sig1')
    expect(isUnchangedSinceLastSync(state, '/m', 'API', 'sig1')).toBe(true)
    expect(isUnchangedSinceLastSync(state, '/m', 'API', 'sig2')).toBe(false)
    expect(isUnchangedSinceLastSync(state, '/m', 'OTHER', 'sig1')).toBe(false)
  })
})
