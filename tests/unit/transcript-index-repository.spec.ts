import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampLimit,
  cosineSimilarity,
  MAX_MATCHES,
  readyWindowCount,
  rowToMatch,
  windowToRow,
  type EmbeddedWindow,
  type IndexState,
} from '../../server/utils/db/windows'
import { createLocalTranscriptIndexRepository } from '../../server/utils/db/windows-local'
import { createSupabaseTranscriptIndexRepository } from '../../server/utils/db/windows-supabase'

const DIMS = 1024

/** A unit vector along one axis, blended towards a second when `towards` is given. */
function axis(n: number, towards?: { n: number, weight: number }): number[] {
  const v = new Array<number>(DIMS).fill(0)
  v[n] = 1
  if (towards) v[towards.n] = towards.weight
  return v
}

const hash = (c: string) => c.repeat(64)

function window(idx: number, embedding: number[], overrides: Partial<EmbeddedWindow> = {}): EmbeddedWindow {
  return {
    idx,
    firstSegmentIdx: idx,
    lastSegmentIdx: idx + 1,
    startMs: idx * 1000,
    endMs: idx * 1000 + 999,
    text: `window ${idx}`,
    contentHash: hash('a'),
    model: '@cf/baai/bge-m3',
    embedding,
    ...overrides,
  }
}

describe('shared helpers', () => {
  it('scores cosine similarity the way pgvector\'s 1 - (a <=> b) does', () => {
    expect(cosineSimilarity(axis(0), axis(0))).toBeCloseTo(1, 12)
    expect(cosineSimilarity(axis(0), axis(1))).toBe(0)
    // Magnitude does not matter, only direction.
    expect(cosineSimilarity(axis(0).map(v => v * 5), axis(0))).toBeCloseTo(1, 12)
  })

  it('scores a zero vector as NaN, matching pgvector rather than inventing a direction for it', () => {
    // pgvector's `<=>` genuinely returns NaN for a zero-norm operand (verified
    // against a real pgvector/pgvector:pg17 instance during a self-review of
    // this branch) — Postgres then sorts NaN as larger than every real value,
    // in either direction, so a zero-norm row always ranks last. Scoring it as
    // 0 here matched neither: 0 sorts ABOVE any window with genuine negative
    // similarity, the opposite of where pgvector places it. See the ordering
    // test below for the local driver's search() actually honouring this.
    expect(cosineSimilarity(new Array(DIMS).fill(0), axis(0))).toBeNaN()
  })

  it('refuses to compare vectors of different sizes', () => {
    expect(() => cosineSimilarity(axis(0), [1, 0, 0])).toThrow(/1024 and 3/)
  })

  it('clamps a search limit exactly as the SQL function does', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(Number.NaN)).toBe(1)
    expect(clampLimit(3.7)).toBe(3)
    expect(clampLimit(1_000)).toBe(MAX_MATCHES)
  })

  it('maps a window to a row and a search row back to a match', () => {
    const w = window(3, axis(0), { contentHash: hash('c') })
    expect(windowToRow('m1', w)).toEqual({
      meeting_id: 'm1', idx: 3, first_segment_idx: 3, last_segment_idx: 4, start_ms: 3000, end_ms: 3999,
      content: 'window 3', content_hash: hash('c'), model: '@cf/baai/bge-m3', embedding: w.embedding,
    })
    expect(rowToMatch({
      idx: 3, first_segment_idx: 3, last_segment_idx: 4, start_ms: 3000, end_ms: 3999,
      content: 'window 3', content_hash: hash('c'), similarity: 0.75,
    })).toEqual({
      idx: 3, firstSegmentIdx: 3, lastSegmentIdx: 4, startMs: 3000, endMs: 3999,
      text: 'window 3', contentHash: hash('c'), similarity: 0.75,
    })
  })
})

