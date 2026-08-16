import { env, pipeline } from '@xenova/transformers'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// Simpan model cache di ~/.engram/models. Kalau belum ada tapi cache cacheAI
// lama ada, pakai itu agar tak perlu re-download model 23MB.
const engramModels = path.join(os.homedir(), '.engram', 'models')
const legacyModels = path.join(os.homedir(), '.cacheai', 'models')
env.cacheDir = fs.existsSync(engramModels) || !fs.existsSync(legacyModels) ? engramModels : legacyModels
// Matikan remote fetch error spam jika offline (bisa fallback ke cache)
env.allowLocalModels = true

// Set ENGRAM_NO_EMBED=1 (atau CACHEAI_NO_EMBED=1) untuk mematikan embedding
// sepenuhnya (keyword-only). Berguna tanpa RAM/CPU cukup atau offline tanpa cache.
const EMBEDDING_DISABLED =
  process.env.ENGRAM_NO_EMBED === '1' || process.env.CACHEAI_NO_EMBED === '1'

let embedderPromise: Promise<any> | null = null
let embedderBroken = false

export async function getEmbedder() {
  if (!embedderPromise) {
    // Model kecil, cepat, standar untuk RAG (all-MiniLM-L6-v2) ~22MB
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true, // pakai INT8 biar ringan di RAM/CPU
    })
  }
  return embedderPromise
}

/**
 * Hangatkan model di background saat server boot supaya call pertama
 * (recall/remember) tidak kena latency cold-start beberapa detik.
 * Fire-and-forget: kegagalan di sini tidak boleh menjatuhkan server.
 */
export function warmupEmbedder(): void {
  if (EMBEDDING_DISABLED) return
  getEmbedder().catch(() => {
    // Biarkan safeEmbedText yang menangani degradasi ke keyword-only.
  })
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Versi tahan-banting dari embedding.
 *
 * Mengembalikan `null` (bukan throw) jika embedding gagal atau dimatikan,
 * sehingga pemanggil bisa degradasi ke keyword/FTS-only alih-alih membuat
 * seluruh tool call gagal. Ini penyebab utama "kadang gagal ambil ke database":
 * dulu satu error embedding menjatuhkan remember & recall sepenuhnya.
 *
 * Circuit breaker hanya "putus" bila MODEL gagal dimuat (masalah permanen se-proses).
 * Kegagalan spesifik-input tidak mematikan semantik untuk input lain.
 */
export async function safeEmbedText(text: string): Promise<number[] | null> {
  if (EMBEDDING_DISABLED || embedderBroken) return null

  let extractor: any
  try {
    extractor = await getEmbedder()
  } catch (err) {
    // Model tidak bisa dimuat (offline tanpa cache, korup, OOM saat load).
    // Retry per-call tidak berguna → matikan semantik untuk sesa proses.
    embedderBroken = true
    console.error('[engram] embedding model unavailable, falling back to keyword search:', errMsg(err))
    return null
  }

  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data) as number[]
  } catch (err) {
    // Kegagalan untuk satu input (mis. terlalu panjang) — jangan matikan semantik global.
    console.error('[engram] embedding failed for one input, using keyword for it:', errMsg(err))
    return null
  }
}

// Cosine similarity (karena output normalize=true, ini sama dengan dot product)
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0
  let dotProduct = 0
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
  }
  return dotProduct
}
