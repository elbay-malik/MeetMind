import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { SupabaseOptions } from './supabase'
import { actionItemToRow, decisionToRow } from './summaries'
import {
  assertStorableResult,
  assertValidIndexBatch,
  assertValidLease,
  assertReleasable,
  assertValidPage,
  assertValidPlan,
  parseStoredResult,
  rowToRun,
  type IndexFinish,
  type PipelineRepository,
  type StepClaim,
  type SummaryChunk,
} from './pipeline'

const clients = new Map<string, SupabaseClient<Database>>()

function clientFor(options: SupabaseOptions): SupabaseClient<Database> {
  const cacheKey = `${options.url}\n${options.serviceKey}`
  let client = clients.get(cacheKey)
  if (!client) {
    client = createClient<Database>(options.url, options.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    clients.set(cacheKey, client)
  }
  return client
}

function fail(action: string, error: { code?: string, message: string }): never {
  throw new Error(`Supabase ${action} failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
}

/** A boolean rpc answer, or a loud failure: an unusable answer must not read as "written". */
function granted(action: string, data: unknown): boolean {
  if (typeof data !== 'boolean') throw new Error(`Supabase ${action} returned an unusable answer: ${JSON.stringify(data)}`)
  return data
}

/**
 * The run ledger in `public.pipeline_runs` and `public.summary_chunks`. Every
 * write is one SQL function, so its token fence and the write are a single
 * transaction.
 */
export function createSupabasePipelineRepository(options: SupabaseOptions): PipelineRepository {
  const db = () => clientFor(options)

  return {
    kind: 'supabase',

    async claimStep(meetingId, stage, { status, leaseMs, chunkNo, newRun, resetAttempts, moveTo, redo, expectedUpdatedAt }) {
      assertValidLease(leaseMs)
      const { data, error } = await db().rpc('claim_step', {
        p_meeting: meetingId,
        p_stage: stage,
        p_status: status,
        p_lease_ms: leaseMs,
        p_chunk_no: chunkNo ?? null,
        p_new_run: newRun ?? false,
        p_reset_attempts: resetAttempts ?? false,
        p_move_to: moveTo ?? null,
        p_redo: redo ?? false,
        p_expected_updated_at: expectedUpdatedAt ?? null,
      })
      if (error) fail('claim step', error)
      const row = data?.[0]
      if (!row) return null
      return { token: row.step_token, runId: row.run_id, cursor: row.run_cursor, attempts: row.attempts } satisfies StepClaim
    },

    async releaseStep(meetingId, stage, token, { error: reason, retryAt, refundAttempt, cursor, failFrom }) {
      assertReleasable(stage, failFrom)
      const { data, error } = await db().rpc('release_step', {
        p_meeting: meetingId,
        p_stage: stage,
        p_token: token,
        p_error: reason,
        p_retry_at: retryAt ? retryAt.toISOString() : null,
        p_refund_attempt: refundAttempt ?? false,
        p_cursor: cursor ?? null,
        p_fail_from: failFrom ?? null,
      })
      if (error) fail('release step', error)
      return granted('release step', data)
    },

    async listRuns(meetingId) {
      const { data, error } = await db().from('pipeline_runs').select().eq('meeting_id', meetingId)
      if (error) fail('pipeline runs select', error)
      return data.map(rowToRun)
    },

    async planChunks(meetingId, token, chunks) {
      assertValidPlan(chunks)
      const { data, error } = await db().rpc('plan_chunks', {
        p_meeting: meetingId,
        p_token: token,
        p_chunks: chunks.map(c => ({ chunk_no: c.chunkNo, seg_from: c.segFrom, seg_to: c.segTo, est_tokens: c.estTokens })),
      })
      if (error) fail('plan chunks', error)
      return granted('plan chunks', data)
    },

    async listChunks(meetingId) {
      // Only the current summarization run's chunks: plan_chunks removes an
      // older run's, but a new run that has not planned yet would otherwise
      // read them as its own.
      const run = await db().from('pipeline_runs').select('run_id')
        .eq('meeting_id', meetingId).eq('stage', 'summarization').maybeSingle()
      if (run.error) fail('summarization run select', run.error)
      if (!run.data) return []
      // A plan is at most MAX_CHUNKS rows, far under PostgREST's page cap.
      const { data, error } = await db().from('summary_chunks').select()
        .eq('meeting_id', meetingId).eq('run_id', run.data.run_id).order('chunk_no', { ascending: true })
      if (error) fail('summary chunks select', error)
      return data.map((row): SummaryChunk => {
        const plan = { chunkNo: row.chunk_no, segFrom: row.seg_from, segTo: row.seg_to, estTokens: row.est_tokens }
        const result = parseStoredResult(plan, row.result)
        return { ...plan, attempts: row.attempts, result, unusable: row.result != null && result === null }
      })
    },

    async recordChunk(meetingId, token, chunk, result) {
      assertStorableResult(chunk, result)
      const { data, error } = await db().rpc('record_chunk', {
        p_meeting: meetingId,
        p_token: token,
        p_chunk_no: chunk.chunkNo,
        p_seg_from: chunk.segFrom,
        p_seg_to: chunk.segTo,
        p_result: result,
      })
      if (error) fail('record chunk', error)
      return granted('record chunk', data)
    },

    async finalizeSummary(meetingId, token, summary) {
      const { data, error } = await db().rpc('finalize_summary', {
        p_meeting: meetingId,
        p_token: token,
        p_summary: summary.summary,
        p_provider: summary.provider,
        p_decisions: summary.decisions.map(d => decisionToRow(meetingId, d)),
        p_action_items: summary.actionItems.map(a => actionItemToRow(meetingId, a)),
      })
      if (error) fail('finalize summary', error)
      return granted('finalize summary', data)
    },

    async appendSegments(meetingId, token, page) {
      assertValidPage(page)
      const { data, error } = await db().rpc('append_segments', {
        p_meeting: meetingId,
        p_token: token,
        p_from_idx: page.fromIdx,
        p_segments: page.segments.map(s => ({ idx: s.idx, start_ms: s.startMs, end_ms: s.endMs, text: s.text })),
        p_cursor: page.cursor,
      })
      if (error) fail('append segments', error)
      return granted('append segments', data)
    },

    async finishTranscription(meetingId, token, { chunks, refusal }) {
      assertValidPlan(chunks)
      const { data, error } = await db().rpc('finish_transcription', {
        p_meeting: meetingId,
        p_token: token,
        p_chunks: chunks.map(c => ({ chunk_no: c.chunkNo, seg_from: c.segFrom, seg_to: c.segTo, est_tokens: c.estTokens })),
        p_refusal: refusal,
      })
      if (error) fail('finish transcription', error)
      return granted('finish transcription', data)
    },

    async upsertWindows(meetingId, token, batch) {
      assertValidIndexBatch(batch)
      const { data, error } = await db().rpc('upsert_windows', {
        p_meeting: meetingId,
        p_token: token,
        p_windows: batch.windows.map(w => ({
          idx: w.idx,
          first_segment_idx: w.firstSegmentIdx,
          last_segment_idx: w.lastSegmentIdx,
          start_ms: w.startMs,
          end_ms: w.endMs,
          content: w.text,
          content_hash: w.contentHash,
          embedding: w.embedding,
        })),
        p_cursor: batch.cursor,
        p_text_hash: batch.textHash,
        p_model: batch.model,
      })
      if (error) fail('upsert windows', error)
      return granted('upsert windows', data)
    },

    async finishIndex(meetingId, token, { textHash, model, windowCount }) {
      const { data, error } = await db().rpc('finish_index', {
        p_meeting: meetingId,
        p_token: token,
        p_text_hash: textHash,
        p_model: model,
        p_window_count: windowCount,
      })
      if (error) fail('finish index', error)
      // Anything else must not read as complete.
      if (data !== 'complete' && data !== 'changed' && data !== 'lost') {
        throw new Error(`Supabase finish index returned an unusable answer: ${JSON.stringify(data)}`)
      }
      return data satisfies IndexFinish
    },

    async deleteForMeeting(meetingId) {
      // Normally a no-op by the time it runs -- deleting the meeting cascades
      // -- but stated rather than assumed, so it means the same on both drivers.
      const chunks = await db().from('summary_chunks').delete().eq('meeting_id', meetingId)
      if (chunks.error) fail('summary chunks delete', chunks.error)
      const runs = await db().from('pipeline_runs').delete().eq('meeting_id', meetingId)
      if (runs.error) fail('pipeline runs delete', runs.error)
      const marker = await db().from('meeting_index_state').delete().eq('meeting_id', meetingId)
      if (marker.error) fail('index marker delete', marker.error)
    },
  }
}
