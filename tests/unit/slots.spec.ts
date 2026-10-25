import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalSlotRepository } from '../../server/utils/db/slots-local'
import { reserveFrom, type SlotRepository, type SlotState } from '../../server/utils/db/slots'
import { createGroqSummarizer, createSlotPacer, MAX_RATE_LIMIT_BLOCK_MS, ProviderBusyError, retryAfterMs } from '../../server/utils/summary/groq'
import { createGroqAnswerer } from '../../server/utils/qa/groq-answerer'
import { createStubAnswerer } from '../../server/utils/qa/stub-answerer'
import type { SummarizationError } from '../../server/utils/summary/summarizer'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'meetmind-slots-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
const freshDir = () => mkdtemp(join(root, 'ledger-'))

const T = Date.parse('2026-10-25T12:00:00.000Z')
const fresh: SlotState = { nextAvailableAt: 0, blockedUntil: 0 }
const window = { intervalMs: 60_000, maxWaitMs: 0 }

/**
 * The reservation rule. `public.reserve_slot` and `reserveFrom` are written
 * against each other, so scripts/verify-migrations.sh asserts the SQL against
 * the same rule: an immediate grant, the next slot one interval on, a refusal
 * that reserves nothing, a waiting grant, and the Retry-After block for both a
 * waiting and a non-waiting caller. The exact max-wait boundary is checked here
 * only: the SQL reads a moving clock, so an exact edge cannot be staged there.
 */
describe('reserveFrom', () => {
  it('grants a free provider now, and moves its next slot one interval on', () => {
    const { next, reservation } = reserveFrom(fresh, window, T)
    expect(reservation).toEqual({ granted: true, slotAt: new Date(T) })
    expect(next.nextAvailableAt).toBe(T + 60_000)
  })

  it('places a waiting caller at the next slot, not now', () => {
    const state = { nextAvailableAt: T + 20_000, blockedUntil: 0 }
    expect(reserveFrom(state, { intervalMs: 60_000, maxWaitMs: 30_000 }, T).reservation)
      .toEqual({ granted: true, slotAt: new Date(T + 20_000) })
  })

  it('reserves nothing when the next slot is past the caller\'s wait, and says when it frees', () => {
    // A caller that gives up must not hold a slot: it would push everyone
    // after it back by an interval for a request that is never sent.
    const state = { nextAvailableAt: T + 45_000, blockedUntil: 0 }
    const { next, reservation } = reserveFrom(state, { intervalMs: 60_000, maxWaitMs: 30_000 }, T)
    expect(reservation).toEqual({ granted: false, retryAt: new Date(T + 45_000) })
    expect(next).toBe(state)
  })

  it('grants exactly at the edge of the caller\'s wait', () => {
    const state = { nextAvailableAt: T + 30_000, blockedUntil: 0 }
    expect(reserveFrom(state, { intervalMs: 60_000, maxWaitMs: 30_000 }, T).reservation.granted).toBe(true)
  })

  it('refuses an interval or wait that would break the ledger', () => {
    // NaN would store a NaN slot -- pacing silently off; a negative interval
    // would move the next slot backwards. reserve_slot raises on both.
    for (const bad of [Number.NaN, -1]) {
      expect(() => reserveFrom(fresh, { intervalMs: bad, maxWaitMs: 0 }, T)).toThrow()
      expect(() => reserveFrom(fresh, { intervalMs: 0, maxWaitMs: bad }, T)).toThrow()
    }
  })

  it('places no slot before a provider\'s Retry-After, whatever the interval says', () => {
    const state = { nextAvailableAt: T, blockedUntil: T + 90_000 }
    expect(reserveFrom(state, { intervalMs: 60_000, maxWaitMs: 120_000 }, T).reservation)
      .toEqual({ granted: true, slotAt: new Date(T + 90_000) })
    expect(reserveFrom(state, window, T).reservation).toEqual({ granted: false, retryAt: new Date(T + 90_000) })
  })
})

