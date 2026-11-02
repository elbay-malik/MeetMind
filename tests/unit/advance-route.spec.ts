import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'
import type { AdvanceOutcome } from '../../server/utils/pipeline/advance'
import { assessPipeline } from '../../server/utils/pipeline/assess'

/**
 * What the route adds to what the step library decides: the refusals, the header, and that
 * nothing of a database's or a provider's own words gets out.
 */

const advance = vi.hoisted(() => vi.fn<(id: string, deps: unknown) => Promise<AdvanceOutcome>>())
const useDeps = vi.hoisted(() => vi.fn((_event: unknown) => ({ built: true })))
const refuseOnPublicDemo = vi.hoisted(() => vi.fn())
vi.mock('../../server/utils/pipeline/advance', () => ({ advancePipeline: advance }))
vi.mock('../../server/utils/pipeline/deps', () => ({ usePipelineDeps: useDeps }))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo }))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

const headers = new Map<string, unknown>()
let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/advance.post')).default as unknown as typeof handler
})
beforeEach(() => {
  headers.clear()
  advance.mockReset()
  useDeps.mockClear()
  refuseOnPublicDemo.mockReset()
})
afterAll(() => vi.unstubAllGlobals())

const meeting = (status: Meeting['status']): Meeting => ({
  id: 'meeting', createdAt: 'x', updatedAt: '2026-11-03T00:00:00.000Z', title: 't', status, sourceFileName: 'f', sourceBytes: 1, sourceMime: null,
  durationSec: null, audioKey: 'k', audioBytes: 1, audioMime: 'audio/ogg', uploadedAt: null, errorMessage: 'Supabase said something raw', failedStage: null,
})

const assessed = (m: Meeting, runs: Parameters<typeof assessPipeline>[0]['runs'] = []): AdvanceOutcome => ({
  kind: 'assessed',
  assessment: assessPipeline({ meeting: m, runs, chunks: { done: 1, total: 3 }, index: null }, { model: 'm', now: Date.now() }),
})

describe('POST /api/meetings/:id/advance', () => {
  it('refuses the public demo before it builds or reads anything', async () => {
    refuseOnPublicDemo.mockImplementationOnce(() => {
      throw Object.assign(new Error('read-only'), { statusCode: 403 })
    })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403, message: 'read-only' })
    expect(refuseOnPublicDemo).toHaveBeenCalledWith({}, 'meeting')
    expect(useDeps).not.toHaveBeenCalled()
    expect(advance).not.toHaveBeenCalled()
  })

  it('takes the step with what the event builds, and answers the assessment over the wire', async () => {
    advance.mockResolvedValueOnce(assessed(meeting('indexing')))
    const answer = await handler({})
    expect(advance).toHaveBeenCalledWith('meeting', { built: true })
    expect(answer).toEqual({
      status: 'indexing',
      progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null },
      index: { state: 'unavailable', done: 0, total: null, retryAt: null },
      next: 'continue',
      retryAt: null,
      retryAfterMs: null,
    })
    expect(headers.has('retry-after')).toBe(false)
  })

  it('says when to come back on a wait, in the header too', async () => {
    const retryAt = new Date(Date.now() + 90_000)
    advance.mockResolvedValueOnce(assessed(meeting('transcribing'), [{
      stage: 'transcription', runId: 'r', cursor: {}, stepLeaseUntil: null, attempts: 0, lastError: 'a raw reason', retryAt,
    }]))
    const answer = await handler({}) as { next: string, retryAt: string, retryAfterMs: number }
    expect(answer.next).toBe('wait')
    expect(answer.retryAt).toBe(retryAt.toISOString())
    expect(answer.retryAfterMs).toBeGreaterThan(85_000)
    expect(headers.get('retry-after')).toBe(Math.ceil(answer.retryAfterMs / 1000))
  })

  it('carries no meeting, no run and none of their error text', async () => {
    advance.mockResolvedValueOnce(assessed(meeting('failed'), [{
      stage: 'transcription', runId: 'r', cursor: {}, stepLeaseUntil: null, attempts: 0, lastError: 'a raw reason', retryAt: null,
    }]))
    const answer = await handler({})
    expect(answer).toMatchObject({ next: 'failed', status: 'failed' })
    expect(JSON.stringify(answer)).not.toMatch(/raw|Supabase|meeting/)
  })

  it('answers 404 for a meeting that is not there, or stopped being', async () => {
    advance.mockResolvedValueOnce({ kind: 'missing' })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 404, message: 'Meeting not found' })
  })

  it('answers 409 for a meeting nobody has confirmed the upload of, as the transcribe route does', async () => {
    advance.mockResolvedValueOnce({ kind: 'not-uploaded' })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/pending_upload/) })
  })

  it.each<[string, () => void]>([
    ['the step library throws', () => advance.mockRejectedValueOnce(new Error('Supabase claim step failed (42P01): relation "pipeline_runs" does not exist'))],
    ['a driver cannot be built', () => useDeps.mockImplementationOnce(() => {
      throw new Error('NUXT_SUPABASE_SERVICE_KEY is set but NUXT_SUPABASE_URL is not')
    })],
  ])('tells the caller nothing of it when %s, and keeps it for the log', async (_name, arrange) => {
    arrange()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = await handler({}).catch((err: { statusCode: number, message: string }) => err) as { statusCode: number, message: string }
    expect(failure.statusCode).toBe(500)
    expect(failure.message).toBe('The pipeline hit a problem on the server. Try again shortly.')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.lastCall![1])).toMatch(/Supabase|SUPABASE/)
    warn.mockRestore()
  })
})
