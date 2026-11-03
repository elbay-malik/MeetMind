/**
 * Test-only: makes a stub provider fail the way the real one does, with text no visitor may
 * read, so tests/e2e/raw-errors.spec.ts can hold every route to that over real HTTP. Nothing
 * here runs unless `NUXT_STUB_FAILURE_CANARY` is set, which only a stub reads.
 */

/**
 * A database's code and constraint, an object's key and a provider's reply, all at once:
 * what a real failure's message can hold, and what must stay out of every response.
 */
export const INJECTED_FAILURE_TEXT = 'Supabase read failed (PGRST-SENTINEL-116): violates check constraint "meetings_sentinel_check" '
  + 'for meetings/sentinel-object/audio.ogg: {"error":{"message":"provider-sentinel-body","organization":"org_sentinel"}}'

export type InjectedStage = 'transcribe' | 'summarize' | 'embed' | 'answer'

/**
 * - `refused`: the provider said no, and asking again cannot help.
 * - `retryable`: the provider is having a bad moment.
 * - `rate-limited`: the provider's 429.
 * - `internal`: not the provider at all: a plain error, as from a database or a store.
 */
export type InjectedKind = 'refused' | 'retryable' | 'rate-limited' | 'internal'

/** How long a stub's injected 429 holds a caller off. */
export const INJECTED_RATE_LIMIT_MS = 60_000

/**
 * Which failure the text a stub was given asks for: it holds `<canary>:<stage>:<kind>`. Null
 * with no canary set, so a stub with no flag behaves as it always has.
 */
export function injectedFailure(canary: string | undefined, stage: InjectedStage, text: string): InjectedKind | null {
  if (!canary) return null
  for (const kind of ['refused', 'retryable', 'rate-limited', 'internal'] as const) {
    if (text.includes(`${canary}:${stage}:${kind}`)) return kind
  }
  return null
}
