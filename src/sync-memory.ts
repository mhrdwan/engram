// `engram sync-memory`: impor memori bawaan Claude Code (berkas .md) ke Engram,
// supaya catatan yang ditulis model ke MEMORY.md juga bisa di-recall dari klien
// lain (Codex, Gemini, Cursor, OpenCode…) dan lewat pencarian semantik.
//
// Identitas catatan = anchor_path (path absolut berkas .md) + tag `cc-memory`.
// anchor_hash = hash isi berkas → (a) penanda "tak berubah, lewati", dan
// (b) catatan otomatis ⚠️stale bila berkas berubah sebelum sinkron berikutnya.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './store/db.js'
import { safeEmbedText } from './store/embedder.js'
import { computeAnchorHash } from './store/anchor.js'
import { CC_TAG, listMemoryFiles, readMemoryFile } from './cc-memory.js'

export interface SyncResult {
  dir: string
  added: number
  updated: number
  unchanged: number
  removed: number
  skipped: number
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

async function embedBuffer(text: string): Promise<Buffer | null> {
  const v = await safeEmbedText(text)
  return v ? Buffer.from(new Float32Array(v).buffer) : null
}

/**
 * Sinkronkan satu folder memori ke project `projectKey`. Upsert per berkas,
 * lewati yang hash-nya sama, hapus salinan (HANYA yang bertag cc-memory & berasal
 * dari folder ini) bila berkasnya sudah dihapus. Melempar hanya untuk galat DB —
 * pemanggil jalur hook wajib membungkusnya.
 */
export async function syncMemoryDir(memDir: string, projectKey: string): Promise<SyncResult> {
  const db = getDb()
  const dir = path.resolve(memDir)
  const res: SyncResult = { dir, added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 }

  const rows = db.prepare(
    `SELECT id, anchor_path, anchor_hash FROM memories WHERE project = ? AND tags LIKE ?`
  ).all(projectKey, `%"${CC_TAG}"%`) as { id: string; anchor_path: string | null; anchor_hash: string | null }[]

  // Hanya baris milik folder ini (folder lain yang dipetakan ke project sama aman).
  const inDir = (p: string | null) => !!p && path.dirname(p) === dir
  const byPath = new Map<string, { id: string; anchor_hash: string | null }>()
  const extras: string[] = []
  for (const r of rows) {
    if (!inDir(r.anchor_path)) continue
    if (byPath.has(r.anchor_path!)) extras.push(r.id) // duplikat (seharusnya tak terjadi)
    else byPath.set(r.anchor_path!, r)
  }

  const files = listMemoryFiles(dir)
  const present = new Set(files)
  const ts = Date.now()

  const insert = db.prepare(`
    INSERT INTO memories (id, content, type, tags, project, scope, created_at, updated_at, access_count, last_accessed, embedding, anchor_path, anchor_hash)
    VALUES (?, ?, ?, ?, ?, 'project', ?, ?, 0, NULL, ?, ?, ?)
  `)
  const update = db.prepare(`
    UPDATE memories SET content = ?, type = ?, tags = ?, updated_at = ?, embedding = ?, anchor_hash = ? WHERE id = ?
  `)

  for (const file of files) {
    const hash = computeAnchorHash(file)
    const existing = byPath.get(file)
    if (existing && existing.anchor_hash === hash) { res.unchanged++; continue }

    const mem = readMemoryFile(file)
    if (!mem) { res.skipped++; continue }
    const tags = JSON.stringify([CC_TAG, `${CC_TAG}:${mem.key}`, `cc-type:${mem.ccType || 'unknown'}`])
    const emb = await embedBuffer(mem.content)

    if (existing) {
      update.run(mem.content, mem.type, tags, ts, emb, hash, existing.id)
      res.updated++
    } else {
      insert.run(randomUUID(), mem.content, mem.type, tags, projectKey, ts, ts, emb, file, hash)
      res.added++
    }
  }

  // Berkas yang dihapus → hapus salinannya. Hanya bila folder sungguh terbaca
  // (listMemoryFiles [] karena galat baca tak boleh menyapu semua salinan).
  const del = db.prepare('DELETE FROM memories WHERE id = ?')
  const stale = [...byPath.entries()].filter(([p]) => !present.has(p)).map(([, r]) => r.id)
  if (files.length > 0 || dirIsReadableAndEmpty(dir)) {
    db.transaction((ids: string[]) => { for (const id of ids) del.run(id) })([...stale, ...extras])
    res.removed = stale.length
  }

  return res
}

/** Folder terbaca & memang tak berisi berkas memori (beda dari galat baca). */
function dirIsReadableAndEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).filter(n => /\.md$/i.test(n) && n !== 'MEMORY.md').length === 0
  } catch {
    return false
  }
}
