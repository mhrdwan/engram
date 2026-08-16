export type MemoryType =
  | 'decision'
  | 'preference'
  | 'fact'
  | 'bug'
  | 'architecture'
  | 'session'
  | 'general'

export interface Memory {
  id: string
  content: string
  type: MemoryType
  tags: string[]
  project: string
  scope: 'project' | 'global'
  created_at: number
  updated_at: number
  access_count: number
  last_accessed: number | null
  // Living-memory fields
  anchor_path: string | null
  anchor_hash: string | null
  tokens_saved: number
  tokens_spent: number
}

export interface Session {
  id: string
  project: string
  summary: string
  started_at: number
  ended_at: number
}

export interface RecallResult {
  id: string
  content: string
  type: MemoryType
  tags: string[]
  scope: 'project' | 'global'
  created_at: number
  relevance_hint?: string
  /** True bila memory ter-anchor ke file yang isinya sudah berubah (fakta mungkin basi). */
  stale?: boolean
  anchor_path?: string | null
}

export interface StoreConfig {
  dbPath: string
  project: string
}
