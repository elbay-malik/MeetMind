import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixedSentence } from '../../server/utils/public-errors'
import type { PublicStage } from '../../server/utils/public-errors'

/**
 * A refusal's words, on each route that takes a step. Every refusal is our own sentence
 * today, so no request can show a route passing one on unread: only an outcome made up here.
 */

const advance = vi.hoisted(() => vi.fn())
vi.mock('../../server/utils/transcription/steps', () => ({ advanceTranscription: advance }))
vi.mock('../../server/utils/summary/steps', () => ({ advanceExtraction: advance }))
vi.mock('../../server/utils/qa/steps', () => ({ advanceIndexing: advance }))
vi.mock('../../server/utils/pipeline/deps', () => ({
  useTranscriptionStepDeps: () => ({}),
  useExtractionStepDeps: () => ({}),
  useIndexingStepDeps: () => ({}),
}))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo: () => {} }))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

const RAW = 'Supabase read failed (PGRST116) for meetings/9b1d/audio.ogg'

type Handler = (event: unknown) => Promise<unknown>
const routes: Record<string, { stage: PublicStage, handler: Handler }> = {}
const headers = new Map<string, unknown>()

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('setResponseStatus', () => {})
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  routes.transcribe = { stage: 'transcription', handler: (await import('../../server/api/meetings/[id]/transcribe.post')).default as unknown as Handler }
  routes.summarize = { stage: 'extraction', handler: (await import('../../server/api/meetings/[id]/summarize.post')).default as unknown as Handler }
  routes['search-index'] = { stage: 'indexing', handler: (await import('../../server/api/meetings/[id]/search-index.post')).default as unknown as Handler }
})
beforeEach(() => headers.clear())
afterAll(() => vi.unstubAllGlobals())

describe.each(['transcribe', 'summarize', 'search-index'])('POST .../%s, refused in words it does not know', (name) => {
  it.each([404, 409])('answers %i with the fixed sentence', async (statusCode) => {
    const { stage, handler } = routes[name]!
    advance.mockResolvedValueOnce({ kind: 'refused', statusCode, message: RAW })
    await expect(handler({})).rejects.toMatchObject({ statusCode, message: fixedSentence(stage, statusCode) })
  })
})

describe('POST .../search-index, between steps', () => {
  it('says how long to wait in seconds', async () => {
    advance.mockResolvedValueOnce({
      kind: 'progress',
      progress: { done: 1, total: null, lastError: RAW },
      next: 'wait',
      retryAt: new Date(Date.now() + 90_000),
    })
    const answer = await routes['search-index']!.handler({}) as { progress: object }
    expect(headers.get('retry-after')).toBeGreaterThan(85)
    expect(headers.get('retry-after')).toBeLessThanOrEqual(90)
    expect(answer.progress).toEqual({ done: 1, total: null })
  })
})
