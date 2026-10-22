import { readFileSync } from 'node:fs'
import { defineVitestConfig } from '@nuxt/test-utils/config'

/**
 * Load `.env` here, not in the spec: `describe.skipIf` is evaluated during
 * collection, and when every group skips vitest never imports the spec at all,
 * so anything it printed would be invisible.
 */
function loadDotEnv() {
  try {
    for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (match?.[1] && !process.env[match[1]]) {
        process.env[match[1]] = match[2]!.trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  catch { /* no .env; ambient environment only */ }
}
loadDotEnv()

const set = (...keys: string[]) => keys.every(k => (process.env[k] ?? '').length > 0)

/**
 * One entry per `describe.skipIf` group in tests/services/real-services.spec.ts.
 * Keep them in step: a group missing from here still runs, but the banner then
 * under-reports what was covered, and this banner is the only way to tell a
 * credential-less skip from a check that quietly stopped existing. Gemini was
 * absent from this list while its three checks were running and passing, which
 * is the mistake worth not repeating.
 */
const groups: [name: string, keys: string[]][] = [
  ['R2', ['NUXT_R2_ACCOUNT_ID', 'NUXT_R2_ACCESS_KEY_ID', 'NUXT_R2_SECRET_ACCESS_KEY', 'NUXT_R2_BUCKET']],
  ['Supabase', ['NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY']],
  ['Groq', ['NUXT_GROQ_API_KEY']],
  ['Gemini', ['NUXT_GEMINI_API_KEY']],
]
const detected = groups.filter(([, keys]) => set(...keys)).map(([name]) => name)
const absent = groups.filter(([, keys]) => !set(...keys)).map(([name]) => name)
// Name the skips as well as the hits: "10 passed, 6 skipped" on its own does
// not say whether the 6 were skipped for want of a key or for want of a test.
console.info(
  detected.length
    ? `[verify] credentials detected for: ${detected.join(', ')}`
    + (absent.length ? ` — skipping: ${absent.join(', ')} (no credentials)` : ' — all groups covered')
    : '[verify] no credentials detected — every check will skip. Set them in .env or the environment.',
)

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
