import { defineVitestConfig } from '@nuxt/test-utils/config'

// Server-route tests: @nuxt/test-utils builds the app once per file and runs
// it as a real Nitro server. Slow (a full build), so kept out of `pnpm test`.
export default defineVitestConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    // defineVitestConfig always adds a `nuxt` project matching `tests/nuxt/**`
    // whatever `include` says, so exclude it explicitly or these runs also
    // execute the component tests.
    exclude: ['tests/nuxt/**', 'tests/unit/**'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
})
