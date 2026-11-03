import type { MeetingStatus, MeetingSummary, TranscriptSegment } from '#shared/types/meeting'
import { attestedChunkSchema, type AttestedChunk } from '../summary/reconcile'
import { EMBEDDING_DIMENSIONS } from '../qa/embedder'
import type { SlotProvider, SlotState } from './slots'
import type { EmbeddedWindow, IndexMarker } from './windows'

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
  /** A result is stored but failed its read-back check, so the chunk is redone with `redo`. */
  unusable: boolean
}

/** How much of a plan has a result. */
export interface ChunkCounts {
  done: number
  total: number
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
  /**
   * Claim the chunk even though it has a stored result, clearing it: the
   * result failed its read-back check ({@link SummaryChunk.unusable}).
   */
  redo?: boolean
  /**
   * Claim only if the meeting's `updatedAt` is still this. A caller deciding on
   * an earlier read -- a retry out of `failed`, whose status alone does not say
   * which failure it is, or how recent -- passes what it read.
   */
  expectedUpdatedAt?: string
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

/** One step's write to the transcript. */
export interface SegmentPage {
  /** Where this page starts. Given separately because a page can hold no segments. */
  fromIdx: number
  /** Numbered consecutively from `fromIdx`. */
  segments: readonly TranscriptSegment[]
  /** The run's cursor after this page. */
  cursor: Record<string, unknown>
}

/** One step's write to the search index. */
export interface IndexBatch {
  /** What this step embedded. Empty when it found everything it planned already stored. */
  windows: readonly EmbeddedWindow[]
  /** The run's cursor after this batch. */
  cursor: Record<string, unknown>
  /** Which transcript and model this run indexes, for the marker. */
  textHash: string
  model: string
}

/** How `finishIndex` went. */
export type IndexFinish
  /** The marker says complete, and the step has ended. */
  = | 'complete'
    /** What is stored is not what this run planned. Nothing was written, and the step is still live. */
    | 'changed'
    /** The token is not live. Nothing was written. */
    | 'lost'

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
   * How much of a run's plan has a result, without reading a single result: the same
   * size of answer on any length of meeting, for deciding which step comes next and
   * reporting how far it has got. A stored result is counted as it stands, whether or not
   * it would pass {@link listChunks}'s check. That only moves a redo's turn in the
   * queue: the extraction step goes by `listChunks`.
   */
  countChunks(meetingId: string, runId: string): Promise<ChunkCounts>
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
  /**
   * Store one page of transcript and the cursor that says what comes next, and
   * end the step: everything from `fromIdx` on is replaced, so a retried page
   * replaces itself, and rows of an abandoned attempt past the new end go too.
   * False when `token` is not live or the meeting is no longer `transcribing`,
   * which is what keeps a finished transcript from ever being replaced.
   */
  appendSegments(meetingId: string, token: string, page: SegmentPage): Promise<boolean>
  /**
   * Finish transcription and end the step, all or nothing: a new summarization
   * run with this plan, and `transcribing` to `summarizing`. With `refusal`, no
   * plan is written and the meeting moves to `failed` for summarization
   * instead, since it is extraction that cannot go ahead. False when `token` is
   * not live or the meeting is no longer `transcribing`.
   */
  finishTranscription(meetingId: string, token: string, outcome: { chunks: readonly ChunkPlan[], refusal: string | null }): Promise<boolean>
  /**
   * Store one batch of embedded windows and the cursor after it, mark the index
   * incomplete, and end the step, all or nothing. Windows are replaced by index, each
   * under this batch's model; nothing else stored changes. False when `token` is not live.
   */
  upsertWindows(meetingId: string, token: string, batch: IndexBatch): Promise<boolean>
  /**
   * Mark the index complete and end the step, removing windows past the plan's end.
   * Only if the transcript still hashes to `textHash`, every one of the plan's
   * `windowCount` windows is stored under `model`, and the last reaches the transcript's
   * last line. See {@link IndexFinish}.
   */
  finishIndex(meetingId: string, token: string, plan: { textHash: string, model: string, windowCount: number }): Promise<IndexFinish>
  /** Remove the meeting's runs, chunks and index marker. Idempotent; a cascade on Supabase. */
  deleteForMeeting(meetingId: string): Promise<void>
  /**
   * The cron sweeper's one read: a meeting a step can be taken of now, or none, and which
   * providers cannot be asked right now. Moves the rotation on to the meeting it answers,
   * before anything else happens to it, and records that a tick ran, meeting or not.
   * One request, reading at most {@link SWEEP_POOL} of each kind of meeting.
   */
  nextForSweep(options: SweepOptions): Promise<SweepChoice>
  /**
   * The oldest meeting created more than `days` days ago with no live step, leaving out
   * `excludeId`, or null. Age is judged from `createdAt`, by the store's own clock. Deletes
   * nothing: `deleteMeeting` does that, and checks everything again (ADR-0017). One request.
   */
  nextExpired(options: { days: number, excludeId: string }): Promise<string | null>
}

/** What `nextForSweep` needs to be told. */
export interface SweepOptions {
  /** The current embedding model, since an index belongs to one. */
  model: string
  /** The public demo, which nothing moves. Null when no meeting is the demo. */
  excludeId: string | null
  /** The one error on an index's run that ends by itself, once its time has passed: the daily limit. */
  limitError: string
}

export interface SweepChoice {
  meetingId: string | null
  busy: SlotProvider[]
}

/**
 * Meetings of each kind `nextForSweep` looks at: those in progress that have waited longest,
 * and finished transcripts touched most recently. What keeps a tick's read the same size
 * however many meetings there are.
 */
