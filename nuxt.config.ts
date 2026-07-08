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
