import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabasePipelineRepository } from '../../server/utils/db/pipeline-supabase'

/**
 * What the Supabase driver sends step 7's SQL functions. Real calls need the
 * real project, which `pnpm test` never touches, so this holds the driver to the
 * migration's own parameter names instead.
 */

const MIGRATION = readFileSync('supabase/migrations/20261101120000_transcription_steps.sql', 'utf8')
  + readFileSync('supabase/migrations/20261103120000_search_index_steps.sql', 'utf8')
  + readFileSync('supabase/migrations/20261103180000_sweeper.sql', 'utf8')

function sqlParameters(fn: string): string[] {
  const signature = new RegExp(`create (?:or replace )?function public\\.${fn}\\(([\\s\\S]*?)\\n\\)`).exec(MIGRATION)
  if (!signature) throw new Error(`${fn} is not in the migration`)
  return [...signature[1]!.matchAll(/\bp_\w+/g)].map(found => found[0]).sort()
}

const repo = createSupabasePipelineRepository({ url: 'https://project.supabase.co', serviceKey: 'service-role-key' })
const MEETING = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const TOKEN = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

/** Capture the rpc calls, each answered with `answer`. */
function stubRpc(answer: unknown) {
  const calls: { fn: string, body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (input: string | Request, options?: RequestInit) => {
    const request = typeof input === 'string' ? new Request(input, options) : input
    calls.push({ fn: new URL(request.url).pathname.split('/').pop()!, body: await request.clone().json() })
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('appendSegments', () => {
  const segments = [{ idx: 7, startMs: 1000, endMs: 1900, text: 'line' }]

  it('sends exactly the function\'s parameters, in the columns its recordset reads', async () => {
    const calls = stubRpc(true)
    const cursor = { reply: { byteOffset: 9 } }
    await expect(repo.appendSegments(MEETING, TOKEN, { fromIdx: 7, segments, cursor })).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.fn).toBe('append_segments')
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('append_segments'))
    expect(calls[0]!.body).toEqual({
      p_meeting: MEETING,
      p_token: TOKEN,
      p_from_idx: 7,
      p_segments: [{ idx: 7, start_ms: 1000, end_ms: 1900, text: 'line' }],
      p_cursor: cursor,
    })
  })

  it('reads a refusal as false', async () => {
    stubRpc(false)
    await expect(repo.appendSegments(MEETING, TOKEN, { fromIdx: 7, segments, cursor: {} })).resolves.toBe(false)
  })

  it('refuses a page it can see is wrong before the database does, as the local driver would', async () => {
    const calls = stubRpc(true)
    await expect(repo.appendSegments(MEETING, TOKEN, { fromIdx: 0, segments, cursor: {} })).rejects.toThrow(/numbered consecutively/)
    expect(calls).toEqual([])
  })
})

describe('finishTranscription', () => {
  const chunks = [{ chunkNo: 0, segFrom: 0, segTo: 4, estTokens: 900 }]

  it('sends exactly the function\'s parameters, in the columns its recordset reads', async () => {
    const calls = stubRpc(true)
    await expect(repo.finishTranscription(MEETING, TOKEN, { chunks, refusal: null })).resolves.toBe(true)
    expect(calls[0]!.fn).toBe('finish_transcription')
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('finish_transcription'))
    expect(calls[0]!.body).toEqual({
      p_meeting: MEETING,
      p_token: TOKEN,
      p_chunks: [{ chunk_no: 0, seg_from: 0, seg_to: 4, est_tokens: 900 }],
      p_refusal: null,
    })
  })

  it('passes a refusal on', async () => {
    const calls = stubRpc(true)
    await repo.finishTranscription(MEETING, TOKEN, { chunks: [], refusal: 'too long' })
    expect(calls[0]!.body).toMatchObject({ p_chunks: [], p_refusal: 'too long' })
  })
})

describe('claimStep', () => {
  const options = { status: 'failed' as const, leaseMs: 60_000 }

  it('sends exactly the function\'s parameters, with the read a retry is pinned to', async () => {
    const calls = stubRpc([])
    const expectedUpdatedAt = '2026-11-01T12:00:00.123456+00:00'
    await expect(repo.claimStep(MEETING, 'transcription', { ...options, expectedUpdatedAt })).resolves.toBeNull()
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('claim_step'))
    // To the digit: this is compared with `=` against the column it was read from.
    expect(calls[0]!.body.p_expected_updated_at).toBe(expectedUpdatedAt)
  })

  it('sends no pin when the caller gave none', async () => {
    const calls = stubRpc([])
    await repo.claimStep(MEETING, 'transcription', options)
    expect(calls[0]!.body.p_expected_updated_at).toBeNull()
  })
})

