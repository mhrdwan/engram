import { z } from 'zod'
import { getRecentContext, getStats, pruneMemories } from '../store/memory-store.js'

export const contextStatusSchema = z.object({
  action: z.enum(['load', 'stats', 'prune']).default('load').describe(
    'load = get recent context for session start | stats = memory usage stats | prune = evict old unused memories'
  ),
})

export type ContextStatusInput = z.infer<typeof contextStatusSchema>

export function contextStatusHandler(project: string) {
  return (input: ContextStatusInput) => {
    if (input.action === 'stats') {
      const stats = getStats(project)
      const byTypeStr = (stats.byType as { type: string; n: number }[])
        .map(r => `  ${r.type}: ${r.n}`)
        .join('\n')
      return {
        content: [{
          type: 'text' as const,
          text: [
            `## Memory Stats — project: ${project}`,
            `Total memories: ${stats.total}`,
            `Sessions saved: ${stats.sessions}`,
            `Never accessed: ${stats.neverAccessed} (candidates for pruning)`,
            `ROI ledger: saved ~${stats.tokensSaved.toLocaleString()} tok · spent ~${stats.tokensSpent.toLocaleString()} tok · net ~${stats.netTokens.toLocaleString()} tok`,
            `Anchored: ${stats.anchored} (self-invalidating) · Stale now: ${stats.stale} ⚠️`,
            `By type:\n${byTypeStr}`,
          ].join('\n'),
        }],
      }
    }

    if (input.action === 'prune') {
      const evicted = pruneMemories({ project })
      return {
        content: [{
          type: 'text' as const,
          text: evicted > 0
            ? `Pruned ${evicted} old/unused memories. Decisions and architecture notes preserved.`
            : 'Nothing to prune — all memories are recent or frequently accessed.',
        }],
      }
    }

    // action === 'load' — session startup context injection
    const ctx = getRecentContext(project)
    if (!ctx) {
      return {
        content: [{
          type: 'text' as const,
          text: `No prior context for project: ${project}. Fresh start.`,
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: `## Loaded context for: ${project}\n\n${ctx}`,
      }],
    }
  }
}
