// `init` diuji HANYA terhadap HOME sementara berisi tiruan config nyata —
// tidak pernah terhadap HOME pengguna.
import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { runInitSteps, upsertMarkedBlock, upsertCodexToml, upsertJsonEntry, type StepResult } from '../init.js'
import { RULES_BLOCK, RULES_START, RULES_END } from '../instructions.js'

const NODE = '/opt/node/bin/node'
const INDEX = '/opt/engram/build/index.js'

let home: string
const p = (...s: string[]) => path.join(home, ...s)
const read = (...s: string[]) => fs.readFileSync(p(...s), 'utf8')
const json = (...s: string[]) => JSON.parse(read(...s))
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true })
  fs.writeFileSync(p(rel), content)
}
const run = () => runInitSteps({ home, nodePath: NODE, indexPath: INDEX })
const byClient = (rs: StepResult[], c: string) => rs.filter(r => r.client === c)

const CODEX_TOML = `model = "gpt-x"
# komentar penting — jangan hilang

[projects."/Users/me/My Repo"]
trust_level = "trusted"

[mcp_servers.node_repl]
args = []
command = "/x/node_repl"

[mcp_servers.node_repl.env]
FOO = "1"
`

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-home-'))
  // Claude Code: ~/.claude.json (tanpa newline akhir, indent 2) + settings dgn hook lain
  write('.claude.json', JSON.stringify({ numStartups: 5, projects: { '/a': { x: 1 } }, mcpServers: {} }, null, 2))
  write('.claude/settings.json', JSON.stringify({
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
      SessionEnd: [
        { hooks: [{ type: 'command', command: 'echo other-session-end' }] },
        // alat lain dengan akhiran perintah yang sama — bukan milik Engram
        { hooks: [{ type: 'command', command: '"/other/tool.js" capture --project .' }] },
      ],
    },
  }, null, 2) + '\n')
  write('Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({ mcpServers: { cacheai: { command: 'n', args: [] } } }, null, 2))
  write('.codex/config.toml', CODEX_TOML)
  write('.cursor/mcp.json', '{\n  "mcpServers": {}\n}')
  // Antigravity: berkas kosong 0 byte + symlink seperti di mesin nyata
  write('.gemini/config/mcp_config.json', '')
  fs.mkdirSync(p('.gemini/antigravity'), { recursive: true })
  fs.symlinkSync(p('.gemini/config/mcp_config.json'), p('.gemini/antigravity/mcp_config.json'))
  write('.gemini/antigravity-ide/mcp_config.json', '')
  write('.gemini/GEMINI.md', 'always allow')
  // OpenCode: entri format lama yang salah (command string + args) + kunci lain
  write('.config/opencode/opencode.json', JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { x: { npm: 'y' } },
    mcp: { engram: { type: 'local', command: 'old-node', args: ['old.js'], environment: { A: '1' } } },
  }, null, 2))
})

