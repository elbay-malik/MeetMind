import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalTranscriptRepository } from '../../server/utils/db/transcripts-local'
import { createSupabaseTranscriptRepository } from '../../server/utils/db/transcripts-supabase'
import { rowToSegment, segmentToRow, type TranscriptSegmentRow } from '../../server/utils/db/transcripts'
import type { TranscriptSegment } from '../../shared/types/meeting'

const segments: TranscriptSegment[] = [
  { idx: 0, startMs: 0, endMs: 1000, text: 'hello' },
  { idx: 1, startMs: 1000, endMs: 2000, text: 'world' },
]

describe('row mapping', () => {
  const row: TranscriptSegmentRow = {
    meeting_id: 'm1', idx: 3, start_ms: 4000, end_ms: 5500, text: 'spoken', created_at: '2026-09-05T12:00:00Z',
  }

  it('maps a row to the domain shape', () => {
    expect(rowToSegment(row)).toEqual({ idx: 3, startMs: 4000, endMs: 5500, text: 'spoken' })
  })

  it('maps a segment back, attaching the meeting and leaving created_at to the database', () => {
    const mapped = segmentToRow('m1', { idx: 3, startMs: 4000, endMs: 5500, text: 'spoken' })
    expect(mapped).toEqual({ meeting_id: 'm1', idx: 3, start_ms: 4000, end_ms: 5500, text: 'spoken' })
    expect(mapped).not.toHaveProperty('created_at')
  })

  it('round-trips', () => {
    expect(rowToSegment({ ...segmentToRow('m1', segments[1]!), created_at: 'x' })).toEqual(segments[1])
  })
})

describe('local transcript repository', () => {
  let dataDir: string
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'meetmind-transcripts-'))
  })
  afterAll(() => rm(dataDir, { recursive: true, force: true }))

  it('returns an empty transcript before anything is stored', async () => {
    const repo = createLocalTranscriptRepository({ dataDir })
    expect(await repo.listForMeeting('unknown')).toEqual([])
  })

  it('stores and reads back a transcript', async () => {
    const repo = createLocalTranscriptRepository({ dataDir })
    await repo.replaceForMeeting('m1', segments)
    expect(await repo.listForMeeting('m1')).toEqual(segments)
  })

  it('replaces rather than appends, so re-running transcription is idempotent', async () => {
    const repo = createLocalTranscriptRepository({ dataDir })
    await repo.replaceForMeeting('m2', segments)
    await repo.replaceForMeeting('m2', [{ idx: 0, startMs: 0, endMs: 500, text: 'only' }])
    expect(await repo.listForMeeting('m2')).toEqual([{ idx: 0, startMs: 0, endMs: 500, text: 'only' }])
  })

  it('keeps meetings separate', async () => {
    const repo = createLocalTranscriptRepository({ dataDir })
    await repo.replaceForMeeting('m3', segments)
    expect(await repo.listForMeeting('m4')).toEqual([])
  })

  it('can store an empty transcript', async () => {
    const repo = createLocalTranscriptRepository({ dataDir })
    await repo.replaceForMeeting('m5', segments)
    await repo.replaceForMeeting('m5', [])
    expect(await repo.listForMeeting('m5')).toEqual([])
  })

  describe('listFrom', () => {
    const lines = (count: number): TranscriptSegment[] =>
      Array.from({ length: count }, (_, i) => ({ idx: i, startMs: i, endMs: i + 1, text: `line ${i}` }))

    it('reads a page from a line on, in order, saying whether any lie past it', async () => {
      const repo = createLocalTranscriptRepository({ dataDir })
      await repo.replaceForMeeting('f1', lines(10).reverse())
      expect(await repo.listFrom('f1', 2, 3)).toEqual({ segments: lines(5).slice(2), more: true })
      expect(await repo.listFrom('f1', 7, 3)).toEqual({ segments: lines(10).slice(7), more: false })
      expect(await repo.listFrom('f1', 8, 3)).toEqual({ segments: lines(10).slice(8), more: false })
      expect(await repo.listFrom('f1', 40, 3)).toEqual({ segments: [], more: false })
    })

    it('reads across a gap in the numbering, which an index range could not', async () => {
      const repo = createLocalTranscriptRepository({ dataDir })
      const gapped = lines(6).filter(s => s.idx !== 2 && s.idx !== 3)
      await repo.replaceForMeeting('f2', gapped)
      expect(await repo.listFrom('f2', 1, 3)).toEqual({ segments: gapped.slice(1, 4), more: false })
    })
  })

  describe('deleteForMeeting', () => {
    // Read straight from the JSON store: listForMeeting reads a missing file
    // and an empty one identically, so only the store itself can show the
    // file is gone rather than emptied.
    const stored = (meetingId: string) =>
      createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) }).hasItem(`transcripts/${meetingId}`)

    it('removes the transcript file itself, not just its segments', async () => {
      // Nothing cascades on this driver; a file left behind would outlive the
      // meeting it belongs to, with nothing left that knows to remove it.
      const repo = createLocalTranscriptRepository({ dataDir })
      await repo.replaceForMeeting('d1', segments)
      expect(await stored('d1')).toBe(true)
      await repo.deleteForMeeting('d1')
      expect(await stored('d1')).toBe(false)
      expect(await repo.listForMeeting('d1')).toEqual([])
    })

    it('leaves other meetings\' transcripts alone', async () => {
      const repo = createLocalTranscriptRepository({ dataDir })
      await repo.replaceForMeeting('d2', segments)
      await repo.replaceForMeeting('d3', segments)
      await repo.deleteForMeeting('d2')
      expect(await repo.listForMeeting('d3')).toEqual(segments)
    })

    it('is a no-op for a meeting with nothing stored, so a half-finished delete can be re-run', async () => {
      const repo = createLocalTranscriptRepository({ dataDir })
      await expect(repo.deleteForMeeting('never-stored')).resolves.toBeUndefined()
      await repo.replaceForMeeting('d4', segments)
      await repo.deleteForMeeting('d4')
      await expect(repo.deleteForMeeting('d4')).resolves.toBeUndefined()
    })
  })
})

