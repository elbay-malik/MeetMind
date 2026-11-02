import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AwsClient } from 'aws4fetch'
import { EMBEDDING_DIMENSIONS, EmbeddingInputTooLongError, MAX_BATCH_TOKENS, planEmbeddingBatches } from '../../server/utils/qa/embedder'
import { INDEX_BATCH } from '../../server/utils/qa/steps'
import { createWorkersAiEmbedder, WORKERS_AI_EMBEDDING_MODEL } from '../../server/utils/qa/workers-ai'
import { estimateTokens } from '../../server/utils/summary/plan'
import { createGroqTranscriber } from '../../server/utils/transcription/groq'
import { normalizeSegments } from '../../server/utils/transcription/normalize'
import { INITIAL_SCAN, parseSegments, replyDuration, scanWindow } from '../../server/utils/transcription/reply-scanner'
import { meetingSchema, transcriptSegmentSchema } from '../../shared/schemas/meeting'
import { MAX_AUDIO_BYTES } from '../../shared/utils/meeting'

/**
 * Exercises the real services, which nothing else can: the drivers are covered
 * by unit tests with a stubbed fetch, and that proves the request shape but not
 * the contract. ADR-0003 and ADR-0004 both list this as the open follow-up.
 *
 * Run with `pnpm test:services` once credentials exist. Each service is skipped
 * when its variables are absent. Objects and rows are prefixed `verify-` and
 * cleaned up; nothing pre-existing is touched.
 */
const has = (...keys: string[]) => keys.every(k => (process.env[k] ?? '').length > 0)

