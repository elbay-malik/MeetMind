import type { H3Event } from 'h3'

/**
 * The one place that decides what this server runs on, and whether it runs at all
 * (ADR-0016). Every provider and store is built through {@link selectDriver}, and
 * tests/unit/source-hygiene.spec.ts fails if one is built anywhere else, so a new
 * provider cannot forget this.
 *
 * Decided per request and not at startup, because a Worker has no startup with its
 * settings available. It reads the runtime config and nothing else, before any claim,
 * slot, provider call or write.
 */

/** What a caller is told, whichever setting is absent. The log has the names. */
export const DRIVERS_REFUSED_MESSAGE = 'MeetMind is not available at the moment. Try again later.'

/** Every setting a deployment needs, by what it switches on, with its runtime config key. */
export const REQUIRED_SETTINGS = {
  groq: { NUXT_GROQ_API_KEY: 'groqApiKey' },
  workersAi: { NUXT_WORKERS_AI_ACCOUNT_ID: 'workersAiAccountId', NUXT_WORKERS_AI_API_TOKEN: 'workersAiApiToken' },
  supabase: { NUXT_SUPABASE_URL: 'supabaseUrl', NUXT_SUPABASE_SERVICE_KEY: 'supabaseServiceKey' },
  r2: {
    NUXT_R2_ACCOUNT_ID: 'r2AccountId',
    NUXT_R2_ACCESS_KEY_ID: 'r2AccessKeyId',
    NUXT_R2_SECRET_ACCESS_KEY: 'r2SecretAccessKey',
    NUXT_R2_BUCKET: 'r2Bucket',
  },
} as const

export type DriverGroup = keyof typeof REQUIRED_SETTINGS

const GROUPS = Object.keys(REQUIRED_SETTINGS) as DriverGroup[]

/** What stands in for each group when it is absent and that is allowed. */
const STAND_INS: Record<DriverGroup, string> = {
  groq: 'transcription, summaries and answers: stubs',
  workersAi: 'embeddings: a stub',
  supabase: 'meetings: local JSON files',
  r2: 'audio: the local filesystem',
}

export interface DriverEnvironment {
  /** `nuxt dev`. A build constant, so nothing set on a built server can make it true. */
  dev: boolean
  /** Cloudflare Workers, where nothing stands in for a missing setting, whatever is set. */
  worker: boolean
}

export type DriverDecision
  = | { refused: false, real: Record<DriverGroup, boolean> }
    | { refused: true, missing: string[], reason: string }

/**
 * Usable by a driver: not empty, not the whitespace a secret store kept, and not what destr
 * makes of `true` or `{}`. A number is what destr makes of an all-digit value.
 */
function isSet(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
}

/**
 * The decision itself, with nothing else in it. The hazard it exists for is a stand-in's
 * output stored for good: a stub embedder counts as another model, so one indexing request
 * overwrites real windows, and a stub transcript is never replaced.
 *
 * - Every setting present: all real, opt-in or not.
 * - On a Worker: nothing else, and the opt-in is not even read.
 * - On a built server: nothing else, without an opt-in of exactly `true`. `pnpm dev` needs none.
 * - Half of any group: a mistake, not a choice, opt-in or not.
 * - A real database or bucket: every setting must be present, opt-in or not, which is what
 *   stops a stand-in reaching stored data. The two stores also go together, because a
 *   bucket's storage budget is counted from the database's rows.
 *
 * What is left is a local database and bucket, with a stub or the real provider for each of
 * Groq and Workers AI. Real output in a throwaway store can harm nothing, and it is how a
 * developer tries a real provider without touching real data.
 */
