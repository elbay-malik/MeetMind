import type { Meeting, MeetingStatus, MeetingSummary } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import type { MeetingRepository } from '../db/meetings'
import type { ClaimOptions, PipelineRepository, PipelineRun, ReleaseOutcome, StepClaim, SummaryChunk } from '../db/pipeline'
import type { SummaryRepository } from '../db/summaries'
import type { TranscriptRepository } from '../db/transcripts'
import { CHUNK_BUDGET_TOKENS } from './groq'
import { planChunks } from './plan'
import { mergeReconciled } from './reconcile'
import { SummarizationError, type Summarizer } from './summarizer'

/**
 * Extraction as a series of short steps (ADR-0012 §2): plan the chunks,
 * extract one chunk per step, then finalize. Each call does at most one step,
 * makes at most one provider request, and leaves everything it learned in the
 * run ledger, so the next call -- from this tab, another one, or after a crash
 * -- carries on from there.
 */

/** A chunk step's lease: above the provider's 90 s timeout. */
export const CHUNK_STEP_LEASE_MS = 3 * 60_000

/** Planning and finalizing make no provider call. */
export const SHORT_STEP_LEASE_MS = 60_000

/**
 * Claims of one chunk before the run fails. A killed attempt counts, since the
 * claim is what counts it; a slot miss or a 429 does not, since nothing was
 * spent (ADR §5).
 */
export const MAX_CHUNK_ATTEMPTS = 2

/**
 * Claims of a planning or finalizing step, in a row, before the run fails.
 * They make no provider call, so only a step that keeps dying or throwing --
 * a transcript too heavy to plan inside the CPU limit, say -- reaches it.
 */
export const MAX_STEP_ATTEMPTS = 3

/**
 * How long a chunk parks after a retryable failure. A provider error is spaced
 * by the slot ledger anyway, but a failure before any slot was reserved -- the
 * database refusing a read -- is not, and an instant retry would spend the
 * chunk's last attempt on the same blip.
 */
export const RETRYABLE_PARK_MS = 5_000

/** Provider 429s in a row on one chunk before the run fails. */
export const MAX_CONSECUTIVE_RATE_LIMITS = 3

/**
 * How long a failure must sit before it can be retried, unless the provider
 * asked for longer. A retry resumes at the failed chunk rather than starting
 * over, but it still goes straight back to the provider that just failed.
 */
export const RETRY_COOLDOWN_MS = 60_000

/**
 * A transcript needing more chunks than this is refused before any is sent.
 * Every chunk is a request against a per-minute allowance, so a run this long
 * would hold the account's quota for most of an hour.
 */
export const MAX_CHUNKS = 40

/**
 * How soon a caller refused by a live step asks again. A step usually ends long
 * before its lease does; the lease is only the bound for a step that died.
 */
export const LIVE_STEP_POLL_MS = 2_000

export interface ExtractionDeps {
  meetings: MeetingRepository
  pipeline: PipelineRepository
  transcripts: TranscriptRepository
  summaries: SummaryRepository
  summarizer: Summarizer
  now?: () => number
}

export interface ExtractionProgress {
  done: number
  total: number | null
  lastError: string | null
}

export type ExtractionOutcome
  = | { kind: 'done', meeting: Meeting, summary: MeetingSummary }
    | { kind: 'progress', meeting: Meeting, progress: ExtractionProgress, next: 'continue' | 'wait', retryAt: Date | null }
    /** The step failed the run; the meeting is now `failed`. */
    | { kind: 'failed', statusCode: number, statusMessage: string, message: string }
    /** Nothing was done: the meeting is missing, or not in a state to extract. */
    | { kind: 'refused', statusCode: 404 | 409, message: string }

/** What the run's cursor holds between steps. A type, not an interface, so it is a cursor record. */
type ExtractionCursor = {
  /** Provider 429s in a row on one chunk, so the third can end the run. */
  rateLimited?: { chunkNo: number, count: number }
}

