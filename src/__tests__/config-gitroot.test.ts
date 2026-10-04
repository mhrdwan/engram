import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { findGitRoot, resolveConfig } from '../config.js'

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-git-')))
}

describe('project key from git root', () => {
  const savedProject = process.env.ENGRAM_PROJECT
  const savedDb = process.env.ENGRAM_DB
  afterEach(() => {
    if (savedProject === undefined) delete process.env.ENGRAM_PROJECT
    else process.env.ENGRAM_PROJECT = savedProject
    if (savedDb === undefined) delete process.env.ENGRAM_DB
    else process.env.ENGRAM_DB = savedDb
  })

  it('finds the repo root from a nested subfolder (.git dir or .git file)', () => {
    const root = path.join(tmp(), 'API')
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    const sub = path.join(root, 'order-service', 'src')
    fs.mkdirSync(sub, { recursive: true })
    expect(findGitRoot(sub)).toBe(root)

    const wt = path.join(tmp(), 'worktree')
    fs.mkdirSync(wt)
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere')
    expect(findGitRoot(wt)).toBe(wt)
  })

  it('returns null outside any repo', () => {
    expect(findGitRoot(tmp())).toBeNull()
  })

  it('resolveConfig uses the git-root basename; ENGRAM_PROJECT still wins', () => {
    delete process.env.ENGRAM_PROJECT
    process.env.ENGRAM_DB = path.join(tmp(), 'x.db')
    const root = path.join(tmp(), 'API')
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dashboard-hms'))

    const c = resolveConfig(path.join(root, 'dashboard-hms'))
    expect(c.projectKey).toBe('API')
    expect(c.projectDir).toBe(path.join(root, 'dashboard-hms')) // legacy DB lookup stays local

    process.env.ENGRAM_PROJECT = 'custom'
    expect(resolveConfig(path.join(root, 'dashboard-hms')).projectKey).toBe('custom')
  })

  it('outside a repo falls back to the folder basename', () => {
    delete process.env.ENGRAM_PROJECT
    process.env.ENGRAM_DB = path.join(tmp(), 'x.db')
    const d = path.join(tmp(), 'plainfolder')
    fs.mkdirSync(d)
    expect(resolveConfig(d).projectKey).toBe('plainfolder')
  })
})
