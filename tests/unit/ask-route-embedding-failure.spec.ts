import { inspect } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixedSentence } from '../../server/utils/public-errors'
import { AnswerError, AnswerSlotBusyError } from '../../server/utils/qa/answerer'
import { QuestionError } from '../../server/utils/qa/ask'
import { EmbeddingError } from '../../server/utils/qa/embedder'
import { createGroqAnswerer } from '../../server/utils/qa/groq-answerer'
import { createWorkersAiEmbedder } from '../../server/utils/qa/workers-ai'
import { ProviderBusyError } from '../../server/utils/summary/groq'

/**
 * What the route does with an embedding failure the e2e specs cannot cause: their
 * stub only ever refuses with the daily limit, so a capacity shortage or a rejected
 * token never reaches this branch there. Unhandled, either is a bare 500 to a visitor.
 */

const askMeeting = vi.hoisted(() => vi.fn())
vi.mock('../../server/utils/qa/ask', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/qa/ask')>(),
  askMeeting,
}))
vi.mock('../../server/utils/qa', () => ({ useAnswerer: () => ({}), useEmbedder: () => ({}) }))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({ get: async () => ({ status: 'ready' }) }),
  useTranscriptIndexRepository: () => ({}),
  useTranscriptRepository: () => ({ listForMeeting: async () => [] }),
}))

// No demo here: tests/unit/demo-question-cap.spec.ts has the route with one.
vi.mock('../../server/utils/demo-meeting', () => ({ isPublicDemo: () => false }))

const headers = new Map<string, unknown>()
let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('getRouterParam', () => '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')
  vi.stubGlobal('getRequestHeader', () => '30')
  vi.stubGlobal('readBody', async () => ({ question: 'What did we decide?' }))
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/ask.post')).default as unknown as typeof handler
})
beforeEach(() => headers.clear())
afterAll(() => vi.unstubAllGlobals())

describe('POST /api/meetings/:id/ask, when embedding the question fails', () => {
  it.each([
    ['a capacity shortage', 'The embedding service is out of capacity for the moment. Try again shortly.', 503],
    ['a rejected token', 'The embedding service rejected our credentials.', 502],
  ])('passes on %s as it was said, with its status and no time to wait for', async (_name, message, statusCode) => {
    askMeeting.mockRejectedValueOnce(new EmbeddingError(message, statusCode, false))
    await expect(handler({})).rejects.toMatchObject({ statusCode, message, statusMessage: 'Answering failed' })
    expect(headers.has('retry-after')).toBe(false)
  })

  it('never tells a caller to come back in no time, whatever the clock has done since', async () => {
    askMeeting.mockRejectedValueOnce(new EmbeddingError('limit', 429, false, new Date(Date.now() - 5_000)))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429, data: { retryAfterSec: 1 } })
    expect(headers.get('retry-after')).toBe(1)
  })
})

