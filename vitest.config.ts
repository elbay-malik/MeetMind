import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // Default environment is node. Files named *.nuxt.spec.ts opt into the
    // Nuxt runtime environment (happy-dom) per @nuxt/test-utils convention.
    // Server-route tests live in tests/e2e and run via `pnpm test:e2e`.
    include: ['tests/unit/**/*.spec.ts', 'tests/nuxt/**/*.spec.ts'],
    // The e2e tier needs a built app and the services tier needs credentials.
    exclude: ['tests/e2e/**', 'tests/services/**'],
    // GitHub's runner is up to 15 times slower than a laptop here, and a test past its time
    // keeps running into the next, so a few sweeps and plans need far more than the default 5 s.
    testTimeout: 60_000,
  },
})
