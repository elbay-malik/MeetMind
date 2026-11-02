import type { SearchIndexStatus } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import type { MeetingRepository } from '../db/meetings'
import type { PipelineRepository, ReleaseOutcome, StepClaim } from '../db/pipeline'
import type { SlotRepository } from '../db/slots'
import type { TranscriptRepository } from '../db/transcripts'
import { readyWindowCount, type IndexState, type TranscriptIndexRepository } from '../db/windows'
import { RETRY_COOLDOWN_MS, RETRYABLE_PARK_MS, waitingOn } from '../summary/steps'
import {
  DAILY_LIMIT_MESSAGE,
  EmbeddingError,
  EmbeddingInputTooLongError,
  planEmbeddingBatches,
  type Embedder,
} from './embedder'
import { planWindowSlice, type TranscriptWindow } from './windows'

/**
 * Indexing as a series of short steps (ADR-0012 §2): each call plans the next windows
 * from one page of the transcript, embeds the ones not already stored, and stores them
 * with the cursor after them. A last step checks it all adds up and marks the index
 * complete. Each call does at most one step and makes at most one provider request, so
 * the next call -- from this tab, another one, or after a crash -- carries on from there.
 *
 * Indexing never touches the meeting's status (ADR-0012 §5): whatever happens here, the
 * transcript and the summary go on as they were, and the run parks.
 */

/**
 * Windows one step may plan and embed. Not measured on Workers: ADR-0014 has the local
 * numbers, and this is the setting to shrink if a step measures over its 10 ms of CPU.
 * The batch also stays within `MAX_BATCH_TOKENS`, which 16 windows at the full budget
 * would not.
 */
export const INDEX_BATCH = 16

/**
 * Lines a step reads to plan its windows. A window is usually about 10 lines, so this
 * covers `INDEX_BATCH` of them with some to spare, and shorter lines just mean fewer
 * windows a step.
 */
export const INDEX_PAGE_SEGMENTS = 256

/**
 * The most lines a step reads, when one window needs more than a page. Every line with
 * text costs at least 5 tokens, so a window closes within about 300 lines. Past this
 * is no transcript, and following it would make the step's work unbounded. At
 * PostgREST's default row cap, which `listFrom` could not read past in one request.
 */
export const MAX_INDEX_PAGE_SEGMENTS = 1000

/** A step's lease: above the embedder's 30 s timeout, with one attempt per step. */
export const INDEX_STEP_LEASE_MS = 60_000

/**
 * Claims of one batch before the run parks for {@link RETRY_COOLDOWN_MS}. Each may have
 * spent quota, so a step that keeps dying stops rather than spending it again. A slot
 * miss, a block or a refusal does not count.
 */
export const MAX_INDEX_ATTEMPTS = 2

/** Passes in a row finished by finding that the stored windows do not add up. */
export const MAX_INDEX_RESTARTS = 2

export interface IndexingDeps {
  meetings: Pick<MeetingRepository, 'get'>
  pipeline: PipelineRepository
  transcripts: Pick<TranscriptRepository, 'listFrom'>
  index: Pick<TranscriptIndexRepository, 'readState' | 'listKeys'>
  slots: Pick<SlotRepository, 'reserve' | 'blockedUntil' | 'noteRateLimit'>
  embedder: Embedder
  /** Minimum gap between embedding requests, through the slot ledger. */
  embedIntervalMs: number
  now?: () => number
}

export interface IndexingProgress {
  /** Windows of the plan this run has dealt with: embedded, or found stored. */
  done: number
  /** How many the plan holds, once the run has reached its end; null until then. */
  total: number | null
  lastError: string | null
}

export type IndexingOutcome
  = | { kind: 'done', index: SearchIndexStatus }
    | { kind: 'progress', progress: IndexingProgress, next: 'continue' | 'wait', retryAt: Date | null }
    /**
     * This request could not move the run on, and the caller should be told why rather
     * than wait: the daily limit, a refusal, or a run that keeps stopping. Everything
     * stored stays stored. `resumes` says whether trying again can help.
     */
    | { kind: 'failed', statusCode: number, message: string, retryAt: Date | null, resumes: boolean }
    /** Nothing was done: the meeting is missing, or has no finished transcript. */
    | { kind: 'refused', statusCode: 404 | 409, message: string }

/** How far one pass over the transcript has got. A type, not an interface, so it is a cursor record. */
type IndexPass = {
  /** What this pass is an index of. A pass for anything else is over. */
  textHash: string
  model: string
  /** The next window's index in the whole plan, and the line it starts at. */
  nextWindow: number
  nextSegment: number
  /** How many lines the next step reads: {@link INDEX_PAGE_SEGMENTS}, unless a window needed more. */
  pageSegments: number
  /** The plan has ended; only the last step remains. */
  planned: boolean
}

