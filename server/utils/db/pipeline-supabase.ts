import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { SupabaseOptions } from './supabase'
import { actionItemToRow, decisionToRow } from './summaries'
import {
  assertStorableResult,
  assertValidLease,
  assertValidPlan,
  parseStoredResult,
  rowToRun,
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

    async claimStep(meetingId, stage, { status, leaseMs, chunkNo, newRun, resetAttempts }) {
      assertValidLease(leaseMs)
      const { data, error } = await db().rpc('claim_step', {
        p_meeting: meetingId,
        p_stage: stage,
        p_status: status,
        p_lease_ms: leaseMs,
        p_chunk_no: chunkNo ?? null,
        p_new_run: newRun ?? false,
        p_reset_attempts: resetAttempts ?? false,
      })
      if (error) fail('claim step', error)
      const row = data?.[0]
      if (!row) return null
      return { token: row.step_token, runId: row.run_id, cursor: row.run_cursor, attempts: row.attempts } satisfies StepClaim
    },

    async releaseStep(meetingId, stage, token, { error: reason, retryAt, refundAttempt }) {
      const { data, error } = await db().rpc('release_step', {
        p_meeting: meetingId,
        p_stage: stage,
        p_token: token,
        p_error: reason,
        p_retry_at: retryAt ? retryAt.toISOString() : null,
        p_refund_attempt: refundAttempt ?? false,
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
        return { ...plan, attempts: row.attempts, result: parseStoredResult(plan, row.result) }
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

    async deleteForMeeting(meetingId) {
      // Normally a no-op by the time it runs -- deleting the meeting cascades
      // -- but stated rather than assumed, so it means the same on both drivers.
      const chunks = await db().from('summary_chunks').delete().eq('meeting_id', meetingId)
      if (chunks.error) fail('summary chunks delete', chunks.error)
      const runs = await db().from('pipeline_runs').delete().eq('meeting_id', meetingId)
      if (runs.error) fail('pipeline runs delete', runs.error)
    },
  }
}
