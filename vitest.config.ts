import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'hono/jsx' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, pool: 'forks' }
})
