import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import Database from 'better-sqlite3'

export interface Config {
  projectDir: string
  /** Nama project untuk ditampilkan (basename folder). */
  projectName: string
  /** Kunci stabil yang dipakai sebagai kolom `project` di DB. */
  projectKey: string
  /** Unified DB — satu-satunya sumber kebenaran (lintas project). */
  dbPath: string
  /** DB per-project lama untuk dimigrasikan sekali (kalau ada). */
  legacyDbPath: string
}

/** Baca env dengan nama Engram, fallback ke nama cacheAI lama (kompat). */
function readEnv(name: string): string | undefined {
  const v = process.env[`ENGRAM_${name}`]?.trim() || process.env[`CACHEAI_${name}`]?.trim()
  return v || undefined
}

/**
 * Migrasi satu kali store global dari lokasi cacheAI lama (~/.cacheai/memory.db)
 * ke lokasi Engram (~/.engram/memory.db). Hanya jalan bila target belum ada.
 */
function migrateGlobalStore(newDbPath: string): void {
  try {
    if (fs.existsSync(newDbPath)) return
    const oldDb = path.join(os.homedir(), '.cacheai', 'memory.db')
    if (!fs.existsSync(oldDb)) return

    // Fold WAL ke file utama dulu supaya menyalin satu file .db konsisten
    // (menghindari pasangan WAL/main yang tidak sinkron kalau di-copy mentah).
    try {
      const old = new Database(oldDb)
      old.pragma('wal_checkpoint(TRUNCATE)')
      old.close()
    } catch {
      /* kalau tak bisa checkpoint (mis. terkunci proses lain), fallback copy mentah di bawah */
    }

    fs.copyFileSync(oldDb, newDbPath)
    // Salin sisa WAL/SHM kalau checkpoint gagal (best-effort, tetap konsisten mayoritas kasus).
    for (const suffix of ['-wal', '-shm']) {
      const src = oldDb + suffix
      if (fs.existsSync(src)) fs.copyFileSync(src, newDbPath + suffix)
    }
  } catch {
    /* best-effort — jangan jatuhkan boot */
  }
}

/**
 * Cari akar repo git dengan naik direktori mencari `.git` (folder ATAU berkas —
 * worktree & submodule memakai berkas `.git`). Tanpa spawn `git` supaya murah
 * di jalur hook. Null bila tidak di dalam repo git. Tidak pernah melempar.
 */
export function findGitRoot(startDir: string): string | null {
  try {
    let dir = path.resolve(startDir)
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

export function resolveConfig(projectArg?: string): Config {
  // --project flag atau cwd
  const projectDir = projectArg
    ? path.resolve(projectArg)
    : process.cwd()

  // Nama project = basename AKAR GIT (bukan folder saat ini) supaya sesi yang
  // dibuka di subfolder (mis. API/order-service) tidak memecah catatan satu repo
  // ke banyak kunci. Di luar repo git → basename folder seperti dulu.
  const projectName = path.basename(findGitRoot(projectDir) ?? projectDir)

  // Kunci project: default nama di atas, bisa dioverride via ENGRAM_PROJECT
  // untuk menghindari tabrakan bila dua folder berbeda punya nama sama.
  const projectKey = readEnv('PROJECT') || projectName

  // ~/.engram/ — unified store. Bisa dioverride via ENGRAM_DB.
  const globalDir = path.join(os.homedir(), '.engram')
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true })
  }
  const dbOverride = readEnv('DB')
  const dbPath = dbOverride ? path.resolve(dbOverride) : path.join(globalDir, 'memory.db')
  // Pastikan folder induk DB ada (override bisa menunjuk ke folder yang belum dibuat).
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // Migrasi store cacheAI lama → Engram (sekali, hanya bila pakai lokasi default).
  if (!dbOverride) migrateGlobalStore(dbPath)

  // Lokasi DB per-project lama (era cacheAI v3) untuk migrasi satu kali.
  const legacyDbPath = path.join(projectDir, '.cacheai', 'memory.db')

  return {
    projectDir,
    projectName,
    projectKey,
    dbPath,
    legacyDbPath,
  }
}
