// `engram init`: daftarkan server MCP Engram + hook + aturan ke klien AI yang
// TERPASANG di mesin ini. Semua langkah idempoten (tidak menulis bila sudah
// sesuai), mencadangkan berkas ke `<berkas>.bak-engram` sebelum menulis, menulis
// atomik (berkas sementara + rename, mengikuti symlink), dan tidak pernah
// menyentuh isi lain di berkas config. `home` adalah parameter supaya bisa diuji
// terhadap HOME sementara.
import fs from 'node:fs'
import path from 'node:path'
import { RULES_BLOCK, RULES_START, RULES_END } from './instructions.js'

export type StepStatus = 'added' | 'updated' | 'unchanged' | 'skipped' | 'error'

export interface StepResult {
  client: string
  file: string
  status: StepStatus
  note?: string
  backup?: string
}

export interface InitOptions {
  home: string
  nodePath: string
  indexPath: string
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ─── TULIS AMAN ───────────────────────────────────────────────────────────────

function realTarget(file: string): string {
  try { return fs.realpathSync(file) } catch { return file }
}

/** Tulis atomik: berkas sementara di folder yang sama lalu rename. Ikuti symlink, pertahankan mode. */
export function atomicWrite(file: string, content: string): void {
  const target = realTarget(file)
  let mode: number | undefined
  try { mode = fs.statSync(target).mode & 0o777 } catch { /* berkas baru */ }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.engram-${process.pid}-${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, content, { mode: mode ?? 0o644 })
    if (mode !== undefined) fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* abaikan */ }
    throw e
  }
}

/** Cadangkan isi lama (bila ada) ke `<real>.bak-engram`, lalu tulis atomik. Return path cadangan. */
function backupAndWrite(file: string, oldText: string | null, newText: string): string | undefined {
  let backup: string | undefined
  if (oldText !== null) {
    const real = realTarget(file)
    backup = `${real}.bak-engram`
    let mode = 0o600
    try { mode = fs.statSync(real).mode & 0o777 } catch { /* default */ }
    fs.writeFileSync(backup, oldText, { mode })
  }
  atomicWrite(file, newText)
  return backup
}

function readOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

function detectIndent(text: string): string | number {
  const m = text.match(/\n([ \t]+)"/)
  return m ? m[1] : 2
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/**
 * Upsert `obj[...keyPath][name] = entry` di berkas JSON. Kunci lain di entri lama
 * dipertahankan (mis. `env`), kecuali yang disebut `drop`. Berkas tidak sah →
 * error & TIDAK disentuh. Baca-ubah-tulis diulang bila berkas berubah di tengah
 * jalan (mis. ~/.claude.json yang ditulis Claude Code sendiri).
 */
export function upsertJsonEntry(params: {
  client: string
  file: string
  keyPath: string[]
  name: string
  entry: Record<string, unknown>
  create: boolean
  drop?: string[]
}): StepResult {
  const { client, file, keyPath, name, entry, create, drop = [] } = params
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = readOrNull(file)
      if (text === null && !create) return { client, file, status: 'skipped', note: 'berkas tidak ada (klien tidak terpasang)' }

      let root: unknown
      try {
        root = text === null || !text.trim() ? {} : JSON.parse(text)
      } catch {
        return { client, file, status: 'error', note: 'JSON tidak sah — tidak disentuh' }
      }
      if (!isObj(root)) return { client, file, status: 'error', note: 'akar JSON bukan objek — tidak disentuh' }

      let container: Record<string, unknown> = root
      for (const k of keyPath) {
        const next = container[k]
        if (next === undefined) container[k] = {}
        else if (!isObj(next)) return { client, file, status: 'error', note: `"${k}" bukan objek — tidak disentuh` }
        container = container[k] as Record<string, unknown>
      }

      const existing = container[name]
      const merged: Record<string, unknown> = { ...(isObj(existing) ? existing : {}), ...entry }
      for (const k of drop) delete merged[k]
      if (existing !== undefined && stableStringify(existing) === stableStringify(merged)) {
        return { client, file, status: 'unchanged' }
      }
      container[name] = merged

      const trailingNl = text === null || text === '' || text.endsWith('\n')
      const out = JSON.stringify(root, null, text ? detectIndent(text) : 2) + (trailingNl ? '\n' : '')

      // Berkas berubah sejak dibaca → ulangi dari isi terbaru (jangan timpa perubahan orang lain).
      if (readOrNull(file) !== text) continue
      const backup = backupAndWrite(file, text, out)
      return { client, file, status: existing === undefined ? 'added' : 'updated', backup }
    }
    return { client, file, status: 'error', note: 'berkas terus berubah saat ditulis — coba lagi' }
  } catch (e) {
    return { client, file, status: 'error', note: errMsg(e) }
  }
}