/** Do the meeting's next extraction step, if one is runnable. */
export async function advanceExtraction(meetingId: string, deps: ExtractionDeps): Promise<ExtractionOutcome> {
  const now = deps.now ?? Date.now
  const meeting = await deps.meetings.get(meetingId)
  if (!meeting) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }

  if (meeting.status === 'ready') {
    const stored = await deps.summaries.getForMeeting(meetingId)
    if (stored) return { kind: 'done', meeting, summary: stored }
  }
  if (!transcriptionFinished(meeting)) {
    return { kind: 'refused', statusCode: 409, message: 'This meeting has no transcript to summarise yet' }
  }

  const steps = stepsFor(meetingId, deps, now)

  // Transcription leaves the plan ready (ADR-0012 §2), under a run of its own,
  // so the first extraction need not read the transcript back to make one. Such
  // a plan has no results yet, since the first chunk's claim leaves `summarizing`;
  // a plan that has them belongs to an earlier extraction and is not reused.
  if (meeting.status === 'summarizing') {
    const planned = await deps.pipeline.listChunks(meetingId)
    if (planned.length > 0 && planned.every(c => !c.result && !c.unusable)) {
      const run = (await deps.pipeline.listRuns(meetingId)).find(r => r.stage === 'summarization')
      return steps.next({ status: 'summarizing', moveTo: 'indexing' }, run)
    }
  }

  // A new run, planned from the transcript: from `summarizing` with no usable
  // stored plan, a transcript with no lines or one written before plans were
  // stored; from `ready` with no summary row, a repair. Either way an older run's chunks
  // are not reused.
  if (meeting.status === 'summarizing' || meeting.status === 'ready') {
    return steps.plan({ status: meeting.status, moveTo: 'indexing', newRun: true, leaseMs: SHORT_STEP_LEASE_MS })
  }

  const run = (await deps.pipeline.listRuns(meetingId)).find(r => r.stage === 'summarization')

  if (meeting.status === 'failed') {
    const waitMs = cooldownEnds(meeting, run) - now()
    if (waitMs > 0) return { kind: 'refused', statusCode: 409, message: cooldownMessage(waitMs) }
    // Resumes where the run failed: finished chunks are kept, and the failed
    // chunk starts its attempts over.
    return steps.next({ status: 'failed', moveTo: 'indexing', resetAttempts: true }, run)
  }

  // `indexing`: the run is in progress, or parked between steps.
  const parked = waitingOn(run, now())
  if (parked) return steps.progress(parked, run?.lastError ?? null)
  return steps.next({ status: 'indexing' }, run)
}

/** The moment a failed run may be retried: the cooldown, or the provider's own block if longer. */
export function cooldownEnds(meeting: Meeting, run: PipelineRun | undefined): number {
  return Math.max(Date.parse(meeting.updatedAt) + RETRY_COOLDOWN_MS, run?.retryAt?.getTime() ?? 0)
}

function cooldownMessage(waitMs: number): string {
  return `The last extraction failed recently; wait ${Math.max(1, Math.ceil(waitMs / 1000))}s before retrying`
}

