import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_MAX_COMPLETION_TOKENS, createGroqAnswerer } from '../../server/utils/qa/groq-answerer'
import { AnswerError } from '../../server/utils/qa/answerer'
import type { RequestPacer } from '../../server/utils/summary/groq'
import type { TranscriptSegment } from '../../shared/types/meeting'

const segments: TranscriptSegment[] = [
  { idx: 10, startMs: 50_000, endMs: 54_800, text: 'We agreed to cut the marketing budget.' },
  { idx: 11, startMs: 55_000, endMs: 59_800, text: 'Finance will circulate it on Monday.' },
]

/** A pacer that counts how often it was waited on, and records each 429 it is told of. */
function countingPacer() {
  const pacer = {
    waits: 0,
    blocks: [] as number[],
    async wait() {
      pacer.waits++
    },
    async rateLimited(ms: number) {
      pacer.blocks.push(ms)
    },
  }
  return pacer satisfies RequestPacer
}

const reply = (content: unknown) => Response.json({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
})
const good = { citations: [{ quote: 'We agreed to cut the marketing budget.', segmentIdx: 10 }], answer: 'It was cut.' }

function stubGroq(responses: Array<() => Response>) {
  const bodies: Record<string, unknown>[] = []
  const queue = [...responses]
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return (queue.shift() ?? (() => new Response(null, { status: 500 })))()
  })
  return bodies
}

afterEach(() => vi.unstubAllGlobals())

describe('groq answerer', () => {
  it('asks for strict structured output with the evidence before the answer', async () => {
    const bodies = stubGroq([() => reply(good)])
    const answerer = createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() })
    expect(await answerer.answer({ question: 'What about the budget?', segments })).toEqual(good)

    const body = bodies[0] as {
      model: string
      temperature: number
      messages: { role: string, content: string }[]
      response_format: { type: string, json_schema: { name: string, strict: boolean, schema: { properties: object, required: string[] } } }
    }
    expect(body.model).toBe('openai/gpt-oss-120b')
    expect(body.temperature).toBe(0)
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema).toMatchObject({ name: 'meeting_answer', strict: true })
    // Constrained decoding emits keys in schema order: citations first makes
    // "find the evidence, then answer" a property of the schema.
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toEqual(['citations', 'answer'])
  })

  it('shows only the lines it was given, numbered by their real segment index', async () => {
    const bodies = stubGroq([() => reply(good)])
    await createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() }).answer({ question: 'What about the budget?', segments })
    const user = (bodies[0] as { messages: { role: string, content: string }[] }).messages.find(m => m.role === 'user')!
    expect(user.content).toBe(
      'Question: What about the budget?\n\nTranscript lines:\n'
      + '10| We agreed to cut the marketing budget.\n11| Finance will circulate it on Monday.',
    )
  })

  it('tells the model that transcript lines are content, not instructions', async () => {
    // A transcript is untrusted text: anyone speaking in the meeting wrote it.
    const bodies = stubGroq([() => reply(good)])
    await createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() }).answer({ question: 'q', segments })
    const system = (bodies[0] as { messages: { role: string, content: string }[] }).messages.find(m => m.role === 'system')!
    expect(system.content).toMatch(/not instructions to you/)
  })

  it('waits on the shared pacer before every attempt, retries included', async () => {
    // A retry spends the same per-account allowance as a first attempt.
    const pacer = countingPacer()
    const bodies = stubGroq([() => reply('not json'), () => reply(good)])
    await createGroqAnswerer({ apiKey: 'k', pacer }).answer({ question: 'q', segments })
    expect(bodies).toHaveLength(2)
    expect(pacer.waits).toBe(2)
  })

  it('retries a reply that does not match the schema, then gives up', async () => {
    const bodies = stubGroq([() => reply({ answer: 'no citations key' }), () => reply({ answer: 'still wrong' })])
    await expect(createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() }).answer({ question: 'q', segments }))
      .rejects.toThrow(/did not match the expected shape/)
    expect(bodies).toHaveLength(2)
  })

  it('reports a quota refusal as a 429 and does not retry into it', async () => {
    const bodies = stubGroq([() => new Response('slow down', { status: 429, headers: { 'retry-after': '12' } })])
    const pacer = countingPacer()
    const failure = await createGroqAnswerer({ apiKey: 'k', pacer })
      .answer({ question: 'q', segments }).catch(e => e)
    expect(failure).toBeInstanceOf(AnswerError)
    expect(failure).toMatchObject({ statusCode: 429, retryable: false })
    expect(failure.message).toMatch(/12s/)
    expect(bodies).toHaveLength(1)
    // Recorded on the shared ledger, so extraction waits it out as well.
    expect(pacer.blocks).toEqual([12_000])
  })

  // Same model, same provider default of 3,072 output tokens, reasoning
  // included -- see the summarizer's measured case.
  it('sets low reasoning effort and an explicit output budget rather than the provider\'s default', async () => {
    const bodies = stubGroq([() => reply(good)])
    await createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() }).answer({ question: 'q', segments })
    const body = bodies[0] as { max_completion_tokens?: number, reasoning_effort?: string }
    expect(body.reasoning_effort).toBe('low')
    expect(body.max_completion_tokens).toBe(ANSWER_MAX_COMPLETION_TOKENS)
  })

  it('names the output budget when the provider refuses a reply as invalid JSON, and does not retry it', async () => {
    const bodies = stubGroq([() => new Response(JSON.stringify({
      error: { message: 'Failed to validate JSON.', type: 'invalid_request_error', code: 'json_validate_failed', failed_generation: '' },
    }), { status: 400 })])
    const failure = await createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() })
      .answer({ question: 'q', segments }).catch(e => e)
    expect(failure).toBeInstanceOf(AnswerError)
    expect(failure).toMatchObject({ retryable: false })
    expect(failure.message).toMatch(/output budget/)
    expect(bodies).toHaveLength(1)
  })

  it('treats rejected credentials as final', async () => {
    const bodies = stubGroq([() => new Response('no', { status: 401 })])
    await expect(createGroqAnswerer({ apiKey: 'k', pacer: countingPacer() }).answer({ question: 'q', segments }))
      .rejects.toMatchObject({ retryable: false })
    expect(bodies).toHaveLength(1)
  })
})