describe('upsertWindows', () => {
  const embedding = new Array(1024).fill(0.5)
  const window = {
    idx: 3, firstSegmentIdx: 20, lastSegmentIdx: 29, startMs: 1000, endMs: 2000, text: 'passage', contentHash: 'c'.repeat(64),
    model: 'model-a', embedding,
  }
  const batch = { windows: [window], cursor: { pass: { nextWindow: 4 } }, textHash: 'a'.repeat(64), model: 'model-a' }

  it('sends exactly the function\'s parameters, in the columns its recordset reads', async () => {
    const calls = stubRpc(true)
    await expect(repo.upsertWindows(MEETING, TOKEN, batch)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.fn).toBe('upsert_windows')
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('upsert_windows'))
    expect(calls[0]!.body).toEqual({
      p_meeting: MEETING,
      p_token: TOKEN,
      p_windows: [{
        idx: 3, first_segment_idx: 20, last_segment_idx: 29, start_ms: 1000, end_ms: 2000,
        content: 'passage', content_hash: 'c'.repeat(64), embedding,
      }],
      p_cursor: batch.cursor,
      p_text_hash: batch.textHash,
      p_model: 'model-a',
    })
  })

  it('reads a refusal as false, and anything else as a failure', async () => {
    stubRpc(false)
    await expect(repo.upsertWindows(MEETING, TOKEN, batch)).resolves.toBe(false)
    vi.unstubAllGlobals()
    stubRpc('sure')
    await expect(repo.upsertWindows(MEETING, TOKEN, batch)).rejects.toThrow(/unusable answer/)
  })

  it('refuses a batch it can see is wrong before the database does, as the local driver would', async () => {
    const calls = stubRpc(true)
    await expect(repo.upsertWindows(MEETING, TOKEN, { ...batch, windows: [{ ...window, embedding: [1, 2] }] })).rejects.toThrow(/2-dimension/)
    await expect(repo.upsertWindows(MEETING, TOKEN, { ...batch, windows: [{ ...window, model: 'other' }] })).rejects.toThrow(/other's/)
    expect(calls).toEqual([])
  })
})

describe('finishIndex', () => {
  const plan = { textHash: 'a'.repeat(64), model: 'model-a', windowCount: 12 }

  it('sends exactly the function\'s parameters', async () => {
    const calls = stubRpc('complete')
    await expect(repo.finishIndex(MEETING, TOKEN, plan)).resolves.toBe('complete')
    expect(calls[0]!.fn).toBe('finish_index')
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('finish_index'))
    expect(calls[0]!.body).toEqual({
      p_meeting: MEETING, p_token: TOKEN, p_text_hash: plan.textHash, p_model: 'model-a', p_window_count: 12,
    })
  })

  it.each(['changed', 'lost'] as const)('passes %s on', async (answer) => {
    stubRpc(answer)
    await expect(repo.finishIndex(MEETING, TOKEN, plan)).resolves.toBe(answer)
  })

  it('never reads an answer it does not know as complete', async () => {
    stubRpc(true)
    await expect(repo.finishIndex(MEETING, TOKEN, plan)).rejects.toThrow(/unusable answer/)
  })
})

describe('what a read costs, which the worst case in ADR-0012\'s step 9 addendum adds up', () => {
  function stubRows(rows: unknown[]) {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | Request, options?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, options) : input
      requests.push(new URL(request.url).pathname.split('/').pop()!)
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return requests
  }

  it('is one request for the runs', async () => {
    const requests = stubRows([])
    await repo.listRuns(MEETING)
    expect(requests).toEqual(['pipeline_runs'])
  })

  it('is two for the chunks: the current run, then its plan', async () => {
    const requests = stubRows([{ run_id: 'run', chunk_no: 0, seg_from: 0, seg_to: 1, est_tokens: 1, attempts: 0, result: null }])
    await repo.listChunks(MEETING)
    expect(requests).toEqual(['pipeline_runs', 'summary_chunks'])
  })
})

