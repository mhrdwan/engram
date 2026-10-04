// Urutan recall: kecocokan kata kunci harus MENANG atas popularitas.
// Regresi: skor FTS dulu `Math.abs(rank) * -0.5` — bm25 FTS5 bernilai negatif
// dan makin negatif = makin cocok, jadi catatan PALING cocok justru dihukum
// paling berat; ditambah access_count tak berbatas, catatan yang sering
// dipanggil menenggelamkan catatan baru yang tepat sasaran.
process.env.ENGRAM_NO_EMBED = '1'

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type * as DbModule from '../store/db.js'
import type * as StoreModule from '../store/memory-store.js'

let db: typeof DbModule
let store: typeof StoreModule

describe('recall ranking', () => {
  beforeAll(async () => {
    db = await import('../store/db.js')
    store = await import('../store/memory-store.js')
  })
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-rank-'))
    db.openDb(path.join(dir, 'test.db'))
  })
  afterEach(() => db.closeDb())

  const buat = (content: string) =>
    store.createMemory({ content, type: 'fact', tags: [], project: 'p', scope: 'project' })

  it('catatan yang memuat semua kata kunci di atas catatan populer yang hanya memuat satu', async () => {
    const populer = await buat('Deploy CMS lewat banner workflow GitHub Actions, verifikasi bundel live.')
    db.getDb().prepare('UPDATE memories SET access_count = 40 WHERE id = ?').run(populer.memory.id)
    const tepat = await buat('Beranda JXPass: hero penuh-lebar, lengkung bawah menggembung, banner slider CMS.')

    const hasil = await store.searchMemories({ query: 'JXPass hero lengkung banner', project: 'p' })
    expect(hasil[0]?.id).toBe(tepat.memory.id)
  })

  it('di antara dua yang cocok, kecocokan lebih kuat menang', async () => {
    const lemah = await buat('Catatan tentang hero saja dan hal lain yang tidak berkaitan sama sekali di sini.')
    const kuat = await buat('Hero JXPass lengkung hero JXPass lengkung.')
    const hasil = await store.searchMemories({ query: 'hero JXPass lengkung', project: 'p' })
    expect(hasil.map(r => r.id).indexOf(kuat.memory.id)).toBeLessThan(hasil.map(r => r.id).indexOf(lemah.memory.id))
  })
})
