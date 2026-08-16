import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'

/**
 * Self-invalidating memory — bagian pembeda Engram.
 *
 * Sebuah memory bisa "di-anchor" ke sebuah file. Kita simpan hash isi file saat
 * memory dibuat. Saat recall, kita bandingkan dengan hash file SEKARANG — kalau
 * berbeda, memory ditandai `stale` (fakta mungkin sudah usang karena kode berubah).
 * Ini "cache invalidation"-nya AI memory: fakta basi lebih berbahaya daripada
 * tidak ada fakta, karena menyesatkan.
 */

// Di atas ukuran ini, hash pakai proxy ukuran+mtime alih-alih membaca seluruh isi.
const LARGE_FILE_BYTES = 1_000_000

/** Hash isi file (sha1, 16 char). 'MISSING' bila file hilang, 'ERROR' bila gagal baca. */
export function computeAnchorHash(absPath: string): string {
  try {
    if (!existsSync(absPath)) return 'MISSING'
    // File besar → pakai ukuran+mtime sebagai proxy agar tak baca seluruh isi.
    const st = statSync(absPath)
    if (st.size > LARGE_FILE_BYTES) return `meta:${st.size}:${Math.floor(st.mtimeMs)}`
    const buf = readFileSync(absPath)
    return createHash('sha1').update(buf).digest('hex').slice(0, 16)
  } catch {
    return 'ERROR'
  }
}

/** True bila memory ter-anchor DAN hash file sekarang beda dari yang tersimpan. */
export function isStale(anchorPath: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!anchorPath || !storedHash) return false
  return computeAnchorHash(anchorPath) !== storedHash
}