type IndexCursor = {
  pass?: IndexPass
  /** Passes in a row the last step refused. */
  restarts?: number
  /** The claim count when the run last parked, so {@link MAX_INDEX_ATTEMPTS} counts from there. */
  parkedAtAttempt?: number
}

/** What the caller and the run are told of a failure that is not the provider's. */
const INTERNAL_FAILURE_MESSAGE = 'Indexing hit a problem on the server.'

const STAGE = 'search_index'
const PROVIDER = 'workers-ai-embed'

function newPass(state: IndexState, model: string): IndexPass {
  return {
    textHash: state.transcriptHash,
    model,
    nextWindow: 0,
    nextSegment: 0,
    pageSegments: INDEX_PAGE_SEGMENTS,
    planned: false,
  }
}

/** Do the meeting's next indexing step, if one is runnable. */
export async function advanceIndexing(meetingId: string, deps: IndexingDeps): Promise<IndexingOutcome> {
  const now = deps.now ?? Date.now
  const { model } = deps.embedder

  const meeting = await deps.meetings.get(meetingId)
  if (!meeting) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
  if (!transcriptionFinished(meeting)) {
    return { kind: 'refused', statusCode: 409, message: `Meeting is ${meeting.status}; it has no finished transcript to index yet` }
  }

  const steps = stepsFor(meetingId, deps, now)

  const state = await deps.index.readState(meetingId, model)
  const ready = readyWindowCount(state, model)
  if (ready !== null) return steps.done(ready)

  const run = await steps.readRun()
  const parked = waitingOn(run, now())
  if (parked) {
    // A wait of hours is an answer, not something for a page to sit through. Said the
    // same way however many times it is asked, and nothing is sent.
    const live = run!.stepLeaseUntil !== null && run!.stepLeaseUntil.getTime() > now()
    if (!live && run!.lastError === DAILY_LIMIT_MESSAGE) {
      return { kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE, retryAt: parked, resumes: true }
    }
    return steps.progress(parked, (run!.cursor as IndexCursor).pass, run!.lastError)
  }

  // Whatever status the meeting is in: indexing needs a finished transcript and nothing
  // else, so it neither waits for extraction nor blocks it. Another stage moving the
  // status since the read above only refuses this claim, and the next call reads it anew.
  const claimed = await deps.pipeline.claimStep(meetingId, STAGE, { status: meeting.status, leaseMs: INDEX_STEP_LEASE_MS })
  if (!claimed) return steps.snapshot()
  // The limit has reset to have got here, and a slot miss must not bring its words back.
  const lastError = run?.lastError === DAILY_LIMIT_MESSAGE ? null : run?.lastError ?? null
  return steps.step(claimed, state, lastError)
}

