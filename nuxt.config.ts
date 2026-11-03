import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Server-only secrets, overridden by NUXT_* env vars at runtime.
    groqApiKey: '', // NUXT_GROQ_API_KEY
    // Cloudflare Workers AI embeddings (ADR-0014). Both are needed, or a local stub
    // embeds where ADR-0016 allows one. The token should be scoped to Workers AI alone:
    // it is not the wrangler token, nor the R2 keys.
    workersAiAccountId: '', // NUXT_WORKERS_AI_ACCOUNT_ID
    workersAiApiToken: '', // NUXT_WORKERS_AI_API_TOKEN
    supabaseUrl: '', // NUXT_SUPABASE_URL
    supabaseServiceKey: '', // NUXT_SUPABASE_SERVICE_KEY
    // Cloudflare R2 (S3 API) for compressed audio. All four are needed, or the
    // local filesystem driver is used where ADR-0016 allows it.
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
    // Bearer token for the admin-only routes (DELETE /api/meetings/:id). Empty
    // means those routes answer 404; set means at least 32 characters, or they
    // refuse to run. Generate with `openssl rand -base64 32`.
    adminToken: '', // NUXT_ADMIN_TOKEN
    // The code POST /api/meetings asks for (ADR-0015). At least 32 characters.
    // Empty or shorter closes uploads for everyone, and it never belongs under `public`.
    // Generate with `openssl rand -hex 24`.
    inviteCode: '', // NUXT_INVITE_CODE
    // Days after which the cron deletes a meeting and everything stored for it (ADR-0017), at
    // most one per tick. Irreversible, so off: empty or 0 is off, and so is anything but a
    // positive whole number, which is logged, or no NUXT_PUBLIC_DEMO_MEETING_ID. On a Worker only,
    // since nothing else has a cron. Stays empty here and out of wrangler.jsonc.
    retentionPurgeDays: '', // NUXT_RETENTION_PURGE_DAYS
    // Minimum gap between Groq chat requests (extraction chunks and questions)
    // across EVERY server instance, enforced through the slot ledger
    // (ADR-0012). One request a minute fits the free tier's 8,000 tokens per
    // minute for gpt-oss-120b. Lower only with a higher Groq tier.
    groqChatIntervalMs: 60_000, // NUXT_GROQ_CHAT_INTERVAL_MS
    // Minimum gap between embedding requests of indexing steps across every server
    // instance, through the slot ledger (ADR-0012). The daily allocation is what
    // binds (ADR-0014), and a 429 blocks the slot until it resets; this only keeps
    // many meetings indexing at once from arriving together.
    embedIntervalMs: 1_000, // NUXT_EMBED_INTERVAL_MS
    // How long a question waits for its Groq slot before it is refused with a
    // 429 and Retry-After. Short, so a question never queues behind a whole
    // extraction and the queue stays bounded (ADR-0012).
    askMaxSlotWaitMs: 20_000, // NUXT_ASK_MAX_SLOT_WAIT_MS
    // ADR-0016. A built server missing any setting above refuses every request that
    // needs a provider or store, unless this is exactly true, which lets it run on stubs
    // and local stores: for the e2e and browser jobs. `pnpm dev` needs no flag. Ignored
    // outright on a Cloudflare Worker, and no help beside a real database or bucket. Stays
    // false here and out of wrangler.jsonc.
    allowLocalDrivers: false, // NUXT_ALLOW_LOCAL_DRIVERS
    // Local drivers only (dev/tests): HMAC secret for upload URLs and data root.
    uploadTokenSecret: '', // NUXT_UPLOAD_TOKEN_SECRET (random per process when empty)
    dataDir: '.data', // NUXT_DATA_DIR
    // The six test-only flags below are read only when a stub is built, so they do
    // nothing without ADR-0016's opt-in and nothing at all on a Worker.
    //
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
    // Test-only: makes the stub answerer take a Groq slot like the real one,
    // so tests can prove a question refused for a held slot gets a 429 with
    // Retry-After over the real HTTP route. Never set outside tests.
    answerStubPaced: false, // NUXT_ANSWER_STUB_PACED
    // Test-only: the stub embedder refuses any text containing this string the way
    // the real provider refuses once its daily allocation is spent, so tests can
    // prove what a visitor is told, and that indexing resumes, over the real HTTP
    // routes. Never set outside tests.
    embedStubQuotaCanary: '', // NUXT_EMBED_STUB_QUOTA_CANARY
    // Test-only: a stub given text holding this string followed by a stage and a kind
    // fails with text no visitor may read (server/utils/injected-failure.ts), so tests
    // can prove none of it reaches a browser over the real HTTP routes. Never set
    // outside tests.
    stubFailureCanary: '', // NUXT_STUB_FAILURE_CANARY
    public: {
      // The one meeting linked publicly, from the home page (ADR-0013). Its id
      // ends up in every page's payload, so only ever a meeting meant to be seen.
      demoMeetingId: '', // NUXT_PUBLIC_DEMO_MEETING_ID
    },
  },
  routeRules: {
    // A portfolio demo, not a site to be found by search. robots.txt asks crawlers
    // to stay out; this covers a page reached through a link from elsewhere.
    //
    // Referrer-Policy: a meeting's URL is the capability to read it (ADR-0013),
    // so it must not reach a third party in a Referer header.
    //
    // Nothing here is meant to be framed or sniffed: X-Frame-Options and frame-ancestors say the
    // first to old and new browsers, and this CSP says nothing else. A Worker's static assets
    // never reach this code, and Nitro writes these into the build's _headers for them.
    '/**': {
      headers: {
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': 'frame-ancestors \'none\'',
      },
    },
    '/spike/**': { ssr: false },
  },
  compatibilityDate: '2025-07-15',
  hooks: {
    // ffmpeg's wasm is over the 25 MiB asset limit, so a Worker build leaves it out and a route
    // serves it from R2 (ADR-0018). Here, before Nitro lists its assets: a file only left
    // behind by .assetsignore stays in that list, and the Worker sends the path to the assets
    // and answers 404 without running the route. A Node build and dev keep the public file.
    async 'nitro:build:public-assets'(nitro) {
      if (!nitro.options.preset.startsWith('cloudflare')) return
      await rm(join(nitro.options.output.publicDir, 'ffmpeg/ffmpeg-core.wasm'), { force: true })
    },
  },
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
