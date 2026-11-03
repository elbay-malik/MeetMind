/**
 * Blank, not left out, because a server inherits this process's environment. Nothing puts
 * `.env` there (the Nuxt test config loads `.env.test`, and a built server reads no dotenv
 * file), but a shell could have exported real keys, and writing to the real database from a
 * test run is not a mistake to leave open.
 */
export const REAL_SETTINGS_ABSENT = {
  NUXT_GROQ_API_KEY: '',
  NUXT_WORKERS_AI_ACCOUNT_ID: '',
  NUXT_WORKERS_AI_API_TOKEN: '',
  NUXT_SUPABASE_URL: '',
  NUXT_SUPABASE_SERVICE_KEY: '',
  NUXT_R2_ACCOUNT_ID: '',
  NUXT_R2_ACCESS_KEY_ID: '',
  NUXT_R2_SECRET_ACCESS_KEY: '',
  NUXT_R2_BUCKET: '',
}

/**
 * What every e2e server runs with, unless a spec is about its absence. They run a real
 * production build, which refuses stubs and local stores unless told otherwise
 * (ADR-0016), and it is told the way any server would be: nothing in it knows it is under test.
 */
export const LOCAL_DRIVERS = { NUXT_ALLOW_LOCAL_DRIVERS: 'true', ...REAL_SETTINGS_ABSENT }