// ─── TOML (Codex) — edit teks, komentar & urutan lain tidak disentuh ──────────

function tomlStr(s: string): string {
  return JSON.stringify(s) // string JSON = basic string TOML yang sah
}

/** Upsert `[mcp_servers.<name>]` command/args di config.toml Codex lewat edit teks. */
export function upsertCodexToml(file: string, name: string, command: string, args: string[], create: boolean): StepResult {
  const client = 'codex'
  try {
    const text = readOrNull(file)
    if (text === null && !create) return { client, file, status: 'skipped', note: 'berkas tidak ada' }
    const src = text ?? ''
    const want = [`command = ${tomlStr(command)}`, `args = [${args.map(tomlStr).join(', ')}]`]

    const lines = src.split('\n')
    const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:${name}|"${name}")\\s*\\]\\s*(?:#.*)?$`)
    const h = lines.findIndex(l => header.test(l))

    let out: string
    if (h === -1) {
      const sep = src === '' ? '' : src.endsWith('\n\n') ? '' : src.endsWith('\n') ? '\n' : '\n\n'
      out = `${src}${sep}[mcp_servers.${name}]\n${want.join('\n')}\n`
    } else {
      let end = h + 1
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
      const body = lines.slice(h + 1, end)
      // Buang baris command/args lama (termasuk array args multi-baris).
      const kept: string[] = []
      const found: string[] = []
      for (let i = 0; i < body.length; i++) {
        const l = body[i]
        if (/^\s*command\s*=/.test(l)) { found.push(l.trim()); continue }
        if (/^\s*args\s*=/.test(l)) {
          let full = l.trim()
          while (!full.includes(']') && i + 1 < body.length) full += ' ' + body[++i].trim()
          found.push(full)
          continue
        }
        kept.push(l)
      }
      if (found.length === 2 && found[0] === want[0] && found[1] === want[1]) {
        return { client, file, status: 'unchanged' }
      }
      out = [...lines.slice(0, h + 1), ...want, ...kept, ...lines.slice(end)].join('\n')
    }

    const backup = backupAndWrite(file, text, out)
    return { client, file, status: h === -1 ? 'added' : 'updated', backup }
  } catch (e) {
    return { client, file, status: 'error', note: errMsg(e) }
  }
}

// ─── BLOK ATURAN BERTANDA (AGENTS.md / GEMINI.md) ─────────────────────────────

/**
 * Ganti blok `<!-- engram:start -->…<!-- engram:end -->` di tempat, atau tambahkan
 * di akhir bila belum ada. Isi lain tidak disentuh. Penanda rusak (start tanpa
 * end) → error, berkas tidak disentuh.
 */
export function upsertMarkedBlock(client: string, file: string, block: string, create: boolean): StepResult {
  try {
    const text = readOrNull(file)
    if (text === null && !create) return { client, file, status: 'skipped', note: 'berkas tidak ada' }
    const src = text ?? ''
    const s = src.indexOf(RULES_START)
    const e = s === -1 ? -1 : src.indexOf(RULES_END, s)

    let out: string
    if (s !== -1 && e === -1) return { client, file, status: 'error', note: 'penanda engram:start tanpa engram:end — tidak disentuh' }
    if (s !== -1) {
      out = src.slice(0, s) + block + src.slice(e + RULES_END.length)
    } else {
      const sep = src === '' ? '' : src.endsWith('\n\n') ? '' : src.endsWith('\n') ? '\n' : '\n\n'
      out = `${src}${sep}${block}\n`
    }
    if (out === src) return { client, file, status: 'unchanged' }
    const backup = backupAndWrite(file, text, out)
    return { client, file, status: s === -1 ? 'added' : 'updated', backup }
  } catch (e) {
    return { client, file, status: 'error', note: errMsg(e) }
  }
}

// ─── HOOK CLAUDE CODE ─────────────────────────────────────────────────────────

