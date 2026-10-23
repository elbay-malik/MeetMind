// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Server-only secrets, overridden by NUXT_* env vars at runtime.
    groqApiKey: '', // NUXT_GROQ_API_KEY
    geminiApiKey: '', // NUXT_GEMINI_API_KEY
    supabaseUrl: '', // NUXT_SUPABASE_URL
    supabaseServiceKey: '', // NUXT_SUPABASE_SERVICE_KEY
    // Cloudflare R2 (S3 API) for compressed audio. All four must be set to
    // activate the R2 driver; otherwise the local filesystem driver is used.
    r2AccountId: '', // NUXT_R2_ACCOUNT_ID
    r2AccessKeyId: '', // NUXT_R2_ACCESS_KEY_ID
    r2SecretAccessKey: '', // NUXT_R2_SECRET_ACCESS_KEY
    r2Bucket: '', // NUXT_R2_BUCKET
    // Self-imposed storage ceiling, because R2 has none: past the free
    // allowance Cloudflare bills rather than refusing, and storage is the
    // charge that recurs every month for as long as an object exists. Default
    // 8 GiB, under R2's 10 GB-month free tier with room for the estimate to be
    // a little behind reality. 0 disables the check.
    r2MaxStoredBytes: 8 * 1024 * 1024 * 1024, // NUXT_R2_MAX_STORED_BYTES
    // Days the bucket's lifecycle rule keeps audio. MUST match the rule itself
    // (see the R2 setup steps in the README) -- it is how the byte estimate
    // knows which uploads Cloudflare has already deleted. 0 means no rule, so
    // nothing is assumed to expire.
    r2RetentionDays: 30, // NUXT_R2_RETENTION_DAYS
    // Local drivers only (dev/tests): HMAC secret for upload URLs and data root.
    uploadTokenSecret: '', // NUXT_UPLOAD_TOKEN_SECRET (random per process when empty)
    dataDir: '.data', // NUXT_DATA_DIR
    // Test-only: makes the stub summarizer emit one item whose quote does not
    // occur in the transcript, so tests can prove reconciliation actually
    // drops it over the real HTTP path rather than only in a unit test that
    // calls reconcile() directly. Never set outside tests.
    summaryStubCanary: false, // NUXT_SUMMARY_STUB_CANARY
    // Test-only: makes the stub transcriber fail once with a 429, the same
    // shape a real Groq quota exhaustion takes, so tests can prove the
    // cooldown-gated retry path over the real HTTP route rather than only by
    // reasoning about the code. Never set outside tests.
    transcribeStubQuotaFail: false, // NUXT_TRANSCRIBE_STUB_QUOTA_FAIL
    // Test-only: makes the stub summarizer fail once with a retryable error
    // (a transient 5xx, not a 429), so tests can prove a retryable
    // summarization failure lands on a cooldown-gated `failed` state rather
    // than the ungated `summarizing` one. Never set outside tests.
    summaryStubFailOnceRetryable: false, // NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE
    public: {},
  },
  routeRules: {
    '/spike/**': { ssr: false },
  },
  compatibilityDate: '2025-07-15',
  vite: {
    // ffmpeg.wasm resolves its internal worker via new URL(..., import.meta.url);
    // esbuild pre-bundling relocates the module and breaks that resolution.
    optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
    // Our orchestration worker imports @ffmpeg/ffmpeg, which spawns a nested
    // worker chunk — only the ES worker format supports the required code-split.
    worker: { format: 'es' },
  },
  typescript: {
    // strict is the Nuxt 4 default; pinned explicitly. typeCheck stays off:
    // vue-tsc in dev/build is slow, CI runs `nuxt typecheck` instead.
    strict: true,
  },
  eslint: {
    config: {
      stylistic: true,
    },
  },
})
