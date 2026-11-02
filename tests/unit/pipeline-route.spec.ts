import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'
import type { IndexState } from '../../server/utils/db/windows'

/**
 * `GET .../pipeline` may only read, which is what makes it safe to leave open on the public
 * demo. The repositories here have only the reads it is allowed: anything else is a TypeError
 * the route would answer with a 500, and that fails these. The bigger proof, that a stored
 * byte never changes, is over the real route in tests/e2e/pipeline-api.spec.ts.
 */

const repo = vi.hoisted(() => ({
  meeting: null as unknown,
  runs: [] as unknown[],
  state: null as unknown,
  counts: { done: 0, total: 0 },
  fail: null as Error | null,
}))
const refuseOnPublicDemo = vi.hoisted(() => vi.fn())
const isPublicDemo = vi.hoisted(() => vi.fn())
const embedDocuments = vi.hoisted(() => vi.fn())
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({
    get: async () => {
      if (repo.fail) throw repo.fail
      return repo.meeting
    },
  }),
  usePipelineRepository: () => ({ listRuns: async () => repo.runs, countChunks: async () => repo.counts }),
  useTranscriptIndexRepository: () => ({ readState: async () => repo.state }),
}))
vi.mock('../../server/utils/qa', () => ({ useEmbedder: () => ({ model: 'model-a', embedDocuments }) }))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo, isPublicDemo }))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/pipeline.get')).default as unknown as typeof handler
})
beforeEach(() => {
  repo.meeting = null
  repo.runs = []
  repo.state = null
  repo.counts = { done: 0, total: 0 }
  repo.fail = null
  refuseOnPublicDemo.mockReset()
  isPublicDemo.mockReset()
  embedDocuments.mockReset()
})
afterAll(() => vi.unstubAllGlobals())

const meeting = (status: Meeting['status'], patch: Partial<Meeting> = {}): Meeting => ({
  id: 'meeting', createdAt: 'x', updatedAt: '2026-11-03T00:00:00.000Z', title: 't', status, sourceFileName: 'f', sourceBytes: 1, sourceMime: null,
  durationSec: null, audioKey: 'k', audioBytes: 1, audioMime: 'audio/ogg', uploadedAt: null, errorMessage: null, failedStage: null, ...patch,
})

const INDEX: IndexState = {
  marker: { textHash: 'h', model: 'model-a', windowCount: 4, complete: true },
  transcriptHash: 'h', segmentCount: 9, storedWindows: 4, storedForModel: 4,
}

describe('GET /api/meetings/:id/pipeline', () => {
  it('answers how far the meeting has got', async () => {
    repo.meeting = meeting('ready')
    repo.state = INDEX
    await expect(handler({})).resolves.toEqual({
      status: 'ready',
      progress: { stage: 'search_index', done: 4, total: 4, etaSeconds: null },
      index: { state: 'complete', done: 4, total: 4, retryAt: null },
      next: 'done',
      retryAt: null,
      retryAfterMs: null,
    })
  })

  describe('on the public demo, where POST .../advance can only answer 403', () => {
    const HOUR = 3_600_000
    const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString()

    beforeEach(() => {
      isPublicDemo.mockReturnValue(true)
      refuseOnPublicDemo.mockImplementation(() => {
        throw Object.assign(new Error('read-only'), { statusCode: 403 })
      })
    })

    it('is not refused, and does not say continue, since no later call could', async () => {
      repo.meeting = meeting('uploaded')
      await expect(handler({})).resolves.toMatchObject({ status: 'uploaded', next: 'wait', retryAt: null, retryAfterMs: null })
      expect(refuseOnPublicDemo).not.toHaveBeenCalled()
    })

    it('does not say continue for an index with work to do, and still says how it stands', async () => {
      repo.meeting = meeting('ready')
      repo.state = { ...INDEX, marker: null, storedWindows: 0, storedForModel: 0 }
      await expect(handler({})).resolves.toMatchObject({ next: 'wait', retryAt: null, retryAfterMs: null, index: { state: 'building' } })
    })

    it('does not offer a retry of a failure, which asking again could not start', async () => {
      repo.meeting = meeting('failed', { failedStage: 'transcription', errorMessage: 'it broke', updatedAt: fromNow(0) })
      await expect(handler({})).resolves.toMatchObject({ next: 'failed', retryAt: null, retryAfterMs: null })
    })

    it('does not offer to pick up a parked index, which opening it could not do', async () => {
      const until = fromNow(8 * HOUR)
      repo.meeting = meeting('ready')
      repo.state = { ...INDEX, marker: null, storedWindows: 0, storedForModel: 0 }
      repo.runs = [{ stage: 'search_index', runId: 'r', cursor: {}, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: new Date(until) }]
      await expect(handler({})).resolves.toMatchObject({ next: 'done', retryAt: null, retryAfterMs: null, index: { state: 'parked', retryAt: until } })
    })

    it('still gives the time of a step already under way, which is not this caller\'s to take', async () => {
      const until = fromNow(60_000)
      repo.meeting = meeting('transcribing')
      repo.runs = [{ stage: 'transcription', runId: 'r', cursor: {}, stepLeaseUntil: null, attempts: 1, lastError: null, retryAt: new Date(until) }]
      await expect(handler({})).resolves.toMatchObject({ next: 'wait', retryAt: until })
    })
  })

  // `continue` here says what a POST would do, which this GET does not do.
  it('calls no provider, whatever a step would do next', async () => {
    repo.meeting = meeting('ready')
    repo.state = { ...INDEX, marker: null, storedWindows: 0, storedForModel: 0 }
    await expect(handler({})).resolves.toMatchObject({ next: 'continue', index: { state: 'building' } })
    expect(embedDocuments).not.toHaveBeenCalled()
  })

  it('answers 404 for a meeting that is not there', async () => {
    await expect(handler({})).rejects.toMatchObject({ statusCode: 404, message: 'Meeting not found' })
  })

  it('tells the caller nothing of a database error, and keeps it for the log', async () => {
    repo.fail = new Error('Supabase meeting select failed (42P01): relation "meetings" does not exist')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(handler({})).rejects.toMatchObject({ statusCode: 500, message: 'The pipeline hit a problem on the server. Try again shortly.' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
