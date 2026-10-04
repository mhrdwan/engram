// Payload hook Claude Code (JSON di stdin). Semua event hook membawa
// `transcript_path` & `cwd`; PreCompact/Stop/SessionEnd juga. Dibaca SEKALI per
// proses lalu dioper ke capture / sync-memory.
import fs from 'node:fs'

export interface HookPayload {
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
}

/** Baca payload hook dari stdin. Null bila TTY/kosong/rusak. Tidak pernah melempar. */
export function readHookPayload(): HookPayload | null {
  try {
    if (process.stdin.isTTY) return null
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw.trim()) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const out: HookPayload = {}
    if (typeof v.transcript_path === 'string' && v.transcript_path) out.transcript_path = v.transcript_path
    if (typeof v.cwd === 'string' && v.cwd) out.cwd = v.cwd
    if (typeof v.hook_event_name === 'string') out.hook_event_name = v.hook_event_name
    return out
  } catch {
    return null
  }
}
