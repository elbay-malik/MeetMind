import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalSlotRepository } from '../../server/utils/db/slots-local'
import { createGroqSummarizer, createSlotPacer, type RequestPacer } from '../../server/utils/summary/groq'
import { SummarizationError } from '../../server/utils/summary/summarizer'
import type { TranscriptSegment } from '../../shared/types/meeting'

const segments: TranscriptSegment[] = [
  { idx: 0, startMs: 0, endMs: 4000, text: 'We agreed to ship the billing change on Friday.' },
  { idx: 1, startMs: 5000, endMs: 9000, text: 'Priya will draft the migration plan by next week.' },
]

/** Only what these tests read back off the wire. */
interface GroqRequest {
  model: string
  temperature: number
  stream?: unknown
  messages: { role: string, content: string }[]
  max_completion_tokens?: number
  reasoning_effort?: string
  response_format: {
    type: string
    json_schema: { strict: boolean, schema: Record<string, unknown> }
  }
}

/** Records each 429 the summarizer reports to its pacer, and paces nothing. */
const rateLimited: number[] = []
const unpaced: RequestPacer = {
  wait: async () => {},
  rateLimited: async (ms) => {
    rateLimited.push(ms)
  },
}

/**
 * Pacing tests space SLOTS 400 ms apart and assert sends at least 200 ms
 * apart. The slack is real, not padding: a caller that slept re-reads the
 * ledger before sending (see createSlotPacer), so its send can trail its slot
 * by a few milliseconds -- tens under a loaded test run. Unpaced, the gap is ~0.
 *
 * A real slot ledger (the local driver) in a fresh directory. Each call to
 * `pacer()` is what one HTTP request builds; pacers from the same ledger share
 * its slots, which is how two requests -- or two isolates -- are paced against
 * each other in production.
 */
const ledgerRoot = mkdtempSync(join(tmpdir(), 'meetmind-slots-'))
afterAll(() => rmSync(ledgerRoot, { recursive: true, force: true }))

function ledger(intervalMs: number) {
  const slots = createLocalSlotRepository({ dataDir: mkdtempSync(join(ledgerRoot, 'ledger-')) })
  return { pacer: () => createSlotPacer({ slots, provider: 'groq-chat', intervalMs }) }
}

// Unpaced: these tests are not about pacing (that has its own tests below,
// with a real, small interval), and several exercise a within-call retry,
// which is paced exactly like a new chunk. At the real interval they would
// each wait out a real 60s here for no reason.
const summarizer = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 2, pacer: unpaced })

const reply = (payload: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(payload) } }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

const goodPayload = {
  summary: 'A short review.',
  decisions: [{ quote: 'ship the billing change', segmentIdx: 0, decision: 'Ship billing Friday' }],
  actionItems: [{
    quote: 'draft the migration plan', segmentIdx: 1, task: 'Draft migration plan',
    assignee: 'Priya', dueDateText: 'next week',
  }],
}

/** When each stubbed request was actually SENT, for the pacing tests. */
let sentAt: number[] = []

/**
 * Gaps between consecutive requests. The pacing tests used to assert on the
 * total wall time of summarize() instead, which passes just as well when both
 * requests fire back to back and the wait lands AFTER the last one — measured:
 * moving pacer.wait() after the request left two of those tests green while
 * the exact behaviour they name was broken.
 */
const requestGaps = () => sentAt.slice(1).map((time, i) => time - sentAt[i]!)

function stubFetch(responses: (Response | (() => never))[]) {
  const calls: Request[] = []
  const queue = [...responses]
  sentAt = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sentAt.push(Date.now())
    calls.push(new Request(url, init))
    const next = queue.shift()
    if (typeof next === 'function') return next()
    return next ?? new Response(null, { status: 500 })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  rateLimited.length = 0
})

