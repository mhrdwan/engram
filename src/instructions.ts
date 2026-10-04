// Satu sumber teks "cara memakai Engram": dipakai sebagai `instructions` server
// MCP (disuntikkan ke system prompt oleh klien MCP yang mendukungnya) dan sebagai
// blok aturan di AGENTS.md / GEMINI.md untuk klien yang membaca berkas aturan.
// Sengaja dalam bahasa Inggris: dibaca model dari banyak vendor.

export const ENGRAM_INSTRUCTIONS = [
  'Engram is your persistent memory across sessions AND across AI clients (Claude, Codex, Gemini, Cursor, OpenCode share it). Use it actively:',
  '1. START of every task: call `recall` with the task topic (a few keywords) before exploring code — past decisions, gotchas and user preferences live here.',
  '2. As soon as an important decision, non-obvious fact, bug root cause, or user preference/correction is established: call `remember` (one concise, self-contained fact per call; pass `anchor` = source file path when the fact comes from a file).',
  '3. When a substantial task is finished: call `session_summary` (what changed, why, next steps).',
  'Prefer Engram over re-deriving context. A recalled memory marked stale means its source file changed — verify before relying on it.',
].join('\n')

export const RULES_START = '<!-- engram:start -->'
export const RULES_END = '<!-- engram:end -->'

/** Blok aturan bertanda untuk AGENTS.md / GEMINI.md (diganti di tempat oleh `init`). */
export const RULES_BLOCK = [
  RULES_START,
  '## Engram memory (MCP server `engram`)',
  '',
  ENGRAM_INSTRUCTIONS.split('\n').map(l => (/^\d\./.test(l) ? `- ${l.slice(3)}` : l)).join('\n'),
  RULES_END,
].join('\n')
