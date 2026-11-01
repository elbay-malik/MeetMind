import type { Meeting, TranscriptSegment } from '#shared/types/meeting'
import { AUDIO_MIME, MAX_AUDIO_BYTES, whisperReplyKey } from '#shared/utils/meeting'
import type { MeetingRepository } from '../db/meetings'
import type { ClaimOptions, PipelineRepository, PipelineRun, ReleaseOutcome, StepClaim } from '../db/pipeline'
import type { SlotRepository } from '../db/slots'
import { RangeNotSatisfiableError, type AudioStore } from '../storage/audio-store'
import { CHUNK_BUDGET_TOKENS } from '../summary/groq'
import { closePlan, EMPTY_PLAN, extendPlan, type IncrementalPlan } from '../summary/plan'
import {
  cooldownEnds,
  MAX_CHUNKS,
  MAX_STEP_ATTEMPTS,
  RETRYABLE_PARK_MS,
  waitingOn,
} from '../summary/steps'
import { normalizeSegments } from './normalize'
import { INITIAL_SCAN, parseSegments, ReplyFormatError, scanWindow, type ScanState } from './reply-scanner'
import { TranscriptionError, type Transcriber } from './transcriber'

/**
 * Transcription as a series of short steps (ADR-0012 §2): one Whisper call whose
 * reply goes to storage unparsed, one step per page of that reply, and a last
 * step that hands the meeting to extraction with its plan already written. Each
 * call does at most one step, makes at most one provider request, and leaves
 * everything it learned in the run ledger, so the next call -- from this tab,
 * another one, or after a crash -- carries on from there.
 */

/** The Whisper step's lease: above the transcriber's 5 minute timeout. */
export const WHISPER_STEP_LEASE_MS = 7 * 60_000

/** A page or the last step makes no provider call. */
export const PAGE_STEP_LEASE_MS = 60_000

/**
 * Claims of the Whisper step before the run fails. Each may have spent audio
 * quota, so a step that keeps dying stops rather than spending it again. A
 * blocked provider or a 429 does not count.
 */
export const MAX_WHISPER_ATTEMPTS = 2

/** How much of the reply a page reads. */
export const PAGE_BYTES = 64 * 1024

/** A page stores at most this many segments, whatever fits in its window. */
export const SEGMENTS_PER_PAGE = 100

/**
 * The window a single segment may need. A page that holds no whole object
 * doubles its window up to here; a segment bigger than this is no transcript
 * line, and following it would make the page's work unbounded.
 */
export const MAX_PAGE_BYTES = 1024 * 1024

export interface TranscriptionDeps {
  meetings: MeetingRepository
  pipeline: PipelineRepository
  /** The store holding the audio, and the raw reply beside it. */
  store: Pick<AudioStore, 'get' | 'put' | 'openRange' | 'delete'>
  slots: Pick<SlotRepository, 'blockedUntil' | 'noteRateLimit'>
  transcriber: Transcriber
  now?: () => number
}

export interface TranscriptionProgress {
  done: number
  total: number | null
  segments: number
  lastError: string | null
}

export type TranscriptionOutcome
  /** The transcript is complete. The meeting may still be `failed`, when extraction refused the plan. */
  = | { kind: 'done', meeting: Meeting }
    | { kind: 'progress', meeting: Meeting, progress: TranscriptionProgress, next: 'continue' | 'wait', retryAt: Date | null }
    /** The step failed the run; the meeting is now `failed`. */
    | { kind: 'failed', statusCode: number, message: string, retryAt: Date | null }
    /** Nothing was done: the meeting is missing, or not in a state to transcribe. */
    | { kind: 'refused', statusCode: 404 | 409, message: string }

/** How far parsing has got. A type, not an interface, so it is a cursor record. */
type ReplyCursor = {
  /** What the Whisper step stored. A page that finds anything else is not reading this run's reply. */
  size: number
  etag: string | null
  byteOffset: number
  /** The window the next page reads: {@link PAGE_BYTES}, unless a segment needed more. */
  pageBytes: number
  scan: ScanState
  /** The array has closed; only the last step remains. */
  parsed: boolean
  nextIdx: number
  /** The last stored line's start, which the next page's lines may not come before. */
  lastStartMs: number
  plan: IncrementalPlan
}

type TranscriptionCursor = { reply?: ReplyCursor }

/** Past transcription, whatever happens next; `failed` for extraction is told apart where it matters. */
const PAST_TRANSCRIPTION: readonly Meeting['status'][] = ['summarizing', 'indexing', 'ready']