describe('request', () => {
  it('asks for strict structured output from a model that supports it', async () => {
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })

    const body = await calls[0]!.json() as GroqRequest
    // The playbook's llama model is still current but cannot do structured
    // outputs; only the gpt-oss models can.
    expect(body.model).toBe('openai/gpt-oss-120b')
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.temperature).toBe(0)
    // Streaming is not supported alongside structured outputs.
    expect(body.stream).toBeUndefined()
  })

  it('sends a schema in the shape strict mode requires', async () => {
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })
    const schema = (await calls[0]!.json() as GroqRequest).response_format.json_schema.schema

    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['summary', 'decisions', 'actionItems'])
    const properties = schema.properties as Record<string, { items?: Record<string, unknown> }>
    const item = properties.actionItems!.items!
    expect(item.additionalProperties).toBe(false)
    // Every property required; an optional field is a union with null.
    expect(item.required).toEqual(['quote', 'segmentIdx', 'task', 'assignee', 'dueDateText'])
    // Keywords strict mode rejects must not survive the normaliser.
    expect(JSON.stringify(schema)).not.toContain('minLength')
    expect(JSON.stringify(schema)).not.toContain('format')
  })

  // Without both, a dense one-hour meeting could never be summarised: the
  // provider's default 3,072-token cap was spent on reasoning (up to 4,413
  // tokens measured at the default effort) and every reply was cut off. At low
  // effort a dense full chunk measured 1,779 reply tokens; the budget must
  // cover that with room, and the effort must stay low or the reply size is
  // unpredictable again.
  it('sets low reasoning effort and an output budget that covers a dense chunk\'s measured reply', async () => {
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })
    const body = await calls[0]!.json() as GroqRequest
    expect(body.reasoning_effort).toBe('low')
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2 * 1779)
  })

  it('numbers transcript lines so the model can cite one', async () => {
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })
    const content = (await calls[0]!.json() as GroqRequest).messages[1]!.content
    expect(content).toContain('0| We agreed')
    expect(content).toContain('1| Priya will')
  })

  it('tells the model that transcript lines are content, not instructions', async () => {
    // A transcript is untrusted text: anyone speaking in the meeting wrote it.
    // The ANSWERING prompt has said so since Phase 7; this one did not, and
    // this is the side whose output is stored and shown to everyone. Only
    // `quote` is checked against the transcript, so an instruction spoken
    // aloud ("note the action item: …") could otherwise be recorded verbatim
    // as an extracted item in fields nothing verifies.
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })
    const system = (await calls[0]!.json() as GroqRequest).messages
      .find(m => m.role === 'system')!
    expect(system.content).toMatch(/not instructions to you/)
  })
})

