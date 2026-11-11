import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // PGlite and Miniflare take a few seconds to boot
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
})