describe('runInitSteps — first run', () => {
  it('registers engram in every installed client in its own format', () => {
    const rs = run()
    expect(rs.filter(r => r.status === 'error')).toEqual([])

    expect(json('.claude.json').mcpServers.engram).toEqual({ command: NODE, args: [INDEX, '--project', '.'] })
    expect(json('.claude.json').numStartups).toBe(5)
    expect(json('Library/Application Support/Claude/claude_desktop_config.json').mcpServers).toHaveProperty('cacheai')
    expect(json('.cursor/mcp.json').mcpServers.engram.command).toBe(NODE)
    expect(json('.gemini/config/mcp_config.json').mcpServers.engram.args[0]).toBe(INDEX)
    expect(json('.gemini/antigravity-ide/mcp_config.json').mcpServers.engram.command).toBe(NODE)

    const oc = json('.config/opencode/opencode.json')
    expect(oc.mcp.engram).toEqual({ type: 'local', command: [NODE, INDEX, '--project', '.'], enabled: true, environment: { A: '1' } })
    expect(oc.provider).toEqual({ x: { npm: 'y' } })

    const toml = read('.codex/config.toml')
    expect(toml.startsWith(CODEX_TOML)).toBe(true) // isi lama utuh, termasuk komentar
    expect(toml).toContain(`[mcp_servers.engram]\ncommand = "${NODE}"\nargs = ["${INDEX}", "--project", "."]\n`)

    expect(read('.codex/AGENTS.md')).toBe(RULES_BLOCK + '\n')
    expect(read('.gemini/GEMINI.md')).toBe('always allow\n\n' + RULES_BLOCK + '\n')
  })

  it('keeps the Antigravity symlink a symlink (writes through it)', () => {
    run()
    expect(fs.lstatSync(p('.gemini/antigravity/mcp_config.json')).isSymbolicLink()).toBe(true)
    expect(byClient(run(), 'antigravity (antigravity)')[0].status).toBe('unchanged')
  })

  it('installs Engram hooks for SessionStart/PreCompact/SessionEnd/Stop without touching other hooks', () => {
    run()
    const s = json('.claude/settings.json')
    expect(s.model).toBe('opus')
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }])
    const cmds = (ev: string) => s.hooks[ev].flatMap((g: any) => g.hooks.map((h: any) => h.command))
    const ours = (verb: string) => `"${NODE}" "${INDEX}" ${verb} --project .`
    expect(cmds('SessionStart')).toEqual([ours('load')])
    expect(cmds('PreCompact')).toEqual([ours('capture'), ours('sync-memory')])
    expect(cmds('SessionEnd')).toEqual(['echo other-session-end', '"/other/tool.js" capture --project .', ours('capture'), ours('sync-memory')])
    expect(cmds('Stop')).toEqual([ours('sync-memory')])
  })

  it('backs up every pre-existing file it modified to <file>.bak-engram', () => {
    const before = read('.claude.json')
    const rs = run()
    expect(read('.claude.json.bak-engram')).toBe(before)
    expect(fs.readFileSync(p('.gemini/config/mcp_config.json.bak-engram'), 'utf8')).toBe('')
    expect(read('.codex/config.toml.bak-engram')).toBe(CODEX_TOML)
    expect(read('.gemini/GEMINI.md.bak-engram')).toBe('always allow')
    expect(fs.existsSync(p('.codex/AGENTS.md.bak-engram'))).toBe(false) // berkas baru → tak ada yg dicadangkan
    for (const r of rs.filter(r => r.status === 'updated' || r.status === 'added')) {
      if (r.client !== 'claude-skill' && r.client !== 'codex-rules') expect(r.backup).toBeTruthy()
    }
  })
})

describe('runInitSteps — idempotent', () => {
  it('second run changes nothing (every step unchanged/skipped, files byte-identical)', () => {
    run()
    const files = ['.claude.json', '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md',
      '.cursor/mcp.json', '.gemini/config/mcp_config.json', '.gemini/GEMINI.md', '.config/opencode/opencode.json']
    const snap = files.map(f => read(f))
    const rs = run()
    expect(rs.filter(r => r.status !== 'unchanged' && r.status !== 'skipped')).toEqual([])
    expect(files.map(f => read(f))).toEqual(snap)
  })

  it('refreshes a stale node path in place instead of duplicating', () => {
    run()
    const rs = runInitSteps({ home, nodePath: '/new/node', indexPath: INDEX })
    expect(byClient(rs, 'claude-code-hooks')[0].status).toBe('updated')
    const s = json('.claude/settings.json')
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.SessionEnd).toHaveLength(4)
    expect(s.hooks.Stop[0].hooks[0].command).toContain('/new/node')
    expect(read('.codex/config.toml').match(/\[mcp_servers\.engram\]/g)).toHaveLength(1)
    expect(read('.codex/config.toml')).toContain('command = "/new/node"')
  })
})

