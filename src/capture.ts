// Auto-capture: tulis record sesi yang ringkas & deterministik dari transcript
// Claude Code (hook PreCompact & SessionEnd), tanpa LLM dan tanpa bergantung
// pada model memanggil tool. Sisi "makna" (kenapa/keputusan) tetap tugas model
// via session_summary — di sini kita cuma menangkap yang BISA diketahui pasti:
// permintaan manusia (pertama & terakhir), file yang diedit, perintah yang
// dijalankan, dan commit yang dibuat.
//
// Prinsip hemat token: hanya menulis bila segmen transcript benar-benar mengubah
// sesuatu, digest dipangkas pendek, dan tiap bagian transcript di-capture SEKALI
// (offset byte per transcript disimpan di DB) — PreCompact yang terpicu berulang
// lalu SessionEnd tidak menulis duplikat.
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './store/db.js'
import {
  createSession, listSessions, getCaptureOffset, setCaptureOffset,
} from './store/memory-store.js'
import type { HookPayload } from './hook-input.js'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_FILES_LISTED = 5
const MAX_REQUEST_CHARS = 120
const MAX_DIGEST_CHARS = 400
const MAX_COMMIT_CHARS = 60

export interface SessionFacts {
  firstRequest: string
  /** Permintaan manusia TERAKHIR di segmen (kosong bila sama dgn yang pertama). */
  lastRequest?: string
  editedFiles: string[]
  commandCount: number
  commits: string[]
}

/** Nama file dasar (buang path) supaya digest ringkas & tidak bocorkan path panjang. */
function base(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

// ─── PERMINTAAN MANUSIA ───────────────────────────────────────────────────────

// Bungkus meta yang disisipkan harness ke pesan user: pengingat sistem, slash
// command, keluaran perintah lokal. Dibuang dulu; sisanya baru dinilai.
const META_BLOCK = /<(system-reminder|command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g
// Pesan user buatan harness (bukan ketikan manusia).
const SYNTHETIC_PREFIX = [
  'This session is being continued from a previous conversation', // ringkasan compact
  '[Request interrupted',
  'Caveat:',
]

/**
 * Teks permintaan manusia dari satu baris transcript, atau '' bila baris itu
 * bukan ketikan manusia: echo tool_result, ringkasan compact (isCompactSummary),
 * pesan meta (isMeta / sidechain), system-reminder, atau `<command-…>`.
 */
export function humanRequestText(obj: any): string {
  if (!obj || typeof obj !== 'object') return ''
  if (obj.isCompactSummary || obj.isMeta || obj.isSidechain) return ''
  const msg = obj.message ?? obj
  const role = msg?.role ?? obj.type
  if (role !== 'user') return ''

  const content = msg?.content
  let raw = ''
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    if (content.some((b: any) => b?.type === 'tool_result')) return ''
    raw = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  }

  const t = raw.replace(META_BLOCK, '').trim()
  if (!t || t.startsWith('<')) return ''
  if (SYNTHETIC_PREFIX.some(p => t.startsWith(p))) return ''
  return t.replace(/\s+/g, ' ').slice(0, MAX_REQUEST_CHARS)
}

// ─── PESAN COMMIT ─────────────────────────────────────────────────────────────

// `git [opsi global] commit` — subperintah harus `commit` (bukan `git log --grep commit`).
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/

function clip(line: string): string {
  return line.trim().slice(0, MAX_COMMIT_CHARS)
}

/**
 * Baris pertama yang tidak kosong dari badan heredoc pertama di `text`
 * (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`). Null bila tak ada heredoc.
 */
function heredocFirstLine(text: string): string | null {
  const m = text.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/)
  if (!m || m.index === undefined) return null
  const delim = m[2]
  const after = text.slice(m.index + m[0].length)
  const nl = after.indexOf('\n')
  if (nl === -1) return null
  for (const line of after.slice(nl + 1).split('\n')) {
    if (line.trim() === delim) break
    if (line.trim()) return clip(line)
  }
  return null
}

/** Nilai argumen shell yang dimulai di awal `s`: "…", '…', $(…heredoc), atau kata polos. */
function shellValue(s: string): string | null {
  if (/^"?\$\(/.test(s) && /<</.test(s)) return heredocFirstLine(s)
  if (s.startsWith('"')) {
    let out = ''
    for (let i = 1; i < s.length; i++) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue }
      if (c === '"') return out
      out += c
    }
    return out
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    return end === -1 ? s.slice(1) : s.slice(1, end)
  }
  const m = s.match(/^[^\s;&|)]+/)
  return m ? m[0] : null
}

