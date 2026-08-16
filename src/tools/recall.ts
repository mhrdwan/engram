import { z } from 'zod'
import { searchMemories, listMemories } from '../store/memory-store.js'
import { isStale } from '../store/anchor.js'
import type { MemoryType, RecallResult } from '../types.js'

export const recallSchema = z.object({
  query: z.string().min(1).describe(
    'What to search for. Use natural language — e.g. "tech stack", "auth approach", "database choice"'
  ),
  limit: z.number().int().min(1).max(50).default(10).describe(
    'Max number of memories to return'
  ),
  scope: z.enum(['project', 'global', 'all']).default('all').describe(
    'Search scope: project (current project + global), global (global only), all (everything)'
  ),
  type: z.enum(['decision', 'preference', 'fact', 'bug', 'architecture', 'session', 'general'])
    .optional()
    .describe('Filter by memory type'),
  verbose: z.boolean().default(false).describe(
    'Include memory IDs in the output (needed only for forget). Off by default to save tokens.'
  ),
})

export type RecallInput = z.infer<typeof recallSchema>

export function recallHandler(project: string) {
  return async (input: RecallInput) => {
    const results = await searchMemories({
      query: input.query,
      project,
      scope: input.scope,
      limit: input.limit,
    })

    // if FTS returns nothing, fall back to list with type filter
    const memories: RecallResult[] = results.length > 0
      ? results
      : listMemories({
          project,
          type: input.type as MemoryType | undefined,
          scope: input.scope === 'all' ? 'all' : input.scope as 'project' | 'global',
          limit: input.limit,
        }).map((m): RecallResult => ({
          id: m.id,
          content: m.content,
          type: m.type,
          tags: m.tags,
          scope: m.scope,
          created_at: m.created_at,
          relevance_hint: 'fallback-list',
          // Jalur fallback juga harus menandai fakta basi (kalau tidak, self-invalidation
          // hilang justru saat pencarian semantik/keyword lemah).
          stale: isStale(m.anchor_path, m.anchor_hash),
          anchor_path: m.anchor_path,
        }))

    if (memories.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No memories found for: "${input.query}"`,
        }],
      }
    }

    const lines = memories.map((m, i) => {
      const tags = m.tags.length > 0 ? ` #${m.tags.join(' #')}` : ''
      const date = new Date(m.created_at).toISOString().split('T')[0]
      const idLine = input.verbose ? `\n   ID: ${m.id}` : ''
      // Self-invalidating: fakta yang file sumbernya berubah ditandai basi.
      const stale = m.stale ? '⚠️ STALE ' : ''
      return `${i + 1}. ${stale}[${m.type}]${tags} ${m.content} (${date})${idLine}`
    })

    return {
      content: [{
        type: 'text' as const,
        text: `Found ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} for "${input.query}":\n\n${lines.join('\n\n')}`,
      }],
    }
  }
}
