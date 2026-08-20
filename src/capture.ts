// Auto-capture: tulis SATU record sesi yang ringkas & deterministik di akhir
// sesi (hook SessionEnd), tanpa LLM dan tanpa bergantung pada model memanggil
// tool. Sisi "makna" (kenapa/keputusan) tetap tugas model via session_summary —
// di sini kita cuma menangkap yang BISA diketahui pasti dari transcript:
// file yang diedit, perintah yang dijalankan, dan commit yang dibuat.
//
// Prinsip hemat token: dipanggil sekali per sesi (SessionEnd), hanya menulis
// bila sesi benar-benar mengubah sesuatu, dan digest-nya dipangkas pendek.
import fs from 'node:fs'
import { createSession, listSessions } from './store/memory-store.js'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_FILES_LISTED = 5
const MAX_REQUEST_CHARS = 120
const MAX_DIGEST_CHARS = 400

export interface SessionFacts {
  firstRequest: string
  editedFiles: string[]
  commandCount: number
  commits: string[]
}

/** Ambil teks pertama dari sebuah `content` (string atau array block). */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') {
        return (b as any).text
      }
    }
  }
  return ''
}

/** Nama file dasar (buang path) supaya digest ringkas & tidak bocorkan path panjang. */
function base(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** Ekstrak pesan commit dari sebuah command `git commit -m "..."` (best-effort). */
function commitMessage(cmd: string): string | null {
  if (!/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return null
  const m = cmd.match(/-m\s+(["'])([\s\S]*?)\1/)
  return m ? m[2].split('\n')[0].slice(0, 60) : '(commit)'
}

/**
 * Parse transcript JSONL Claude Code menjadi fakta deterministik. Sangat
 * defensif: baris rusak dilewati, bentuk pesan yang tak dikenal diabaikan.
 */
export function parseTranscript(text: string): SessionFacts {
  const editedFiles: string[] = []
  const seenFile = new Set<string>()
  const commits: string[] = []
  let commandCount = 0
  let firstRequest = ''

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try { obj = JSON.parse(trimmed) } catch { continue }

    const msg = obj?.message ?? obj
    const role = msg?.role ?? obj?.type
    const content = msg?.content

    if (role === 'user' && !firstRequest) {
      const t = firstText(content).trim()
      // Lewati echo tool_result & meta; ambil permintaan manusia pertama.
      if (t && !t.startsWith('<') && (!Array.isArray(content) || content.some((b: any) => b?.type === 'text'))) {
        firstRequest = t.replace(/\s+/g, ' ').slice(0, MAX_REQUEST_CHARS)
      }
    }

    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue
        const name = b.name
        const input = b.input ?? {}
        if (EDIT_TOOLS.has(name)) {
          const fp = input.file_path ?? input.notebook_path
          if (typeof fp === 'string') {
            const bn = base(fp)
            if (!seenFile.has(bn)) { seenFile.add(bn); editedFiles.push(bn) }
          }
        } else if (name === 'Bash' && typeof input.command === 'string') {
          commandCount++
          const cm = commitMessage(input.command)
          if (cm) commits.push(cm)
        }
      }
    }
  }

  return { firstRequest, editedFiles, commandCount, commits }
}

/**
 * Rakit digest ringkas. Return null bila sesi tidak mengubah apa pun
 * (tidak ada edit & tidak ada commit) → jangan cemari store (hemat token).
 */
export function buildDigest(f: SessionFacts): string | null {
  if (f.editedFiles.length === 0 && f.commits.length === 0) return null

  const parts: string[] = []
  if (f.firstRequest) parts.push(f.firstRequest)

  if (f.editedFiles.length > 0) {
    const shown = f.editedFiles.slice(0, MAX_FILES_LISTED).join(', ')
    const more = f.editedFiles.length > MAX_FILES_LISTED ? ` +${f.editedFiles.length - MAX_FILES_LISTED} more` : ''
    parts.push(`edited ${f.editedFiles.length} file(s): ${shown}${more}`)
  }
  if (f.commandCount > 0) parts.push(`${f.commandCount} cmd(s)`)
  if (f.commits.length > 0) parts.push(`commits: ${f.commits.join(' / ')}`)

  return ('[auto] ' + parts.join(' — ')).slice(0, MAX_DIGEST_CHARS)
}

/** Baca payload hook (JSON di stdin) → path transcript. Null bila tak ada. */
function transcriptPathFromStdin(): string | null {
  if (process.stdin.isTTY) return null
  try {
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw.trim()) return null
    const payload = JSON.parse(raw)
    const p = payload?.transcript_path
    return typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}

/**
 * Entry hook SessionEnd: tangkap sesi ke store. Tidak pernah melempar —
 * kegagalan apa pun harus diam (jangan ganggu penutupan sesi user).
 */
export function runCapture(projectKey: string): void {
  try {
    const tPath = transcriptPathFromStdin()
    if (!tPath || !fs.existsSync(tPath)) return

    const facts = parseTranscript(fs.readFileSync(tPath, 'utf8'))
    const digest = buildDigest(facts)
    if (!digest) return

    // Dedup: jangan tulis bila identik dengan record sesi terakhir (mis. hook
    // terpicu dua kali). Perbandingan string eksak sudah cukup & murah.
    const last = listSessions(projectKey, 1) as Array<{ summary: string }>
    if (last[0]?.summary === digest) return

    createSession({ project: projectKey, summary: digest, started_at: Date.now() })
  } catch {
    /* diam: auto-capture bersifat best-effort */
  }
}
