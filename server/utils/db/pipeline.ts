import type { MeetingStatus, MeetingSummary } from '#shared/types/meeting'
import { attestedChunkSchema, type AttestedChunk } from '../summary/reconcile'

/**
 * The run ledger (ADR-0012 §3): how far each stage of a meeting's pipeline has
 * got, and which step of it, if any, is in flight.
 *
 * A stage is a series of short steps. Each step is claimed under a fresh token
 * with a short lease, and every write it makes is fenced on that token. A step
 * killed mid-flight leaves a lease that simply expires; the next caller
 * re-claims the step under a new token, and the killed step's late writes
 * match nothing.
 */

export type PipelineStage = 'transcription' | 'summarization' | 'search_index'

/** A granted claim. `token` fences every write the step makes. */
export interface StepClaim {
  token: string
  runId: string
  cursor: Record<string, unknown>
  /** Claims of this step so far, this one included; of the chunk, when one was claimed. */
  attempts: number
}

export interface PipelineRun {
  stage: PipelineStage
  runId: string
  cursor: Record<string, unknown>
  /** When the step in flight loses its claim; null when none is in flight. */
  stepLeaseUntil: Date | null
  attempts: number
  lastError: string | null
  retryAt: Date | null
}

/** One chunk of the extraction plan: segments `segFrom..segTo` by index, inclusive. */
export interface ChunkPlan {
  chunkNo: number
  segFrom: number
  segTo: number
  estTokens: number
}

export interface SummaryChunk extends ChunkPlan {
  attempts: number
  /** The chunk's attested extraction, or null until it has one. */
  result: AttestedChunk | null
}

export interface ClaimOptions {
  /** The meeting's status the step belongs to. In any other status nothing is claimed. */
  status: MeetingStatus
  leaseMs: number
  /** Count this attempt on a chunk of the current plan. */
  chunkNo?: number
  /** Start the stage over under a new run id; results of the old run become stale. */
  newRun?: boolean
  /** Count this claim as attempt 1, as when a failed run is retried. */
  resetAttempts?: boolean
  /**
   * Move the meeting to this status with the claim, clearing its error: how a
   * step enters its stage, from `summarizing` or a cooled-down `failed`.
   */
  moveTo?: MeetingStatus
}

export interface ReleaseOutcome {
  error: string | null
  retryAt: Date | null
  /**
   * Give back the attempt the claim counted, because the step made no provider
   * call: its request slot was not free, or the provider refused with a 429.
   */
  refundAttempt?: boolean
  /** Replace the run's cursor; left as it is when omitted. */
  cursor?: Record<string, unknown>
  /**
   * Move the meeting to `failed` for this stage, with `error`, if it is still
   * in this status. Fenced on the token like the rest of the release, so a
   * step whose lease ran out cannot fail a run another step has taken over.
   */
  failFrom?: MeetingStatus
}

export interface PipelineRepository {
  readonly kind: 'supabase' | 'local'
  /**
   * Claim the stage's next step, or null when another step of it holds a live
   * lease, the meeting is not in `status`, or the chunk already has its result. Moves the meeting's `updatedAt`,
   * so a delete that read the meeting before this claim no longer matches it.
   */
  claimStep(meetingId: string, stage: PipelineStage, options: ClaimOptions): Promise<StepClaim | null>
  /** End a step without a result, saying why and when to try again. False when `token` is not live. */
  releaseStep(meetingId: string, stage: PipelineStage, token: string, outcome: ReleaseOutcome): Promise<boolean>
  listRuns(meetingId: string): Promise<PipelineRun[]>
  /**
   * Write the extraction plan for the current summarization run, unless it
   * already has one, which is then kept as it is -- so the caller works from
   * {@link listChunks} afterwards, not from the plan it passed. The step keeps
   * its claim. False when `token` is not live.
   */
  planChunks(meetingId: string, token: string, chunks: readonly ChunkPlan[]): Promise<boolean>
  /**
   * The current summarization run's plan, in chunk order. A stored result
   * that fails its checks reads as null, so the chunk is done again rather
   * than merged.
   */
  listChunks(meetingId: string): Promise<SummaryChunk[]>
  /**
   * Store one chunk's result and end the step. Refuses a result that would not
   * read back. False when `token` is not live, or the chunk is not planned with
   * exactly this segment range.
   */
  recordChunk(meetingId: string, token: string, chunk: ChunkPlan, result: AttestedChunk): Promise<boolean>
  /**
   * Write the summary and move the meeting from `indexing` to `ready`, all or
   * nothing, and end the step. False when `token` is not live or the meeting
   * is no longer `indexing`. Throws while a chunk of the plan has no result.
   */
  finalizeSummary(meetingId: string, token: string, summary: MeetingSummary): Promise<boolean>
  /** Remove the meeting's runs and chunks. Idempotent; a cascade on Supabase. */
  deleteForMeeting(meetingId: string): Promise<void>
}

