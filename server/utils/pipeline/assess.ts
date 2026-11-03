import type { Meeting, PipelineResponse } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import type { MeetingRepository } from '../db/meetings'
import type { ChunkCounts, PipelineRepository, PipelineRun, PipelineStage } from '../db/pipeline'
import type { SlotProvider } from '../db/slots'
import { readyWindowCount, type IndexState, type TranscriptIndexRepository } from '../db/windows'
import { DAILY_LIMIT_MESSAGE, DAILY_RESET_MARGIN_MS } from '../qa/embedder'
import { holdsPassOfAnotherModel, indexProgress, unattendedMayIndex } from '../qa/steps'
import { cooldownEnds, refusedAsTooLong, waitingOn } from '../summary/steps'
import { audioIsGone, replyProgress } from '../transcription/steps'

/**
 * What a meeting's pipeline should do next, from what is stored and nothing else (ADR-0012
 * §2): the same answer for `POST .../advance`, which then takes the step, and for
 * `GET .../pipeline`, which does not. Pure, so its table can be read and tested row by row.
 */

/**
 * The longest a driver is told to sit through for the index alone. Past this it is told it
 * is done for now: a page sleeping until 00:00 UTC is mostly a page that has been closed,
 * and the meeting can already be read. A refusal in the minutes just after the daily limit
 * resets parks for at most this, so that one is still waited out.
 */
export const LONGEST_INDEX_WAIT_MS = DAILY_RESET_MARGIN_MS

/** One step, of the three kinds that exist. */
export type PipelineStep = 'transcription' | 'extraction' | 'indexing'

/** Everything the decision rests on. Each part is one read of constant size. */
export interface PipelineSnapshot {
  meeting: Meeting
  runs: readonly PipelineRun[]
  /** The current extraction run's plan. All zero when no plan is relevant or written. */
  chunks: ChunkCounts
  /** Null until there is a finished transcript to index. */
  index: IndexState | null
}

export interface PipelineReadDeps {
  meetings: Pick<MeetingRepository, 'get'>
  pipeline: Pick<PipelineRepository, 'listRuns' | 'countChunks'>
  index: Pick<TranscriptIndexRepository, 'readState'>
}

const NO_CHUNKS: ChunkCounts = { done: 0, total: 0 }

/** Extraction has a plan worth counting only while it is going on or stopped. */
function extractionInProgress(meeting: Pick<Meeting, 'status' | 'failedStage'>): boolean {
  return meeting.status === 'summarizing'
    || meeting.status === 'indexing'
    || (meeting.status === 'failed' && meeting.failedStage === 'summarization')
}

/**
 * Read what deciding takes: at most 5 subrequests on any length of meeting. The meeting and
 * its run rows are one each, the index state one (the hashing is in the database), and the
 * chunk counts are two HEADs, only while extraction is going on. Null when there is no
 * such meeting.
 */
export async function readPipeline(meetingId: string, model: string, deps: PipelineReadDeps): Promise<PipelineSnapshot | null> {
  const meeting = await deps.meetings.get(meetingId)
  if (!meeting) return null
  const runs = await deps.pipeline.listRuns(meetingId)
  const extraction = runs.find(run => run.stage === 'summarization')
  const [chunks, index] = await Promise.all([
    extraction && extractionInProgress(meeting) ? deps.pipeline.countChunks(meetingId, extraction.runId) : NO_CHUNKS,
    transcriptionFinished(meeting) ? deps.index.readState(meetingId, model) : null,
  ])
  return { meeting, runs, chunks, index }
}

/** Where one stage stands. */
type Turn
  /** No step of this stage belongs here: it has finished, or its turn has not come. */
  = | { kind: 'nothing' }
    /** A step can be taken now. */
    | { kind: 'run' }
    /** A failure whose cooldown is over: table row 1. */
    | { kind: 'retry' }
    /** Every chunk has its result, so only writing the summary is left: table row 5. */
    | { kind: 'finalize' }
    /** A step is in flight, or the run is parked, until then. */
    | { kind: 'waiting', until: Date }
    /** A failure, retryable from `until`, or by no one when that is null. */
    | { kind: 'failed', until: Date | null }

type IndexTurn
  = | Extract<Turn, { kind: 'run' | 'waiting' }>
    | { kind: 'unavailable' | 'complete' | 'held' | 'stopped' }
    | { kind: 'parked', until: Date }

const runOf = (runs: readonly PipelineRun[], stage: PipelineStage) => runs.find(run => run.stage === stage)

function failedTurn(meeting: Meeting, run: PipelineRun | undefined, now: number, permanent: boolean): Turn {
  if (permanent) return { kind: 'failed', until: null }
  const ends = cooldownEnds(meeting, run)
  return now >= ends ? { kind: 'retry' } : { kind: 'failed', until: new Date(ends) }
}