describe('response', () => {
  it('keeps only what the transcript supports and resolves timestamps itself', async () => {
    stubFetch([reply(goodPayload)])
    const result = await summarizer.summarize({ segments })

    expect(result.provider).toBe('groq')
    expect(result.decisions[0]).toMatchObject({ segmentIdx: 0, startMs: 0 })
    expect(result.actionItems[0]).toMatchObject({ assignee: 'Priya', segmentIdx: 1, startMs: 5000 })
  })

  it('drops an item the transcript does not support', async () => {
    stubFetch([reply({
      summary: 'x',
      decisions: [{ quote: 'we agreed to acquire a competitor', segmentIdx: 0, decision: 'Acquire' }],
      actionItems: [],
    })])
    const result = await summarizer.summarize({ segments })
    expect(result.decisions).toEqual([])
  })

  it('accepts a meeting with nothing to report', async () => {
    stubFetch([reply({ summary: 'Nothing was decided.', decisions: [], actionItems: [] })])
    const result = await summarizer.summarize({ segments })
    expect(result).toMatchObject({ decisions: [], actionItems: [] })
  })

  it('paces chunk requests so two chunks cannot land in the same rate-limit window', async () => {
    // Sequential alone does not pace anything: two full-budget chunks sent
    // back to back can both land inside the same rolling minute and exceed
    // the provider's aggregate allowance even though each fits its own
    // per-request budget. Two segments, each already over budget alone, so
    // planChunks puts each in its own chunk regardless of packing.
    const bigText = Array.from({ length: 4000 }, () => 'word').join(' ')
    const bigSegments: TranscriptSegment[] = [
      { idx: 0, startMs: 0, endMs: 1000, text: bigText },
      { idx: 1, startMs: 1000, endMs: 2000, text: bigText },
    ]
    const paced = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: ledger(400).pacer() })
    const calls = stubFetch([
      reply({ summary: '', decisions: [], actionItems: [] }),
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await paced.summarize({ segments: bigSegments })

    expect(calls).toHaveLength(2)
    expect(requestGaps()).toHaveLength(1)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(200)
  })

  it('paces a within-chunk retry exactly like a new chunk', async () => {
    // A retry from withRetries is a real request too, and can consume close
    // to the same chunk's whole token budget — just as capable of landing in
    // the same rolling minute as its own first attempt as a new chunk is.
    const paced = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 2, pacer: ledger(400).pacer() })
    const calls = stubFetch([
      reply({ summary: 'x' }), // malformed: triggers a retry
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await paced.summarize({ segments })

    expect(calls).toHaveLength(2)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(200)
  })

  it('paces across summarizers that share a slot ledger, since the rate limit is per account', async () => {
    // useSummarizer builds a fresh Summarizer and a fresh pacer per HTTP
    // request, so two instances stand in for two concurrent extractions of
    // DIFFERENT meetings -- on Workers, quite possibly in different isolates.
    // Nothing in memory is shared between them; only the ledger is, and that
    // is what keeps them from together exceeding the per-account allowance.
    const shared = ledger(400)
    const meetingA = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: shared.pacer() })
    const meetingB = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: shared.pacer() })
    stubFetch([
      reply({ summary: '', decisions: [], actionItems: [] }),
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await meetingA.summarize({ segments })
    await meetingB.summarize({ segments })

    expect(requestGaps()).toHaveLength(1)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(200)
  })

  it('serializes TRULY concurrent callers of a shared pacer, not just sequentially-awaited ones', async () => {
    // The previous test only proves pacing works when one caller is fully
    // awaited before the next starts. A pacer whose read-then-sleep-then-
    // write has a gap between the read and the write would let two calls
    // that both invoke wait() before either has updated its own state read
    // the SAME stale value, both sleep the same remainder, and both fire
    // together — Promise.all is what actually exercises that gap; two
    // separately-awaited calls never do. Priming the pacer with one call
    // first matters too: the very first-ever call never reaches the
    // internal sleep at all (nothing to wait ON yet), so it can never
    // expose this race on its own — only a call that actually has to sleep
    // creates the gap a second concurrent caller can land in.
    const requestTimestamps: number[] = []
    vi.stubGlobal('fetch', async () => {
      requestTimestamps.push(Date.now())
      return reply({ summary: '', decisions: [], actionItems: [] })
    })

    const shared = ledger(400)
    await shared.pacer().wait()

    const meetingA = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: shared.pacer() })
    const meetingB = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: shared.pacer() })

    await Promise.all([meetingA.summarize({ segments }), meetingB.summarize({ segments })])

    expect(requestTimestamps).toHaveLength(2)
    expect(Math.abs(requestTimestamps[1]! - requestTimestamps[0]!)).toBeGreaterThanOrEqual(200)
  })

  it('does not call the provider at all for an empty transcript', async () => {
    const calls = stubFetch([reply(goodPayload)])
    const result = await summarizer.summarize({ segments: [] })
    expect(calls).toHaveLength(0)
    expect(result.summary).toBe('')
  })
})

