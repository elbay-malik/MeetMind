import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroqSummarizer, createRequestPacer } from '../../server/utils/summary/groq'
import type { SummarizationError } from '../../server/utils/summary/summarizer'
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
  response_format: {
    type: string
    json_schema: { strict: boolean, schema: Record<string, unknown> }
  }
}

// minRequestIntervalMs: 0 — these tests are not about pacing (that has its
// own test below, with its own summarizer and a real, small interval), and
// several exercise a within-call retry, which is paced exactly like a new
// chunk since the pacing fix. Left at the real default they would each wait
// out a real 60s here for no reason.
const summarizer = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 2, minRequestIntervalMs: 0 })

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

afterEach(() => vi.unstubAllGlobals())

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

  it('numbers transcript lines so the model can cite one', async () => {
    const calls = stubFetch([reply(goodPayload)])
    await summarizer.summarize({ segments })
    const content = (await calls[0]!.json() as GroqRequest).messages[1]!.content
    expect(content).toContain('0| We agreed')
    expect(content).toContain('1| Priya will')
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
    const paced = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, minRequestIntervalMs: 200 })
    const calls = stubFetch([
      reply({ summary: '', decisions: [], actionItems: [] }),
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await paced.summarize({ segments: bigSegments })

    expect(calls).toHaveLength(2)
    expect(requestGaps()).toHaveLength(1)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(180)
  })

  it('paces a within-chunk retry exactly like a new chunk', async () => {
    // A retry from withRetries is a real request too, and can consume close
    // to the same chunk's whole token budget — just as capable of landing in
    // the same rolling minute as its own first attempt as a new chunk is.
    const paced = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 2, minRequestIntervalMs: 200 })
    const calls = stubFetch([
      reply({ summary: 'x' }), // malformed: triggers a retry
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await paced.summarize({ segments })

    expect(calls).toHaveLength(2)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(180)
  })

  it('paces across summarizer instances that share a pacer, since the rate limit is per account', async () => {
    // useSummarizer builds a fresh Summarizer per HTTP request, so two
    // instances stand in for two concurrent extractions of DIFFERENT
    // meetings. Each is internally paced on its own either way; a shared
    // pacer is what keeps them from together exceeding the same
    // per-account rolling-minute allowance neither alone would hit.
    const sharedPacer = createRequestPacer(200)
    const meetingA = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: sharedPacer })
    const meetingB = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: sharedPacer })
    stubFetch([
      reply({ summary: '', decisions: [], actionItems: [] }),
      reply({ summary: '', decisions: [], actionItems: [] }),
    ])

    await meetingA.summarize({ segments })
    await meetingB.summarize({ segments })

    expect(requestGaps()).toHaveLength(1)
    expect(Math.min(...requestGaps())).toBeGreaterThanOrEqual(180)
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

    const sharedPacer = createRequestPacer(200)
    await sharedPacer.wait()

    const meetingA = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: sharedPacer })
    const meetingB = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 1, pacer: sharedPacer })

    await Promise.all([meetingA.summarize({ segments }), meetingB.summarize({ segments })])

    expect(requestTimestamps).toHaveLength(2)
    expect(Math.abs(requestTimestamps[1]! - requestTimestamps[0]!)).toBeGreaterThanOrEqual(180)
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
    // hit the same throttle again. Only one request should go out; the
    // 60s cooldown before a failed meeting can be retried (summarize.post.ts)
    // is where the actual backoff lives.
    const calls = stubFetch([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }),
      new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }),
    ])
    const err = await summarizer.summarize({ segments }).catch((e: SummarizationError) => e)
    expect(err.message).toMatch(/quota is exhausted.*60s/s)
    expect(err.retryable).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('turns a network error into a retryable failure', async () => {
    stubFetch([() => {
      throw new TypeError('fetch failed')
    }, reply(goodPayload)])
    const result = await summarizer.summarize({ segments })
    expect(result.decisions).toHaveLength(1)
  })
})