function transcriptionTurn({ meeting, runs }: PipelineSnapshot, now: number): Turn {
  const run = runOf(runs, 'transcription')
  if (meeting.status === 'uploaded') return { kind: 'run' }
  if (meeting.status === 'transcribing') {
    const until = waitingOn(run, now)
    return until ? { kind: 'waiting', until } : { kind: 'run' }
  }
  if (meeting.status === 'failed' && meeting.failedStage === 'transcription') {
    return failedTurn(meeting, run, now, audioIsGone(meeting))
  }
  return { kind: 'nothing' }
}

function extractionTurn({ meeting, runs, chunks }: PipelineSnapshot, now: number): Turn {
  const run = runOf(runs, 'summarization')
  if (meeting.status === 'failed' && meeting.failedStage === 'summarization') {
    return failedTurn(meeting, run, now, refusedAsTooLong(meeting))
  }
  // `ready` is left out on purpose, summary row or not. A `ready` meeting with no summary
  // row is repaired by an explicit POST .../summarize, not by a page opening it.
  if (!extractionInProgress(meeting)) return { kind: 'nothing' }
  // What a slot miss leaves, as well as a step in flight or a failure's short park. So
  // "if a slot is free now" costs a claim once per gap, and then no reads at all.
  const until = waitingOn(run, now)
  if (until) return { kind: 'waiting', until }
  return chunks.total > 0 && chunks.done === chunks.total ? { kind: 'finalize' } : { kind: 'run' }
}

function indexTurn({ runs, index }: PipelineSnapshot, model: string, now: number): IndexTurn {
  if (!index) return { kind: 'unavailable' }
  if (readyWindowCount(index, model) !== null) return { kind: 'complete' }
  const run = runOf(runs, 'search_index')
  if (!unattendedMayIndex(index, model) || holdsPassOfAnotherModel(run, model)) return { kind: 'held' }
  const until = waitingOn(run, now)
  if (until) return until.getTime() - now > LONGEST_INDEX_WAIT_MS ? { kind: 'parked', until } : { kind: 'waiting', until }
  // No time to come back, and a reason: what a refusal an explicit request got leaves, and
  // a passage over the model's limit. Retrying here would only be refused the same way.
  if (run?.lastError && !run.retryAt) return { kind: 'stopped' }
  return { kind: 'run' }
}

export interface PipelineAssessment {
  /** The one step to take now, first match wins. Null means there is none. */
  step: PipelineStep | null
  answer: Omit<PipelineResponse, 'retryAfterMs' | 'retryAt' | 'index'> & {
    retryAt: Date | null
    index: Omit<PipelineResponse['index'], 'retryAt'> & { retryAt: Date | null }
  }
}

/** ADR-0012's step priority: the first match wins. */
function firstStep(transcription: Turn, extraction: Turn, index: IndexTurn): PipelineStep | null {
  // 1. A cooled-down failed stage to retry.
  if (transcription.kind === 'retry') return 'transcription'
  if (extraction.kind === 'retry') return 'extraction'
  // 2. Transcription steps. While these are the question, the other two have no transcript.
  if (transcription.kind === 'run') return 'transcription'
  // 3. An extraction chunk, if it is not parked on its slot. Also planning, which has to
  //    come before any chunk and is not one: it makes no provider call.
  if (extraction.kind === 'run') return 'extraction'
  // 4. An index batch, if any windows are pending. Reached during extraction's gaps.
  if (index.kind === 'run') return 'indexing'
  // 5. Finalize, once every chunk is done.
  if (extraction.kind === 'finalize') return 'extraction'
  return null
}

/**
 * The table again with nobody watching, for the cron sweeper (ADR-0012's step 11 addendum).
 * The same turns in the same order, with less on offer, since each step here is quota spent
 * every 5 minutes for as long as it goes on:
 *
 * - **No row 1.** A failed stage is not retried, whatever its cooldown says: that takes a click.
 * - **No provider that cannot answer now.** A step that needs a provider which is blocked, or
 *   whose next slot is not free, is passed over for one that does not, rather than claimed
 *   only to find that out. The slot itself still decides, for whoever got there in between.
 * - **No index with an error on its run**, apart from the daily limit with its time passed.
 *   Transcription and extraction count their attempts and end in `failed`; an index has
 *   nowhere to end, and a page's 15-minute park would have this retrying all day.
 *
 * What stays is each step's own second attempt, since that is bounded and stored.
 * `sweepCanMove` in server/utils/db/pipeline.ts and `public.sweep_can_move` mirror this.
 */