/** When a caller should ask again, if the run cannot take a step now. */
export function waitingOn(run: PipelineRun | undefined, now: number): Date | null {
  if (run?.stepLeaseUntil && run.stepLeaseUntil.getTime() > now) {
    return new Date(Math.min(run.stepLeaseUntil.getTime(), now + LIVE_STEP_POLL_MS))
  }
  if (run?.retryAt && run.retryAt.getTime() > now) return run.retryAt
  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stepsFor(meetingId: string, deps: ExtractionDeps, now: () => number) {
  const { pipeline } = deps

  const release = (claim: StepClaim, outcome: ReleaseOutcome) =>
    pipeline.releaseStep(meetingId, 'summarization', claim.token, outcome)

  /** Give the claim back after an unexpected error, so the next caller need not wait out the lease. */
  async function releaseAfter(claim: StepClaim, err: unknown): Promise<never> {
    await release(claim, { error: errorMessage(err), retryAt: null }).catch(() => {})
    throw err
  }

  async function fail(claim: StepClaim, statusCode: number, statusMessage: string, message: string, extra: Partial<ReleaseOutcome> = {}): Promise<ExtractionOutcome> {
    const released = await release(claim, { error: message, retryAt: null, failFrom: 'indexing', ...extra })
    if (!released) return snapshot()
    return { kind: 'failed', statusCode, statusMessage, message }
  }

  async function progress(retryAt: Date | null, lastError: string | null, chunks?: SummaryChunk[]): Promise<ExtractionOutcome> {
    const meeting = await deps.meetings.get(meetingId)
    if (!meeting) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    const plan = chunks ?? await pipeline.listChunks(meetingId)
    return {
      kind: 'progress',
      meeting,
      progress: { done: plan.filter(c => c.result).length, total: plan.length || null, lastError },
      next: retryAt ? 'wait' : 'continue',
      retryAt,
    }
  }

  /**
   * Where things stand after this caller lost a race -- another caller took the
   * step, finished it, or failed the run -- so it reports that rather than
   * guessing.
   */
  async function snapshot(): Promise<ExtractionOutcome> {
    const meeting = await deps.meetings.get(meetingId)
    if (!meeting) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    if (meeting.status === 'ready') {
      const stored = await deps.summaries.getForMeeting(meetingId)
      if (stored) return { kind: 'done', meeting, summary: stored }
    }
    const run = (await pipeline.listRuns(meetingId)).find(r => r.stage === 'summarization')
    if (meeting.status === 'failed' && meeting.failedStage === 'summarization') {
      return { kind: 'refused', statusCode: 409, message: cooldownMessage(cooldownEnds(meeting, run) - now()) }
    }
    if (!['indexing', 'summarizing', 'ready'].includes(meeting.status)) {
      return { kind: 'refused', statusCode: 409, message: `Meeting is ${meeting.status}; it has no transcript ready to summarise` }
    }
    return progress(waitingOn(run, now()), run?.lastError ?? null)
  }

  async function claim(options: Omit<ClaimOptions, 'leaseMs'> & { leaseMs: number }): Promise<StepClaim | null> {
    return pipeline.claimStep(meetingId, 'summarization', options)
  }

  /** The step the current plan calls for: plan it, extract its first unfinished chunk, or finalize. */
  async function next(base: { status: MeetingStatus, moveTo?: MeetingStatus, resetAttempts?: boolean }, run: PipelineRun | undefined) {
    const chunks = await pipeline.listChunks(meetingId)
    const unfinished = chunks.find(c => !c.result)
    if (unfinished) {
      // `redo`: a stored result failed its read-back check, and the claim
      // would otherwise refuse the chunk as done -- forever.
      const options = { ...base, chunkNo: unfinished.chunkNo, redo: unfinished.unusable, leaseMs: CHUNK_STEP_LEASE_MS }
      return chunk(options, unfinished, chunks, run)
    }
    // No plan yet, or a plan with nothing in it: planning again keeps a plan
    // that exists, and finishes one that is empty.
    if (chunks.length === 0) return plan({ ...base, leaseMs: SHORT_STEP_LEASE_MS })
    return finalize({ ...base, leaseMs: SHORT_STEP_LEASE_MS })
  }

  /** A planning or finalizing step that keeps ending without finishing fails the run. */
  function overTried(claimed: StepClaim, what: string): Promise<ExtractionOutcome> | null {
    if (claimed.attempts <= MAX_STEP_ATTEMPTS) return null
    return fail(claimed, 500, 'Summarisation failed', `${what} kept stopping without finishing; try again later.`)
  }

  async function plan(options: ClaimOptions): Promise<ExtractionOutcome> {
    const claimed = await claim(options)
    if (!claimed) return snapshot()
    const exhausted = overTried(claimed, 'Planning the extraction')
    if (exhausted) return exhausted
    try {
      const segments = await deps.transcripts.listForMeeting(meetingId)
      const planned = planChunks(segments, CHUNK_BUDGET_TOKENS)
      // After claiming, so the failure is recorded: the transcript's length
      // does not change between attempts, and without a persisted `failed`
      // every later call would refuse the same way with nothing to show for it.
      if (planned.length > MAX_CHUNKS) {
        const message = `This transcript would need ${planned.length} sequential requests, over the ${MAX_CHUNKS} limit.`
        return fail(claimed, 413, 'Transcript too long', message)
      }
      const written = await pipeline.planChunks(meetingId, claimed.token, planned.map((c, chunkNo) => ({
        chunkNo,
        segFrom: c.segments[0]!.idx,
        segTo: c.segments.at(-1)!.idx,
        estTokens: c.estimatedTokens,
      })))
      if (!written) return snapshot()
      // The stored plan, which a retried planning step keeps as it was.
      const chunks = await pipeline.listChunks(meetingId)
      // A silent recording plans no chunks; there is nothing to wait for.
      if (chunks.length === 0) return finishUnder(claimed, chunks)
      if (!await release(claimed, { error: null, retryAt: null })) return snapshot()
      return progress(null, null, chunks)
    }
    catch (err) {
      return releaseAfter(claimed, err)
    }
  }

  async function chunk(options: ClaimOptions, target: SummaryChunk, chunks: SummaryChunk[], run: PipelineRun | undefined): Promise<ExtractionOutcome> {
    const claimed = await claim(options)
    if (!claimed) return snapshot()
    const label = `chunk ${target.chunkNo + 1} of ${chunks.length}`
    const cursor = claimed.cursor as ExtractionCursor
    const { rateLimited: _streak, ...cursorWithoutStreak } = cursor

    // Claims that ended without an answer -- killed mid-request, most likely --
    // count like failures, or a chunk that always kills its worker would be
    // claimed forever.
    if (claimed.attempts > MAX_CHUNK_ATTEMPTS) {
      return fail(claimed, 502, 'Summarisation failed',
        `Extraction of ${label} stopped without an answer ${MAX_CHUNK_ATTEMPTS} times.`, { cursor: cursorWithoutStreak })
    }

    let result
    try {
      const segments = await deps.transcripts.listRange(meetingId, target.segFrom, target.segTo)
      result = await deps.summarizer.summarizeChunk({ segments })
    }
    catch (err) {
      const failure = err instanceof SummarizationError ? err : null
      const message = errorMessage(err)
      try {
        if (failure?.hold?.kind === 'busy') {
          // Nothing was sent, so nothing changes but when to come back: the
          // last error stays, and so does a streak of 429s.
          const parked = await release(claimed, { error: run?.lastError ?? null, retryAt: failure.hold.retryAt, refundAttempt: true })
          return parked ? progress(failure.hold.retryAt, run?.lastError ?? null, chunks) : snapshot()
        }
        if (failure?.hold?.kind === 'rate-limited') {
          const count = cursor.rateLimited?.chunkNo === target.chunkNo ? cursor.rateLimited.count + 1 : 1
          const streak: ExtractionCursor = { ...cursorWithoutStreak, rateLimited: { chunkNo: target.chunkNo, count } }
          if (count >= MAX_CONSECUTIVE_RATE_LIMITS) {
            return fail(claimed, 429, 'Summarisation failed', message,
              { refundAttempt: true, retryAt: failure.hold.retryAt, cursor: cursorWithoutStreak })
          }
          const parked = await release(claimed, { error: message, retryAt: failure.hold.retryAt, refundAttempt: true, cursor: streak })
          return parked ? progress(failure.hold.retryAt, message, chunks) : snapshot()
        }
        // An error that is not the provider's own -- a database blip reading
        // the lines -- is worth one more attempt, like a 5xx.
        const retryable = failure ? failure.retryable : true
        if (retryable && claimed.attempts < MAX_CHUNK_ATTEMPTS) {
          const retryAt = new Date(now() + RETRYABLE_PARK_MS)
          const parked = await release(claimed, { error: message, retryAt, cursor: cursorWithoutStreak })
          return parked ? progress(retryAt, message, chunks) : snapshot()
        }
        return fail(claimed, failure?.statusCode ?? 500, 'Summarisation failed', message, { cursor: cursorWithoutStreak })
      }
      catch (releaseErr) {
        return releaseAfter(claimed, releaseErr)
      }
    }

    try {
      if (!await pipeline.recordChunk(meetingId, claimed.token, target, result)) return snapshot()
      return progress(null, null, chunks.map(c => c.chunkNo === target.chunkNo ? { ...c, result } : c))
    }
    catch (err) {
      return releaseAfter(claimed, err)
    }
  }

  async function finalize(options: ClaimOptions): Promise<ExtractionOutcome> {
    const claimed = await claim(options)
    if (!claimed) return snapshot()
    const exhausted = overTried(claimed, 'Saving the summary')
    if (exhausted) return exhausted
    try {
      const chunks = await pipeline.listChunks(meetingId)
      // A result that failed its re-check reads as missing: that chunk is
      // extracted again first.
      if (chunks.some(c => !c.result)) {
        if (!await release(claimed, { error: null, retryAt: null })) return snapshot()
        return progress(null, null, chunks)
      }
      return finishUnder(claimed, chunks)
    }
    catch (err) {
      return releaseAfter(claimed, err)
    }
  }

  /** Merge every chunk's result and write the summary with `ready`, under the claim. */
  async function finishUnder(claimed: StepClaim, chunks: SummaryChunk[]): Promise<ExtractionOutcome> {
    const { summary, decisions, actionItems } = mergeReconciled(chunks.map(c => c.result!))
    const written = await pipeline.finalizeSummary(meetingId, claimed.token, {
      summary, decisions, actionItems, provider: deps.summarizer.kind,
    })
    if (!written) return snapshot()
    const [meeting, stored] = await Promise.all([deps.meetings.get(meetingId), deps.summaries.getForMeeting(meetingId)])
    if (!meeting || !stored) return snapshot()
    return { kind: 'done', meeting, summary: stored }
  }

  return { next, plan, progress }
}