// ---------------------------------------------------------------- Cloudflare R2
describe.skipIf(!has('NUXT_R2_ACCOUNT_ID', 'NUXT_R2_ACCESS_KEY_ID', 'NUXT_R2_SECRET_ACCESS_KEY', 'NUXT_R2_BUCKET'))(
  'Cloudflare R2',
  () => {
    // Built lazily: describe.skipIf still runs this callback, so constructing
    // the client here would throw before any test is skipped.
    const client = () => new AwsClient({
      accessKeyId: process.env.NUXT_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.NUXT_R2_SECRET_ACCESS_KEY!,
      service: 's3',
      region: 'auto',
      retries: 1,
    })
    const objectKey = `verify-${Date.now()}/audio.ogg`
    const objectUrl = () => {
      const url = new URL(`https://${process.env.NUXT_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
      url.pathname = `/${process.env.NUXT_R2_BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
      return url
    }
    const body = new Uint8Array(2048).map((_, i) => i % 251)

    it('accepts a browser PUT to the presigned URL we mint', async () => {
      const url = objectUrl()
      url.searchParams.set('X-Amz-Expires', '900')
      const signed = await client().sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } })
      const put = await fetch(signed.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body })
      expect(put.ok, `HTTP ${put.status}: ${await put.text()}`).toBe(true)
    })

    it('reports the exact byte count on HEAD, which the completion check depends on', async () => {
      const head = await client().fetch(objectUrl().href, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(String(body.byteLength))
    })

    it('returns the same bytes on GET, which transcription depends on', async () => {
      const get = await client().fetch(objectUrl().href, { method: 'GET' })
      expect(get.ok).toBe(true)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)
    })

    // ADR-0012 step 7: a page checks it is reading the reply the Whisper step
    // stored. The validator from the PUT has to be the one a range read reports.
    it('reports the same validator on a server PUT and on a range read of it, and serves the range', async () => {
      const { createR2AudioStore } = await import('../../server/utils/storage/r2')
      const store = createR2AudioStore({
        accountId: process.env.NUXT_R2_ACCOUNT_ID!,
        accessKeyId: process.env.NUXT_R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.NUXT_R2_SECRET_ACCESS_KEY!,
        bucket: process.env.NUXT_R2_BUCKET!,
      })
      const key = `verify-${Date.now()}/whisper-reply.json`
      const reply = new TextEncoder().encode('{"segments":[{"start":0,"end":1,"text":"hello"}]}')
      try {
        const { etag } = await store.put(key, reply, 'application/json')
        expect(etag).toBeTruthy()
        const opened = (await store.openRange(key, { start: 13, end: 20 }))!
        expect(opened.etag).toBe(etag)
        expect(opened.size).toBe(reply.byteLength)
        expect(new TextDecoder().decode(await new Response(opened.body).arrayBuffer())).toBe('{"start"')
      }
      finally {
        await store.delete(key)
      }
    })

    it('answers 404 for a missing object rather than an error', async () => {
      const missing = await client().fetch(`${objectUrl().href}-absent`, { method: 'HEAD' })
      expect(missing.status).toBe(404)
    })

    it('allows the browser origin to PUT, without which uploads fail only in a browser', async () => {
      const preflight = await fetch(objectUrl().href, {
        method: 'OPTIONS',
        headers: {
          'origin': process.env.VERIFY_ORIGIN ?? 'http://localhost:3000',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(
        preflight.headers.get('access-control-allow-origin'),
        'no CORS rule matched — see README → Storage setup',
      ).toBeTruthy()
    })

    it('deletes the object', async () => {
      const del = await client().fetch(objectUrl().href, { method: 'DELETE' })
      expect([200, 204, 404]).toContain(del.status)
    })
  },
)

// ------------------------------------------------------------------- Supabase
describe.skipIf(!has('NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY'))('Supabase Postgres', () => {
  const id = crypto.randomUUID()
  const newRow = () => ({
    id,
    title: 'verify-services probe',
    status: 'uploaded' as const,
    source_file_name: 'verify.mp4',
    source_bytes: 1,
    source_mime: null,
    duration_sec: null,
    audio_key: `verify-${id}/audio.ogg`,
    audio_bytes: 1024,
    audio_mime: 'audio/ogg',
    uploaded_at: null,
    error_message: null,
  })

  async function db() {
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(process.env.NUXT_SUPABASE_URL!, process.env.NUXT_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }

  it('stores a meeting row whose shape satisfies meetingSchema', async () => {
    const client = await db()
    const { data, error } = await client.from('meetings').insert(newRow()).select().single()
    expect(error, `${error?.code}: ${error?.message} — is the migration applied?`).toBeNull()

    // The real question: do Postgres timestamps parse the way the schema assumes?
    const parsed = meetingSchema.safeParse({
      id: data!.id,
      createdAt: data!.created_at,
      updatedAt: data!.updated_at,
      title: data!.title,
      status: data!.status,
      sourceFileName: data!.source_file_name,
      sourceBytes: Number(data!.source_bytes),
      sourceMime: data!.source_mime,
      durationSec: data!.duration_sec,
      audioKey: data!.audio_key,
      audioBytes: data!.audio_bytes,
      audioMime: data!.audio_mime,
      uploadedAt: data!.uploaded_at,
      errorMessage: data!.error_message,
      failedStage: data!.failed_stage,
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true)
  })

  it('advances updated_at through the trigger', async () => {
    const client = await db()
    const before = await client.from('meetings').select().eq('id', id).single()
    const after = await client.from('meetings').update({ status: 'transcribing' }).eq('id', id).select().single()
    expect(after.error).toBeNull()
    expect(
      new Date(after.data!.updated_at).getTime(),
      'updated_at did not advance — is the trigger installed?',
    ).toBeGreaterThan(new Date(before.data!.updated_at).getTime())
  })

  it('enforces the audio cap in the database, not just in code', async () => {
    const client = await db()
    const { error } = await client.from('meetings').insert({
      ...newRow(), id: crypto.randomUUID(), audio_key: `verify-over-${id}`, audio_bytes: MAX_AUDIO_BYTES + 1,
    })
    expect(error, 'an over-cap row was accepted — the tightening migration is not applied').not.toBeNull()
  })

  it('stores transcript segments and reads them back in order', async () => {
    const client = await db()
    const segments = [0, 1, 2].map(idx => ({
      meeting_id: id, idx, start_ms: idx * 1000, end_ms: (idx + 1) * 1000, text: `segment ${idx}`,
    }))
    const inserted = await client.from('transcript_segments').insert(segments)
    expect(inserted.error, `${inserted.error?.code}: ${inserted.error?.message}`).toBeNull()

    const listed = await client.from('transcript_segments').select().eq('meeting_id', id).order('idx', { ascending: true })
    expect(listed.data).toHaveLength(3)
    for (const [i, row] of listed.data!.entries()) {
      const parsed = transcriptSegmentSchema.safeParse({
        idx: row.idx, startMs: row.start_ms, endMs: row.end_ms, text: row.text,
      })
      expect(parsed.success).toBe(true)
      expect(row.idx).toBe(i)
    }
  })

  it('cascades the transcript away when the meeting is deleted', async () => {
    const client = await db()
    await client.from('meetings').delete().eq('id', id)
    await client.from('meetings').delete().eq('audio_key', `verify-over-${id}`)
    const orphans = await client.from('transcript_segments').select().eq('meeting_id', id)
    expect(orphans.data).toHaveLength(0)
  })

  it('answers the storage budget over PostgREST, as a number the app can add to', async () => {
    // The only check on this path. The local tier's copy of the rule is unit
    // tested and the SQL is tested in verify-migrations.sh, but neither proves
    // the RPC is reachable or that a bigint survives the trip: PostgREST sends
    // bigint as a JSON number when it fits and a STRING when it does not, and a
    // string reaching arithmetic unnoticed would read as "nothing stored" and
    // disable the budget exactly when the store is largest.
    const client = await db()
    const budgetId = crypto.randomUUID()
    const { error: insertError } = await client.from('meetings').insert({
      ...newRow(),
      id: budgetId,
      audio_key: `verify-budget-${budgetId}/audio.ogg`,
      audio_bytes: 4096,
      uploaded_at: new Date().toISOString(),
    })
    expect(insertError, `${insertError?.code}: ${insertError?.message}`).toBeNull()

    try {
      const { data, error } = await client.rpc('stored_audio_bytes', {
        p_retention_days: 30,
        p_reservation_seconds: 900,
      })
      expect(error, `${error?.code}: ${error?.message} — is the migration applied?`).toBeNull()

      const total = typeof data === 'string' ? Number(data) : data
      expect(typeof total, `expected a usable total, got ${JSON.stringify(data)}`).toBe('number')
      expect(Number.isFinite(total as number)).toBe(true)
      // The row just inserted is inside the retention window, so it counts.
      expect(total as number).toBeGreaterThanOrEqual(4096)
    }
    finally {
      await client.from('meetings').delete().eq('id', budgetId)
    }
  })

  it('deletes a meeting only while its status and updated_at still match, and cascades everything under it', async () => {
    // The unit tests prove the driver SENDS id, status and updated_at filters;
    // only the real PostgREST proves they MATCH. updated_at round-trips as text
    // with microseconds and an offset, and a value that came back from the
    // database in one format but is compared in another would fence out every
    // delete, or, worse, a dropped filter would let a stale delete win the
    // race against a claim. The cascade is the other half: the admin route
    // relies on the foreign keys, and a table added without `on delete cascade`
    // would leave orphans no unit test can see.
    const { createSupabaseMeetingRepository } = await import('../../server/utils/db/supabase')
    const repo = createSupabaseMeetingRepository({
      url: process.env.NUXT_SUPABASE_URL!,
      serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY!,
    })
    const client = await db()
    const deleteId = crypto.randomUUID()
    const { error: insertError } = await client.from('meetings').insert({
      ...newRow(), id: deleteId, audio_key: `verify-delete-${deleteId}/audio.ogg`,
    })
    expect(insertError, `${insertError?.code}: ${insertError?.message}`).toBeNull()

    try {
      const children = await Promise.all([
        client.from('transcript_segments').insert({ meeting_id: deleteId, idx: 0, start_ms: 0, end_ms: 1000, text: 'We ship on Friday.' }),
        client.from('meeting_summaries').insert({ meeting_id: deleteId, summary: 'verify-services probe', provider: 'stub' }),
      ])
      // The decision cites the segment, so it can only go in once that exists.
      children.push(await client.from('meeting_decisions').insert({
        meeting_id: deleteId, idx: 0, decision: 'Ship on Friday', quote: 'We ship on Friday.', segment_idx: 0, start_ms: 0,
      }))
      children.push(await client.from('transcript_windows').insert({
        meeting_id: deleteId,
        idx: 0,
        first_segment_idx: 0,
        last_segment_idx: 0,
        start_ms: 0,
        end_ms: 1000,
        content: 'We ship on Friday.',
        content_hash: '0'.repeat(64),
        model: 'verify-services',
        embedding: `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01).join(',')}]`,
      }))
      for (const { error } of children) expect(error, `${error?.code}: ${error?.message}`).toBeNull()

      // A stale view, made the way the route meets one: read the row, then
      // something else writes it and the trigger advances updated_at.
      const stale = (await repo.get(deleteId))!
      const touched = await client.from('meetings').update({ title: 'verify-services probe (touched)' }).eq('id', deleteId)
      expect(touched.error).toBeNull()
      const fresh = (await repo.get(deleteId))!
      expect(fresh.updatedAt, 'updated_at did not advance — is the trigger installed?').not.toBe(stale.updatedAt)

      expect(await repo.delete(deleteId, { status: stale.status, updatedAt: stale.updatedAt })).toBeNull()
      expect(await repo.get(deleteId), 'a stale updated_at deleted the row').not.toBeNull()
      // Same for a status the row has already left, with the timestamp right.
      expect(await repo.delete(deleteId, { status: 'transcribing', updatedAt: fresh.updatedAt })).toBeNull()
      expect(await repo.get(deleteId), 'a stale status deleted the row').not.toBeNull()

      // The value as read back is exactly what must match, with no reformatting.
      const deleted = await repo.delete(deleteId, { status: fresh.status, updatedAt: fresh.updatedAt })
      expect(deleted?.id, 'the current status and updated_at did not match the row').toBe(deleteId)
      expect(await repo.get(deleteId)).toBeNull()

      for (const tableName of ['transcript_segments', 'meeting_summaries', 'meeting_decisions', 'transcript_windows'] as const) {
        const { data, error } = await client.from(tableName).select('meeting_id').eq('meeting_id', deleteId)
        expect(error, `${tableName}: ${error?.code}: ${error?.message}`).toBeNull()
        expect(data, `${tableName} kept rows for a deleted meeting — missing on delete cascade?`).toHaveLength(0)
      }
    }
    finally {
      await client.from('meetings').delete().eq('id', deleteId)
    }
  })

  it('gives concurrent callers distinct request slots one interval apart, over the real RPC', async () => {
    // The whole point of the slot ledger (ADR-0012): several isolates asking at
    // once must each get their own slot. Only the database can prove that --
    // the local driver's queue is a stand-in for the row lock, not the lock.
    // A 'verify-' provider of its own, so the app's real 'groq-chat' slot is
    // never touched.
    const { createSupabaseSlotRepository } = await import('../../server/utils/db/slots-supabase')
    const slots = createSupabaseSlotRepository({
      url: process.env.NUXT_SUPABASE_URL!,
      serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY!,
    })
    const provider = `verify-${crypto.randomUUID()}` as 'groq-chat'
    const client = await db()
    try {
      const grants = await Promise.all(Array.from({ length: 6 }, () =>
        slots.reserve(provider, { intervalMs: 1000, maxWaitMs: 60_000 })))
      expect(grants.every(g => g.granted), `${JSON.stringify(grants)} — is the slot migration applied?`).toBe(true)
      const starts = grants.map(g => (g.granted ? g.slotAt.getTime() : 0)).sort((a, b) => a - b)
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(1000)

      // A caller that will not wait is refused, told when the next slot frees,
      // and reserves nothing.
      const refused = await slots.reserve(provider, { intervalMs: 1000, maxWaitMs: 0 })
      expect(refused).toMatchObject({ granted: false })
      if (!refused.granted) expect(refused.retryAt.getTime()).toBe(starts.at(-1)! + 1000)

      // A provider's Retry-After holds every caller off.
      await slots.noteRateLimit(provider, 120_000)
      expect((await slots.reserve(provider, { intervalMs: 0, maxWaitMs: 60_000 })).granted).toBe(false)
    }
    finally {
      await client.from('provider_slots').delete().eq('provider', provider)
    }
  })

  it('runs a summarization through the run ledger over the real RPCs, fenced on the step token', async () => {
    // What only PostgREST can show: that the repository's arguments arrive as
    // the jsonb and uuid the functions expect, and their answers come back in
    // the shapes it reads. The rules themselves are pinned by
    // scripts/verify-migrations.sh.
    const { createSupabasePipelineRepository } = await import('../../server/utils/db/pipeline-supabase')
    const { createSupabaseSummaryRepository } = await import('../../server/utils/db/summaries-supabase')
    const options = { url: process.env.NUXT_SUPABASE_URL!, serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY! }
    const pipeline = createSupabasePipelineRepository(options)
    const client = await db()
    const ledgerId = crypto.randomUUID()
    try {
      const { error } = await client.from('meetings')
        .insert({ ...newRow(), id: ledgerId, audio_key: `verify-${ledgerId}/audio.ogg`, status: 'indexing' })
      expect(error).toBeNull()
      const segments = await client.from('transcript_segments').insert([0, 1, 2, 3].map(idx => ({
        meeting_id: ledgerId, idx, start_ms: idx * 1000, end_ms: idx * 1000 + 900, text: `line ${idx}`,
      })))
      expect(segments.error).toBeNull()

      const claim = await pipeline.claimStep(ledgerId, 'summarization', { status: 'indexing', leaseMs: 60_000 })
      expect(claim, 'is the run ledger migration applied?').toMatchObject({ attempts: 1, cursor: {} })
      expect(await pipeline.claimStep(ledgerId, 'summarization', { status: 'indexing', leaseMs: 60_000 })).toBeNull()

      const plan = [{ chunkNo: 0, segFrom: 0, segTo: 1, estTokens: 10 }, { chunkNo: 1, segFrom: 2, segTo: 3, estTokens: 10 }]
      expect(await pipeline.planChunks(ledgerId, claim!.token, plan)).toBe(true)
      expect(await pipeline.countChunks(ledgerId, claim!.runId)).toEqual({ done: 0, total: 2 })
      const result = (segmentIdx: number) => ({
        summary: `around ${segmentIdx}`,
        decisions: [{ decision: 'Ship', quote: `line ${segmentIdx}`, segmentIdx, startMs: segmentIdx * 1000 }],
        actionItems: [],
        droppedDecisions: 0,
        droppedActionItems: 0,
      })
      expect(await pipeline.recordChunk(ledgerId, claim!.token, plan[0]!, result(1))).toBe(true)
      expect(await pipeline.recordChunk(ledgerId, claim!.token, plan[1]!, result(3))).toBe(false)

      const second = await pipeline.claimStep(ledgerId, 'summarization', { status: 'indexing', leaseMs: 60_000, chunkNo: 1 })
      expect(second).toMatchObject({ attempts: 1 })
      expect(await pipeline.recordChunk(ledgerId, second!.token, plan[1]!, result(3))).toBe(true)
      expect((await pipeline.listChunks(ledgerId)).map(c => c.result)).toEqual([result(1), result(3)])
      expect(await pipeline.countChunks(ledgerId, claim!.runId)).toEqual({ done: 2, total: 2 })

      const final = await pipeline.claimStep(ledgerId, 'summarization', { status: 'indexing', leaseMs: 60_000 })
      const summary = {
        summary: 'Shipping.',
        provider: 'stub' as const,
        decisions: [{ idx: 0, decision: 'Ship', quote: 'line 1', segmentIdx: 1, startMs: 1000 }],
        actionItems: [{ idx: 0, task: 'Send', assignee: null, dueDateText: 'Friday', quote: 'line 3', segmentIdx: 3, startMs: 3000 }],
      }
      expect(await pipeline.finalizeSummary(ledgerId, final!.token, summary)).toBe(true)
      expect(await createSupabaseSummaryRepository(options).getForMeeting(ledgerId)).toEqual(summary)
      const meeting = await client.from('meetings').select('status').eq('id', ledgerId).single()
      expect(meeting.data?.status).toBe('ready')
      expect((await pipeline.listRuns(ledgerId))[0]).toMatchObject({ stage: 'summarization', stepLeaseUntil: null })
    }
    finally {
      await client.from('meetings').delete().eq('id', ledgerId)
    }
    // The cascade took the ledger with the meeting.
    expect(await pipeline.listRuns(ledgerId)).toEqual([])
  })

  it('drives step-wise extraction to ready over the real RPCs, and fails a run under its token', async () => {
    // Step 6 (ADR-0012): the claim that moves the meeting into the stage, and
    // the release that stores the cursor and fails the meeting, as PostgREST
    // delivers them. The stub summarizer stands in for Groq: this is about the
    // ledger, and spends no quota.
    const { createSupabasePipelineRepository } = await import('../../server/utils/db/pipeline-supabase')
    const { createSupabaseSummaryRepository } = await import('../../server/utils/db/summaries-supabase')
    const { createSupabaseTranscriptRepository } = await import('../../server/utils/db/transcripts-supabase')
    const { createSupabaseMeetingRepository } = await import('../../server/utils/db/supabase')
    const { advanceExtraction } = await import('../../server/utils/summary/steps')
    const { createStubSummarizer } = await import('../../server/utils/summary/stub')
    const { SummarizationError } = await import('../../server/utils/summary/summarizer')
    const options = { url: process.env.NUXT_SUPABASE_URL!, serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY! }
    const stub = createStubSummarizer()
    let failNext = false
    const deps = {
      meetings: createSupabaseMeetingRepository(options),
      pipeline: createSupabasePipelineRepository(options),
      transcripts: createSupabaseTranscriptRepository(options),
      summaries: createSupabaseSummaryRepository(options),
      summarizer: {
        ...stub,
        async summarizeChunk(input: Parameters<typeof stub.summarizeChunk>[0]) {
          if (failNext) throw new SummarizationError('refused (verify)', 502, false)
          return stub.summarizeChunk(input)
        },
      },
    }
    const client = await db()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    try {
      for (const id of ids) {
        const { error } = await client.from('meetings')
          .insert({ ...newRow(), id, audio_key: `verify-${id}/audio.ogg`, status: 'summarizing' })
        expect(error).toBeNull()
        await deps.transcripts.replaceForMeeting(id, [0, 1, 2].map(idx => ({
          idx, startMs: idx * 1000, endMs: idx * 1000 + 900, text: `We agreed on point ${idx}.`,
        })))
      }

      const [ok, failing] = ids as [string, string]
      const planned = await advanceExtraction(ok, deps)
      expect(planned, 'is the pipeline steps migration applied?').toMatchObject({ kind: 'progress', meeting: { status: 'indexing' } })
      let outcome = planned
      for (let i = 0; i < 5 && outcome.kind === 'progress'; i++) outcome = await advanceExtraction(ok, deps)
      expect(outcome).toMatchObject({ kind: 'done', meeting: { status: 'ready' }, summary: { provider: 'stub' } })

      await advanceExtraction(failing, deps)
      failNext = true
      expect(await advanceExtraction(failing, deps)).toMatchObject({ kind: 'failed', statusCode: 502 })
      const meeting = await client.from('meetings').select('status, failed_stage, error_message').eq('id', failing).single()
      expect(meeting.data).toEqual({ status: 'failed', failed_stage: 'summarization', error_message: 'refused (verify)' })
    }
    finally {
      await client.from('meetings').delete().in('id', ids)
    }
  })
})

// ------------------------------------------------- Step-wise transcription
describe.skipIf(!has('NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY'))('step-wise transcription (ADR-0012, step 7)', () => {
  it('drives a reply into the real tables through the real rpcs, and refuses a stale token', { timeout: 60_000 }, async () => {
    // The stub transcriber and a store in memory stand in for Groq and R2: this
    // is about append_segments and finish_transcription, and spends no quota.
    const { createClient } = await import('@supabase/supabase-js')
    const { createSupabaseMeetingRepository } = await import('../../server/utils/db/supabase')
    const { createSupabasePipelineRepository } = await import('../../server/utils/db/pipeline-supabase')
    const { createSupabaseSlotRepository } = await import('../../server/utils/db/slots-supabase')
    const { createSupabaseTranscriptRepository } = await import('../../server/utils/db/transcripts-supabase')
    const { advanceTranscription } = await import('../../server/utils/transcription/steps')
    const { createStubTranscriber } = await import('../../server/utils/transcription/stub')
    const options = { url: process.env.NUXT_SUPABASE_URL!, serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY! }
    const client = createClient(options.url, options.serviceKey, { auth: { persistSession: false } })

    const id = crypto.randomUUID()
    const objects = new Map<string, Uint8Array>()
    const audioKey = `verify-${id}/audio.ogg`
    objects.set(audioKey, new Uint8Array(20_000))
    const deps = {
      meetings: createSupabaseMeetingRepository(options),
      pipeline: createSupabasePipelineRepository(options),
      slots: createSupabaseSlotRepository(options),
      transcriber: createStubTranscriber(),
      store: {
        async get(key: string) {
          const bytes = objects.get(key)
          return bytes ? { bytes, size: bytes.byteLength, contentType: 'audio/ogg', etag: null } : null
        },
        async put(key: string, body: Uint8Array) {
          objects.set(key, body)
          return { etag: null }
        },
        async openRange(key: string, window: { start: number, end: number } | null) {
          const bytes = objects.get(key)
          if (!bytes) return null
          const served = window ?? { start: 0, end: bytes.byteLength - 1 }
          return {
            body: new Response(bytes.subarray(served.start, served.end + 1)).body!,
            size: bytes.byteLength,
            contentType: null,
            window: served,
            etag: null,
          }
        },
        async delete(key: string) {
          objects.delete(key)
        },
      },
    }
    try {
      const { error } = await client.from('meetings').insert({
        id, title: 'verify', status: 'uploaded', source_file_name: 'a.mp4', source_bytes: 1,
        audio_key: audioKey, audio_bytes: 20_000,
      })
      expect(error).toBeNull()

      const first = await advanceTranscription(id, deps)
      expect(first, 'is the transcription steps migration applied?').toMatchObject({ kind: 'progress', meeting: { status: 'transcribing' } })
      let outcome = first
      for (let i = 0; i < 5 && outcome.kind === 'progress'; i++) outcome = await advanceTranscription(id, deps)
      expect(outcome).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })

      const stored = await createSupabaseTranscriptRepository(options).listForMeeting(id)
      expect(stored.length).toBeGreaterThan(0)
      expect(stored.map(s => s.idx)).toEqual(stored.map((_, i) => i))
      const chunks = await deps.pipeline.listChunks(id)
      expect(chunks[0]).toMatchObject({ chunkNo: 0, segFrom: 0, segTo: stored.length - 1, result: null })

      // Past transcription: the transcript is not touched, whoever holds what.
      const refused = await client.rpc('append_segments', {
        p_meeting: id, p_token: crypto.randomUUID(), p_from_idx: 0, p_segments: [], p_cursor: {},
      })
      expect(refused.error).toBeNull()
      expect(refused.data).toBe(false)
      expect((await createSupabaseTranscriptRepository(options).listForMeeting(id)).length).toBe(stored.length)
    }
    finally {
      await client.from('meetings').delete().eq('id', id)
    }
  })
})

// ---------------------------------------------------- Step-wise search indexing
describe.skipIf(!has('NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY'))('step-wise indexing (ADR-0012, step 8)', () => {
  // The stub embedder stands in for the provider: this is about the marker, the fence
  // and the vectors going through the real rpcs, and it spends no quota. Needs
  // 20261103120000_search_index_steps.sql applied, which until then fails here.
  async function realDrivers() {
    const { createClient } = await import('@supabase/supabase-js')
    const { createSupabaseMeetingRepository } = await import('../../server/utils/db/supabase')
    const { createSupabasePipelineRepository } = await import('../../server/utils/db/pipeline-supabase')
    const { createSupabaseSlotRepository } = await import('../../server/utils/db/slots-supabase')
    const { createSupabaseTranscriptRepository } = await import('../../server/utils/db/transcripts-supabase')
    const { createSupabaseTranscriptIndexRepository } = await import('../../server/utils/db/windows-supabase')
    const { createStubEmbedder } = await import('../../server/utils/qa/stub')
    const options = { url: process.env.NUXT_SUPABASE_URL!, serviceKey: process.env.NUXT_SUPABASE_SERVICE_KEY! }
    return {
      client: createClient(options.url, options.serviceKey, { auth: { persistSession: false } }),
      transcripts: createSupabaseTranscriptRepository(options),
      deps: {
        meetings: createSupabaseMeetingRepository(options),
        pipeline: createSupabasePipelineRepository(options),
        transcripts: createSupabaseTranscriptRepository(options),
        index: createSupabaseTranscriptIndexRepository(options),
        slots: createSupabaseSlotRepository(options),
        embedder: createStubEmbedder(),
        embedIntervalMs: 0,
      },
    }
  }

  const lines = (count: number) => Array.from({ length: count }, (_, i) => ({
    idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `Verify line ${i} about subject ${i}.`,
  }))

  it('drives a transcript into the real tables, with the plan the whole transcript gives, and marks it complete', { timeout: 60_000 }, async () => {
    const { client, deps, transcripts } = await realDrivers()
    const { advanceIndexing } = await import('../../server/utils/qa/steps')
    const { planWindows } = await import('../../server/utils/qa/windows')
    const { readyWindowCount } = await import('../../server/utils/db/windows')

    const id = crypto.randomUUID()
    const model = deps.embedder.model
    const segments = lines(220)
    try {
      expect((await client.from('meetings').insert({
        id, title: 'verify', status: 'ready', source_file_name: 'a.mp4', source_bytes: 1,
        audio_key: `verify-${id}/audio.ogg`, audio_bytes: 1,
      })).error).toBeNull()
      await transcripts.replaceForMeeting(id, segments)

      const empty = await deps.index.readState(id, model)
      expect(empty, 'is the search index steps migration applied?').toMatchObject({ marker: null, segmentCount: 220, storedWindows: 0 })
      expect(readyWindowCount(empty, model)).toBeNull()

      // The first batch: stored, the marker incomplete, a question would be refused.
      const first = await advanceIndexing(id, deps)
      expect(first).toMatchObject({ kind: 'progress', next: 'continue' })
      const partway = await deps.index.readState(id, model)
      expect(partway.marker).toMatchObject({ complete: false, model, windowCount: 0, textHash: partway.transcriptHash })
      expect(partway.storedForModel).toBeGreaterThan(0)
      expect(readyWindowCount(partway, model)).toBeNull()

      let outcome = first
      for (let i = 0; i < 20 && outcome.kind === 'progress'; i++) outcome = await advanceIndexing(id, deps)
      const plan = await planWindows(segments)
      expect(outcome).toMatchObject({ kind: 'done', index: { state: 'ready', windowCount: plan.length, indexedCount: plan.length, model } })

      // Hash for hash, through PostgREST, which reads what upsert_windows stored.
      expect(await deps.index.listKeys(id)).toEqual(plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model })))
      const finished = await deps.index.readState(id, model)
      expect(finished.marker).toEqual({ complete: true, model, windowCount: plan.length, textHash: finished.transcriptHash })
      expect(readyWindowCount(finished, model)).toBe(plan.length)

      // The vectors went in as vectors: the search function finds its own text.
      const [nearest] = await deps.index.search(id, await deps.embedder.embedQuery(plan[2]!.text), { model, limit: 1 })
      expect(nearest!.idx).toBe(2)
      expect(nearest!.contentHash).toBe(plan[2]!.contentHash)

      // A replaced transcript is noticed from the marker alone.
      await transcripts.replaceForMeeting(id, lines(220).map(s => s.idx === 7 ? { ...s, text: 'Said differently.' } : s))
      expect(readyWindowCount(await deps.index.readState(id, model), model)).toBeNull()
    }
    finally {
      await client.from('meetings').delete().eq('id', id)
    }
  })

  it('refuses a stale token, and a delete leaves no marker, window or run behind', { timeout: 60_000 }, async () => {
    const { client, deps, transcripts } = await realDrivers()
    const { hashedTokenVector } = await import('../../server/utils/qa/stub')
    const id = crypto.randomUUID()
    const model = deps.embedder.model
    const window = {
      idx: 0, firstSegmentIdx: 0, lastSegmentIdx: 2, startMs: 0, endMs: 14_800, text: 'A window.',
      contentHash: 'a'.repeat(64), model, embedding: hashedTokenVector('A window.'),
    }
    try {
      expect((await client.from('meetings').insert({
        id, title: 'verify', status: 'ready', source_file_name: 'a.mp4', source_bytes: 1,
        audio_key: `verify-${id}/audio.ogg`, audio_bytes: 1,
      })).error).toBeNull()
      await transcripts.replaceForMeeting(id, lines(3))
      const { transcriptHash } = await deps.index.readState(id, model)
      const batch = { windows: [window], cursor: { at: 1 }, textHash: transcriptHash, model }

      const stale = (await deps.pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: 1 }))!
      await new Promise(resolve => setTimeout(resolve, 20))
      const live = (await deps.pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: 60_000 }))!
      expect(live.attempts).toBe(2)
      expect(await deps.pipeline.upsertWindows(id, stale.token, batch)).toBe(false)
      expect(await deps.pipeline.finishIndex(id, stale.token, { textHash: transcriptHash, model, windowCount: 1 })).toBe('lost')
      expect(await deps.index.listKeys(id)).toEqual([])

      expect(await deps.pipeline.upsertWindows(id, live.token, batch)).toBe(true)
      const finishing = (await deps.pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: 60_000 }))!
      expect(await deps.pipeline.finishIndex(id, finishing.token, { textHash: 'b'.repeat(64), model, windowCount: 1 })).toBe('changed')
      expect(await deps.pipeline.finishIndex(id, finishing.token, { textHash: transcriptHash, model, windowCount: 1 })).toBe('complete')

      expect((await client.from('meetings').delete().eq('id', id)).error).toBeNull()
      expect((await client.from('meeting_index_state').select().eq('meeting_id', id)).data).toEqual([])
      expect(await deps.index.listKeys(id)).toEqual([])
      expect(await deps.pipeline.listRuns(id)).toEqual([])
      expect(await deps.pipeline.upsertWindows(id, finishing.token, batch)).toBe(false)
    }
    finally {
      await client.from('meetings').delete().eq('id', id)
    }
  })
})

