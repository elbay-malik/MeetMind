import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  clampLimit,
  cosineSimilarity,
  MAX_MATCHES,
  rowToMatch,
  windowToRow,
  type EmbeddedWindow,
} from '../../server/utils/db/windows'
import { createLocalTranscriptIndexRepository } from '../../server/utils/db/windows-local'
import { createSupabaseTranscriptIndexRepository } from '../../server/utils/db/windows-supabase'

const DIMS = 768

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
    model: 'gemini-embedding-2',
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

  it('scores a zero vector as 0 rather than NaN, so it sorts last instead of corrupting the order', () => {
    expect(cosineSimilarity(new Array(DIMS).fill(0), axis(0))).toBe(0)
  })

  it('refuses to compare vectors of different sizes', () => {
    expect(() => cosineSimilarity(axis(0), [1, 0, 0])).toThrow(/768 and 3/)
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
      content: 'window 3', content_hash: hash('c'), model: 'gemini-embedding-2', embedding: w.embedding,
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
      { idx: 0, contentHash: hash('a'), model: 'gemini-embedding-2' },
      { idx: 1, contentHash: hash('a'), model: 'gemini-embedding-2' },
    ])
  })

  it('replaces a window with the same index rather than duplicating it', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m2', [window(0, axis(0))])
    await repo.upsertWindows('m2', [window(0, axis(1), { contentHash: hash('b') })])
    expect(await repo.listKeys('m2')).toEqual([{ idx: 0, contentHash: hash('b'), model: 'gemini-embedding-2' }])
  })

  it('deletes every window not kept, and everything when nothing is kept', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m3', [window(0, axis(0)), window(1, axis(1)), window(2, axis(2))])
    await repo.deleteExcept('m3', [0, 2])
    expect((await repo.listKeys('m3')).map(k => k.idx)).toEqual([0, 2])
    await repo.deleteExcept('m3', [])
    expect(await repo.listKeys('m3')).toEqual([])
  })

  it('returns the nearest windows first, with their similarity and no embedding', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m4', [window(0, axis(0)), window(1, axis(1)), window(2, axis(2))])
    const matches = await repo.search('m4', axis(1, { n: 0, weight: 0.4 }), { model: 'gemini-embedding-2', limit: 5 })

    expect(matches.map(m => m.idx)).toEqual([1, 0, 2])
    expect(matches[0]!.similarity).toBeGreaterThan(matches[1]!.similarity)
    expect(matches[2]!.similarity).toBe(0)
    expect(matches[0]).not.toHaveProperty('embedding')
    expect(matches[0]).not.toHaveProperty('model')
  })

  it('never returns windows embedded by a different model', async () => {
    // Vectors from different models live in different spaces; ranking them
    // together would be meaningless.
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m5', [window(0, axis(0)), window(1, axis(0), { model: 'stub-hashed-tokens-v1' })])
    const matches = await repo.search('m5', axis(0), { model: 'gemini-embedding-2', limit: 5 })
    expect(matches.map(m => m.idx)).toEqual([0])
  })

  it('never returns another meeting\'s windows', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m6', [window(0, axis(3))])
    await repo.upsertWindows('m7', [window(0, axis(4))])
    const matches = await repo.search('m6', axis(4), { model: 'gemini-embedding-2', limit: 5 })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.similarity).toBe(0)
  })

  it('breaks similarity ties by index and clamps the limit', async () => {
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await repo.upsertWindows('m8', [window(2, axis(0)), window(0, axis(0)), window(1, axis(0))])
    expect((await repo.search('m8', axis(0), { model: 'gemini-embedding-2', limit: 5 })).map(m => m.idx))
      .toEqual([0, 1, 2])
    expect(await repo.search('m8', axis(0), { model: 'gemini-embedding-2', limit: 0 })).toHaveLength(1)
  })

  it('keeps every window when upserts for one meeting run concurrently', async () => {
    // Read-modify-write: without the per-meeting queue, the second writer
    // would overwrite the first writer's windows with its own stale read.
    const repo = createLocalTranscriptIndexRepository({ dataDir })
    await Promise.all(Array.from({ length: 10 }, (_, i) => repo.upsertWindows('m9', [window(i, axis(i))])))
    expect((await repo.listKeys('m9')).map(k => k.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
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
    const calls = stub(() => [{ idx: 0, content_hash: hash('a'), model: 'gemini-embedding-2' }])
    expect(await repo.listKeys('m1')).toEqual([{ idx: 0, contentHash: hash('a'), model: 'gemini-embedding-2' }])
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

  it('deletes only the windows not kept, and all of them when nothing is', async () => {
    const calls = stub()
    await repo.deleteExcept('m1', [0, 2])
    await repo.deleteExcept('m1', [])
    expect(calls.map(c => c.method)).toEqual(['DELETE', 'DELETE'])
    expect(calls[0]!.url.searchParams.get('meeting_id')).toBe('eq.m1')
    expect(calls[0]!.url.searchParams.get('idx')).toBe('not.in.(0,2)')
    // PostgREST rejects `not.in.()`, so an empty keep-list sends no idx filter.
    expect(calls[1]!.url.searchParams.has('idx')).toBe(false)
    expect(calls[1]!.url.searchParams.get('meeting_id')).toBe('eq.m1')
  })

  it('searches through the SQL function with a vector literal and a clamped limit', async () => {
    const calls = stub(() => [{
      idx: 1, first_segment_idx: 1, last_segment_idx: 2, start_ms: 1000, end_ms: 1999,
      content: 'window 1', content_hash: hash('a'), similarity: 0.9,
    }])
    const query = axis(1)
    const matches = await repo.search('m1', query, { model: 'gemini-embedding-2', limit: 500 })

    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/rest/v1/rpc/match_transcript_windows')
    expect(calls[0]!.body).toEqual({
      p_meeting_id: 'm1',
      p_query: JSON.stringify(query),
      p_model: 'gemini-embedding-2',
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
    ['deleteExcept', () => repo.deleteExcept('m1', [0])],
    ['search', () => repo.search('m1', axis(0), { model: 'm', limit: 1 })],
  ])('surfaces a database error from %s', async (_name, run) => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ code: '42501', message: 'permission denied', details: '', hint: '' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    await expect(run()).rejects.toThrow(/42501/)
  })
})
