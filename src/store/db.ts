import Database from 'better-sqlite3'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'general',
    tags        TEXT NOT NULL DEFAULT '[]',
    project     TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL DEFAULT 'project',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed INTEGER,
    embedding   BLOB -- Float32Array
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    content,
    tags,
    type,
    content='memories',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, id, content, tags, type)
    VALUES (new.rowid, new.id, new.content, new.tags, new.type);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, type)
    VALUES ('delete', old.rowid, old.id, old.content, old.tags, old.type);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, type)
    VALUES ('delete', old.rowid, old.id, old.content, old.tags, old.type);
    INSERT INTO memories_fts(rowid, id, content, tags, type)
    VALUES (new.rowid, new.id, new.content, new.tags, new.type);
  END;
`

let _db: Database.Database | null = null

// Kolom "living memory" ditambahkan lewat migrasi additive agar DB lama ikut
// terupgrade tanpa kehilangan data:
//  - anchor_path / anchor_hash → self-invalidating (deteksi fakta basi)
//  - tokens_saved / tokens_spent → ROI ledger (evict-by-value, bukan by-age)
const EXTRA_COLUMNS: Array<[string, string]> = [
  ['anchor_path', 'TEXT'],
  ['anchor_hash', 'TEXT'],
  ['tokens_saved', 'INTEGER NOT NULL DEFAULT 0'],
  ['tokens_spent', 'INTEGER NOT NULL DEFAULT 0'],
]

function ensureColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name)
  )
  for (const [name, def] of EXTRA_COLUMNS) {
    if (existing.has(name)) continue
    try {
      db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`)
    } catch (e) {
      // Race saat first-boot: SessionStart `load` + server sama-sama openDb DB
      // bersama. Kalau proses lain sudah menambah kolomnya, jangan crash.
      if (!/duplicate column/i.test(errMsg(e))) throw e
    }
  }
}

export function openDb(dbPath: string): Database.Database {
  if (_db) return _db
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  // run schema statements one by one (better-sqlite3 exec handles multi-statement)
  _db.exec(SCHEMA)
  ensureColumns(_db)
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call openDb() first')
  return _db
}

/**
 * One-time, best-effort migration dari DB per-project lama
 * (`<project>/.cacheai/memory.db`) ke unified DB (`~/.cacheai/memory.db`).
 *
 * Dulu tiap project menulis ke file DB sendiri, sehingga memory scope `global`
 * tidak pernah terlihat lintas project ("kadang lupa"). Sekarang semua memory
 * hidup di satu DB dan dipartisi lewat kolom `project`. Baris legacy diberi
 * `project = projectKey` karena legacy DB berada di dalam folder project ini.
 *
 * Dijalankan HANYA SEKALI: setelah sukses, sebuah marker file ditulis di
 * samping DB legacy sehingga boot berikutnya melewatinya. Ini penting karena
 * migrasi dipanggil tiap boot/`load` — tanpa marker, memory yang sudah
 * di-`forget` user (terhapus dari unified DB, tapi masih ada di file legacy)
 * akan "bangkit" lagi lewat INSERT OR IGNORE pada tiap sesi.
 *
 * Kegagalan tidak menjatuhkan server.
 */
export function migrateLegacyDb(legacyPath: string, projectKey: string): number {
  if (!_db) throw new Error('DB not initialized — call openDb() first')
  if (!legacyPath || !existsSync(legacyPath)) return 0

  // Sudah pernah dimigrasikan → jangan pindai/insert ulang (dan jangan bangkitkan yang di-forget).
  const marker = join(dirname(legacyPath), '.cacheai-migrated')
  if (existsSync(marker)) return 0

  // Jangan migrasikan kalau legacy adalah file yang sama dengan DB aktif.
  try {
    if (resolve(legacyPath) === resolve(_db.name)) return 0
  } catch {
    /* abaikan */
  }

  let migrated = 0
  let legacy: Database.Database | null = null
  try {
    legacy = new Database(legacyPath, { readonly: true })

    const memRows = legacy
      .prepare('SELECT id, content, type, tags, project, scope, created_at, updated_at, access_count, last_accessed, embedding FROM memories')
      .all() as Record<string, unknown>[]

    const insertMem = _db.prepare(`
      INSERT OR IGNORE INTO memories
        (id, content, type, tags, project, scope, created_at, updated_at, access_count, last_accessed, embedding)
      VALUES (@id, @content, @type, @tags, @projectKey, @scope, @created_at, @updated_at, @access_count, @last_accessed, @embedding)
    `)
    const insertMany = _db.transaction((rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        const info = insertMem.run({ ...r, projectKey })
        migrated += info.changes
      }
    })
    insertMany(memRows)

    // Sessions juga (tabel legacy mungkin tidak punya — bungkus try).
    try {
      const sessRows = legacy
        .prepare('SELECT id, project, summary, started_at, ended_at FROM sessions')
        .all() as Record<string, unknown>[]
      const insertSess = _db.prepare(`
        INSERT OR IGNORE INTO sessions (id, project, summary, started_at, ended_at)
        VALUES (@id, @projectKey, @summary, @started_at, @ended_at)
      `)
      const insertSessMany = _db.transaction((rows: Record<string, unknown>[]) => {
        for (const r of rows) insertSess.run({ ...r, projectKey })
      })
      insertSessMany(sessRows)
    } catch {
      /* legacy tanpa tabel sessions — abaikan */
    }

    // Tandai selesai (hanya tercapai bila tak ada exception di atas).
    try {
      writeFileSync(marker, `migrated ${migrated} memories to key "${projectKey}"\n`)
    } catch (e) {
      console.error('[engram] could not write migration marker:', errMsg(e))
    }
  } catch (err) {
    console.error('[engram] legacy migration skipped:', errMsg(err))
  } finally {
    legacy?.close()
  }

  return migrated
}
