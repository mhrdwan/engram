import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { rememberSchema, rememberHandler } from './tools/remember.js'
import { recallSchema, recallHandler } from './tools/recall.js'
import { forgetSchema, forgetHandler } from './tools/forget.js'
import { listMemoriesSchema, listMemoriesHandler } from './tools/list.js'
import { sessionSummarySchema, sessionSummaryHandler } from './tools/session-summary.js'
import { contextStatusSchema, contextStatusHandler } from './tools/context-status.js'
import { ENGRAM_INSTRUCTIONS } from './instructions.js'

export function createServer(project: string): McpServer {
  // `instructions` berlaku untuk SEMUA klien MCP: tanpa ini model tak punya
  // alasan memakai Engram dan memilih memori bawaan kliennya sendiri.
  const server = new McpServer(
    { name: 'engram-mcp', version: '1.0.0' },
    { instructions: ENGRAM_INSTRUCTIONS }
  )

  server.registerTool(
    'remember',
    {
      description:
        'Store a memory (fact, decision, preference, bug, architecture note) that persists across sessions. ' +
        'Auto-deduplicates: if a similar memory exists, it updates instead of creating a duplicate. ' +
        'Call whenever the user states something important or makes a decision.',
      inputSchema: rememberSchema,
    },
    rememberHandler(project)
  )

  server.registerTool(
    'recall',
    {
      description:
        'Search stored memories using natural language. Call at the START of each session to load ' +
        'relevant context. Results ranked by FTS relevance + access frequency + type priority.',
      inputSchema: recallSchema,
    },
    recallHandler(project)
  )

  server.registerTool(
    'forget',
    {
      description: 'Delete a specific memory by ID. Use when a memory is outdated or incorrect.',
      inputSchema: forgetSchema,
    },
    forgetHandler()
  )

  server.registerTool(
    'list_memories',
    {
      description:
        'List all stored memories, grouped by type and sorted by relevance score. ' +
        'Optionally filter by type or tag.',
      inputSchema: listMemoriesSchema,
    },
    listMemoriesHandler(project)
  )

  server.registerTool(
    'session_summary',
    {
      description:
        'Save a summary of the current session. Call at the END of each working session. ' +
        'Include what was done, decisions made, and next steps.',
      inputSchema: sessionSummarySchema,
    },
    sessionSummaryHandler(project)
  )

  server.registerTool(
    'context_status',
    {
      description:
        'Session context management. ' +
        'load = inject recent session summary + top memories at session start (call this first!). ' +
        'stats = see memory usage breakdown. ' +
        'prune = evict old unused memories to keep store lean.',
      inputSchema: contextStatusSchema,
    },
    contextStatusHandler(project)
  )

  return server
}
