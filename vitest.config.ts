import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // Default environment is node. Files named *.nuxt.spec.ts opt into the
    // Nuxt runtime environment (happy-dom) per @nuxt/test-utils convention.
  },
})
