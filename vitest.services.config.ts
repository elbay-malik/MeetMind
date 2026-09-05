import { defineVitestConfig } from '@nuxt/test-utils/config'

// Verifies the real cloud services against their drivers. Excluded from the
// default run because it needs credentials and does real network I/O.
export default defineVitestConfig({
  test: {
    include: ['tests/services/**/*.spec.ts'],
    // defineVitestConfig always adds a `nuxt` project matching `tests/nuxt/**`
    // whatever `include` says, so exclude it explicitly or these runs also
    // execute the component tests.
    exclude: ['tests/nuxt/**', 'tests/unit/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // These talk to shared remote state; running them in parallel invites
    // interference between checks.
    fileParallelism: false,
  },
})