// ----------------------------------------------------------------------- Groq
/**
 * The probe needs a native ffmpeg and the committed fixture. Build it up front
 * so a machine lacking either SKIPS this group rather than failing it — a red
 * suite would say Groq is broken when the local toolchain is simply incomplete.
 */
function buildAudioProbe(): Uint8Array | null {
  try {
    const source = fileURLToPath(new URL('../../fixtures/fixture-30s-720p.mp4', import.meta.url))
    const out = execFileSync('ffmpeg', [
      '-v', 'error', '-i', source, '-t', '5', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '16k', '-f', 'ogg', 'pipe:1',
    ], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.byteLength > 0 ? new Uint8Array(out) : null
  }
  catch {
    return null
  }
}

const probe = has('NUXT_GROQ_API_KEY') ? buildAudioProbe() : null
if (has('NUXT_GROQ_API_KEY') && !probe) {
  console.info('[verify] Groq checks skipped: needs a native ffmpeg and fixtures/fixture-30s-720p.mp4')
}

describe.skipIf(!has('NUXT_GROQ_API_KEY') || !probe)('Groq Whisper', () => {
  const audio = probe!

  it('accepts Ogg/Opus at 16 kHz mono and returns the envelope we parse', async () => {
    const form = new FormData()
    form.append('file', new Blob([audio as BlobPart], { type: 'audio/ogg' }), 'audio.ogg')
    form.append('model', 'whisper-large-v3-turbo')
    form.append('response_format', 'verbose_json')

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.NUXT_GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    expect(response.ok, `HTTP ${response.status}: ${(await response.clone().text()).slice(0, 300)}`).toBe(true)

    const body = await response.json() as { segments?: unknown[] }
    // The envelope was inferred from OpenAI compatibility, never published by
    // Groq. This is the assertion that closes ADR-0004's main open question.
    console.info('[verify] Groq envelope keys:', Object.keys(body).join(', '))
    expect(Array.isArray(body.segments), 'no segments array — groq.ts expects one').toBe(true)
    if (body.segments?.length) {
      console.info('[verify] segment keys:', Object.keys(body.segments[0] as object).join(', '))
      const first = body.segments[0] as { start: unknown, end: unknown, text: unknown }
      expect(typeof first.start).toBe('number')
      expect(typeof first.end).toBe('number')
      expect(typeof first.text).toBe('string')
    }
  })

  it('sends back a reply the production scanner reads a window at a time, and agrees with parsing it whole', async () => {
    const reply = await createGroqTranscriber({ apiKey: process.env.NUXT_GROQ_API_KEY! })
      .transcribe({ bytes: audio, contentType: 'audio/ogg' })

    const whole = JSON.parse(new TextDecoder().decode(reply)) as { duration: number, segments: Array<{ start: number, end: number, text: string }> }
    const expected = whole.segments.map(({ start, end, text }) => ({ start, end, text }))
    expect(expected.length, 'the clip came back with no segments, so nothing was compared').toBeGreaterThan(0)

    // The same calls, in the same order, as `page` in steps.ts. Windows far
    // smaller than a page cut every boundary the reply has; a window holding
    // the whole reply collects many objects at once, as a real page does.
    const read = (startWidth: number, maxObjects: number) => {
      const objects: Uint8Array[] = []
      let scan = INITIAL_SCAN
      let offset = 0
      let width = startWidth
      let finished = false
      while (!finished) {
        const window = reply.subarray(offset, offset + width)
        const scanned = scanWindow(window, scan, { atEnd: offset + window.byteLength >= reply.byteLength, maxObjects })
        if (scanned.consumed === 0 && scanned.objects.length === 0 && !scanned.finished) {
          width *= 2
          continue
        }
        objects.push(...scanned.objects)
        offset += scanned.consumed
        scan = scanned.state
        finished = scanned.finished
        width = startWidth
      }
      return parseSegments(objects)
    }
    expect(read(16, 2)).toEqual(expected)
    const lines = read(reply.byteLength, 100)
    expect(lines).toEqual(expected)

    // The audio's end comes from the head of the reply alone. Null here would
    // quietly turn off the check for timestamps past the end of the audio.
    expect(replyDuration(reply)).toBe(whole.duration)

    const segments = normalizeSegments(lines)
    for (const [i, segment] of segments.entries()) {
      expect(transcriptSegmentSchema.safeParse(segment).success).toBe(true)
      expect(segment.idx).toBe(i)
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs)
    }
    console.info(`[verify] scanned ${reply.byteLength} bytes into ${segments.length} segments, duration ${whole.duration}s`)
  })
})