const STAGE = 'transcription'

/** Do the meeting's next transcription step, if one is runnable. */
export async function advanceTranscription(meetingId: string, deps: TranscriptionDeps): Promise<TranscriptionOutcome> {
  const now = deps.now ?? Date.now
  const meeting = await deps.meetings.get(meetingId)
  if (!meeting) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }

  // Before anything else, and before any claim: nothing below may touch a
  // transcript that is finished.
  if (PAST_TRANSCRIPTION.includes(meeting.status)) return { kind: 'done', meeting }

  const steps = stepsFor(meeting, deps, now)

  if (meeting.status === 'uploaded') {
    // `resetAttempts`, so the first Whisper call counts as attempt 1; a new run
    // would count it as 0, and allow one call more than it should.
    return steps.claimAndRun({ status: 'uploaded', moveTo: 'transcribing', resetAttempts: true, leaseMs: WHISPER_STEP_LEASE_MS })
  }
  if (meeting.status !== 'transcribing' && !(meeting.status === 'failed' && meeting.failedStage === 'transcription')) {
    return { kind: 'refused', statusCode: 409, message: whyNotTranscribable(meeting) }
  }

  const run = (await deps.pipeline.listRuns(meetingId)).find(r => r.stage === STAGE)

  if (meeting.status === 'failed') {
    const waitMs = cooldownEnds(meeting, run) - now()
    if (waitMs > 0) return { kind: 'refused', statusCode: 409, message: cooldownMessage(waitMs) }
    // Resumes from the cursor: a page that failed does not spend Whisper again.
    // Only from the failure checked above: another caller may have finished the
    // transcript since, leaving the status `failed` for extraction's reasons, or
    // failed again and restarted the cooldown.
    return steps.claimAndRun({ status: 'failed', moveTo: 'transcribing', resetAttempts: true, leaseMs: leaseFor(run), expectedUpdatedAt: meeting.updatedAt })
  }

  const parked = waitingOn(run, now())
  if (parked) return steps.progress(parked, run)
  return steps.claimAndRun({ status: 'transcribing', leaseMs: leaseFor(run) })
}

function leaseFor(run: PipelineRun | undefined): number {
  return (run?.cursor as TranscriptionCursor | undefined)?.reply ? PAGE_STEP_LEASE_MS : WHISPER_STEP_LEASE_MS
}

function cooldownMessage(waitMs: number): string {
  return `The last transcription attempt failed recently; wait ${Math.max(1, Math.ceil(waitMs / 1000))}s before retrying`
}

/** An accurate reason a meeting cannot be transcribed, rather than one that reads as "there is no audio" whatever the cause. */
function whyNotTranscribable(meeting: Meeting): string {
  // A summarisation failure leaves the transcript (and so the audio that
  // produced it) completely intact. "It has no audio ready" would be actively
  // wrong here: what is needed is retrying extraction, at POST .../summarize.
  if (meeting.status === 'failed' && meeting.failedStage === 'summarization') {
    return 'This meeting\'s transcript is already there; the failure was in extraction — retry summarisation, not transcription'
  }
  // The one genuinely terminal failure: verification deleted the object, so
  // retrying here can only ever report the audio missing.
  if (meeting.status === 'failed' && meeting.failedStage === 'upload') {
    return 'The uploaded audio was rejected and removed, so there is nothing to transcribe; upload the recording again'
  }
  return `Meeting is ${meeting.status}; it has no audio ready to transcribe`
}

/**
 * A page's lines, numbered on from the pages before it, and in time order with
 * them. `normalizeSegments` sorts a page; the whole reply can no longer be
 * sorted, since no step holds all of it. A line that started before the last
 * page ended is moved up to where that page's last line started, rather than
 * break the order the player's binary search over `startMs` relies on.
 */
