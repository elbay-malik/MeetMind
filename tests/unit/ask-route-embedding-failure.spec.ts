import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingError } from '../../server/utils/qa/embedder'

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
