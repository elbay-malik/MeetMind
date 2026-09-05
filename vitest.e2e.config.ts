import { defineVitestConfig } from '@nuxt/test-utils/config'

// Server-route tests: @nuxt/test-utils builds the app once per file and runs
// it as a real Nitro server. Slow (a full build), so kept out of `pnpm test`.
export default defineVitestConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
})
