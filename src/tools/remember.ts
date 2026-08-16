import { z } from 'zod'
import path from 'node:path'
import { createMemory } from '../store/memory-store.js'
import type { MemoryType } from '../types.js'

/**
 * Confine anchor ke dalam root project (cwd server). Menolak path absolut
 * di luar project atau traversal `../` — mencegah anchor dipakai untuk
 * membaca file arbitrer (mis. /etc/passwd, ~/.ssh) lewat hash-on-recall.
 * Return path yang aman, atau null bila di luar batas.
 */
function safeAnchor(anchor: string | undefined): string | null {
  if (!anchor) return null
  const root = process.cwd()
  const resolved = path.resolve(root, anchor)
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null
}

export const rememberSchema = z.object({
  content: z.string().min(1).describe(
    'The fact, decision, preference, or information to remember. Be specific and complete.'
  ),
  type: z.enum(['decision', 'preference', 'fact', 'bug', 'architecture', 'session', 'general'])
    .default('general')
    .describe(
      'Type: decision (architectural/technical choices), preference (user/project preferences), ' +
      'fact (concrete facts like URLs, names, configs), bug (known bugs/issues), ' +
      'architecture (system design), session (session summary), general (anything else)'
    ),
  tags: z.array(z.string()).default([]).describe(
    'Optional tags, e.g. ["auth", "database", "frontend"]'
  ),
  scope: z.enum(['project', 'global']).default('project').describe(
    'project = only this project, global = visible across all projects'
  ),
  anchor: z.string().optional().describe(
    'Optional path to the source file this fact is derived from (e.g. "src/db.ts"). ' +
    'Makes the memory self-invalidating: on recall it is flagged ⚠️ stale if that file changed.'
  ),
})

export type RememberInput = z.infer<typeof rememberSchema>

export function rememberHandler(project: string) {
  return async (input: RememberInput) => {
    const anchor = safeAnchor(input.anchor)
    const anchorRejected = input.anchor && !anchor

    const result = await createMemory({
      content: input.content,
      type: input.type as MemoryType,
      tags: input.tags,
      project,
      scope: input.scope,
      anchor: anchor ?? undefined,
    })

    const tagsStr = result.memory.tags.length > 0
      ? ` [${result.memory.tags.join(', ')}]`
      : ''
    const anchorNote = anchorRejected
      ? '\n⚠️ anchor ignored — must be a path inside the project root.'
      : anchor ? `\n🔗 anchored to ${path.relative(process.cwd(), anchor)} (self-invalidating)` : ''

    if (result.deduplicated) {
      return {
        content: [{
          type: 'text' as const,
          text: `Updated existing memory (${result.memory.type}${tagsStr}): "${result.memory.content}"\nID: ${result.memory.id} (deduplicated — merged with similar existing memory)${anchorNote}`,
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Remembered (${result.memory.type}${tagsStr}): "${result.memory.content}"\nID: ${result.memory.id}${anchorNote}`,
      }],
    }
  }
}