/** The largest lease Postgres's `integer` holds; both drivers refuse more, alike. */
const MAX_LEASE_MS = 2_147_483_647

export function assertValidLease(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
    throw new Error(`The lease must be a whole number of milliseconds from 1 to ${MAX_LEASE_MS}, got ${leaseMs}`)
  }
}

/** The latest live step lease among a meeting's runs, or null when none is live. */
export function liveStepLease(runs: readonly Pick<PipelineRun, 'stepLeaseUntil'>[], now: number = Date.now()): Date | null {
  let latest: Date | null = null
  for (const { stepLeaseUntil } of runs) {
    if (stepLeaseUntil && stepLeaseUntil.getTime() > now && (!latest || stepLeaseUntil > latest)) {
      latest = stepLeaseUntil
    }
  }
  return latest
}

/**
 * What is wrong with a chunk result, or null when nothing is: its shape, and
 * that every item cites a line inside the chunk it was attested against.
 */
function resultProblem(chunk: ChunkPlan, value: unknown): string | null {
  const parsed = attestedChunkSchema.safeParse(value)
  if (!parsed.success) return parsed.error.message
  const outside = [...parsed.data.decisions, ...parsed.data.actionItems]
    .find(item => item.segmentIdx < chunk.segFrom || item.segmentIdx > chunk.segTo)
  return outside ? `an item cites segment ${outside.segmentIdx}, outside the chunk's ${chunk.segFrom}..${chunk.segTo}` : null
}

/**
 * A stored chunk result, checked before anything merges it. Null when it fails,
 * with the reason logged: the chunk is then extracted again rather than merged.
 */
export function parseStoredResult(chunk: ChunkPlan, stored: unknown): AttestedChunk | null {
  if (stored == null) return null
  const problem = resultProblem(chunk, stored)
  if (problem === null) return attestedChunkSchema.parse(stored)
  console.warn(`[meetmind] stored result of chunk ${chunk.chunkNo} is unusable and will be redone: ${problem}`)
  return null
}

/** Refuse a result before it is stored, so only what would read back is ever written. */
export function assertStorableResult(chunk: ChunkPlan, result: AttestedChunk): void {
  const problem = resultProblem(chunk, result)
  if (problem !== null) throw new Error(`Chunk ${chunk.chunkNo}'s result cannot be stored: ${problem}`)
}

/** Only transcription and extraction have a failed stage of their own; the SQL refuses alike. */
export function assertReleasable(stage: PipelineStage, failFrom: MeetingStatus | undefined): void {
  if (failFrom !== undefined && stage === 'search_index') {
    throw new Error('The search_index stage cannot fail the meeting')
  }
}

export function assertValidPlan(chunks: readonly ChunkPlan[]): void {
  chunks.forEach((c, i) => {
    if (c.chunkNo !== i) throw new Error(`Chunk plan must be numbered 0..n-1 in order, got ${c.chunkNo} at ${i}`)
    if (!Number.isInteger(c.segFrom) || c.segFrom < 0 || !Number.isInteger(c.segTo) || c.segTo < c.segFrom) {
      throw new Error(`Chunk ${c.chunkNo} has an invalid segment range ${c.segFrom}..${c.segTo}`)
    }
    if (!Number.isInteger(c.estTokens) || c.estTokens < 0) throw new Error(`Chunk ${c.chunkNo} has an invalid token estimate`)
  })
}

export type PipelineRunRow = {
  meeting_id: string
  stage: PipelineStage
  run_id: string
  cursor: Record<string, unknown>
  step_token: string | null
  step_lease_until: string | null
  step_chunk_no: number | null
  attempts: number
  last_error: string | null
  retry_at: string | null
  updated_at: string
}

export type SummaryChunkRow = {
  meeting_id: string
  chunk_no: number
  run_id: string
  seg_from: number
  seg_to: number
  est_tokens: number
  attempts: number
  result: unknown
  updated_at: string
}

export function rowToRun(row: PipelineRunRow): PipelineRun {
  return {
    stage: row.stage,
    runId: row.run_id,
    cursor: row.cursor,
    stepLeaseUntil: row.step_lease_until ? new Date(row.step_lease_until) : null,
    attempts: row.attempts,
    lastError: row.last_error,
    retryAt: row.retry_at ? new Date(row.retry_at) : null,
  }
}
