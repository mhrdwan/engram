import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getDb } from './db.js'
import { safeEmbedText, cosineSimilarity } from './embedder.js'
import { computeAnchorHash, isStale } from './anchor.js'
import type { Memory, MemoryType, RecallResult } from '../types.js'

function now(): number {
  return Date.now()
}

/** Resolusi path anchor ke absolut (relatif → terhadap cwd = folder project). */
function resolveAnchor(p: string): string {
  return path.resolve(p)
}

/** Estimasi token dari sebuah teks (konvensi ceil(bytes/4)). */
export function estTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / 4)
}

// Saat sebuah memory di-recall, ia menghemat biaya menurunkan-ulang fakta itu
// (baca file dsb). Kita kreditkan ~faktor ini × ukurannya sebagai "tokens_saved".
const SAVE_FACTOR = 3

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Parse kolom `tags` (JSON) dengan aman — baris legacy/migrasi bisa saja rusak. */
function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

// Bobot per tipe — keputusan & arsitektur paling berharga.
const TYPE_WEIGHT: Record<string, number> = {
  decision: 7, architecture: 6, bug: 5,
  preference: 4, fact: 3, session: 2, general: 1,
}

/**
 * Skor relevansi non-semantik yang dipakai untuk list, konteks sesi, dan prune.
 *
 * Rumus lama (`access_count*2 + created_at/1e6`) praktis rusak: suku created_at
 * (~1.75 juta) mendominasi total sehingga access_count jadi noise dan urutan
 * de-facto hanya "terbaru". Di sini recency dinormalisasi ke 0..1 sehingga
 * frekuensi akses benar-benar berpengaruh.
 */
function memoryScore(
  row: { type: string; access_count: number; created_at: number },
  nowTs: number
): number {
  // clamp: created_at di masa depan (clock skew / data korup) tak boleh meledakkan skor.
  const ageDays = Math.max(0, (nowTs - row.created_at) / DAY_MS)
  const recency = 1 / (1 + ageDays / 14) // half-life ~14 hari, terikat 0..1
  const typeW = TYPE_WEIGHT[row.type] ?? 1
  return row.access_count * 1.0 + recency * 3.0 + typeW * 0.2
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  const intersection = new Set([...a].filter(x => b.has(x)))
  const union = new Set([...a, ...b])
  return intersection.size / union.size
}