describe('local slot repository', () => {
  const repo = async () => createLocalSlotRepository({ dataDir: await freshDir() })

  it('gives concurrent callers distinct slots one interval apart', async () => {
    // Promise.all, not a loop: what matters is callers that arrive together,
    // which is what several isolates do.
    const slots = await repo()
    const granted = await Promise.all(Array.from({ length: 5 }, () =>
      slots.reserve('groq-chat', { intervalMs: 1000, maxWaitMs: 60_000 })))
    const starts = granted.map(r => (r.granted ? r.slotAt.getTime() : Number.NaN)).sort((a, b) => a - b)
    expect(starts.every(Number.isFinite)).toBe(true)
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(1000)
  })

  it('keeps its state in the data directory, not in the instance', async () => {
    // Two instances over one directory are two requests in production.
    const dataDir = await freshDir()
    await createLocalSlotRepository({ dataDir }).reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 0 })
    const second = await createLocalSlotRepository({ dataDir }).reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 0 })
    expect(second.granted).toBe(false)
  })

  it('never shortens a block a provider asked for', async () => {
    const slots = await repo()
    await slots.noteRateLimit('groq-chat', 120_000)
    await slots.noteRateLimit('groq-chat', 5_000)
    const reservation = await slots.reserve('groq-chat', { intervalMs: 0, maxWaitMs: 60_000 })
    expect(reservation.granted).toBe(false)
  })
})

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => expect(retryAfterMs('12')).toBe(12_000))
  it('reads an HTTP date', () => expect(retryAfterMs('Sun, 25 Oct 2026 12:00:30 GMT', T)).toBe(30_000))
  it('treats a date in the past as no wait', () => expect(retryAfterMs('Sun, 25 Oct 2026 11:00:00 GMT', T)).toBe(0))
  it('caps a block at a day, the longest window the provider has', () => {
    expect(retryAfterMs(String(365 * 24 * 3600))).toBe(MAX_RATE_LIMIT_BLOCK_MS)
    expect(retryAfterMs('Sat, 25 Oct 2036 12:00:00 GMT', T)).toBe(MAX_RATE_LIMIT_BLOCK_MS)
  })
  // A 429 still means "not now" when it does not say for how long.
  it.each([null, '', 'soon', '-5'])('falls back to a minute for %j', header => expect(retryAfterMs(header)).toBe(60_000))
})

describe('a pacer with no slot inside its wait', () => {
  afterEach(() => vi.unstubAllGlobals())
  const segments = [{ idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship the billing change on Friday.' }]

  async function busyPacer() {
    const slots = createLocalSlotRepository({ dataDir: await freshDir() })
    await slots.noteRateLimit('groq-chat', 600_000)
    return createSlotPacer({ slots, provider: 'groq-chat', intervalMs: 0, maxWaitMs: 1000 })
  }

  /** The block busyPacer sets, read back, so a refusal can be held to it. */
  async function blockOf(pacer: Promise<ReturnType<typeof createSlotPacer>>) {
    const before = Date.now()
    return { pacer: await pacer, min: before + 600_000, max: () => Date.now() + 600_000 }
  }

  it('refuses rather than sleeping past the caller\'s wait', async () => {
    await expect((await busyPacer()).wait()).rejects.toBeInstanceOf(ProviderBusyError)
  })

  it('makes the summarizer fail like a quota refusal, without calling the provider', async () => {
    // A 429 is what summarize.post.ts already turns into a cooldown-gated
    // failure, so a busy ledger needs no new handling there.
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const err = await createGroqSummarizer({ apiKey: 'k', pacer: await busyPacer() })
      .summarize({ segments }).catch((e: SummarizationError) => e)
    expect(err).toMatchObject({ statusCode: 429, retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes the answerer refuse with a 429 saying when the slot frees, without calling the provider', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { pacer, min, max } = await blockOf(busyPacer())
    const err = await createGroqAnswerer({ apiKey: 'k', pacer }).answer({ question: 'q', segments }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 429, retryable: false })
    expect(err.retryAt.getTime()).toBeGreaterThanOrEqual(min)
    expect(err.retryAt.getTime()).toBeLessThanOrEqual(max())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the real failure when a retry cannot get its slot inside the question\'s wait', async () => {
    // Production pacing: a minute between requests, a question waits 20 s. The
    // first attempt takes the free slot and fails retryably; the retry's slot
    // is a minute out. The user must hear what failed, and when to ask again --
    // not that an extraction is hogging the model.
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: 'not json' } }] }))
    vi.stubGlobal('fetch', fetch)
    const slots = createLocalSlotRepository({ dataDir: await freshDir() })
    const pacer = createSlotPacer({ slots, provider: 'groq-chat', intervalMs: 60_000, maxWaitMs: 20_000 })
    const before = Date.now()
    const err = await createGroqAnswerer({ apiKey: 'k', pacer }).answer({ question: 'q', segments }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 429, retryable: false })
    expect(err.message).toMatch(/invalid JSON/)
    expect(err.message).not.toMatch(/busy/)
    expect(err.retryAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('makes a paced stub answerer refuse the same way, so the route can be tested without a provider', async () => {
    const { pacer, min } = await blockOf(busyPacer())
    const err = await createStubAnswerer({ pacer }).answer({ question: 'billing change', segments }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 429, retryable: false })
    expect(err.retryAt.getTime()).toBeGreaterThanOrEqual(min)
  })
})

