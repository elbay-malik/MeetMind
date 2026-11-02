import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexingDeps, IndexingOutcome } from '../../server/utils/qa/steps'

/**
 * What the route adds to a step's outcome: the status, the header and the sentence a
 * visitor is told. The steps themselves are tests/unit/indexing-steps.spec.ts.
 */

const advance = vi.hoisted(() => vi.fn<(id: string, deps: IndexingDeps) => Promise<IndexingOutcome>>())
const refuseOnPublicDemo = vi.hoisted(() => vi.fn())
const useRuntimeConfig = vi.hoisted(() => vi.fn(() => ({ embedIntervalMs: 1234 })))
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig }))
vi.mock('../../server/utils/qa/steps', () => ({ advanceIndexing: advance }))
vi.mock('../../server/utils/qa', () => ({ useStepEmbedder: () => ({ model: 'step-embedder' }) }))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo }))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({}),
  usePipelineRepository: () => ({}),
  useSlotRepository: () => ({}),
  useTranscriptIndexRepository: () => ({}),
  useTranscriptRepository: () => ({}),
}))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

const headers = new Map<string, unknown>()
let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('setResponseStatus', () => {})
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/search-index.post')).default as unknown as typeof handler
})
beforeEach(() => headers.clear())
afterAll(() => vi.unstubAllGlobals())

const INDEX = { state: 'ready', windowCount: 3, indexedCount: 3, model: 'm' } as const

describe('POST /api/meetings/:id/search-index', () => {
  it('refuses the public demo before anything else', async () => {
    refuseOnPublicDemo.mockImplementationOnce(() => {
      throw Object.assign(new Error('read-only'), { statusCode: 403 })
    })
    advance.mockClear()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403 })
    expect(advance).not.toHaveBeenCalled()
  })

  it('takes the step with an embedder of one attempt and the configured gap', async () => {
    advance.mockResolvedValueOnce({ kind: 'done', index: INDEX })
    await handler({})
    const [id, deps] = advance.mock.lastCall!
    expect(id).toBe('meeting')
    expect(deps.embedIntervalMs).toBe(1234)
    expect(deps.embedder).toEqual({ model: 'step-embedder' })
  })

  it('answers with the index when it is finished', async () => {
    advance.mockResolvedValueOnce({ kind: 'done', index: INDEX })
    await expect(handler({})).resolves.toEqual({ index: INDEX })
  })

  // The 202 itself is held to in tests/e2e/search-index-api.spec.ts.
  it('answers with progress and nothing to wait for when the next step can go at once', async () => {
    advance.mockResolvedValueOnce({ kind: 'progress', progress: { done: 16, total: null, lastError: null }, next: 'continue', retryAt: null })
    await expect(handler({})).resolves.toEqual({
      progress: { done: 16, total: null, lastError: null }, next: 'continue', retryAt: null, retryAfterMs: null,
    })
    expect(headers.has('retry-after')).toBe(false)
  })

  it('answers with when to come back, as a time and as a duration', async () => {
    const retryAt = new Date(Date.now() + 90_000)
    advance.mockResolvedValueOnce({ kind: 'progress', progress: { done: 16, total: null, lastError: 'x' }, next: 'wait', retryAt })
    const body = await handler({}) as { retryAt: string, retryAfterMs: number }
    expect(body.retryAt).toBe(retryAt.toISOString())
    expect(body.retryAfterMs).toBeGreaterThan(85_000)
    expect(body.retryAfterMs).toBeLessThanOrEqual(90_000)
    expect(headers.get('retry-after')).toBeLessThanOrEqual(90)
  })

  it('says a stopped run resumes, and when, in the header and the body', async () => {
    const retryAt = new Date(Date.now() + 3_600_000)
    advance.mockResolvedValueOnce({ kind: 'failed', statusCode: 429, message: 'The limit.', retryAt, resumes: true })
    await expect(handler({})).rejects.toMatchObject({
      statusCode: 429,
      statusMessage: 'Indexing failed',
      message: 'The limit. Passages indexed so far are kept; indexing again resumes from there.',
      data: { retryAt: retryAt.toISOString(), retryAfterSec: expect.any(Number) },
    })
    expect(headers.get('retry-after')).toBeGreaterThan(3_500)
  })

  it('does not promise anything of a failure trying again cannot help', async () => {
    advance.mockResolvedValueOnce({ kind: 'failed', statusCode: 422, message: 'Too long.', retryAt: null, resumes: false })
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string, data: unknown }
    expect(refused).toMatchObject({ statusCode: 422, message: 'Too long.' })
    expect(refused.data).toBeUndefined()
    expect(headers.has('retry-after')).toBe(false)
  })

  it.each([[404, 'Meeting not found'], [409, 'Meeting is uploaded; it has no finished transcript to index yet']] as const)(
    'passes a refusal on as %i', async (statusCode, message) => {
      advance.mockResolvedValueOnce({ kind: 'refused', statusCode, message })
      await expect(handler({})).rejects.toMatchObject({ statusCode, message })
    },
  )
})