export async function findDuplicate(params: {
  content: string
  type: MemoryType
  project: string
  scope: 'project' | 'global'
  threshold?: number
}): Promise<string | null> {
  const db = getDb()
  const { content, type, project, scope, threshold = 0.65 } = params

  const candidates = db.prepare(
    `SELECT id, content FROM memories
     WHERE type = ? AND (project = ? OR scope = 'global')
     ORDER BY created_at DESC LIMIT 50`
  ).all(type, project) as { id: string; content: string }[]

  const incoming = tokenize(content)
  for (const c of candidates) {
    if (jaccard(incoming, tokenize(c.content)) >= threshold) return c.id
  }
  return null
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export interface CreateResult {
  memory: Memory
  deduplicated: boolean
  mergedInto?: string
}

export async function createMemory(params: {
  content: string
  type: MemoryType
  tags: string[]
  project: string
  scope: 'project' | 'global'
  skipDedup?: boolean
  /** Path file sumber fakta ini — memory jadi self-invalidating (deteksi basi). */
  anchor?: string
}): Promise<CreateResult> {
  const db = getDb()

  if (!params.skipDedup) {
    const existingId = await findDuplicate({
      content: params.content,
      type: params.type,
      project: params.project,
      scope: params.scope,
    })
    // getMemoryById bisa null bila baris terhapus (race dgn forget) antara
    // findDuplicate dan sini — kalau begitu, jatuh ke pembuatan baru di bawah.
    const existing = existingId ? getMemoryById(existingId) : null
    if (existingId && existing) {
      const ts = now()
      const mergedTags = [...new Set([...existing.tags, ...params.tags])]

      const longer = params.content.length >= existing.content.length ? params.content : existing.content
      const shorter = params.content.length >= existing.content.length ? existing.content : params.content

      // True-duplicate (yang pendek terkandung di panjang, atau nyaris identik) → simpan yang lengkap.
      // Berbeda substansial meski token overlap tinggi → GABUNG keduanya, jangan buang salah satu.
      const contained = longer.toLowerCase().includes(shorter.toLowerCase())
      const veryClose = jaccard(tokenize(existing.content), tokenize(params.content)) >= 0.9
      const keptContent = contained || veryClose ? longer : `${existing.content} | ${params.content}`

      const vector = await safeEmbedText(keptContent)
      if (vector) {
        const buffer = Buffer.from(new Float32Array(vector).buffer)
        db.prepare(
          'UPDATE memories SET content = ?, tags = ?, updated_at = ?, embedding = ? WHERE id = ?'
        ).run(keptContent, JSON.stringify(mergedTags), ts, buffer, existingId)
      } else {
        // Embedding tidak tersedia → tetap update teks/tags (jangan hapus embedding lama).
        db.prepare(
          'UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?'
        ).run(keptContent, JSON.stringify(mergedTags), ts, existingId)
      }

      // Anchor yang diberikan saat merge tidak boleh hilang diam-diam.
      if (params.anchor) {
        const ap = resolveAnchor(params.anchor)
        db.prepare('UPDATE memories SET anchor_path = ?, anchor_hash = ? WHERE id = ?')
          .run(ap, computeAnchorHash(ap), existingId)
      }

      const updated = getMemoryById(existingId)
      if (updated) {
        return { memory: updated, deduplicated: true, mergedInto: existingId }
      }
      // baris hilang tepat setelah update (sangat jarang) → lanjut buat baru.
    }
  }

  const id = randomUUID()
  const ts = now()
  const vector = await safeEmbedText(params.content)
  const buffer = vector ? Buffer.from(new Float32Array(vector).buffer) : null

  const anchorPath = params.anchor ? resolveAnchor(params.anchor) : null
  const anchorHash = anchorPath ? computeAnchorHash(anchorPath) : null

  db.prepare(`
    INSERT INTO memories (id, content, type, tags, project, scope, created_at, updated_at, access_count, last_accessed, embedding, anchor_path, anchor_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
  `).run(
    id, params.content, params.type,
    JSON.stringify(params.tags),
    params.project, params.scope, ts, ts, buffer, anchorPath, anchorHash
  )

  return { memory: getMemoryById(id)!, deduplicated: false }
}

// ─── READ ─────────────────────────────────────────────────────────────────────

export function getMemoryById(id: string): Memory | null {
  const row = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as RawRow | undefined
  return row ? rowToMemory(row) : null
}

export function listMemories(params: {
  project: string
  type?: MemoryType
  tag?: string
  scope?: 'project' | 'global' | 'all'
  limit?: number
}): Memory[] {
  const db = getDb()
  const { project, type, tag, scope = 'all', limit = 50 } = params

  let where = '1=1'
  const bindings: (string | number)[] = []

  if (scope === 'global') {
    where += " AND scope = 'global'"
  } else {
    // project & all → project ini + global
    where += " AND (project = ? OR scope = 'global')"
    bindings.push(project)
  }

  if (type) {
    where += ' AND type = ?'
    bindings.push(type)
  }

  if (tag) {
    where += ' AND tags LIKE ?'
    bindings.push(`%"${tag}"%`)
  }

  // Ambil kandidat lalu ranking di JS (rumus SQL lama membuat access_count jadi noise).
  // ORDER BY sebelum LIMIT: kalau set > cap, pertahankan yang paling sering diakses &
  // terbaru sebagai kandidat — bukan subset arbitrer (biasanya baris tertua).
  const rows = db.prepare(
    `SELECT * FROM memories WHERE ${where} ORDER BY access_count DESC, created_at DESC LIMIT 2000`
  ).all(...bindings) as RawRow[]

  const nowTs = now()
  return rows
    .map(r => ({ r, s: memoryScore(r, nowTs) }))
    .sort((a, b) => b.s - a.s || b.r.created_at - a.r.created_at)
    .slice(0, limit)
    .map(x => rowToMemory(x.r))
}

// ─── SEARCH (Hybrid: Vector RAG + FTS5 + Relevance) ──────────────────────────

export async function searchMemories(params: {
  query: string
  project: string
  scope?: 'project' | 'global' | 'all'
  limit?: number
}): Promise<RecallResult[]> {
  const db = getDb()
  const { query, project, scope = 'all', limit = 10 } = params

  // 1. Embedding query — bisa null bila embedding dimatikan/gagal (keyword-only).
  const queryVector = await safeEmbedText(query)

  // 2. FTS5 OR match (broad match)
  const queryTokens = query
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)

  const ftsQuery = queryTokens.length > 0 ? queryTokens.join(' OR ') : ''

  let scopeFilter = '1=1'
  const bindings: (string | number)[] = []

  if (scope === 'global') {
    scopeFilter = "scope = 'global'"
  } else {
    scopeFilter = "(project = ? OR scope = 'global')"
    bindings.push(project)
  }

  // Pool kandidat lebih besar untuk di-rerank via vektor.
  let candidates: (RawRow & { fts_rank: number })[] = []

  if (ftsQuery) {
    try {
      candidates = db.prepare(`
        SELECT m.*, rank as fts_rank
        FROM memories_fts
        JOIN memories m ON memories_fts.id = m.id
        WHERE memories_fts MATCH ? AND ${scopeFilter.replace(/project/g, 'm.project').replace(/scope/g, 'm.scope')}
        LIMIT 100
      `).all(ftsQuery, ...bindings) as (RawRow & { fts_rank: number })[]
    } catch (err) {
      // Query FTS5 malformed (token spesial) → jangan jatuhkan recall, lanjut ke fallback.
      console.error('[engram] FTS query failed, using recency fallback:', errMsg(err))
      candidates = []
    }
  }

  // Fallback / padding: ambil memory terbaru dalam scope untuk menangkap
  // kecocokan semantik yang lolos dari keyword.
  if (candidates.length < 50) {
    const recents = db.prepare(`
      SELECT *, 0 as fts_rank
      FROM memories
      WHERE ${scopeFilter}
      ORDER BY created_at DESC LIMIT 50
    `).all(...bindings) as (RawRow & { fts_rank: number })[]

    const seen = new Set(candidates.map(c => c.id))
    for (const r of recents) {
      if (!seen.has(r.id)) {
        candidates.push(r)
        seen.add(r.id)
      }
    }
  }

  // 3. Score & rerank
  // bm25 FTS5 bernilai NEGATIF dan makin negatif = makin cocok. Dinormalkan ke
  // 0..1 terhadap kandidat terbaik supaya kata kunci memberi BONUS (dulu
  // `Math.abs(rank) * -0.5` justru menghukum kecocokan terkuat).
  const ftsTerbaik = candidates.reduce((min, c) => Math.min(min, c.fts_rank), 0)
  const nowTs = now()
  const scored = candidates.map(row => {
    let semanticScore = 0
    if (queryVector && row.embedding) {
      const dbVector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      semanticScore = cosineSimilarity(queryVector, Array.from(dbVector))
    }

    const ageDays = Math.max(0, (nowTs - row.created_at) / DAY_MS)
    const recency = 1 / (1 + ageDays / 14)

    const keyword = row.fts_rank < 0 && ftsTerbaik < 0 ? row.fts_rank / ftsTerbaik : 0

    const final_score = (
      (semanticScore * 50) +               // sinyal vektor kuat (0-1 * 50)
      (keyword * 25) +                     // kecocokan kata kunci (0-1 * 25)
      (Math.log1p(row.access_count) * 0.5) + // frekuensi akses — dilog supaya catatan
                                           // populer tak menenggelamkan yang tepat sasaran
      ((TYPE_WEIGHT[row.type] ?? 1) * 0.3) + // prioritas tipe
      (recency * 2)                        // sedikit dorongan untuk yang baru
    )

    return { ...row, semanticScore, final_score }
  })

  // Bila embedding tersedia → boleh menyaring pakai ambang semantik.
  // Bila tidak (queryVector null) → andalkan keyword: hanya simpan yang match FTS.
  const ranked = scored
    .sort((a, b) => b.final_score - a.final_score)
    .filter(r => (queryVector ? r.semanticScore > 0.3 : false) || r.fts_rank < 0)
    .slice(0, limit)

  // 4. Update statistik akses + ROI ledger (recall menghemat penurunan-ulang fakta).
  if (ranked.length > 0) {
    const updateStmt = db.prepare(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ?, tokens_saved = tokens_saved + ? WHERE id = ?'
    )
    const ts = now()
    db.transaction((rows: typeof ranked) => {
      for (const r of rows) updateStmt.run(ts, estTokens(r.content) * SAVE_FACTOR, r.id)
    })(ranked)
  }

  return ranked.map(r => ({
    id: r.id,
    content: r.content,
    type: r.type as MemoryType,
    tags: parseTags(r.tags),
    scope: r.scope as 'project' | 'global',
    created_at: r.created_at,
    relevance_hint: `sim:${r.semanticScore.toFixed(2)}`,
    // Self-invalidating: cek apakah file sumber fakta sudah berubah.
    stale: isStale(r.anchor_path, r.anchor_hash),
    anchor_path: r.anchor_path,
  }))
}

