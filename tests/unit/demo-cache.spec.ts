import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingSummary, TranscriptSegment } from '../../shared/types/meeting'
import { DEMO_CACHE_SECONDS, demoCacheKey, readThroughDemoCache } from '../../server/utils/demo-cache'

/**
 * The demo's reads come from the edge cache, and nothing else's does. The Cache API is a
 * Map behind `match` and `put` here, as `caches.default` is on a Worker; Node has none,
 * which is the fall-through every other tier of tests runs on.
 */

const repo = vi.hoisted(() => ({
  meetings: [] as unknown[],
  segments: [] as unknown[],
  summary: null as unknown,
  listForMeeting: vi.fn(),
  getForMeeting: vi.fn(),
}))
const isPublicDemo = vi.hoisted(() => vi.fn())
vi.mock('../../server/utils/db', () => ({
  // Each call takes the next row, and the last one stays: a summary read sees the row twice.
  useMeetingRepository: () => ({ get: async () => (repo.meetings.length > 1 ? repo.meetings.shift() : repo.meetings[0]) ?? null }),
  useTranscriptRepository: () => ({ listForMeeting: repo.listForMeeting }),
  useSummaryRepository: () => ({ getForMeeting: repo.getForMeeting }),
}))
vi.mock('../../server/utils/demo-meeting', () => ({ isPublicDemo }))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

type Handler = (event: unknown) => Promise<unknown>
let transcriptRoute: Handler
let summaryRoute: Handler

const store = new Map<string, Response>()
const fakeCache = {
  match: vi.fn(async (key: string) => store.get(key)?.clone()),
  put: vi.fn(async (key: string, response: Response) => {
    store.set(key, response)
  }),
}
const event = () => ({ context: {} })
const cacheHeaders: string[] = []

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  transcriptRoute = (await import('../../server/api/meetings/[id]/transcript.get')).default as unknown as Handler
  summaryRoute = (await import('../../server/api/meetings/[id]/summary.get')).default as unknown as Handler
})
beforeEach(() => {
  vi.stubGlobal('caches', { default: fakeCache })
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => cacheHeaders.push(`${name}=${value}`))
  store.clear()
  fakeCache.match.mockClear()
  fakeCache.put.mockClear()
  repo.meetings = []
  repo.segments = [{ idx: 0, startMs: 0, endMs: 1000, text: 'hello' }] satisfies TranscriptSegment[]
  repo.summary = { overview: 'o' } as unknown as MeetingSummary
  repo.listForMeeting.mockReset().mockImplementation(async () => repo.segments)
  repo.getForMeeting.mockReset().mockImplementation(async () => repo.summary)
  isPublicDemo.mockReset().mockReturnValue(true)
})
afterAll(() => vi.unstubAllGlobals())

const meeting = (status: Meeting['status'], patch: Partial<Meeting> = {}): Meeting => ({
  id: 'meeting', createdAt: 'x', updatedAt: '2026-11-03T00:00:00.000Z', title: 't', status, sourceFileName: 'f', sourceBytes: 1, sourceMime: null,
  durationSec: null, audioKey: 'k', audioBytes: 1, audioMime: 'audio/ogg', uploadedAt: null, errorMessage: null, failedStage: null, ...patch,
})