/** Event hook → perintah Engram (urutan dalam event dipertahankan). */
export const CLAUDE_HOOKS: Array<[string, string]> = [
  ['SessionStart', 'load'],         // auto-inject memory di awal sesi
  ['PreCompact', 'capture'],        // tangkap sesi panjang SEBELUM konteks diringkas
  ['PreCompact', 'sync-memory'],
  ['SessionEnd', 'capture'],        // auto-save record sesi
  ['SessionEnd', 'sync-memory'],
  ['Stop', 'sync-memory'],          // murah: keluar seketika bila memori tak berubah
]

type HookCmd = { type?: string; command?: string }
type HookGroup = { matcher?: string; hooks?: HookCmd[] }

/**
 * Pasang/refresh hook Engram di settings.json Claude Code. Hook Engram dikenali
 * PRESISI via (indexPath + " <verb>"); diganti di tempat (urutan hook lain tetap),
 * hook non-Engram tidak disentuh.
 */
export function upsertClaudeHooks(file: string, nodePath: string, indexPath: string): StepResult {
  const client = 'claude-code-hooks'
  try {
    const text = readOrNull(file)
    let settings: unknown
    try {
      settings = text === null || !text.trim() ? {} : JSON.parse(text)
    } catch {
      return { client, file, status: 'error', note: 'JSON tidak sah — tidak disentuh' }
    }
    if (!isObj(settings)) return { client, file, status: 'error', note: 'akar JSON bukan objek' }
    const hooks = isObj(settings.hooks) ? { ...settings.hooks } : {}

    const cmdFor = (verb: string) => `${JSON.stringify(nodePath)} ${JSON.stringify(indexPath)} ${verb} --project .`
    const isOurCmd = (x: HookCmd, verb: string) =>
      typeof x?.command === 'string' && x.command.includes(indexPath) && x.command.endsWith(` ${verb} --project .`)
    const isOurs = (g: HookGroup, verb: string) => Array.isArray(g?.hooks) && g.hooks.some(x => isOurCmd(x, verb))

    for (const [event, verb] of CLAUDE_HOOKS) {
      const list: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
      const idx = list.findIndex(g => isOurs(g, verb))
      let next: HookGroup[]
      if (idx === -1) {
        next = [...list, { hooks: [{ type: 'command', command: cmdFor(verb) }] }]
      } else {
        // Ganti perintah kita di grup pertama (kunci lain spt timeout tetap);
        // salinan ganda di grup lain dibuang, grup yang jadi kosong ikut dibuang.
        next = list.flatMap((g, i) => {
          if (!isOurs(g, verb)) return [g]
          const cmds = g.hooks!.flatMap(x =>
            !isOurCmd(x, verb) ? [x] : i === idx ? [{ ...x, type: 'command', command: cmdFor(verb) }] : [])
          return cmds.length > 0 ? [{ ...g, hooks: cmds }] : []
        })
      }
      hooks[event] = next
    }

    const updated = { ...settings, hooks }
    if (stableStringify(updated) === stableStringify(settings)) return { client, file, status: 'unchanged' }
    const out = JSON.stringify(updated, null, text ? detectIndent(text) : 2) + (text === null || text.endsWith('\n') ? '\n' : '')
    const backup = backupAndWrite(file, text, out)
    return { client, file, status: text === null ? 'added' : 'updated', backup }
  } catch (e) {
    return { client, file, status: 'error', note: errMsg(e) }
  }
}

// ─── SKILL (berkas milik Engram sendiri) ──────────────────────────────────────

const SKILL_CONTENT = `<skill_content name="engram">
# Skill: Engram Persistent Memory

You are equipped with Engram, a persistent memory system (via MCP) shared across sessions and AI clients.

## Core Rules:
1. **Recall first**: at the start of a task call \`recall\` with the task topic (or \`context_status\` with \`{ "action": "load" }\` to resume).
2. **Remember decisions & bugs**: whenever you make a technical decision, fix a non-obvious bug, or learn a user preference, call \`remember\` (pass \`anchor\` when the fact comes from a file).
3. **Session Summary**: at the end of a substantial task, call \`session_summary\`.

Do not re-analyze the whole project if Engram already knows it. Use your memory!
</skill_content>
`

function writeSkill(home: string): StepResult {
  const client = 'claude-skill'
  const claudeDir = path.join(home, '.claude')
  const file = path.join(claudeDir, 'skills', 'engram', 'SKILL.md')
  try {
    if (!isDir(claudeDir)) return { client, file, status: 'skipped', note: '~/.claude tidak ada' }
    const old = readOrNull(file)
    if (old === SKILL_CONTENT) return { client, file, status: 'unchanged' }
    atomicWrite(file, SKILL_CONTENT)
    return { client, file, status: old === null ? 'added' : 'updated' }
  } catch (e) {
    return { client, file, status: 'error', note: errMsg(e) }
  }
}