function continueFrom(page: TranscriptSegment[], reply: Pick<ReplyCursor, 'nextIdx' | 'lastStartMs'>): TranscriptSegment[] {
  return page.map((s) => {
    const startMs = Math.max(s.startMs, reply.lastStartMs)
    return { ...s, idx: s.idx + reply.nextIdx, startMs, endMs: Math.max(s.endMs, startMs) }
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Validators can come back quoted or not, depending on who reports them; the value is what identifies the bytes. */
function sameBytes(stored: { size: number, etag: string | null }, reply: ReplyCursor): boolean {
  if (stored.size !== reply.size) return false
  if (stored.etag === null || reply.etag === null) return true
  return stored.etag.replace(/"/g, '') === reply.etag.replace(/"/g, '')
}

function stepsFor(meeting: Meeting, deps: TranscriptionDeps, now: () => number) {
  const { pipeline, store } = deps
  const meetingId = meeting.id
  const replyKey = whisperReplyKey(meetingId)

  const release = (claim: StepClaim, outcome: ReleaseOutcome) =>
    pipeline.releaseStep(meetingId, STAGE, claim.token, outcome)

  /** Give the claim back after an unexpected error, so the next caller need not wait out the lease. */
  async function releaseAfter(claim: StepClaim, err: unknown): Promise<never> {
    await release(claim, { error: errorMessage(err), retryAt: null }).catch(() => {})
    throw err
  }

  async function fail(claim: StepClaim, statusCode: number, message: string, extra: Partial<ReleaseOutcome> = {}): Promise<TranscriptionOutcome> {
    const released = await release(claim, { error: message, retryAt: null, failFrom: 'transcribing', ...extra })
    if (!released) return snapshot()
    return { kind: 'failed', statusCode, message, retryAt: extra.retryAt ?? null }
  }

  async function progress(retryAt: Date | null, run: Pick<PipelineRun, 'cursor' | 'lastError'> | undefined): Promise<TranscriptionOutcome> {
    const current = await deps.meetings.get(meetingId)
    if (!current) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    const reply = (run?.cursor as TranscriptionCursor | undefined)?.reply
    return {
      kind: 'progress',
      meeting: current,
      progress: {
        done: reply?.byteOffset ?? 0,
        total: reply?.size ?? null,
        segments: reply?.nextIdx ?? 0,
        lastError: run?.lastError ?? null,
      },
      next: retryAt ? 'wait' : 'continue',
      retryAt,
    }
  }

  /**
   * Where things stand after this caller lost a race -- another caller took the
   * step, finished it, or failed the run -- so it reports that rather than
   * guessing.
   */
  async function snapshot(): Promise<TranscriptionOutcome> {
    const current = await deps.meetings.get(meetingId)
    if (!current) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    if (PAST_TRANSCRIPTION.includes(current.status)) return { kind: 'done', meeting: current }
    const run = (await pipeline.listRuns(meetingId)).find(r => r.stage === STAGE)
    if (current.status === 'failed' && current.failedStage === 'transcription') {
      return { kind: 'refused', statusCode: 409, message: cooldownMessage(cooldownEnds(current, run) - now()) }
    }
    if (current.status !== 'transcribing') return { kind: 'refused', statusCode: 409, message: whyNotTranscribable(current) }
    return progress(waitingOn(run, now()), run)
  }

  /** The step the cursor calls for, read from the claim: a caller's earlier read may be out of date. */
  async function claimAndRun(options: ClaimOptions): Promise<TranscriptionOutcome> {
    const claimed = await pipeline.claimStep(meetingId, STAGE, options)
    if (!claimed) return snapshot()
    const reply = (claimed.cursor as TranscriptionCursor).reply
    if (reply) return reply.parsed ? finish(claimed, reply) : page(claimed, reply)
    // The run went back to needing Whisper since this caller looked, and a page's
    // lease would let another caller re-claim the step part-way through the call
    // and spend the quota twice. Claim again with the right lease.
    if (options.leaseMs < WHISPER_STEP_LEASE_MS) {
      await release(claimed, { error: null, retryAt: null, refundAttempt: true })
      return snapshot()
    }
    return whisper(claimed)
  }

  /**
   * A step failed. A provider's 429 fails the run at once, for its cooldown, and
   * its Retry-After lengthens that cooldown. A retryable failure parks for
   * another attempt; once those run out, or when retrying cannot help, the run
   * fails. An error that is not the provider's own -- storage or the database
   * blipping -- counts as retryable.
   */
  async function stepFailed(claimed: StepClaim, err: unknown, maxAttempts: number): Promise<TranscriptionOutcome> {
    const failure = err instanceof TranscriptionError ? err : null
    const message = errorMessage(err)
    try {
      if (failure?.statusCode === 429) {
        const retryAt = failure.retryAfterMs === null ? null : new Date(now() + failure.retryAfterMs)
        if (failure.retryAfterMs !== null) {
          // Best effort: the 429 is what the caller must see, and the run's own
          // retryAt below keeps this meeting off the provider either way.
          await deps.slots.noteRateLimit('groq-whisper', failure.retryAfterMs)
            .catch(noteErr => console.warn('[meetmind] could not record a provider rate limit:', noteErr))
        }
        return await fail(claimed, 429, message, { retryAt, refundAttempt: true })
      }
      const retryable = failure ? failure.retryable : true
      if (retryable && claimed.attempts < maxAttempts) {
        const retryAt = new Date(now() + RETRYABLE_PARK_MS)
        if (!await release(claimed, { error: message, retryAt })) return snapshot()
        const run = (await pipeline.listRuns(meetingId)).find(r => r.stage === STAGE)
        return progress(retryAt, run)
      }
      return await fail(claimed, failure?.statusCode ?? 500, message)
    }
    catch (releaseErr) {
      return releaseAfter(claimed, releaseErr)
    }
  }

  /** Best effort: the delete path and the bucket's lifecycle rule both remove one left behind. */
  async function deleteReply(): Promise<void> {
    await store.delete(replyKey).catch(err => console.warn('[meetmind] could not delete a raw transcription reply:', err))
  }

  /**
   * A step that lost its token can still have just stored a reply, since R2 has
   * no write fence. That object is dead once the meeting is gone or past
   * transcription, and nothing else would remove it. Short of that, another step
   * may be reading it.
   */
  async function replyHasNoReader(): Promise<boolean> {
    const current = await deps.meetings.get(meetingId)
    if (!current) return true
    return PAST_TRANSCRIPTION.includes(current.status) || (current.status === 'failed' && current.failedStage !== STAGE)
  }

  /** The one provider call: its reply goes to storage as it came, and the first page starts from there. */
  async function whisper(claimed: StepClaim): Promise<TranscriptionOutcome> {
    // Claims that ended without an answer -- killed mid-request, most likely --
    // count like failures, or a step that always kills its worker would keep
    // spending audio quota forever.
    if (claimed.attempts > MAX_WHISPER_ATTEMPTS) {
      return fail(claimed, 502, `Transcription stopped without an answer ${MAX_WHISPER_ATTEMPTS} times.`)
    }
    try {
      // Another meeting's 429 applies to this one too: the allowance is the
      // account's. Nothing is sent, so nothing is spent.
      const blocked = await deps.slots.blockedUntil('groq-whisper')
      if (blocked) {
        if (!await release(claimed, { error: null, retryAt: blocked, refundAttempt: true })) return await snapshot()
        return await progress(blocked, undefined)
      }

      const audio = await store.get(meeting.audioKey, MAX_AUDIO_BYTES)
      if (!audio) throw new TranscriptionError('The meeting audio is missing from storage', 409, false)
      // The object changed after we verified it at upload.
      if (audio.size !== meeting.audioBytes) {
        throw new TranscriptionError(`Stored audio is ${audio.size} bytes, expected ${meeting.audioBytes}`, 409, false)
      }

      const bytes = await deps.transcriber.transcribe({ bytes: audio.bytes, contentType: audio.contentType ?? AUDIO_MIME })
      const { etag } = await store.put(replyKey, bytes, 'application/json')
      const cursor: TranscriptionCursor = {
        reply: {
          size: bytes.byteLength,
          etag,
          byteOffset: 0,
          pageBytes: PAGE_BYTES,
          scan: INITIAL_SCAN,
          parsed: false,
          nextIdx: 0,
          lastStartMs: 0,
          plan: EMPTY_PLAN,
        },
      }
      // Index 0 clears whatever an earlier attempt of this run left behind.
      if (!await pipeline.appendSegments(meetingId, claimed.token, { fromIdx: 0, segments: [], cursor })) {
        const outcome = await snapshot()
        if (await replyHasNoReader()) await deleteReply()
        return outcome
      }
      return await progress(null, { cursor, lastError: null })
    }
    catch (err) {
      return stepFailed(claimed, err, MAX_WHISPER_ATTEMPTS)
    }
  }

  /** The reply this run was reading is not there. Failing rather than re-sending, so a repeat of this spends no quota by itself. */
  function replyLost(claimed: StepClaim, reason: string): Promise<TranscriptionOutcome> {
    return fail(claimed, 502, `${reason} Try transcription again.`, { cursor: {} })
  }

  /** One window of the reply: whole segments out of it, into the transcript and the plan. */
  async function page(claimed: StepClaim, reply: ReplyCursor): Promise<TranscriptionOutcome> {
    if (claimed.attempts > MAX_STEP_ATTEMPTS) {
      return fail(claimed, 500, 'Reading the transcription kept stopping without finishing; try again later.')
    }
    try {
      if (reply.byteOffset >= reply.size) {
        return await fail(claimed, 502, 'Transcription service returned a body we could not read: it ends early', { cursor: {} })
      }
      const end = reply.byteOffset + reply.pageBytes - 1
      let opened
      try {
        opened = await store.openRange(replyKey, { start: reply.byteOffset, end })
      }
      catch (err) {
        if (err instanceof RangeNotSatisfiableError) return await replyLost(claimed, 'The stored transcription reply changed.')
        throw err
      }
      if (!opened) return await replyLost(claimed, 'The stored transcription reply is gone.')
      if (!sameBytes(opened, reply)) {
        await opened.body.cancel().catch(() => {})
        return await replyLost(claimed, 'The stored transcription reply changed.')
      }
      const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer())

      const scanned = scanWindow(bytes, reply.scan, {
        atEnd: reply.byteOffset + bytes.byteLength >= reply.size,
        maxObjects: SEGMENTS_PER_PAGE,
      })
      if (scanned.consumed === 0 && scanned.objects.length === 0 && !scanned.finished) {
        return await widen(claimed, reply)
      }

      const segments = continueFrom(normalizeSegments(parseSegments(scanned.objects)), reply)

      const cursor: TranscriptionCursor = {
        reply: {
          ...reply,
          byteOffset: reply.byteOffset + scanned.consumed,
          pageBytes: PAGE_BYTES,
          scan: scanned.state,
          parsed: scanned.finished,
          nextIdx: reply.nextIdx + segments.length,
          lastStartMs: segments.at(-1)?.startMs ?? reply.lastStartMs,
          plan: extendPlan(reply.plan, segments, CHUNK_BUDGET_TOKENS, MAX_CHUNKS),
        },
      }
      const written = await pipeline.appendSegments(meetingId, claimed.token, { fromIdx: reply.nextIdx, segments, cursor })
      if (!written) return await snapshot()
      return await progress(null, { cursor, lastError: null })
    }
    catch (err) {
      // Asking again is the only fix, so the next attempt starts at Whisper. Not
      // automatically: it spends quota, and the same reply may come back.
      if (err instanceof ReplyFormatError) return fail(claimed, 502, err.message, { cursor: {} })
      return stepFailed(claimed, err, MAX_STEP_ATTEMPTS)
    }
  }

  /** The window held no whole object: the next page reads a larger one, up to a limit. */
  async function widen(claimed: StepClaim, reply: ReplyCursor): Promise<TranscriptionOutcome> {
    if (reply.pageBytes >= MAX_PAGE_BYTES) {
      return fail(claimed, 502, 'Transcription service returned an unexpected response: a segment is too large', { cursor: {} })
    }
    const cursor: TranscriptionCursor = { reply: { ...reply, pageBytes: Math.min(reply.pageBytes * 2, MAX_PAGE_BYTES) } }
    if (!await pipeline.appendSegments(meetingId, claimed.token, { fromIdx: reply.nextIdx, segments: [], cursor })) return snapshot()
    return progress(null, { cursor, lastError: null })
  }

  /** Write the plan and move on, in one transaction; the reply is then no longer needed. */
  async function finish(claimed: StepClaim, reply: ReplyCursor): Promise<TranscriptionOutcome> {
    if (claimed.attempts > MAX_STEP_ATTEMPTS) {
      return fail(claimed, 500, 'Saving the transcript kept stopping without finishing; try again later.')
    }
    try {
      const plan = closePlan(reply.plan, MAX_CHUNKS)
      // The transcript is complete and stays; it is extraction that cannot go
      // ahead, and a retry there refuses the same way, as it always has.
      const refusal = plan.count > MAX_CHUNKS
        ? `This transcript would need ${plan.count} sequential requests, over the ${MAX_CHUNKS} limit.`
        : null
      const chunks = refusal === null ? plan.chunks.map((c, chunkNo) => ({ chunkNo, ...c })) : []
      if (!await pipeline.finishTranscription(meetingId, claimed.token, { chunks, refusal })) return await snapshot()
    }
    catch (err) {
      return stepFailed(claimed, err, MAX_STEP_ATTEMPTS)
    }
    // After the commit, when nothing can need it any more.
    await deleteReply()
    const current = await deps.meetings.get(meetingId)
    if (!current) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    return { kind: 'done', meeting: current }
  }

  return { claimAndRun, progress }
}
