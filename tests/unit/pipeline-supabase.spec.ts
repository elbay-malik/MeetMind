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