function stepsFor(meetingId: string, deps: IndexingDeps, now: () => number) {
  const { pipeline, embedder } = deps
  const { model } = embedder

  const readRun = async () => (await pipeline.listRuns(meetingId)).find(r => r.stage === STAGE)
  const release = (claim: StepClaim, outcome: ReleaseOutcome) => pipeline.releaseStep(meetingId, STAGE, claim.token, outcome)
  const cursorOf = (claim: StepClaim) => claim.cursor as IndexCursor
  /** Claims of this batch since the run last parked. */
  const attemptsOf = (claim: StepClaim) => claim.attempts - (cursorOf(claim).parkedAtAttempt ?? 0)

  function done(windowCount: number): IndexingOutcome {
    return { kind: 'done', index: { state: 'ready', windowCount, indexedCount: windowCount, model } }
  }

  function progress(retryAt: Date | null, pass: IndexPass | undefined, lastError: string | null): IndexingOutcome {
    return {
      kind: 'progress',
      progress: { done: pass?.nextWindow ?? 0, total: pass?.planned ? pass.nextWindow : null, lastError },
      next: retryAt ? 'wait' : 'continue',
      retryAt,
    }
  }

  /** Where things stand after this caller lost a race, so it reports that rather than guessing. */
  async function snapshot(): Promise<IndexingOutcome> {
    if (!await deps.meetings.get(meetingId)) return { kind: 'refused', statusCode: 404, message: 'Meeting not found' }
    const run = await readRun()
    return progress(waitingOn(run, now()), (run?.cursor as IndexCursor | undefined)?.pass, run?.lastError ?? null)
  }

  /**
   * Stop asking for a while, and say so. There is no `failed` status to go to (ADR-0012
   * §5), so this is what keeps a step that always dies from spending quota for as long
   * as someone keeps asking.
   */
  async function park(claimed: StepClaim, statusCode: number, message: string, cursor?: IndexCursor): Promise<IndexingOutcome> {
    const retryAt = new Date(now() + RETRY_COOLDOWN_MS)
    const parkedCursor = cursor ?? { ...cursorOf(claimed), parkedAtAttempt: claimed.attempts }
    if (!await release(claimed, { error: message, retryAt, cursor: parkedCursor })) return snapshot()
    return { kind: 'failed', statusCode, message, retryAt, resumes: true }
  }

  /**
   * A step did not finish. The provider's daily limit parks the run until it resets. A
   * refusal goes back to whoever asked. Anything else is worth another attempt, a 5xx or
   * a database blip alike, until the attempts run out and the run parks.
   */
  async function stepFailed(claimed: StepClaim, err: unknown): Promise<IndexingOutcome> {
    const failure = err instanceof EmbeddingError ? err : null
    // A provider's message is written for visitors, with the credentials scrubbed. Our
    // own errors are not, and a database's can name its tables, so those stay in the log.
    if (!failure) console.warn('[meetmind] an indexing step failed:', err)
    const message = failure ? failure.message : INTERNAL_FAILURE_MESSAGE
    try {
      if (failure?.retryAt) {
        // Best effort: what the caller must see is the limit, and the run's own retryAt
        // keeps this meeting off the provider either way.
        await deps.slots.noteRateLimit(PROVIDER, Math.max(0, failure.retryAt.getTime() - now()))
          .catch(noteErr => console.warn('[meetmind] could not record a provider rate limit:', noteErr))
        if (!await release(claimed, { error: message, retryAt: failure.retryAt, refundAttempt: true })) return await snapshot()
        return { kind: 'failed', statusCode: failure.statusCode, message, retryAt: failure.retryAt, resumes: true }
      }
      if (failure && !failure.retryable) {
        if (!await release(claimed, { error: message, retryAt: null, refundAttempt: true })) return await snapshot()
        return {
          kind: 'failed',
          statusCode: failure.statusCode,
          message,
          retryAt: null,
          resumes: !(failure instanceof EmbeddingInputTooLongError),
        }
      }
      if (attemptsOf(claimed) < MAX_INDEX_ATTEMPTS) {
        const retryAt = new Date(now() + RETRYABLE_PARK_MS)
        if (!await release(claimed, { error: message, retryAt })) return await snapshot()
        return progress(retryAt, cursorOf(claimed).pass, message)
      }
      return await park(claimed, failure?.statusCode ?? 500, message)
    }
    catch (releaseErr) {
      // The release is what failed, so the lease is left to run out.
      console.warn('[meetmind] could not release an indexing step:', releaseErr)
      throw err
    }
  }

  /** The last step: every window stored, so say so, if it all adds up. */
  async function finish(claimed: StepClaim, pass: IndexPass): Promise<IndexingOutcome> {
    const outcome = await pipeline.finishIndex(meetingId, claimed.token, {
      textHash: pass.textHash,
      model,
      windowCount: pass.nextWindow,
    })
    if (outcome === 'lost') return snapshot()
    if (outcome === 'complete') return done(pass.nextWindow)
    // Not what this pass planned. A transcript replaced under it, most likely: go round
    // again from the start, which re-embeds only what no longer matches.
    const restarts = (cursorOf(claimed).restarts ?? 0) + 1
    if (restarts > MAX_INDEX_RESTARTS) {
      return park(claimed, 500, 'The stored passages do not add up to this transcript; indexing will try again later.', {})
    }
    if (!await release(claimed, { error: null, retryAt: null, refundAttempt: true, cursor: { restarts } })) return snapshot()
    return progress(null, undefined, null)
  }

  /** Store what this step did and the cursor after it, under the claim. */
  async function write(claimed: StepClaim, pass: IndexPass, next: IndexPass, windows: TranscriptWindow[] = [], vectors: number[][] = []): Promise<IndexingOutcome> {
    const { restarts } = cursorOf(claimed)
    const written = await pipeline.upsertWindows(meetingId, claimed.token, {
      windows: windows.map((window, k) => ({ ...window, model, embedding: vectors[k]! })),
      cursor: { pass: next, ...(restarts ? { restarts } : {}) },
      textHash: pass.textHash,
      model,
    })
    return written ? progress(null, next, null) : snapshot()
  }

  /** One page of the transcript: the next windows, the ones not stored embedded and stored. */
  async function batch(claimed: StepClaim, pass: IndexPass, lastError: string | null): Promise<IndexingOutcome> {
    const page = await deps.transcripts.listFrom(meetingId, pass.nextSegment, pass.pageSegments)
    const slice = await planWindowSlice(page.segments, {
      firstWindowIdx: pass.nextWindow,
      atEnd: !page.more,
      maxWindows: INDEX_BATCH,
    })

    // The page ended inside its first window: read a larger one, up to a limit.
    if (slice.windows.length === 0 && !slice.finished) {
      if (pass.pageSegments >= MAX_INDEX_PAGE_SEGMENTS) {
        const message = `A passage in this transcript runs past ${MAX_INDEX_PAGE_SEGMENTS} lines, too long to index for questions. Its transcript and summary are not affected.`
        if (!await release(claimed, { error: message, retryAt: null, refundAttempt: true })) return snapshot()
        return { kind: 'failed', statusCode: 422, message, retryAt: null, resumes: false }
      }
      return write(claimed, pass, { ...pass, pageSegments: Math.min(pass.pageSegments * 2, MAX_INDEX_PAGE_SEGMENTS) })
    }

    // Skip what is already paid for: a resumed run, or a meeting indexed before this.
    const planned = slice.windows
    const stored = planned.length === 0
      ? []
      : await deps.index.listKeys(meetingId, { from: planned[0]!.idx, to: planned.at(-1)!.idx })
    const hashes = new Map(stored.filter(key => key.model === model).map(key => [key.idx, key.contentHash]))
    const pending = planned.filter(window => hashes.get(window.idx) !== window.contentHash)

    // One provider request, within the count and the tokens: the same split the driver
    // applies, so what is sent here is not split again there.
    const embedding = pending.length === 0 ? [] : planEmbeddingBatches(pending, window => window.text)[0]!
    const stoppedAt = pending[embedding.length]
    const next: IndexPass = stoppedAt
      ? { ...pass, nextWindow: stoppedAt.idx, nextSegment: stoppedAt.firstSegmentIdx, pageSegments: INDEX_PAGE_SEGMENTS }
      : {
          ...pass,
          nextWindow: pass.nextWindow + planned.length,
          nextSegment: slice.nextSegmentIdx ?? pass.nextSegment,
          pageSegments: INDEX_PAGE_SEGMENTS,
          planned: slice.finished,
        }

    if (embedding.length === 0) return write(claimed, pass, next)

    // Never sent during a block, whichever meeting's request caused it: the allowance
    // is the account's. Reserving reads the block as well, so a free slot costs no more.
    const slot = await deps.slots.reserve(PROVIDER, { intervalMs: deps.embedIntervalMs, maxWaitMs: 0 })
    if (!slot.granted) {
      const blocked = await deps.slots.blockedUntil(PROVIDER)
      if (blocked) {
        if (!await release(claimed, { error: DAILY_LIMIT_MESSAGE, retryAt: blocked, refundAttempt: true })) return snapshot()
        return { kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE, retryAt: blocked, resumes: true }
      }
      // Nothing was sent, so nothing changes but when to come back.
      if (!await release(claimed, { error: lastError, retryAt: slot.retryAt, refundAttempt: true })) return snapshot()
      return progress(slot.retryAt, pass, lastError)
    }

    const vectors = await embedder.embedDocuments(embedding.map(window => window.text))
    return write(claimed, pass, next, embedding, vectors)
  }

  /** The step the cursor calls for. */
  async function step(claimed: StepClaim, state: IndexState, lastError: string | null): Promise<IndexingOutcome> {
    // Claims that ended without an answer -- killed mid-request, most likely -- count
    // like failures, or a step that always kills its worker would spend quota for ever.
    if (attemptsOf(claimed) > MAX_INDEX_ATTEMPTS) {
      return park(claimed, 502, `Indexing stopped without an answer ${MAX_INDEX_ATTEMPTS} times; it will try again later.`)
    }
    try {
      // Over as soon as it is known to be for something else: indexing goes on from the
      // start, and the stored windows that still match cost nothing.
      const { pass: stored } = cursorOf(claimed)
      const pass = stored?.textHash === state.transcriptHash && stored.model === model ? stored : newPass(state, model)
      return await (pass.planned ? finish(claimed, pass) : batch(claimed, pass, lastError))
    }
    catch (err) {
      return stepFailed(claimed, err)
    }
  }

  return { done, progress, readRun, snapshot, step }
}