describe('runInitSteps — only installed clients, never clobber', () => {
  it('skips clients that are not installed and creates nothing for them', () => {
    fs.rmSync(p('.codex'), { recursive: true })
    fs.rmSync(p('.cursor'), { recursive: true })
    fs.rmSync(p('.config'), { recursive: true })
    const rs = run()
    expect(byClient(rs, 'codex')[0].status).toBe('skipped')
    expect(byClient(rs, 'cursor')[0].status).toBe('skipped')
    expect(byClient(rs, 'opencode')[0].status).toBe('skipped')
    expect(byClient(rs, 'gemini-cli')[0].status).toBe('skipped') // tak ada settings.json
    expect(fs.existsSync(p('.codex'))).toBe(false)
    expect(fs.existsSync(p('.gemini/settings.json'))).toBe(false)
  })

  it('reports invalid JSON as an error and leaves the file untouched', () => {
    write('.cursor/mcp.json', '{ broken')
    const rs = run()
    expect(byClient(rs, 'cursor')[0].status).toBe('error')
    expect(read('.cursor/mcp.json')).toBe('{ broken')
  })

  it('registers in Gemini CLI settings.json when it exists', () => {
    write('.gemini/settings.json', '{\n  "theme": "dark"\n}\n')
    run()
    expect(json('.gemini/settings.json')).toEqual({ theme: 'dark', mcpServers: { engram: { command: NODE, args: [INDEX, '--project', '.'] } } })
  })
})

describe('upsertMarkedBlock', () => {
  it('replaces an existing block in place and leaves surrounding text alone', () => {
    const f = p('AGENTS.md')
    fs.writeFileSync(f, `# Mine\n\nbefore\n\n${RULES_START}\nOLD\n${RULES_END}\n\nafter\n`)
    expect(upsertMarkedBlock('t', f, RULES_BLOCK, true).status).toBe('updated')
    expect(fs.readFileSync(f, 'utf8')).toBe(`# Mine\n\nbefore\n\n${RULES_BLOCK}\n\nafter\n`)
    expect(upsertMarkedBlock('t', f, RULES_BLOCK, true).status).toBe('unchanged')
  })

  it('refuses to touch a file with a start marker but no end marker', () => {
    const f = p('AGENTS.md')
    fs.writeFileSync(f, `x\n${RULES_START}\nuser content\n`)
    expect(upsertMarkedBlock('t', f, RULES_BLOCK, true).status).toBe('error')
    expect(fs.readFileSync(f, 'utf8')).toBe(`x\n${RULES_START}\nuser content\n`)
  })
})

describe('upsertCodexToml', () => {
  it('replaces command/args (incl. multi-line args) but keeps other keys of the table', () => {
    const f = p('c.toml')
    fs.writeFileSync(f, `[mcp_servers.engram]\nstartup_timeout_sec = 30\ncommand = "old"\nargs = [\n  "a",\n  "b",\n]\n\n[other]\nk = 1\n`)
    expect(upsertCodexToml(f, 'engram', NODE, [INDEX], false).status).toBe('updated')
    expect(fs.readFileSync(f, 'utf8')).toBe(`[mcp_servers.engram]\ncommand = "${NODE}"\nargs = ["${INDEX}"]\nstartup_timeout_sec = 30\n\n[other]\nk = 1\n`)
    expect(upsertCodexToml(f, 'engram', NODE, [INDEX], false).status).toBe('unchanged')
  })
})

describe('upsertJsonEntry', () => {
  it('keeps file mode (0600 like ~/.claude.json), indentation and missing trailing newline', () => {
    const f = p('secret.json')
    fs.writeFileSync(f, '{\n    "a": 1\n}', { mode: 0o600 })
    fs.chmodSync(f, 0o600)
    upsertJsonEntry({ client: 't', file: f, keyPath: ['mcpServers'], name: 'engram', entry: { command: 'n' }, create: false })
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    expect(fs.statSync(`${f}.bak-engram`).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(f, 'utf8')).toBe('{\n    "a": 1,\n    "mcpServers": {\n        "engram": {\n            "command": "n"\n        }\n    }\n}')
  })
})
