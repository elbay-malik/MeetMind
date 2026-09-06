import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroqSummarizer } from '../../server/utils/summary/groq'
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

const summarizer = createGroqSummarizer({ apiKey: 'gsk-test', maxAttempts: 2 })

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

function stubFetch(responses: (Response | (() => never))[]) {
  const calls: Request[] = []
  const queue = [...responses]
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
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

  it('explains quota exhaustion in the user\'s terms', async () => {
    stubFetch([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }),
      new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }),
    ])
    const err = await summarizer.summarize({ segments }).catch((e: SummarizationError) => e)
    expect(err.message).toMatch(/quota is exhausted.*60s/s)
    expect(err.retryable).toBe(true)
  })

  it('turns a network error into a retryable failure', async () => {
    stubFetch([() => {
      throw new TypeError('fetch failed')
    }, reply(goodPayload)])
    const result = await summarizer.summarize({ segments })
    expect(result.decisions).toHaveLength(1)
  })
})
