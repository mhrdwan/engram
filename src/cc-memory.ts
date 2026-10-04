// Memori bawaan Claude Code: berkas `~/.claude/projects/<slug-cwd>/memory/*.md`
// (+ indeks MEMORY.md). Tiap berkas ber-frontmatter `name`, `description`,
// `metadata.type` (kadang `type` di tingkat atas) = user|feedback|project|reference.
//
// Modul ini SENGAJA ringan (hanya fs/path/os, tanpa DB/embedding) supaya jalur
// cepat hook Stop — "adakah berkas yang berubah?" — tidak memuat apa pun yang berat.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { MemoryType } from './types.js'

/** Versi pemetaan berkas→catatan. Naikkan bila format isi berubah → paksa sinkron ulang. */
export const CC_SYNC_VERSION = 1
export const CC_TAG = 'cc-memory'
const INDEX_FILE = 'MEMORY.md'

/** Folder konfigurasi Claude Code (hormati CLAUDE_CONFIG_DIR seperti Claude Code). */
export function claudeConfigDir(home: string = os.homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override ? path.resolve(override) : path.join(home, '.claude')
}

/**
 * Slug folder proyek Claude Code: path absolut dengan SETIAP karakter
 * non-alfanumerik diganti `-` (diverifikasi terhadap ~/.claude/projects nyata:
 * `/Users/apple/.claudegauge-probe` → `-Users-apple--claudegauge-probe`,
 * `/…/JXB/My Drive/…` → `-…-JXB-My-Drive-…`).
 */
export function claudeProjectSlug(absPath: string): string {
  return path.resolve(absPath).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Tentukan folder memori proyek. Urutan keandalan:
 *  1. dirname(transcript_path)/memory — persis folder sesi yang sedang berjalan.
 *  2. ~/.claude/projects/<slug>/memory untuk tiap kandidat dir (cwd, project, akar git).
 * Return folder yang ADA; null bila tak satu pun ada. Tidak pernah melempar.
 */
export function findMemoryDir(opts: {
  transcriptPath?: string
  candidates?: Array<string | null | undefined>
  claudeDir?: string
}): string | null {
  try {
    if (opts.transcriptPath) {
      const d = path.join(path.dirname(opts.transcriptPath), 'memory')
      if (isDir(d)) return d
    }
    const projectsDir = path.join(opts.claudeDir ?? claudeConfigDir(), 'projects')
    for (const c of opts.candidates ?? []) {
      if (!c) continue
      const d = path.join(projectsDir, claudeProjectSlug(c), 'memory')
      if (isDir(d)) return d
    }
  } catch {
    /* jatuh ke null */
  }
  return null
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// ─── FRONTMATTER (YAML-lite) ──────────────────────────────────────────────────

type FmValue = string | Record<string, string>

/** Nilai skalar YAML: "…" (escape gaya JSON), '…' ('' = '), atau polos. */
function scalar(raw: string): string {
  const v = raw.trim()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  return v
}

/**
 * Parser frontmatter minimal: `key: nilai`, blok bersarang satu tingkat
 * (`metadata:` + baris berindentasi), dan blok skalar `|` / `>`. Cukup untuk
 * format memori Claude Code; bentuk lain diabaikan, bukan dilempar.
 */
export function parseFrontmatter(text: string): { fm: Record<string, FmValue>; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)
  if (!m) return { fm: {}, body: src }
  const fm: Record<string, FmValue> = {}
  const lines = m[1].split('\n')
  let parent: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indented = /^\s+/.test(line)
    const kv = line.trim().match(/^([A-Za-z0-9_-]+):(.*)$/)
    if (!kv) continue
    const [, key, rest] = kv
    let value = rest.trim()

    // Blok skalar: kumpulkan baris berikutnya yang lebih menjorok.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const baseIndent = line.match(/^\s*/)![0].length
      const parts: string[] = []
      while (i + 1 < lines.length) {
        const nxt = lines[i + 1]
        const ind = nxt.match(/^\s*/)![0].length
        if (nxt.trim() && ind <= baseIndent) break
        parts.push(nxt.trim())
        i++
      }
      value = parts.join(value.startsWith('>') ? ' ' : '\n').trim()
    } else {
      value = scalar(value)
    }

    if (indented && parent) {
      const obj = fm[parent]
      if (obj && typeof obj === 'object') obj[key] = value
    } else if (!indented && rest.trim() === '') {
      fm[key] = {}
      parent = key
    } else if (!indented) {
      fm[key] = value
      parent = null
    }
  }
  return { fm, body: src.slice(m[0].length) }
}

