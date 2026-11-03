import { defineVitestConfig } from '@nuxt/test-utils/config'

// The real Supabase drivers against a throwaway Postgres with PostgREST in front
// (scripts/lib/throwaway-postgrest.mjs). Needs Docker, reads no .env and reaches no real
// project, so it needs none of the credentials `pnpm test:services` does. Kept out of `pnpm test`,
// which needs nothing running; verify-migrations.sh is what `pnpm ci:local` holds the SQL to.
export default defineVitestConfig({
  test: {
    include: ['tests/postgrest/**/*.spec.ts'],
    // defineVitestConfig always adds a `nuxt` project matching `tests/nuxt/**`
    // whatever `include` says, so exclude it explicitly or these runs also
    // execute the component tests.
    exclude: ['tests/nuxt/**', 'tests/unit/**', 'tests/e2e/**', 'tests/services/**'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
