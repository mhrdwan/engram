import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Jalankan file test SATU per satu. Tiap file meng-import @xenova/transformers
    // (onnxruntime native yang berat); menjalankan banyak worker paralel bisa
    // memicu OOM/SIGTRAP di CI/mesin dengan RAM terbatas.
    fileParallelism: false,
  },
})