describe('local transcript index repository', () => {
  let dataDir: string
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'meetmind-windows-'))
  })
  afterAll(() => rm(dataDir, { recursive: true, force: true }))

  it('stores windows and reports their keys in index order, without vectors', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m1', [window(1, axis(1)), window(0, axis(0))])
    const keys = await repo.listKeys('m1')
    expect(keys).toEqual([
      { idx: 0, contentHash: hash('a'), model: '@cf/baai/bge-m3' },
      { idx: 1, contentHash: hash('a'), model: '@cf/baai/bge-m3' },
    ])
  })

  it('replaces a window with the same index rather than duplicating it', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m2', [window(0, axis(0))])
    await repo.upsertWindows('m2', [window(0, axis(1), { contentHash: hash('b') })])
    expect(await repo.listKeys('m2')).toEqual([{ idx: 0, contentHash: hash('b'), model: '@cf/baai/bge-m3' }])
  })

  it('reads only the keys in a range when given one, which is what keeps a step\'s read the size of its batch', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m3', [window(0, axis(0)), window(1, axis(1)), window(2, axis(2)), window(3, axis(3))])
    expect((await repo.listKeys('m3', { from: 1, to: 2 })).map(k => k.idx)).toEqual([1, 2])
    expect((await repo.listKeys('m3', { from: 9, to: 12 }))).toEqual([])
    expect((await repo.listKeys('m3')).map(k => k.idx)).toEqual([0, 1, 2, 3])
  })

  it('reads the state of a meeting nothing has been stored for', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    const state = await repo.readState('never-indexed', 'model-a')
    expect(state).toEqual({
      marker: null,
      // The hash of nothing, which is also what the SQL answers for no lines.
      transcriptHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      segmentCount: 0,
      storedWindows: 0,
      storedForModel: 0,
    })
  })

  it('counts the windows stored under the model asked about, and under any', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m-count', [window(0, axis(0)), window(1, axis(1), { model: 'another-model' })])
    expect(await repo.readState('m-count', 'another-model')).toMatchObject({ storedWindows: 2, storedForModel: 1 })
    expect(await repo.readState('m-count', 'a-third-model')).toMatchObject({ storedWindows: 2, storedForModel: 0 })
  })

  it('returns the nearest windows first, with their similarity and no embedding', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m4', [window(0, axis(0)), window(1, axis(1)), window(2, axis(2))])
    const matches = await repo.search('m4', axis(1, { n: 0, weight: 0.4 }), { model: '@cf/baai/bge-m3', limit: 5 })

    expect(matches.map(m => m.idx)).toEqual([1, 0, 2])
    expect(matches[0]!.similarity).toBeGreaterThan(matches[1]!.similarity)
    expect(matches[2]!.similarity).toBe(0)
    expect(matches[0]).not.toHaveProperty('embedding')
    expect(matches[0]).not.toHaveProperty('model')
  })

  it('ranks a zero-norm window behind one with genuine negative similarity, matching pgvector', async () => {
    // The parity claim this file's module comment makes ("the same result the
    // SQL function returns") specifically for the case pgvector treats as
    // worst-of-all: a zero-norm embedding. Sorting it as similarity 0 (rather
    // than NaN, sorted last) would rank it ABOVE window 1's genuine -1, the
    // opposite of what a real pgvector instance returns for identical data.
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    const opposite = axis(0).map(v => -v)
    await repo.upsertWindows('m10', [
      window(0, axis(0)),
      window(1, opposite),
      window(2, new Array(DIMS).fill(0)),
    ])
    const matches = await repo.search('m10', axis(0), { model: '@cf/baai/bge-m3', limit: 5 })
    expect(matches.map(m => m.idx)).toEqual([0, 1, 2])
  })

  it('never returns windows embedded by a different model', async () => {
    // Vectors from different models live in different spaces; ranking them
    // together would be meaningless.
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m5', [window(0, axis(0)), window(1, axis(0), { model: 'stub-hashed-tokens-v1' })])
    const matches = await repo.search('m5', axis(0), { model: '@cf/baai/bge-m3', limit: 5 })
    expect(matches.map(m => m.idx)).toEqual([0])
  })

  it('never returns another meeting\'s windows', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m6', [window(0, axis(3))])
    await repo.upsertWindows('m7', [window(0, axis(4))])
    const matches = await repo.search('m6', axis(4), { model: '@cf/baai/bge-m3', limit: 5 })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.similarity).toBe(0)
  })

  it('breaks similarity ties by index and clamps the limit', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m8', [window(2, axis(0)), window(0, axis(0)), window(1, axis(0))])
    expect((await repo.search('m8', axis(0), { model: '@cf/baai/bge-m3', limit: 5 })).map(m => m.idx))
      .toEqual([0, 1, 2])
    expect(await repo.search('m8', axis(0), { model: '@cf/baai/bge-m3', limit: 0 })).toHaveLength(1)
  })

  it('keeps every window when upserts for one meeting run concurrently', async () => {
    // Read-modify-write: without the per-meeting queue, the second writer
    // would overwrite the first writer's windows with its own stale read.
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await Promise.all(Array.from({ length: 10 }, (_, i) => repo.upsertWindows('m9', [window(i, axis(i))])))
    expect((await repo.listKeys('m9')).map(k => k.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  describe('deleteForMeeting', () => {
    // A fresh directory per test, so `keys()` below sees only what that test
    // stored rather than every meeting the shared `dataDir` has accumulated.
    let freshDataDir: string
    beforeEach(async () => {
      freshDataDir = await mkdtemp(join(tmpdir(), 'meetmind-windows-delete-'))
    })
    afterEach(() => rm(freshDataDir, { recursive: true, force: true }))

    const keys = () =>
      createStorage({ driver: fsDriver({ base: join(freshDataDir, 'db') }) }).getKeys('windows')

    it('leaves no key behind', async () => {
      // An empty array would still be a key, for a meeting that no longer exists.
      const repo = createLocalTranscriptIndexRepository({ dataDir: freshDataDir })
      await repo.upsertWindows('xd-gone', [window(0, axis(1))])
      await repo.upsertWindows('xd-kept', [window(0, axis(1))])
      await repo.deleteForMeeting('xd-gone')

      expect(await keys()).toEqual(['windows:xd-kept'])
      expect(await repo.listKeys('xd-gone')).toEqual([])
      expect(await repo.listKeys('xd-kept')).toHaveLength(1)
    })

    it('is a no-op for a meeting with nothing stored, so a half-finished delete can be re-run', async () => {
      const repo = createLocalTranscriptIndexRepository({ dataDir: freshDataDir })
      await repo.upsertWindows('xd-kept', [window(0, axis(1))])
      await expect(repo.deleteForMeeting('never-stored')).resolves.toBeUndefined()
      await repo.deleteForMeeting('xd-kept')
      await expect(repo.deleteForMeeting('xd-kept')).resolves.toBeUndefined()
      expect(await keys()).toEqual([])
    })
  })
})

describe('supabase transcript index repository', () => {
  const repo = createSupabaseTranscriptIndexRepository({ url: 'https://p.supabase.co', serviceKey: 'k' })

  interface Call { method: string, url: URL, body: unknown, prefer: string }

  function stub(reply: (call: Call) => unknown = () => []) {
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, init) : input
      const raw = await request.clone().text()
      const call = {
        method: request.method,
        url: new URL(request.url),
        body: raw ? JSON.parse(raw) : undefined,
        prefer: request.headers.get('prefer') ?? '',
      }
      calls.push(call)
      return new Response(JSON.stringify(reply(call)), { headers: { 'content-type': 'application/json' } })
    })
    return calls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('lists keys without downloading any vector, filtered to the meeting', async () => {
    const calls = stub(() => [{ idx: 0, content_hash: hash('a'), model: '@cf/baai/bge-m3' }])
    expect(await repo.listKeys('m1')).toEqual([{ idx: 0, contentHash: hash('a'), model: '@cf/baai/bge-m3' }])
    const url = calls[0]!.url
    expect(url.pathname).toBe('/rest/v1/transcript_windows')
    // A meeting's embeddings are megabytes; comparing hashes needs none of them.
    expect(url.searchParams.get('select')).toBe('idx,content_hash,model')
    expect(url.searchParams.get('meeting_id')).toBe('eq.m1')
  })

  it('pages the key list rather than trusting one capped response', async () => {
    let call = 0
    const calls = stub(() => {
      call++
      const size = call === 1 ? 1000 : 3
      const offset = call === 1 ? 0 : 1000
      return Array.from({ length: size }, (_, i) => ({ idx: offset + i, content_hash: hash('a'), model: 'm' }))
    })
    const keys = await repo.listKeys('m1')
    expect(calls).toHaveLength(2)
    expect(keys.map(k => k.idx)).toEqual(Array.from({ length: 1003 }, (_, i) => i))
  })

  it('upserts on (meeting_id, idx) in batches of 50', async () => {
    const calls = stub()
    await repo.upsertWindows('m1', Array.from({ length: 120 }, (_, i) => window(i, axis(i))))
    expect(calls.map(c => (c.body as unknown[]).length)).toEqual([50, 50, 20])
    for (const c of calls) {
      expect(c.method).toBe('POST')
      expect(c.prefer).toMatch(/resolution=merge-duplicates/)
      expect(c.url.searchParams.get('on_conflict')).toBe('meeting_id,idx')
    }
  })

  it('narrows the key list to a range when given one', async () => {
    const calls = stub(() => [{ idx: 3, content_hash: hash('a'), model: 'm' }])
    expect(await repo.listKeys('m1', { from: 3, to: 18 })).toEqual([{ idx: 3, contentHash: hash('a'), model: 'm' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get('select')).toBe('idx,content_hash,model')
    expect(calls[0]!.url.searchParams.get('meeting_id')).toBe('eq.m1')
    expect(calls[0]!.url.searchParams.getAll('idx')).toEqual(['gte.3', 'lte.18'])
  })

  it('has no way left to remove a meeting\'s windows but all of them, with the meeting', () => {
    // The one call that could empty an index in a single request (ADR-0012, step 8).
    expect(repo).not.toHaveProperty('deleteExcept')
  })

  describe('readState', () => {
    const row = {
      text_hash: hash('a'), model: 'm', window_count: 7, complete: true,
      current_hash: hash('b'), segment_count: 70, stored_windows: 7, stored_for_model: 6,
    }

    it('asks the SQL function, for this meeting and model, and reads every column', async () => {
      const calls = stub(() => [row])
      expect(await repo.readState('m1', 'm')).toEqual({
        marker: { textHash: hash('a'), model: 'm', windowCount: 7, complete: true },
        transcriptHash: hash('b'),
        segmentCount: 70,
        storedWindows: 7,
        storedForModel: 6,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url.pathname).toBe('/rest/v1/rpc/read_index_state')
      expect(calls[0]!.body).toEqual({ p_meeting: 'm1', p_model: 'm' })
    })

    it('reads a meeting with no marker as having none, not an incomplete one', async () => {
      stub(() => [{ ...row, text_hash: null, model: null, window_count: null, complete: null }])
      expect((await repo.readState('m1', 'm')).marker).toBeNull()
    })

    it('refuses an unusable answer rather than reading it as a state', async () => {
      stub(() => [])
      await expect(repo.readState('m1', 'm')).rejects.toThrow(/unusable row/)
    })
  })

  it('deletes every window of the meeting with one DELETE filtered only by meeting', async () => {
    // Normally a no-op behind the meetings cascade. No idx filter at all: this
    // is the whole meeting, and a missing meeting_id filter would be everyone's.
    const calls = stub()
    await repo.deleteForMeeting('m1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url.pathname).toBe('/rest/v1/transcript_windows')
    expect(calls[0]!.url.searchParams.get('meeting_id')).toBe('eq.m1')
    expect(calls[0]!.url.searchParams.has('idx')).toBe(false)
  })

  it('searches through the SQL function with a vector literal and a clamped limit', async () => {
    const calls = stub(() => [{
      idx: 1, first_segment_idx: 1, last_segment_idx: 2, start_ms: 1000, end_ms: 1999,
      content: 'window 1', content_hash: hash('a'), similarity: 0.9,
    }])
    const query = axis(1)
    const matches = await repo.search('m1', query, { model: '@cf/baai/bge-m3', limit: 500 })

    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/rest/v1/rpc/match_transcript_windows')
    expect(calls[0]!.body).toEqual({
      p_meeting_id: 'm1',
      p_query: JSON.stringify(query),
      p_model: '@cf/baai/bge-m3',
      p_match_count: MAX_MATCHES,
    })
    expect(matches).toEqual([{
      idx: 1, firstSegmentIdx: 1, lastSegmentIdx: 2, startMs: 1000, endMs: 1999,
      text: 'window 1', contentHash: hash('a'), similarity: 0.9,
    }])
  })

  it.each([
    ['listKeys', () => repo.listKeys('m1')],
    ['upsertWindows', () => repo.upsertWindows('m1', [window(0, axis(0))])],
    ['readState', () => repo.readState('m1', 'm')],
    ['deleteForMeeting', () => repo.deleteForMeeting('m1')],
    ['search', () => repo.search('m1', axis(0), { model: 'm', limit: 1 })],
  ])('surfaces a database error from %s', async (_name, run) => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ code: '42501', message: 'permission denied', details: '', hint: '' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    await expect(run()).rejects.toThrow(/42501/)
  })
})

/** The one definition of "ready" a question and the status route both go by. */
describe('readyWindowCount', () => {
  const finished: IndexState = {
    marker: { textHash: 'current', model: 'm', windowCount: 5, complete: true },
    transcriptHash: 'current',
    segmentCount: 40,
    storedWindows: 5,
    storedForModel: 5,
  }

  it('is the marker\'s count when the marker holds for this transcript, this model and what is stored', () => {
    expect(readyWindowCount(finished, 'm')).toBe(5)
  })

  it.each<[string, IndexState]>([
    ['there is no marker: a meeting indexed by older code, however many windows it has', { ...finished, marker: null }],
    ['the marker is incomplete: a run in progress, every window stored or not', { ...finished, marker: { ...finished.marker!, complete: false } }],
    ['the transcript has changed', { ...finished, transcriptHash: 'replaced' }],
    ['a window has gone', { ...finished, storedWindows: 4, storedForModel: 4 }],
    ['a window has appeared past the plan', { ...finished, storedWindows: 6, storedForModel: 6 }],
    ['another model\'s window is stored', { ...finished, storedWindows: 6 }],
  ])('is null when %s', (_name, state) => {
    expect(readyWindowCount(state, 'm')).toBeNull()
  })

  it('is null for a model the marker is not for, however complete', () => {
    expect(readyWindowCount(finished, 'another-model')).toBeNull()
  })

  it('is 0 for a transcript with no lines and nothing stored, with or without a marker', () => {
    const silent = { marker: null, transcriptHash: 'empty', segmentCount: 0, storedWindows: 0, storedForModel: 0 }
    expect(readyWindowCount(silent, 'm')).toBe(0)
  })

  it('is null for a transcript with no lines while windows are still stored for it', () => {
    expect(readyWindowCount({ marker: null, transcriptHash: 'empty', segmentCount: 0, storedWindows: 3, storedForModel: 3 }, 'm')).toBeNull()
  })
})