export const SWEEP_POOL = 50

/** What {@link sweepCanMove} rests on: one meeting's rows, as it reads them. */
export interface SweepFacts {
  status: MeetingStatus
  failedStage: 'transcription' | 'summarization' | 'upload' | null
  runs: Partial<Record<PipelineStage, Pick<PipelineRun, 'cursor' | 'lastError' | 'retryAt' | 'stepLeaseUntil'>>>
  /** The current extraction run has a planned chunk with no result. */
  unfinishedChunk: boolean
  marker: Pick<IndexMarker, 'model' | 'complete'> | null
  hasLines: boolean
  hasWindows: boolean
  /** A window is stored under a model other than the current one. */
  hasOtherModelWindows: boolean
}

/** What `reserve_slot` would refuse at no wait, by provider. Whisper takes no slot, only a block. */
export function busyProviders(slots: Partial<Record<SlotProvider, SlotState>>, now: number): SlotProvider[] {
  return (['groq-chat', 'groq-whisper', 'workers-ai-embed'] as const).filter((provider) => {
    const slot = slots[provider]
    if (!slot) return false
    return (provider === 'groq-whisper' ? slot.blockedUntil : Math.max(slot.nextAvailableAt, slot.blockedUntil)) > now
  })
}

/**
 * Whether a step of this meeting can be taken now, with nobody watching. A deliberate mirror
 * of `public.sweep_can_move`, for the local driver, which `unattendedStep` decides the step
 * from what `GET .../pipeline` reads. They differ in one way on purpose: a complete marker
 * counts as settled here, because telling that it no longer adds up takes hashing the
 * transcript, and that is not a cost to pay for each meeting looked at.
 */
export function sweepCanMove(facts: SweepFacts, { model, limitError, busy, now }: Pick<SweepOptions, 'model' | 'limitError'> & { busy: readonly SlotProvider[], now: number }): boolean {
  const { status, failedStage, runs } = facts
  const waiting = (run: SweepFacts['runs'][PipelineStage]) =>
    (run?.stepLeaseUntil != null && run.stepLeaseUntil.getTime() > now) || (run?.retryAt != null && run.retryAt.getTime() > now)

  if (status === 'uploaded') return !busy.includes('groq-whisper')
  if (status === 'transcribing') {
    if (waiting(runs.transcription)) return false
    return (runs.transcription?.cursor as { reply?: unknown } | undefined)?.reply != null || !busy.includes('groq-whisper')
  }
  if (status === 'summarizing' || status === 'indexing') {
    if (!waiting(runs.summarization) && (!facts.unfinishedChunk || !busy.includes('groq-chat'))) return true
  }
  else if (status !== 'ready' && !(status === 'failed' && failedStage === 'summarization')) {
    return false
  }

  if (busy.includes('workers-ai-embed')) return false
  if (facts.marker?.complete || (facts.marker && facts.marker.model !== model)) return false
  const index = runs.search_index
  if (waiting(index)) return false
  if (index?.lastError != null && (index.lastError !== limitError || index.retryAt == null)) return false
  const pass = (index?.cursor as { pass?: { model?: string } } | undefined)?.pass
  if (pass?.model != null && pass.model !== model) return false
  if (facts.hasOtherModelWindows) return false
  return facts.hasLines || facts.hasWindows
}

/** Whether `row` comes after the meeting the rotation last chose, by when it was created and then its id. */
export function afterInRotation(row: { createdAt: string, id: string }, last: { createdAt: string, id: string } | null): boolean {
  if (!last) return true
  const created = Date.parse(row.createdAt) - Date.parse(last.createdAt)
  return created > 0 || (created === 0 && row.id > last.id)
}

/** Neither driver looks for anything with no age or no demo to leave out, alike: see `next_expired_meeting`. */
export function assertValidExpiry({ days, excludeId }: { days: number, excludeId: string }): void {
  if (!Number.isInteger(days) || days <= 0) throw new Error(`The days must be a positive whole number, got ${days}`)
  if (!excludeId) throw new Error('The public demo must be named')
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

/** The latest time `start_ms` and `end_ms` hold: Postgres's `integer`. */
export const MAX_SEGMENT_MS = 2_147_483_647

/** Refuse a page the transcript's gapless numbering or its columns could not hold; the SQL refuses alike. */
export function assertValidPage({ fromIdx, segments, cursor }: SegmentPage): void {
  if (!Number.isInteger(fromIdx) || fromIdx < 0) throw new Error(`A page must start at a segment index, got ${fromIdx}`)
  segments.forEach((s, i) => {
    if (s.idx !== fromIdx + i) throw new Error(`A page must be numbered consecutively from ${fromIdx}, got ${s.idx} at ${i}`)
    if (s.startMs > MAX_SEGMENT_MS || s.endMs > MAX_SEGMENT_MS || s.text.includes('\u0000') || !s.text.isWellFormed()) {
      throw new Error(`Segment ${s.idx} cannot be stored: its times or its text are out of range for the transcript's columns`)
    }
  })
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('The cursor must be a JSON object')
}

/** Refuse a batch the columns could not hold; the SQL refuses alike. */
export function assertValidIndexBatch({ windows, cursor, model }: IndexBatch): void {
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('The cursor must be a JSON object')
  for (const window of windows) {
    if (window.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Window ${window.idx} has a ${window.embedding.length}-dimension vector, expected ${EMBEDDING_DIMENSIONS}`)
    }
    if (window.model !== model) throw new Error(`Window ${window.idx} is ${window.model}'s, in a batch of ${model}'s`)
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