// ─── ORKESTRASI ───────────────────────────────────────────────────────────────

/** Jalankan semua langkah init untuk klien yang terpasang. Tidak melempar. */
export function runInitSteps(opts: InitOptions): StepResult[] {
  const { home, nodePath, indexPath } = opts
  const args = [indexPath, '--project', '.']
  const stdEntry = { command: nodePath, args }
  const results: StepResult[] = []
  const claudeDir = path.join(home, '.claude')

  // Claude Code
  results.push(writeSkill(home))
  results.push(upsertJsonEntry({
    client: 'claude-code', file: path.join(home, '.claude.json'),
    keyPath: ['mcpServers'], name: 'engram', entry: stdEntry, create: false,
  }))
  results.push(isDir(claudeDir)
    ? upsertClaudeHooks(path.join(claudeDir, 'settings.json'), nodePath, indexPath)
    : { client: 'claude-code-hooks', file: path.join(claudeDir, 'settings.json'), status: 'skipped', note: '~/.claude tidak ada' })

  // Claude Desktop
  results.push(upsertJsonEntry({
    client: 'claude-desktop',
    file: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    keyPath: ['mcpServers'], name: 'engram', entry: stdEntry, create: false,
  }))

  // Codex (~/.codex ada = terpasang)
  const codexDir = path.join(home, '.codex')
  if (isDir(codexDir)) {
    results.push(upsertCodexToml(path.join(codexDir, 'config.toml'), 'engram', nodePath, args, true))
    results.push(upsertMarkedBlock('codex-rules', path.join(codexDir, 'AGENTS.md'), RULES_BLOCK, true))
  } else {
    results.push({ client: 'codex', file: codexDir, status: 'skipped', note: 'tidak terpasang' })
  }

  // Cursor
  const cursorDir = path.join(home, '.cursor')
  results.push(isDir(cursorDir)
    ? upsertJsonEntry({ client: 'cursor', file: path.join(cursorDir, 'mcp.json'), keyPath: ['mcpServers'], name: 'engram', entry: stdEntry, create: true })
    : { client: 'cursor', file: cursorDir, status: 'skipped', note: 'tidak terpasang' })

  // Gemini CLI + Antigravity (keduanya di ~/.gemini; GEMINI.md = aturan global keduanya)
  const geminiDir = path.join(home, '.gemini')
  results.push(upsertJsonEntry({
    client: 'gemini-cli', file: path.join(geminiDir, 'settings.json'),
    keyPath: ['mcpServers'], name: 'engram', entry: stdEntry, create: false,
  }))
  const seen = new Set<string>()
  for (const sub of ['antigravity', 'antigravity-ide']) {
    const file = path.join(geminiDir, sub, 'mcp_config.json')
    const real = realTarget(file)
    if (seen.has(real)) continue // symlink ke berkas yang sama
    seen.add(real)
    results.push(upsertJsonEntry({ client: `antigravity (${sub})`, file, keyPath: ['mcpServers'], name: 'engram', entry: stdEntry, create: false }))
  }
  if (isDir(geminiDir)) {
    results.push(upsertMarkedBlock('gemini-rules', path.join(geminiDir, 'GEMINI.md'), RULES_BLOCK, true))
  }

  // OpenCode — format sendiri: { type: "local", command: [...], enabled }
  const ocDir = path.join(home, '.config', 'opencode')
  const ocJson = path.join(ocDir, 'opencode.json')
  if (fs.existsSync(ocJson)) {
    results.push(upsertJsonEntry({
      client: 'opencode', file: ocJson, keyPath: ['mcp'], name: 'engram',
      entry: { type: 'local', command: [nodePath, ...args], enabled: true },
      create: false, drop: ['args'], // `args` dari format lama yang salah
    }))
  } else if (fs.existsSync(path.join(ocDir, 'opencode.jsonc'))) {
    results.push({ client: 'opencode', file: path.join(ocDir, 'opencode.jsonc'), status: 'skipped', note: 'JSONC (berkomentar) tidak disunting otomatis — tambahkan manual' })
  } else {
    results.push({ client: 'opencode', file: ocJson, status: 'skipped', note: 'tidak terpasang' })
  }

  return results
}