// ─── PRUNING ──────────────────────────────────────────────────────────────────
export function pruneMemories(params: {
  project: string
  maxAge?: number
  maxTotal?: number
  keepMinAccess?: number
}): number {
  const db = getDb()
  const {
    project,
    maxAge = 30 * 24 * 60 * 60 * 1000,
    maxTotal = 500,
    keepMinAccess = 1,
  } = params

  const cutoff = now() - maxAge

  // Salinan memori bawaan Claude Code (tag cc-memory) dikecualikan: sumber
  // kebenarannya berkas .md — membuangnya di sini hanya membuat catatan hilang
  // sampai berkasnya berubah lagi.
  const result = db.prepare(`
    DELETE FROM memories
    WHERE project = ?
      AND access_count < ?
      AND created_at < ?
      AND type NOT IN ('decision', 'architecture')
      AND tags NOT LIKE '%"cc-memory"%'
  `).run(project, keepMinAccess, cutoff)

  const total = (db.prepare('SELECT COUNT(*) as n FROM memories WHERE project = ?').get(project) as { n: number }).n
  let evicted = result.changes

  if (total > maxTotal) {
    // Pilih korban bernilai TERENDAH: skor recency/akses + sinyal ROI. Memory yang
    // cuma dibebankan (di-inject) tapi tak pernah menghemat (net negatif) dibuang duluan.
    const rows = db.prepare(`
      SELECT id, type, access_count, created_at, tokens_saved, tokens_spent FROM memories
      WHERE project = ? AND type NOT IN ('decision', 'architecture')
        AND tags NOT LIKE '%"cc-memory"%'
    `).all(project) as {
      id: string; type: string; access_count: number; created_at: number
      tokens_saved: number; tokens_spent: number
    }[]

    const nowTs = now()
    // Sinyal ROI dibatasi ±3 agar sebanding dengan suku memoryScore (recency/akses/tipe),
    // bukan mendominasi dgn tokens_saved historis yang tak berbatas.
    const roiSignal = (r: { tokens_saved: number; tokens_spent: number }) =>
      Math.max(-3, Math.min(3, (r.tokens_saved - r.tokens_spent) / 500))
    const victims = rows
      .map(r => ({ id: r.id, s: memoryScore(r, nowTs) + roiSignal(r) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, total - maxTotal)

    const del = db.prepare('DELETE FROM memories WHERE id = ?')
    db.transaction((ids: string[]) => { for (const id of ids) del.run(id) })(victims.map(v => v.id))
    evicted += victims.length
  }

  return evicted
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
export function deleteMemory(id: string): boolean {
  return getDb().prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
}

// ─── SESSION ──────────────────────────────────────────────────────────────────
export function createSession(params: { project: string; summary: string; started_at: number }): string {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    'INSERT INTO sessions (id, project, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, params.project, params.summary, params.started_at, now())
  return id
}

export function listSessions(project: string, limit = 10) {
  return getDb().prepare('SELECT * FROM sessions WHERE project = ? ORDER BY ended_at DESC LIMIT ?').all(project, limit)
}

/**
 * Gabungkan semua catatan & sesi dari kunci project `from` ke `to` (mis. setelah
 * kunci project berpindah ke akar git). Satu transaksi; return jumlah baris.
 */
export function mergeProject(from: string, to: string): { memories: number; sessions: number } {
  if (!from || !to || from === to) return { memories: 0, sessions: 0 }
  const db = getDb()
  return db.transaction(() => {
    const memories = db.prepare('UPDATE memories SET project = ? WHERE project = ?').run(to, from).changes
    const sessions = db.prepare('UPDATE sessions SET project = ? WHERE project = ?').run(to, from).changes
    return { memories, sessions }
  })()
}

/** Offset byte transcript yang sudah di-capture (0 bila belum pernah). */
export function getCaptureOffset(transcriptPath: string): number {
  const row = getDb()
    .prepare('SELECT offset FROM capture_offsets WHERE transcript_path = ?')
    .get(transcriptPath) as { offset: number } | undefined
  return row?.offset ?? 0
}

export function setCaptureOffset(transcriptPath: string, offset: number): void {
  getDb().prepare(`
    INSERT INTO capture_offsets (transcript_path, offset, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(transcript_path) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at
  `).run(transcriptPath, offset, now())
}

export function getRecentContext(project: string): string | null {
  const db = getDb()
  const session = db.prepare('SELECT summary FROM sessions WHERE project = ? ORDER BY ended_at DESC LIMIT 1').get(project) as any

  const rows = db.prepare(`
    SELECT id, content, type, access_count, created_at, anchor_path, anchor_hash FROM memories
    WHERE (project = ? OR scope = 'global')
    ORDER BY access_count DESC, created_at DESC
    LIMIT 500
  `).all(project) as {
    id: string; content: string; type: string; access_count: number; created_at: number
    anchor_path: string | null; anchor_hash: string | null
  }[]

  const nowTs = now()
  const topMemories = rows
    .map(r => ({ r, s: memoryScore(r, nowTs) }))
    .sort((a, b) => b.s - a.s || b.r.created_at - a.r.created_at)
    .slice(0, 5)
    .map(x => x.r)

  if (!session && topMemories.length === 0) return null

  // ROI ledger: memory yang di-inject dibayar biayanya (tokens_spent).
  if (topMemories.length > 0) {
    const spend = db.prepare('UPDATE memories SET tokens_spent = tokens_spent + ? WHERE id = ?')
    db.transaction((ms: typeof topMemories) => {
      for (const m of ms) spend.run(estTokens(m.content), m.id)
    })(topMemories)
  }

  const parts: string[] = []
  if (session) parts.push(`Last session: ${session.summary}`)
  if (topMemories.length > 0) {
    parts.push('Key facts: ' + topMemories
      .map(m => `${isStale(m.anchor_path, m.anchor_hash) ? '⚠️stale ' : ''}[${m.type}] ${m.content}`)
      .join(' | '))
  }
  return parts.join('\n')
}

export interface MemoryStats {
  total: number
  byType: { type: string; n: number }[]
  neverAccessed: number
  sessions: number
  tokensSaved: number
  tokensSpent: number
  netTokens: number
  anchored: number
  stale: number
}

// Batas berapa file anchor yang di-rehash saat stats, agar satu panggilan stats
// tak memblok event loop lama bila ada ribuan anchor / anchor di mount lambat.
const STALE_SCAN_CAP = 2000

export function getStats(project: string): MemoryStats {
  const db = getDb()
  const total = (db.prepare("SELECT COUNT(*) as n FROM memories WHERE project = ? OR scope = 'global'").get(project) as { n: number }).n
  const byType = db.prepare("SELECT type, COUNT(*) as n FROM memories WHERE project = ? OR scope = 'global' GROUP BY type").all(project) as { type: string; n: number }[]
  const neverAccessed = (db.prepare("SELECT COUNT(*) as n FROM memories WHERE project = ? AND access_count = 0").get(project) as { n: number }).n
  const sessions = (db.prepare('SELECT COUNT(*) as n FROM sessions WHERE project = ?').get(project) as { n: number }).n

  // ROI ledger — netto token yang dihemat vs dibebani memory.
  const roi = db.prepare(
    "SELECT COALESCE(SUM(tokens_saved),0) as saved, COALESCE(SUM(tokens_spent),0) as spent FROM memories WHERE project = ? OR scope = 'global'"
  ).get(project) as { saved: number; spent: number }

  // Self-invalidating — berapa memory ter-anchor yang sekarang basi (dibatasi).
  const anchored = db.prepare(
    "SELECT anchor_path, anchor_hash FROM memories WHERE (project = ? OR scope = 'global') AND anchor_path IS NOT NULL LIMIT ?"
  ).all(project, STALE_SCAN_CAP) as { anchor_path: string | null; anchor_hash: string | null }[]
  let stale = 0
  for (const a of anchored) if (isStale(a.anchor_path, a.anchor_hash)) stale++

  return {
    total, byType, neverAccessed, sessions,
    tokensSaved: roi.saved, tokensSpent: roi.spent, netTokens: roi.saved - roi.spent,
    anchored: anchored.length, stale,
  }
}

interface RawRow {
  id: string; content: string; type: string; tags: string; project: string; scope: string
  created_at: number; updated_at: number; access_count: number; last_accessed: number | null
  embedding: Buffer | null
  anchor_path: string | null; anchor_hash: string | null
  tokens_saved: number; tokens_spent: number
}
function rowToMemory(row: RawRow): Memory {
  return {
    id: row.id, content: row.content, type: row.type as MemoryType,
    tags: parseTags(row.tags), project: row.project, scope: row.scope as 'project' | 'global',
    created_at: row.created_at, updated_at: row.updated_at,
    access_count: row.access_count, last_accessed: row.last_accessed,
    anchor_path: row.anchor_path ?? null, anchor_hash: row.anchor_hash ?? null,
    tokens_saved: row.tokens_saved ?? 0, tokens_spent: row.tokens_spent ?? 0,
  }
}