export function unattendedStep(snapshot: PipelineSnapshot, { model, now, busy }: { model: string, now: number, busy: readonly SlotProvider[] }): PipelineStep | null {
  const { runs, chunks } = snapshot
  const transcription = transcriptionTurn(snapshot, now)
  if (transcription.kind === 'run') {
    const reply = (runOf(runs, 'transcription')?.cursor as { reply?: unknown } | undefined)?.reply
    return reply || !busy.includes('groq-whisper') ? 'transcription' : null
  }
  const extraction = extractionTurn(snapshot, now)
  if (extraction.kind === 'run' && (chunks.done >= chunks.total || !busy.includes('groq-chat'))) return 'extraction'
  if (indexTurn(snapshot, model, now).kind === 'run' && !busy.includes('workers-ai-embed')) {
    const lastError = runOf(runs, 'search_index')?.lastError
    if (!lastError || lastError === DAILY_LIMIT_MESSAGE) return 'indexing'
  }
  return extraction.kind === 'finalize' ? 'extraction' : null
}

function stageFigures(snapshot: PipelineSnapshot, indexFigures: { done: number, total: number | null }): PipelineResponse['progress'] {
  const { meeting, runs, chunks } = snapshot
  const figures = (stage: PipelineResponse['progress']['stage'], { done, total }: { done: number, total: number | null }) =>
    ({ stage, done, total, etaSeconds: null })
  if (meeting.status === 'ready') return figures('search_index', indexFigures)
  if (extractionInProgress(meeting)) return figures('summarization', { done: chunks.done, total: chunks.total || null })
  if (meeting.status === 'pending_upload' || (meeting.status === 'failed' && meeting.failedStage !== 'transcription')) {
    return figures('upload', { done: 0, total: null })
  }
  return figures('transcription', replyProgress(runOf(runs, 'transcription')))
}

/** Row 6, and how a pipeline with no step left ends. */
function afterSteps(meeting: Meeting, transcription: Turn, extraction: Turn, index: IndexTurn): Pick<PipelineAssessment['answer'], 'next' | 'retryAt'> {
  const waits = [transcription, extraction, index].flatMap(turn => turn.kind === 'waiting' ? [turn.until.getTime()] : [])
  if (waits.length > 0) return { next: 'wait', retryAt: new Date(Math.min(...waits)) }
  for (const turn of [transcription, extraction]) {
    if (turn.kind === 'failed') return { next: 'failed', retryAt: turn.until }
  }
  if (meeting.status === 'ready') return { next: 'done', retryAt: index.kind === 'parked' ? index.until : null }
  // A `failed` meeting with no stage of its own: its upload was rejected, and its audio
  // removed, or it predates the column.
  if (meeting.status === 'failed') return { next: 'failed', retryAt: null }
  // `pending_upload`: only the upload's `complete` moves this. A passive tab may look again.
  return { next: 'wait', retryAt: null }
}

export function assessPipeline(snapshot: PipelineSnapshot, { model, now }: { model: string, now: number }): PipelineAssessment {
  const { meeting, runs, index: state } = snapshot
  const transcription = transcriptionTurn(snapshot, now)
  const extraction = extractionTurn(snapshot, now)
  const index = indexTurn(snapshot, model, now)

  const step = firstStep(transcription, extraction, index)
  const indexFigures = state ? indexProgress(runOf(runs, 'search_index'), state, model) : { done: 0, total: null }
  const { next, retryAt } = step ? { next: 'continue' as const, retryAt: null } : afterSteps(meeting, transcription, extraction, index)

  return {
    step,
    answer: {
      status: meeting.status,
      progress: stageFigures(snapshot, indexFigures),
      index: {
        state: index.kind === 'run' || index.kind === 'waiting' ? 'building' : index.kind,
        ...indexFigures,
        retryAt: index.kind === 'parked' || index.kind === 'waiting' ? index.until : null,
      },
      next,
      retryAt,
    },
  }
}

/** The answer as it goes over the wire. A duration too, since a page's clock may be minutes off. */
export function toPipelineResponse({ answer }: PipelineAssessment, now: number): PipelineResponse {
  return {
    ...answer,
    index: { ...answer.index, retryAt: answer.index.retryAt?.toISOString() ?? null },
    retryAt: answer.retryAt?.toISOString() ?? null,
    retryAfterMs: answer.retryAt ? Math.max(0, answer.retryAt.getTime() - now) : null,
  }
}

/**
 * The answer for a meeting whose `POST .../advance` can only refuse, which is the public demo
 * (ADR-0015): nothing is on offer to a caller, so nothing here says there is. `continue` and a
 * time to come back and retry both promise a step, so neither is said. A `wait` with a time
 * stays, because that is a step someone already started, and `index` still says how it stands.
 */
export function withNoStepOnOffer(answer: PipelineResponse): PipelineResponse {
  if (answer.next === 'wait') return answer
  return { ...answer, next: answer.next === 'continue' ? 'wait' : answer.next, retryAt: null, retryAfterMs: null }
}