describe('countChunks', () => {
  const RUN = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'

  /** Answer every count as PostgREST does, in `content-range`, recording what each asked for. */
  function stubCounts(answer: (url: URL) => string | null) {
    const calls: { method: string, url: URL, prefer: string | null }[] = []
    vi.stubGlobal('fetch', async (input: string | Request, options?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, options) : input
      const url = new URL(request.url)
      calls.push({ method: request.method, url, prefer: request.headers.get('prefer') })
      const range = answer(url)
      return new Response(null, { status: 200, headers: range ? { 'content-range': range } : {} })
    })
    return calls
  }
  const finished = (url: URL) => url.searchParams.get('result') === 'not.is.null'

  it('asks twice with HEAD, for the count alone, so no result crosses the wire', async () => {
    const calls = stubCounts(url => (finished(url) ? '*/3' : '*/7'))
    await expect(repo.countChunks(MEETING, RUN)).resolves.toEqual({ done: 3, total: 7 })
    expect(calls).toHaveLength(2)
    for (const { method, url, prefer } of calls) {
      expect(method).toBe('HEAD')
      expect(url.pathname.split('/').pop()).toBe('summary_chunks')
      expect(url.searchParams.get('meeting_id')).toBe(`eq.${MEETING}`)
      expect(url.searchParams.get('run_id')).toBe(`eq.${RUN}`)
      expect(url.searchParams.get('select')).toBe('chunk_no')
      expect(prefer).toContain('count=exact')
    }
    expect(calls.filter(call => finished(call.url))).toHaveLength(1)
  })

  it('never reads an answer with no count as none, which would plan again', async () => {
    stubCounts(() => null)
    await expect(repo.countChunks(MEETING, RUN)).rejects.toThrow(/unusable/)
  })

  it('reports a refused count as a failure', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: '42501', message: 'denied' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    await expect(repo.countChunks(MEETING, RUN)).rejects.toThrow(/summary chunks count failed/)
  })
})

describe('deleteForMeeting', () => {
  it('removes the marker with the runs and chunks, each filtered to the meeting', async () => {
    const calls: URL[] = []
    vi.stubGlobal('fetch', async (input: string | Request, options?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, options) : input
      expect(request.method).toBe('DELETE')
      calls.push(new URL(request.url))
      return new Response(null, { status: 204 })
    })
    await repo.deleteForMeeting(MEETING)
    expect(calls.map(url => url.pathname.split('/').pop()).sort()).toEqual(['meeting_index_state', 'pipeline_runs', 'summary_chunks'])
    for (const url of calls) expect(url.searchParams.get('meeting_id')).toBe(`eq.${MEETING}`)
  })
})

describe('nextForSweep', () => {
  const OPTIONS = { model: 'model-a', excludeId: MEETING, limitError: 'the limit' }

  it('sends exactly the function\'s parameters, and reads its one row', async () => {
    const calls = stubRpc([{ meeting_id: MEETING, busy: ['groq-chat'] }])
    await expect(repo.nextForSweep(OPTIONS)).resolves.toEqual({ meetingId: MEETING, busy: ['groq-chat'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.fn).toBe('sweep_next_meeting')
    expect(Object.keys(calls[0]!.body).sort()).toEqual(sqlParameters('sweep_next_meeting'))
    expect(calls[0]!.body).toEqual({ p_model: 'model-a', p_exclude: MEETING, p_limit_error: 'the limit' })
  })

  it('sends no demo as null, which SQL compares as nothing to leave out', async () => {
    const calls = stubRpc([{ meeting_id: null, busy: [] }])
    await expect(repo.nextForSweep({ ...OPTIONS, excludeId: null })).resolves.toEqual({ meetingId: null, busy: [] })
    expect(calls[0]!.body.p_exclude).toBeNull()
  })

  // Read as "nothing to do", any of these would hide a broken sweeper for as long as it lasted,
  // and a list of providers that went missing would ask one while it is blocked.
  it.each<[string, unknown]>([
    ['no row', []],
    ['no list of providers', [{ meeting_id: null }]],
    ['a list that is not one', [{ meeting_id: null, busy: 'groq-chat' }]],
    ['an id that is not one', [{ meeting_id: 7, busy: [] }]],
    ['an answer of the wrong shape', { meeting_id: null, busy: [] }],
  ])('throws on %s, rather than reading it as nothing to do', async (_name, answer) => {
    stubRpc(answer)
    await expect(repo.nextForSweep(OPTIONS)).rejects.toThrow(/unusable answer/)
  })

  it('throws when the function refuses', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: '22023', message: 'a model is required' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    await expect(repo.nextForSweep(OPTIONS)).rejects.toThrow(/sweep selection failed/)
  })
})
