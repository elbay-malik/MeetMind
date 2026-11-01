import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AwsClient } from 'aws4fetch'
import { createGeminiEmbedder, GEMINI_EMBEDDING_MODEL } from '../../server/utils/qa/gemini'
import { createGroqTranscriber } from '../../server/utils/transcription/groq'
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
        embedding: `[${Array.from({ length: 768 }, () => 0.01).join(',')}]`,
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

  it('is parsed by the production transcriber into valid segments', async () => {
    const result = await createGroqTranscriber({ apiKey: process.env.NUXT_GROQ_API_KEY! })
      .transcribe({ bytes: audio, contentType: 'audio/ogg' })

    for (const [i, segment] of result.segments.entries()) {
      expect(transcriptSegmentSchema.safeParse(segment).success).toBe(true)
      expect(segment.idx).toBe(i)
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs)
    }
    console.info(`[verify] transcribed into ${result.segments.length} segments, duration ${result.durationSec}s`)
  })
})

// ------------------------------------------------------------- Gemini embeddings
describe.skipIf(!has('NUXT_GEMINI_API_KEY'))('Gemini embeddings', () => {
  // Nothing in ADR-0007's driver has run against the real API: the request
  // shape comes from the API reference, and three of its facts could only be
  // confirmed with a key. These are those three.
  const embedder = () => createGeminiEmbedder({ apiKey: process.env.NUXT_GEMINI_API_KEY! })
  const cosine = (a: number[], b: number[]) => {
    const dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0)
    return dot / Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0))
  }

  it('honours embedContentConfig.outputDimensionality, returning 768 values rather than the 3,072 default', async () => {
    // assertEmbedding inside the driver throws on any other length, so this
    // passing at all proves the field name is right.
    const [vector] = await embedder().embedDocuments(['We agreed to ship the billing change on Friday.'])
    expect(vector).toHaveLength(768)
  })

  it('returns unit-length vectors at 768 dimensions, as gemini-embedding-2 is documented to', async () => {
    // gemini-embedding-001 would need the caller to re-normalize a truncated
    // vector; ADR-0007 chose this model partly because it does not.
    const [vector] = await embedder().embedDocuments(['The marketing budget is being cut next quarter.'])
    const norm = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0))
    console.info(`[verify] ${GEMINI_EMBEDDING_MODEL} norm at 768d: ${norm.toFixed(6)}`)
    expect(norm).toBeCloseTo(1, 3)
  })

  it('ranks a question closer to the passage that answers it than to an unrelated one', async () => {
    // The task prefixes are what put queries and documents in the same space.
    const client = embedder()
    const [budget, hiring] = await client.embedDocuments([
      'We agreed to cut the marketing budget by twenty percent next quarter.',
      'Priya will interview two candidates for a design role.',
    ])
    const question = await client.embedQuery('What did we decide about marketing spend?')
    const toBudget = cosine(question, budget!)
    const toHiring = cosine(question, hiring!)
    console.info(`[verify] similarity: answering passage ${toBudget.toFixed(3)}, unrelated ${toHiring.toFixed(3)}`)
    expect(toBudget).toBeGreaterThan(toHiring)
  })
})