describe('createSlotPacer', () => {
  it('refuses a malformed interval when built, naming the provider', async () => {
    const slots = createLocalSlotRepository({ dataDir: await freshDir() })
    for (const bad of [Number.NaN, -1, 1.5]) {
      expect(() => createSlotPacer({ slots, provider: 'groq-chat', intervalMs: bad })).toThrow(/groq-chat/)
    }
  })

  it('refuses a malformed wait when built, so a mistyped NUXT_ASK_MAX_SLOT_WAIT_MS fails loudly', async () => {
    const slots = createLocalSlotRepository({ dataDir: await freshDir() })
    for (const bad of [Number.NaN, -1, 1.5]) {
      expect(() => createSlotPacer({ slots, provider: 'groq-chat', intervalMs: 0, maxWaitMs: bad })).toThrow(/slot wait/)
    }
  })

  it('does not send into a Retry-After noted while it waited for its slot', async () => {
    // The scenario: callers queued behind an earlier request that is then
    // refused with a 429. Their slots were handed out before the block
    // existed; sending at them would only collect more 429s.
    const slots = createLocalSlotRepository({ dataDir: await freshDir() })
    const pacer = () => createSlotPacer({ slots, provider: 'groq-chat', intervalMs: 300, maxWaitMs: 60_000 })
    await pacer().wait()
    const queued = pacer().wait()
    await slots.noteRateLimit('groq-chat', 60_000)
    await expect(queued).rejects.toBeInstanceOf(ProviderBusyError)
  })

  it('keeps the provider\'s 429 as the error when recording it fails', async () => {
    // The routes' cooldowns hang off that 429; a database error in its place
    // would turn a quota refusal into an anonymous 500.
    const failing: SlotRepository = {
      ...createLocalSlotRepository({ dataDir: await freshDir() }),
      noteRateLimit: async () => {
        throw new Error('database unavailable')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }))
    const pacer = createSlotPacer({ slots: failing, provider: 'groq-chat', intervalMs: 0 })
    const segments = [{ idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship the billing change on Friday.' }]
    await expect(createGroqSummarizer({ apiKey: 'k', pacer, maxAttempts: 1 }).summarize({ segments }))
      .rejects.toMatchObject({ statusCode: 429 })
    await expect(createGroqAnswerer({ apiKey: 'k', pacer }).answer({ question: 'q', segments }))
      .rejects.toMatchObject({ statusCode: 429 })
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  it('treats a failure to reserve a slot as retryable, without the database\'s words', async () => {
    let attempts = 0
    const flaky: SlotRepository = {
      ...createLocalSlotRepository({ dataDir: await freshDir() }),
      reserve: async () => {
        attempts++
        if (attempts === 1) throw new Error('Supabase reserve slot failed (57P01): terminating connection')
        return { granted: true, slotAt: new Date() }
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 's', decisions: [], actionItems: [] }) } }] }))
    const pacer = createSlotPacer({ slots: flaky, provider: 'groq-chat', intervalMs: 0 })
    const segments = [{ idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship the billing change on Friday.' }]
    // One blip, then a grant: the chunk is retried rather than the run failed.
    await expect(createGroqSummarizer({ apiKey: 'k', pacer, maxAttempts: 2 }).summarize({ segments })).resolves.toMatchObject({ summary: 's' })
    // And when it does fail for good, the meeting is told something it can act on.
    attempts = 0
    const err = await createGroqSummarizer({ apiKey: 'k', pacer, maxAttempts: 1 }).summarize({ segments }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 503, retryable: true })
    expect(err.message).not.toMatch(/Supabase|57P01/)

    // The answerer, the same way.
    attempts = 0
    vi.stubGlobal('fetch', async () => Response.json({ choices: [{ message: { content: JSON.stringify({ citations: [], answer: '' }) } }] }))
    const asked = await createGroqAnswerer({ apiKey: 'k', pacer, maxAttempts: 1 }).answer({ question: 'q', segments }).catch(e => e)
    expect(asked).toMatchObject({ statusCode: 503, retryable: true })
    expect(asked.message).not.toMatch(/Supabase|57P01/)
    vi.unstubAllGlobals()
    warn.mockRestore()
  })
})