export function decideDrivers(settings: Record<string, unknown>, environment: DriverEnvironment): DriverDecision {
  const missing = {} as Record<DriverGroup, string[]>
  const real = {} as Record<DriverGroup, boolean>
  for (const group of GROUPS) {
    missing[group] = Object.entries(REQUIRED_SETTINGS[group]).filter(([, key]) => !isSet(settings[key])).map(([name]) => name)
    real[group] = missing[group].length === 0
  }
  const allMissing = GROUPS.flatMap(group => missing[group])
  if (allMissing.length === 0) return { refused: false, real }

  if (environment.worker) {
    return { refused: true, missing: allMissing, reason: 'a Cloudflare Worker runs on the real services or not at all, and ignores NUXT_ALLOW_LOCAL_DRIVERS' }
  }
  if (!environment.dev && settings.allowLocalDrivers !== true) {
    return { refused: true, missing: allMissing, reason: 'a built server runs on the real services unless NUXT_ALLOW_LOCAL_DRIVERS is true' }
  }

  const halves = GROUPS.filter(group => !real[group] && missing[group].length < Object.keys(REQUIRED_SETTINGS[group]).length)
  if (halves.length > 0) {
    return { refused: true, missing: halves.flatMap(group => missing[group]), reason: 'half a group of settings is a mistake, not a choice of stub or local driver' }
  }
  if (real.supabase || real.r2) {
    return { refused: true, missing: allMissing, reason: 'a real database or bucket needs every other setting too, because what a stand-in makes would be stored for good' }
  }
  return { refused: false, real }
}

/**
 * Where this code is running. On a Worker, any one of three signals is enough: what it was
 * built for, what Nitro's Cloudflare handler hands each request, and what the runtime says it
 * is. The first is fixed at build time and the other two come from the runtime, so none of
 * them can be set from outside, by a variable or by a request.
 *
 * Not NODE_ENV: the e2e and browser jobs run a real production build, and it says nothing
 * about the runtime. `import.meta.preset` must not be followed by a `.`, or Nitro does not
 * replace it (its replacement refuses a following dot).
 */
export function driverEnvironment(event: H3Event): DriverEnvironment {
  return {
    dev: import.meta.dev === true,
    worker: String(import.meta.preset ?? '').startsWith('cloudflare')
      || event.context.cloudflare !== undefined
      || globalThis.navigator?.userAgent === 'Cloudflare-Workers',
  }
}

let lastLogged = ''

/**
 * Refuse, and put the names in the log, never a value. The settings do not change while a
 * process or isolate lives, so this logs once for each, however many requests are refused.
 */
function refuse(decision: { missing: string[], reason: string }): never {
  const line = `[meetmind] refusing requests: ${decision.reason}. Missing: ${decision.missing.join(', ')}. See ADR-0016.`
  if (line !== lastLogged) {
    lastLogged = line
    console.error(line)
  }
  throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: DRIVERS_REFUSED_MESSAGE })
}

/** The refusal above, so that a route's catch-all can let it through as what it is. */
export function isDriverRefusal(err: unknown): boolean {
  const { statusCode, message } = (err ?? {}) as { statusCode?: unknown, message?: unknown }
  return statusCode === 503 && message === DRIVERS_REFUSED_MESSAGE
}

function permitted(event: H3Event): Record<DriverGroup, boolean> {
  const decision = decideDrivers(useRuntimeConfig(event), driverEnvironment(event))
  if (decision.refused) refuse(decision)
  return decision.real
}

/** Refuse now, for a route that wants to say so before it reads a body. */
export function requireDrivers(event: H3Event): void {
  permitted(event)
}

const announced = new Set<DriverGroup>()

function announce(group: DriverGroup) {
  if (announced.has(group)) return
  announced.add(group)
  console.info(`[meetmind] ${STAND_INS[group]} (set ${Object.keys(REQUIRED_SETTINGS[group]).join(', ')} for the real one)`)
}

type Config = ReturnType<typeof useRuntimeConfig>

/**
 * Build a provider or store: `real` when its settings are present, `local` when they are
 * absent and that is allowed, and otherwise a 503. The test-only stub flags and the local
 * drivers' settings are read inside `local` and nowhere else, so they do nothing unless
 * this has already allowed a stand-in.
 */
export function selectDriver<T>(event: H3Event, group: DriverGroup, build: { real: (config: Config) => T, local: (config: Config) => T }): T {
  const real = permitted(event)[group]
  const config = useRuntimeConfig(event)
  if (real) return build.real(config)
  announce(group)
  return build.local(config)
}