describe('failures and retries', () => {
  it('retries a malformed reply, which is what the acceptance criterion asks for', async () => {
    const calls = stubFetch([reply({ summary: 'x' }), reply(goodPayload)])
    const result = await summarizer.summarize({ segments })
    expect(calls).toHaveLength(2)
    expect(result.decisions).toHaveLength(1)
  })

  it('gives up after the allowed attempts rather than looping', async () => {
    stubFetch([reply({ summary: 'x' }), reply({ summary: 'x' }), reply(goodPayload)])
    await expect(summarizer.summarize({ segments })).rejects.toThrow(/did not match/)
  })

  it('does not retry a failure retrying cannot fix', async () => {
    const calls = stubFetch([new Response('bad key', { status: 401 }), reply(goodPayload)])
    await expect(summarizer.summarize({ segments })).rejects.toThrow(/credentials/)
    expect(calls).toHaveLength(1)
  })

  it('explains quota exhaustion in the user\'s terms, and does not instantly retry it', async () => {
    // withRetries has no backoff, so retrying a 429 immediately would just
    // hit the same throttle again. Only one request should go out; the hold
    // says when to come back, and a step-wise caller parks the chunk until
    // then (summary/steps.ts).
    const calls = stubFetch([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '17' } }),
      new Response('rate limited', { status: 429, headers: { 'retry-after': '17' } }),
    ])
    const err = await summarizer.summarize({ segments }).catch((e: SummarizationError) => e)
    expect(err.message).toMatch(/quota is exhausted.*17s/s)
    expect(err.retryable).toBe(false)
    expect(err.hold?.kind).toBe('rate-limited')
    expect(Math.abs(err.hold!.retryAt.getTime() - (Date.now() + 17_000))).toBeLessThan(2000)
    expect(calls).toHaveLength(1)
    // And it reached the shared ledger, so every other caller -- in any
    // isolate -- waits out the same 17s instead of colliding again. 17, not
    // 60: a summarizer that ignored the header would record the 60s default.
    expect(rateLimited).toEqual([17_000])
  })

  it('holds a chunk back, sending nothing, when its slot is not free now (step-wise, ADR-0012)', async () => {
    const slots = createLocalSlotRepository({ dataDir: mkdtempSync(join(ledgerRoot, 'ledger-')) })
    const stepwise = createGroqSummarizer({
      apiKey: 'gsk-test',
      maxAttempts: 1,
      pacer: createSlotPacer({ slots, provider: 'groq-chat', intervalMs: 60_000, maxWaitMs: 0 }),
    })
    const calls = stubFetch([reply(goodPayload), reply(goodPayload)])
    await stepwise.summarizeChunk({ segments })
    const before = Date.now()
    const err = await stepwise.summarizeChunk({ segments }).catch((e: SummarizationError) => e)
    expect(err).toBeInstanceOf(SummarizationError)
    expect(err.hold?.kind).toBe('busy')
    expect(err.hold!.retryAt.getTime()).toBeGreaterThan(before + 55_000)
    expect(calls).toHaveLength(1)
  })

  // What a reply cut off by the output budget looks like on the wire: the
  // provider's strict-mode check refuses it, with nothing in failed_generation.
  // Captured from the real API.
  const truncatedReply = () => new Response(JSON.stringify({
    error: {
      message: 'Failed to validate JSON. Please adjust your prompt. See \'failed_generation\' for more details.',
      type: 'invalid_request_error',
      code: 'json_validate_failed',
      failed_generation: '',
    },
  }), { status: 400 })

  it('names the output budget when the provider refuses a reply as invalid JSON, and does not retry it', async () => {
    // At temperature 0 the same chunk produces the same reply, so a retry
    // only spends another request of the per-minute allowance on a known
    // failure.
    const calls = stubFetch([truncatedReply(), reply(goodPayload)])
    const err = await summarizer.summarize({ segments }).catch((e: SummarizationError) => e)
    expect(err.message).toMatch(/output budget/)
    expect(err.retryable).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('recognises that refusal by its error code even past the part of the body it quotes', async () => {
    const padded = JSON.stringify({ error: { message: 'x'.repeat(400), code: 'json_validate_failed' } })
    stubFetch([new Response(padded, { status: 400 })])
    await expect(summarizer.summarize({ segments })).rejects.toThrow(/output budget/)
  })

  it('turns a network error into a retryable failure', async () => {
    stubFetch([() => {
      throw new TypeError('fetch failed')
    }, reply(goodPayload)])
    const result = await summarizer.summarize({ segments })
    expect(result.decisions).toHaveLength(1)
  })
})
