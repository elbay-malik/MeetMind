import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NewMeeting } from '../../server/utils/db/meetings'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { createLocalTranscriptIndexRepository } from '../../server/utils/db/windows-local'
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../server/utils/qa/embedder'
import { indexMeeting } from '../../server/utils/qa/indexing'
import { searchMeetings, SearchError } from '../../server/utils/qa/search'
import { createStubEmbedder } from '../../server/utils/qa/stub'
import type { TranscriptSegment } from '../../shared/types/meeting'

const embedder = createStubEmbedder()

/** A unit vector along one axis — precise control over similarity, unlike the stub's hashed tokens. */
function axis(n: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  v[n] = 1
  return v
}

/** An embedder whose query vector is fixed, so a test controls similarity exactly. */
function fixedQueryEmbedder(queryVector: number[]): Embedder {
  return {
    kind: 'stub',
    model: 'fixed-test-vector',
    dimensions: queryVector.length,
    embedDocuments: () => { throw new Error('not used by this fixture') },
    embedQuery: async () => queryVector,
  }
}

function fixtureMeeting(id: string, title: string): NewMeeting {
  return {
    id,
    title,
    status: 'ready',
    sourceFileName: 'meeting.mp4',
    sourceBytes: 1_000_000,
    sourceMime: 'video/mp4',
    durationSec: 300,
    audioKey: `meetings/${id}/audio.ogg`,
    audioBytes: 50_000,
    audioMime: 'audio/ogg',
    uploadedAt: new Date(0).toISOString(),
    errorMessage: null,
    failedStage: null,
  }
}

// A search spans every meeting in the repository, unlike a per-meeting test —
// a shared directory across tests (the usual pattern elsewhere in this repo)
// would make each test's results depend on every earlier test's leftover
// meetings. A fresh directory per test avoids that.
describe('searchMeetings', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'meetmind-search-'))
  })
  afterEach(() => rm(dataDir, { recursive: true, force: true }))

  const repo = () => createLocalTranscriptIndexRepository({ dataDir })
  const meetings = () => createLocalMeetingRepository({ dataDir })

  async function indexed(id: string, title: string, segments: TranscriptSegment[]) {
    await meetings().create(fixtureMeeting(id, title))
    await indexMeeting({ meetingId: id, segments, embedder, repo: repo() })
  }

  it('returns passages across meetings, each tagged with its own meeting\'s title', async () => {
    await indexed('s1', 'Budget planning', [
      { idx: 0, startMs: 0, endMs: 4_800, text: 'We agreed to cut the marketing budget by twenty percent.' },
    ])
    await indexed('s2', 'Hiring roundup', [
      { idx: 0, startMs: 0, endMs: 4_800, text: 'Priya will interview two candidates for a design role.' },
    ])

    const result = await searchMeetings({
      query: 'What did we decide about the marketing budget?', embedder, repo: repo(), meetings: meetings(),
    })

    const match = result.results.find(r => r.meetingId === 's1')
    expect(match).toBeDefined()
    expect(match!.meetingTitle).toBe('Budget planning')
    expect(match!.quote).toContain('marketing budget')
    expect(match!.segmentIdx).toBe(0)
    expect(match!.startMs).toBe(0)
  })

  it('refuses a query with no words, spending no embedding call', async () => {
    await expect(searchMeetings({ query: ' ?! ', embedder, repo: repo(), meetings: meetings() }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns no results when nothing has been indexed', async () => {
    const result = await searchMeetings({
      query: 'anything at all', embedder, repo: repo(), meetings: meetings(),
    })
    expect(result).toEqual({ results: [] })
  })

  it('drops a match whose meeting no longer exists, rather than showing a blank title', async () => {
    // Simulates a meeting deleted after being indexed: its windows remain in
    // the index (nothing in this app deletes them today), but the meeting
    // repository has no row for it any more.
    await indexMeeting({
      meetingId: 'ghost',
      segments: [{ idx: 0, startMs: 0, endMs: 4_800, text: 'We agreed to cut the marketing budget sharply.' }],
      embedder,
      repo: repo(),
    })

    const result = await searchMeetings({
      query: 'What did we decide about the marketing budget?', embedder, repo: repo(), meetings: meetings(),
    })
    expect(result.results.some(r => r.meetingId === 'ghost')).toBe(false)
  })

  it('rejects an error instance that is really a SearchError', async () => {
    const failure = await searchMeetings({ query: '', embedder, repo: repo(), meetings: meetings() }).catch(e => e)
    expect(failure).toBeInstanceOf(SearchError)
  })

  it('excludes a match with zero or negative similarity, even when it is the only thing indexed', async () => {
    // Retrieval ranks whatever it is given, top-K regardless of how weak the
    // match is — a query with nothing genuinely relevant indexed anywhere
    // must still come back empty, not "confidently" surface the
    // least-unrelated thing available. Exactly the scenario a real e2e run
    // hit: a nonsense query against an unrelated corpus still ranked
    // something, because nothing filtered a non-positive score out.
    await meetings().create(fixtureMeeting('neg', 'Unrelated meeting'))
    const opposite: TranscriptSegment = { idx: 0, startMs: 0, endMs: 4_800, text: 'unrelated content entirely' }
    await repo().upsertWindows('neg', [{
      idx: 0,
      firstSegmentIdx: opposite.idx,
      lastSegmentIdx: opposite.idx,
      startMs: opposite.startMs,
      endMs: opposite.endMs,
      text: opposite.text,
      contentHash: '0'.repeat(64),
      model: 'fixed-test-vector',
      // Exactly opposite the query vector: cosine similarity -1.
      embedding: axis(0).map(v => -v),
    }])

    const result = await searchMeetings({
      query: 'anything', embedder: fixedQueryEmbedder(axis(0)), repo: repo(), meetings: meetings(),
    })
    expect(result).toEqual({ results: [] })
  })

  it('keeps a genuinely positive-similarity match — the floor does not over-filter', async () => {
    await meetings().create(fixtureMeeting('pos', 'Relevant meeting'))
    const relevant: TranscriptSegment = { idx: 0, startMs: 0, endMs: 4_800, text: 'relevant content' }
    await repo().upsertWindows('pos', [{
      idx: 0,
      firstSegmentIdx: relevant.idx,
      lastSegmentIdx: relevant.idx,
      startMs: relevant.startMs,
      endMs: relevant.endMs,
      text: relevant.text,
      contentHash: '0'.repeat(64),
      model: 'fixed-test-vector',
      // Exactly the query vector: cosine similarity 1.
      embedding: axis(0),
    }])

    const result = await searchMeetings({
      query: 'anything', embedder: fixedQueryEmbedder(axis(0)), repo: repo(), meetings: meetings(),
    })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.meetingId).toBe('pos')
  })
})