describe('supabase transcript repository', () => {
  const repo = createSupabaseTranscriptRepository({ url: 'https://p.supabase.co', serviceKey: 'k' })

  /**
   * Serve `total` rows the way PostgREST does: honour `offset`/`limit` (which is
   * what .range() actually sets, not a Range header), and never return more than
   * `cap` rows, which is the server-side row cap this paging exists to survive.
   */
  function stubPaged(total: number, cap = 1000) {
    const urls: URL[] = []
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, init) : input
      const url = new URL(request.url)
      urls.push(url)
      if (request.method !== 'GET') return new Response('[]', { headers: { 'content-type': 'application/json' } })
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Math.min(cap, Number(url.searchParams.get('limit') ?? cap))
      const count = Math.max(0, Math.min(limit, total - offset))
      const rows = Array.from({ length: count }, (_, i) => ({
        meeting_id: 'm1', idx: offset + i, start_ms: 0, end_ms: 1, text: `segment ${offset + i}`, created_at: 'x',
      }))
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } })
    })
    return urls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('reads a short transcript in one request', async () => {
    const urls = stubPaged(3)
    expect(await repo.listForMeeting('m1')).toHaveLength(3)
    expect(urls).toHaveLength(1)
  })

  it('pages past the server-side row cap instead of truncating silently', async () => {
    // PostgREST caps result sets and returns a short array with no error. An
    // unpaged read would return 1000 of these 2500 segments and look complete.
    const urls = stubPaged(2500)
    const result = await repo.listForMeeting('m1')
    expect(result).toHaveLength(2500)
    expect(result.map(s => s.idx)).toEqual(Array.from({ length: 2500 }, (_, i) => i))
    expect(urls.length).toBeGreaterThan(1)
  })

  it('stops at the exact cap boundary without an extra empty page', async () => {
    const urls = stubPaged(1000)
    expect(await repo.listForMeeting('m1')).toHaveLength(1000)
    // 1000 rows means "there may be more", so exactly one extra probe.
    expect(urls).toHaveLength(2)
  })

  describe('listFrom', () => {
    /** As PostgREST answers a count: the page, and the total in Content-Range. */
    function stubCounted(total: number, cap = 1000) {
      const requests: Request[] = []
      vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
        const request = typeof input === 'string' ? new Request(input, init) : input
        requests.push(request)
        const url = new URL(request.url)
        const limit = Math.min(cap, Number(url.searchParams.get('limit')))
        const rows = Array.from({ length: Math.min(limit, total) }, (_, i) => ({
          meeting_id: 'm1', idx: 5 + i, start_ms: 0, end_ms: 1, text: `line ${5 + i}`, created_at: 'x',
        }))
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${total}` },
        })
      })
      return requests
    }

    it('reads one page in one request, from the line asked for', async () => {
      const requests = stubCounted(3)
      const page = await repo.listFrom('m1', 5, 256)
      expect(requests).toHaveLength(1)
      const url = new URL(requests[0]!.url)
      expect(url.searchParams.get('meeting_id')).toBe('eq.m1')
      expect(url.searchParams.get('idx')).toBe('gte.5')
      expect(url.searchParams.get('limit')).toBe('256')
      expect(url.searchParams.get('order')).toBe('idx.asc')
      expect(requests[0]!.headers.get('prefer')).toMatch(/count=exact/)
      expect(page).toMatchObject({ more: false })
      expect(page.segments.map(s => s.idx)).toEqual([5, 6, 7])
    })

    it('says there is more when there is', async () => {
      stubCounted(300)
      const page = await repo.listFrom('m1', 5, 256)
      expect(page.segments).toHaveLength(256)
      expect(page.more).toBe(true)
    })

    // The reason `more` is the store's count: a short page reads like the end of the
    // transcript, and a plan cut short here would index half a meeting and call it done.
    it('knows a page shortened by the server\'s row cap is not the end', async () => {
      stubCounted(300, 100)
      const page = await repo.listFrom('m1', 5, 256)
      expect(page.segments).toHaveLength(100)
      expect(page.more).toBe(true)
    })

    it('refuses an answer with no count rather than guess', async () => {
      vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
      await expect(repo.listFrom('m1', 5, 256)).rejects.toThrow(/no count/)
    })
  })

  it('deletes a whole transcript with one DELETE filtered to the meeting', async () => {
    // Normally a no-op behind the meetings cascade, but the delete route runs
    // it on both drivers; an unfiltered DELETE here would empty the table.
    const calls: Request[] = []
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      calls.push(typeof input === 'string' ? new Request(input, init) : input)
      return new Response(null, { status: 204 })
    })
    await repo.deleteForMeeting('m1')
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(calls[0]!.method).toBe('DELETE')
    expect(url.pathname).toBe('/rest/v1/transcript_segments')
    expect(url.searchParams.get('meeting_id')).toBe('eq.m1')
  })

  it('surfaces a database error from the delete', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ code: '42501', message: 'permission denied', details: '', hint: '' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    await expect(repo.deleteForMeeting('m1')).rejects.toThrow(/42501/)
  })

  it('asks for rows in transcript order', async () => {
    const urls = stubPaged(5)
    await repo.listForMeeting('m1')
    expect(urls[0]!.searchParams.get('order')).toBe('idx.asc')
    expect(urls[0]!.searchParams.get('meeting_id')).toBe('eq.m1')
  })
})