// ─── BERKAS MEMORI → CATATAN ──────────────────────────────────────────────────

export interface CcMemoryFile {
  /** Path absolut berkas .md (kunci identitas di DB lewat anchor_path). */
  file: string
  /** Basename tanpa .md — kunci stabil untuk tag `cc-memory:<key>`. */
  key: string
  name: string
  description: string
  ccType: string
  type: MemoryType
  content: string
}

const TYPE_MAP: Record<string, MemoryType> = {
  user: 'preference',
  feedback: 'preference',
  project: 'fact',
  reference: 'fact',
}

export function mapCcType(t: string): MemoryType {
  return TYPE_MAP[t.trim().toLowerCase()] ?? 'fact'
}

/** Parse satu berkas memori. Null bila tak terbaca / kosong. Tidak pernah melempar. */
export function readMemoryFile(file: string): CcMemoryFile | null {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const { fm, body } = parseFrontmatter(text)
    const key = path.basename(file).replace(/\.md$/i, '')
    const str = (v: FmValue | undefined) => (typeof v === 'string' ? v : '')
    const meta = typeof fm.metadata === 'object' ? fm.metadata : {}
    const name = str(fm.name) || key
    const description = str(fm.description)
    const ccType = meta.type || str(fm.type) || ''
    const bodyText = body.trim()
    if (!description && !bodyText) return null

    const head = description ? `${name} — ${description}` : name
    const content = bodyText ? `${head}\n\n${bodyText}` : head
    return { file, key, name, description, ccType, type: mapCcType(ccType), content }
  } catch {
    return null
  }
}

/** Berkas memori (*.md, bukan MEMORY.md) di folder, terurut. [] bila gagal. */
export function listMemoryFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && /\.md$/i.test(d.name) && d.name !== INDEX_FILE)
      .map(d => path.join(dir, d.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Sidik murah isi folder (nama + ukuran + mtime, tanpa membaca isi) — dipakai
 * jalur cepat hook Stop untuk keluar seketika bila tak ada yang berubah.
 */
export function memoryDirSignature(dir: string): string {
  const parts: string[] = [`v${CC_SYNC_VERSION}`]
  for (const f of listMemoryFiles(dir)) {
    try {
      const st = fs.statSync(f)
      parts.push(`${path.basename(f)}:${st.size}:${Math.floor(st.mtimeMs)}`)
    } catch {
      parts.push(`${path.basename(f)}:?`)
    }
  }
  return parts.join('|')
}

// ─── STATUS SINKRON (berkas kecil di samping DB) ──────────────────────────────

type SyncState = Record<string, { sig: string; at: number }>

function stateKey(memDir: string, projectKey: string): string {
  return `${projectKey}::${memDir}`
}

function readState(stateFile: string): SyncState {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** True bila sidik folder sama dengan yang tercatat pada sinkron sukses terakhir. */
export function isUnchangedSinceLastSync(stateFile: string, memDir: string, projectKey: string, sig: string): boolean {
  return readState(stateFile)[stateKey(memDir, projectKey)]?.sig === sig
}

/** Catat sidik setelah sinkron sukses (tulis atomik). Tidak pernah melempar. */
export function recordSync(stateFile: string, memDir: string, projectKey: string, sig: string): void {
  try {
    const state = { ...readState(stateFile), [stateKey(memDir, projectKey)]: { sig, at: Date.now() } }
    const tmp = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, stateFile)
  } catch {
    /* best-effort: paling buruk sinkron berikutnya jalan lagi (idempoten) */
  }
}