// --------------------------------------------------------- Workers AI embeddings
describe.skipIf(!has('NUXT_WORKERS_AI_ACCOUNT_ID', 'NUXT_WORKERS_AI_API_TOKEN'))('Workers AI embeddings', () => {
  // ADR-0014's measurements, kept as checks: a model swapped or changed under its
  // name should fail here and not in front of a visitor. Seven calls, about 20
  // neurons out of the day's 10,000.
  const embedder = () => createWorkersAiEmbedder({
    accountId: process.env.NUXT_WORKERS_AI_ACCOUNT_ID!,
    apiToken: process.env.NUXT_WORKERS_AI_API_TOKEN!,
  })
  const cosine = (a: number[], b: number[]) => {
    const dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0)
    return dot / Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0))
  }
  const sentences = (count: number, ending: string) => [
    ...Array.from({ length: count }, (_, i) => `Item ${i} on the agenda was the warehouse contract review, moved to Thursday.`),
    ending,
  ].join(' ')

  it('returns one unit-length vector of the schema\'s size per document, each its own', async () => {
    const vectors = await embedder().embedDocuments([
      'We agreed to ship the billing change on Friday.',
      'The marketing budget is being cut next quarter.',
      'Priya will interview two candidates for a design role.',
    ])
    expect(vectors).toHaveLength(3)
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
      console.info(`[verify] ${WORKERS_AI_EMBEDDING_MODEL} norm at ${EMBEDDING_DIMENSIONS}d: ${norm.toFixed(6)}`)
      // Not closer: 1.0002 has been seen (ADR-0014).
      expect(norm).toBeCloseTo(1, 2)
    }
    expect(cosine(vectors[0]!, vectors[1]!)).toBeLessThan(0.99)
  })

  it('embeds a question as it embeds a document, and keeps a batch in order', async () => {
    // The second place in a batch, so a shuffled reply fails too. No prefix on
    // either: the driver sends text as it is, and this is what says that is right.
    const client = embedder()
    const [, second] = await client.embedDocuments(['An unrelated first text.', 'The second text in the batch.'])
    expect(cosine(await client.embedQuery('The second text in the batch.'), second!)).toBeGreaterThan(0.999)
  })

  it('takes one indexing step\'s largest batch as one request, whatever fills it', async () => {
    // ADR-0012 step 8: at most INDEX_BATCH windows and MAX_BATCH_TOKENS. A step's batch
    // is split by the same rule the driver splits by, so what it sends is sent whole,
    // once. About 30 neurons.
    const real = globalThis.fetch
    let requests = 0
    const counting: typeof fetch = (...args) => {
      requests++
      return real(...args)
    }
    globalThis.fetch = counting
    try {
      const step = createWorkersAiEmbedder({
        accountId: process.env.NUXT_WORKERS_AI_ACCOUNT_ID!,
        apiToken: process.env.NUXT_WORKERS_AI_API_TOKEN!,
        maxAttempts: 1,
      })
      const atTheBudget = (i: number) => Array.from({ length: 600 }, (_, k) => `word${i}x${k}`).join(' ')
      const windows = Array.from({ length: INDEX_BATCH }, (_, i) => atTheBudget(i))
      const [batch] = planEmbeddingBatches(windows, text => text)
      // The premise: these are big enough that the tokens bind before the count.
      expect(batch!.length).toBeLessThan(INDEX_BATCH)
      expect(batch!.reduce((sum, text) => sum + estimateTokens(text), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)

      const vectors = await step.embedDocuments(batch!)
      expect(requests).toBe(1)
      expect(vectors).toHaveLength(batch!.length)
      for (const vector of vectors) expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)

      const short = await step.embedDocuments(Array.from({ length: INDEX_BATCH }, (_, i) => `A short window, number ${i}.`))
      expect(requests).toBe(2)
      expect(short).toHaveLength(INDEX_BATCH)
    }
    finally {
      globalThis.fetch = real
    }
  })

  it('refuses an input over 8,192 tokens rather than truncating it', async () => {
    const failure = await embedder().embedDocuments([sentences(1_000, 'The end.')]).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingInputTooLongError)
    expect(failure).toMatchObject({ statusCode: 422, retryable: false })
    console.info(`[verify] refusal: ${failure.message}`)
    // The model's count, read from its refusal. It is how the driver knows the case.
    expect(failure.message).toMatch(/\(\d[\d,]* tokens; the limit is 8,192 tokens\)/)
  })

  it('reads an input to its end, close to the limit', async () => {
    // How the rejected bge-base fails: past 512 tokens it silently drops the rest,
    // so these two would come back identical.
    const [a, b] = await embedder().embedDocuments([
      sentences(400, 'Finally, the billing migration was approved without objections.'),
      sentences(400, 'Finally, the hiring freeze was lifted for the support team.'),
    ])
    const similarity = cosine(a!, b!)
    console.info(`[verify] same text with another ending: similarity ${similarity.toFixed(6)}`)
    expect(similarity).toBeLessThan(1 - 1e-5)
  })

  it('finds the passage for a reworded question, in English and in German', async () => {
    // Made-up text, and clear cases. Each question shares almost no words with its
    // passage, so this is the model's sense of meaning and not word overlap. The
    // German half is the point: bge-base-en-v1.5 fails it with these very sentences
    // (one miss of four), so an English-only model cannot be swapped in unnoticed.
    const languages = {
      English: {
        passages: [
          'We agreed to cut the marketing budget by twenty percent next quarter.',
          'Priya will interview two candidates for the design role next week.',
          'The database migration is delayed until the new server hardware arrives.',
          'Everyone should hand in their travel expenses to Tom by the end of the month.',
        ],
        questions: [
          'How much less will we spend on advertising?',
          'Who is talking to job applicants?',
          'Why is moving the data running late?',
          'Where do I send my trip receipts?',
        ],
      },
      German: {
        passages: [
          'Wir haben beschlossen, das Marketingbudget im nächsten Quartal um zwanzig Prozent zu kürzen.',
          'Priya führt nächste Woche Vorstellungsgespräche mit zwei Kandidaten für die Designstelle.',
          'Die Datenbankmigration verzögert sich, bis die neue Serverhardware geliefert wird.',
          'Alle reichen ihre Reisekostenabrechnungen bis Monatsende bei Tom ein.',
        ],
        questions: [
          'Wie viel weniger geben wir künftig für Werbung aus?',
          'Wer spricht mit den Bewerbern?',
          'Warum dauert der Umzug der Daten länger?',
          'Wo gebe ich meine Belege von Dienstreisen ab?',
        ],
      },
    }
    const client = embedder()
    const all = Object.values(languages)
    const passages = await client.embedDocuments(all.flatMap(l => l.passages))
    const questions = await client.embedDocuments(all.flatMap(l => l.questions))

    // Each question ranks its own language's passages: a German question finding
    // the English twin of its passage would say nothing against the model.
    const size = languages.English.passages.length
    for (const [l, name] of Object.keys(languages).entries()) {
      const candidates = passages.slice(l * size, (l + 1) * size)
      const found = questions.slice(l * size, (l + 1) * size).map((question) => {
        const scores = candidates.map(passage => cosine(question, passage))
        return scores.indexOf(Math.max(...scores))
      })
      console.info(`[verify] ${name}: top passage per question ${found.join(', ')}`)
      expect(found, name).toEqual([0, 1, 2, 3])
    }
  })
})