/** Baris subjek dari berkas pesan commit (lewati komentar `#`). Null bila tak terbaca. */
function messageFromFile(file: string, cwd?: string): string | null {
  try {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file)
    const text = fs.readFileSync(abs, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() && !line.trimStart().startsWith('#')) return clip(line)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Ekstrak subjek commit dari sebuah perintah Bash (best-effort). Mengenali:
 *  - `-m "…"` / `-m '…'` / `-am …` / `--message=…` (bila `-m` ganda → yang pertama = subjek)
 *  - `-m "$(cat <<'EOF' … EOF)"` (gaya Claude Code)
 *  - `-F -` / `--file=-` dengan heredoc → baris pertama badan heredoc
 *  - `-F <berkas>` → baris pertama berkas (relatif terhadap `cwd`) bila ada
 * Return null bila bukan `git commit`; '(commit)' bila pesannya tak diketahui.
 */
export function commitMessage(cmd: string, cwd?: string): string | null {
  const g = GIT_COMMIT.exec(cmd)
  if (!g) return null
  // Sambungan baris `\⏎` diganti 2 spasi (panjang sama → indeks tetap selaras).
  const rest = cmd.slice(g.index + g[0].length).replace(/\\\n/g, '  ')
  // Opsi dicari HANYA di baris perintah itu sendiri — badan heredoc/berkas pesan
  // bisa saja memuat teks "-m" yang bukan opsi.
  const nl = rest.indexOf('\n')
  const optLine = nl === -1 ? rest : rest.slice(0, nl)

  const mFlag = optLine.match(/(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:\s*=\s*|\s+|(?=["']))/)
  if (mFlag && mFlag.index !== undefined) {
    const v = shellValue(rest.slice(mFlag.index + mFlag[0].length))
    const first = v?.split('\n').find(l => l.trim())
    if (first) return clip(first)
  }

  const fFlag = optLine.match(/(?:^|\s)(?:-[a-zA-Z]*F|--file)(?:\s*=\s*|\s+)/)
  if (fFlag && fFlag.index !== undefined) {
    const v = shellValue(rest.slice(fFlag.index + fFlag[0].length))
    if (v === '-') return heredocFirstLine(rest) ?? '(commit)'
    if (v) return messageFromFile(v, cwd) ?? '(commit)'
  }
  return '(commit)'
}

// ─── TRANSCRIPT → FAKTA ───────────────────────────────────────────────────────

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
  let lastRequest = ''

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try { obj = JSON.parse(trimmed) } catch { continue }

    const req = humanRequestText(obj)
    if (req) {
      if (!firstRequest) firstRequest = req
      lastRequest = req
    }

    const content = (obj?.message ?? obj)?.content
    if (!Array.isArray(content)) continue
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
        const cm = commitMessage(input.command, typeof obj.cwd === 'string' ? obj.cwd : undefined)
        if (cm) commits.push(cm)
      }
    }
  }

  return {
    firstRequest,
    lastRequest: lastRequest && lastRequest !== firstRequest ? lastRequest : '',
    editedFiles, commandCount, commits,
  }
}

/**
 * Rakit digest ringkas. Return null bila segmen tidak mengubah apa pun
 * (tidak ada edit & tidak ada commit) → jangan cemari store (hemat token).
 */
export function buildDigest(f: SessionFacts): string | null {
  if (f.editedFiles.length === 0 && f.commits.length === 0) return null

  const parts: string[] = []
  if (f.firstRequest && f.lastRequest) parts.push(`${f.firstRequest} → terakhir: ${f.lastRequest}`)
  else if (f.firstRequest || f.lastRequest) parts.push(f.firstRequest || f.lastRequest!)

  if (f.editedFiles.length > 0) {
    const shown = f.editedFiles.slice(0, MAX_FILES_LISTED).join(', ')
    const more = f.editedFiles.length > MAX_FILES_LISTED ? ` +${f.editedFiles.length - MAX_FILES_LISTED} more` : ''
    parts.push(`edited ${f.editedFiles.length} file(s): ${shown}${more}`)
  }
  if (f.commandCount > 0) parts.push(`${f.commandCount} cmd(s)`)
  if (f.commits.length > 0) parts.push(`commits: ${f.commits.join(' / ')}`)

  return ('[auto] ' + parts.join(' — ')).slice(0, MAX_DIGEST_CHARS)
}

// ─── SEGMEN BARU TRANSCRIPT ───────────────────────────────────────────────────

/**
 * Baca bagian transcript sejak `offset` sampai akhir baris LENGKAP terakhir.
 * Baris terakhir tanpa '\n' ikut dipakai hanya bila sudah JSON utuh (akhir sesi);
 * kalau masih ditulis, ditunda ke capture berikutnya.
 */
export function readNewSegment(file: string, offset: number): { text: string; end: number } {
  const size = fs.statSync(file).size
  const start = offset > size ? 0 : offset // berkas menyusut/diganti → mulai ulang
  if (start === size) return { text: '', end: size }

  const buf = Buffer.alloc(size - start)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }

  const lastNl = buf.lastIndexOf(0x0a)
  const tail = buf.subarray(lastNl + 1).toString('utf8').trim()
  let tailComplete = false
  if (tail) { try { JSON.parse(tail); tailComplete = true } catch { /* masih ditulis */ } }

  const used = tailComplete ? buf.length : lastNl + 1
  return { text: buf.subarray(0, used).toString('utf8'), end: start + used }
}

/**
 * Entry hook PreCompact / SessionEnd: tangkap segmen transcript yang belum
 * pernah di-capture ke store. Tidak pernah melempar — kegagalan apa pun harus
 * diam (jangan ganggu compact / penutupan sesi user).
 */
export function runCapture(projectKey: string, payload: HookPayload | null): void {
  try {
    const tPath = payload?.transcript_path
    if (!tPath || !fs.existsSync(tPath)) return

    const { text, end } = readNewSegment(tPath, getCaptureOffset(tPath))
    if (!text) return

    const digest = buildDigest(parseTranscript(text))
    getDb().transaction(() => {
      // Dedup: jangan tulis bila identik dengan record sesi terakhir (mis. hook
      // terpicu dua kali). Perbandingan string eksak sudah cukup & murah.
      if (digest) {
        const last = listSessions(projectKey, 1) as Array<{ summary: string }>
        if (last[0]?.summary !== digest) {
          createSession({ project: projectKey, summary: digest, started_at: Date.now() })
        }
      }
      setCaptureOffset(tPath, end)
    })()
  } catch {
    /* diam: auto-capture bersifat best-effort */
  }
}