describe('the transcript route', () => {
  it('reads a finished demo once, and answers the next visit from the cache with the same JSON', async () => {
    repo.meetings = [meeting('ready')]
    const first = await transcriptRoute(event())
    const second = await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first).toEqual({ segments: repo.segments })
    expect(cacheHeaders.slice(-2)).toEqual(['x-demo-cache=miss', 'x-demo-cache=hit'])
  })

  it('stores the entry for an hour, as JSON, under the demo\'s own key', async () => {
    repo.meetings = [meeting('ready')]
    await transcriptRoute(event())
    const [key, response] = fakeCache.put.mock.calls[0]!
    expect(key).toBe(demoCacheKey(meeting('ready'), 'transcript'))
    expect(response.headers.get('cache-control')).toBe(`public, max-age=${DEMO_CACHE_SECONDS}`)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('caches the transcript once transcription has finished, before the summary is', async () => {
    repo.meetings = [meeting('summarizing')]
    await transcriptRoute(event())
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(1)
  })

  it('always reads a meeting that is not the demo, and stores nothing for it', async () => {
    isPublicDemo.mockReturnValue(false)
    repo.meetings = [meeting('ready')]
    await transcriptRoute(event())
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(2)
    expect(fakeCache.match).not.toHaveBeenCalled()
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('does not cache a demo still being transcribed', async () => {
    repo.meetings = [meeting('transcribing')]
    await transcriptRoute(event())
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(2)
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('reads afresh once the meeting row has changed', async () => {
    repo.meetings = [meeting('ready')]
    await transcriptRoute(event())
    repo.meetings = [meeting('ready', { updatedAt: '2026-11-04T00:00:00.000Z' })]
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(2)
  })

  it('stores nothing when the read fails', async () => {
    repo.meetings = [meeting('ready')]
    repo.listForMeeting.mockRejectedValueOnce(new Error('database down'))
    await expect(transcriptRoute(event())).rejects.toThrow('database down')
    expect(fakeCache.put).not.toHaveBeenCalled()
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(2)
  })

  it('reads the repository every time where there is no Cache API', async () => {
    vi.stubGlobal('caches', undefined)
    repo.meetings = [meeting('ready')]
    await transcriptRoute(event())
    await transcriptRoute(event())
    expect(repo.listForMeeting).toHaveBeenCalledTimes(2)
  })

  it('still answers when the cache cannot', async () => {
    fakeCache.match.mockRejectedValueOnce(new Error('cache unavailable'))
    fakeCache.put.mockRejectedValueOnce(new Error('cache unavailable'))
    repo.meetings = [meeting('ready')]
    expect(await transcriptRoute(event())).toEqual({ segments: repo.segments })
  })
})

describe('the summary route', () => {
  it('reads a ready demo\'s summary once, and answers the next visit from the cache', async () => {
    repo.meetings = [meeting('ready')]
    const first = await summaryRoute(event())
    const second = await summaryRoute(event())
    expect(repo.getForMeeting).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first).toEqual({ summary: repo.summary })
  })

  it('does not cache a demo that is not ready', async () => {
    repo.meetings = [meeting('indexing')]
    expect(await summaryRoute(event())).toEqual({ summary: null })
    expect(fakeCache.match).not.toHaveBeenCalled()
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('does not keep a null answer from a ready meeting with no summary row', async () => {
    repo.meetings = [meeting('ready')]
    repo.summary = null
    await summaryRoute(event())
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('does not keep a summary read while the meeting left ready', async () => {
    repo.meetings = [meeting('ready'), meeting('indexing')]
    expect(await summaryRoute(event())).toEqual({ summary: null })
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('sends, but does not keep, a summary read while the row changed', async () => {
    repo.meetings = [meeting('ready'), meeting('ready', { updatedAt: '2026-11-04T00:00:00.000Z' })]
    expect(await summaryRoute(event())).toEqual({ summary: repo.summary })
    expect(fakeCache.put).not.toHaveBeenCalled()
  })

  it('always reads a meeting that is not the demo', async () => {
    isPublicDemo.mockReturnValue(false)
    repo.meetings = [meeting('ready')]
    await summaryRoute(event())
    await summaryRoute(event())
    expect(repo.getForMeeting).toHaveBeenCalledTimes(2)
    expect(fakeCache.put).not.toHaveBeenCalled()
  })
})

describe('readThroughDemoCache', () => {
  it('hands the store to waitUntil when the platform offers it, so the response does not wait', async () => {
    const waitUntil = vi.fn()
    const value = await readThroughDemoCache({ context: {}, waitUntil } as never, meeting('ready'), 'r', { finished: true }, async () => ({ a: 1 }))
    expect(value).toEqual({ a: 1 })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]![0]
    expect(store.size).toBe(1)
  })

  it('keys the demo in lower case, whatever case the row was read in', () => {
    expect(demoCacheKey({ id: 'ABC', updatedAt: 'u' }, 'transcript')).toBe(demoCacheKey({ id: 'abc', updatedAt: 'u' }, 'transcript'))
  })
})