describe('POST /api/meetings/:id/ask, of what a provider said', () => {
  const MEETING = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  beforeEach(() => warn.mockClear())
  afterAll(() => warn.mockRestore())

  it.each([
    ['the answerer', new AnswerError('Answering service refused the request (HTTP 400): {"organization":"org_123"}', 502, false)],
    ['the embedder', new EmbeddingError('Embedding service refused the request (HTTP 400, code 8007): org_123', 502, false)],
  ])('tells a caller a fixed sentence of %s, and keeps the words in the log, with the meeting', async (_name, failure) => {
    askMeeting.mockRejectedValueOnce(failure)
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, statusMessage: string, message: string }
    expect(refused).toMatchObject({ statusCode: 502, statusMessage: 'Answering failed', message: fixedSentence('answering', 502) })
    expect(refused.message).not.toContain('org_123')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.lastCall![0]).toContain(MEETING)
    expect(warn.mock.lastCall![1]).toBe(failure)
  })

  it('says the fixed sentence of a 429, and when to come back', async () => {
    const retryAt = new Date(Date.now() + 30_000)
    askMeeting.mockRejectedValueOnce(new AnswerError('org_123 is over its tier', 429, false, retryAt))
    await expect(handler({})).rejects.toMatchObject({
      statusCode: 429,
      message: fixedSentence('answering', 429),
      data: { retryAt: retryAt.toISOString(), retryAfterSec: expect.any(Number) },
    })
    expect(headers.get('retry-after')).toBeGreaterThan(0)
  })

  it('leaves when to ask again to the page, for a provider that failed and whose retry got no slot', async () => {
    const retryAt = new Date(Date.now() + 90_000)
    const pacer = {
      wait: vi.fn(async () => {
        throw new ProviderBusyError(retryAt)
      }),
      rateLimited: async () => {},
    }
    const reply = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('upstream sentinel', { status: 503 }))
    const failure = await createGroqAnswerer({ apiKey: 'k', pacer })
      .answer({ question: 'q', segments: [] }, { slotHeld: true })
      .catch((err: unknown) => err)
      .finally(() => reply.mockRestore())
    // The real text this path throws, which no rule takes, so it is the fixed sentence that goes out.
    expect(failure).toMatchObject({ statusCode: 429, retryAt, message: 'Answering service is unavailable (HTTP 503). Retrying needs the next request slot.' })

    askMeeting.mockRejectedValueOnce(failure)
    const refused = await handler({}).catch((err: unknown) => err) as { message: string, data: { retryAfterSec: number } }
    expect(refused.message).toBe(fixedSentence('answering', 429))
    expect(refused.data.retryAfterSec).toBeGreaterThan(0)
    expect(refused.message).not.toMatch(/try again|shortly|later|rate limit/i)
  })

  it('passes on a refusal of the app\'s own, and does not log what nothing went wrong to cause', async () => {
    askMeeting.mockRejectedValueOnce(new QuestionError('Ask a question that contains words.', 400))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Cannot answer', message: 'Ask a question that contains words.' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not log a question that only has to wait its turn: asking is open to anyone', async () => {
    askMeeting.mockRejectedValueOnce(new AnswerSlotBusyError(new Date(Date.now() + 30_000)))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429, message: expect.stringMatching(/busy/) })
    expect(warn).not.toHaveBeenCalled()
  })

  it('stops a question of its own too, if it ever holds more than the sentence it should', async () => {
    askMeeting.mockRejectedValueOnce(new QuestionError('Ask a question that contains words. org_123', 400))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, message: fixedSentence('answering', 400) })
  })

  it('leaves anything else for Nitro, which tells a caller nothing of it', async () => {
    const failure = new Error('Supabase read failed (PGRST116)')
    askMeeting.mockRejectedValueOnce(failure)
    await expect(handler({})).rejects.toBe(failure)
  })
})

/**
 * What the log gets is the error object, which the real drivers build. A failure of either
 * is built from the reply's status and body, and neither carries the request it was for.
 */
describe('the errors logged', () => {
  const API_KEY = 'gsk_secret_key_0123456789'
  const ACCOUNT = 'account0123456789'
  const API_TOKEN = 'cf_secret_token_0123456789'

  afterAll(() => vi.unstubAllGlobals())

  it.each([
    ['the answerer', () => createGroqAnswerer({
      apiKey: API_KEY,
      pacer: { wait: async () => {}, rateLimited: async () => {} },
    }).answer({ question: 'q', segments: [] })],
    ['the embedder', () => createWorkersAiEmbedder({ accountId: ACCOUNT, apiToken: API_TOKEN, maxAttempts: 1 }).embedQuery('q')],
  ])('of %s carry no credential and no header', async (_name, fail) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 1, message: 'said no' }] }), { status: 400 })))
    const failure = await fail().catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    const printed = inspect(failure, { depth: null, showHidden: true })
    for (const secret of [API_KEY, ACCOUNT, API_TOKEN, 'authorization', 'Bearer']) expect(printed).not.toContain(secret)
    expect(Object.keys(failure as object)).toEqual(expect.not.arrayContaining(['headers', 'request', 'config']))
  })
})
