import type { MeetingRepository } from '../db/meetings'
import type { SummaryRepository } from '../db/summaries'
import type { TranscriptRepository } from '../db/transcripts'
import type { PipelineRepository } from '../db/pipeline'
import type { SlotProvider, SlotRepository } from '../db/slots'
import type { TranscriptIndexRepository } from '../db/windows'
import type { Embedder } from '../qa/embedder'
import { advanceIndexing } from '../qa/steps'
import type { AudioStore } from '../storage/audio-store'
import { advanceExtraction } from '../summary/steps'
import type { Summarizer } from '../summary/summarizer'
import { advanceTranscription } from '../transcription/steps'
import type { Transcriber } from '../transcription/transcriber'
import { assessPipeline, readPipeline, unattendedStep, type PipelineAssessment, type PipelineStep } from './assess'

/**
 * `POST /api/meetings/:id/advance` (ADR-0012 §1): the one runnable step, whichever it is.
 * The step itself is the library each per-stage route also calls, so a meeting can be
 * driven by either, or both at once, and neither has behaviour the other lacks.
 *
 * What a step answers is not passed on. Once it has run, the stored state is read again
 * and assessed the way `GET .../pipeline` assesses it, so what a driver is told is what is
 * stored, whether this caller took the step, lost the claim or hit a failure.
 */

export interface PipelineDeps {
  meetings: MeetingRepository
  pipeline: PipelineRepository
  transcripts: TranscriptRepository
  summaries: SummaryRepository
  index: TranscriptIndexRepository
  slots: SlotRepository
  store: Pick<AudioStore, 'get' | 'put' | 'openRange' | 'delete'>
  transcriber: Transcriber
  summarizer: Summarizer
  embedder: Embedder
  embedIntervalMs: number
  now?: () => number
}

export type AdvanceOutcome
  = | { kind: 'assessed', assessment: PipelineAssessment }
    /** The meeting does not exist, or has been deleted during the step. */
    | { kind: 'missing' }
    /** `complete` has not confirmed the upload, and a driver cannot do that for it. */
    | { kind: 'not-uploaded' }

/** Take the step, and say how it went in the step's own one word, which holds nothing of why. */
async function takeStep(step: PipelineStep, meetingId: string, deps: PipelineDeps): Promise<string> {
  switch (step) {
    case 'transcription':
      return (await advanceTranscription(meetingId, deps)).kind
    case 'extraction':
      return (await advanceExtraction(meetingId, deps)).kind
    case 'indexing':
      return (await advanceIndexing(meetingId, deps, { unattended: true })).kind
  }
}

/** Take the meeting's next step, if one is runnable, and say where that leaves it. */
export async function advancePipeline(meetingId: string, deps: PipelineDeps): Promise<AdvanceOutcome> {
  const now = deps.now ?? Date.now
  const { model } = deps.embedder

  const before = await readPipeline(meetingId, model, deps)
  if (!before) return { kind: 'missing' }
  if (before.meeting.status === 'pending_upload') return { kind: 'not-uploaded' }

  const assessment = assessPipeline(before, { model, now: now() })
  // Nothing to do, so nothing claimed, written or sent, and no second read.
  if (!assessment.step) return { kind: 'assessed', assessment }

  await takeStep(assessment.step, meetingId, deps)

  const after = await readPipeline(meetingId, model, deps)
  if (!after) return { kind: 'missing' }
  return { kind: 'assessed', assessment: assessPipeline(after, { model, now: now() }) }
}

/**
 * One tick's step of one meeting (ADR-0012's step 11 addendum): the same step `/advance` takes,
 * from the same read, chosen by {@link unattendedStep}. Nobody is waiting to be told where
 * that leaves it, so the second read is not made. Null when no step can be taken.
 */
export async function advanceUnattended(meetingId: string, deps: PipelineDeps, busy: readonly SlotProvider[]): Promise<{ step: PipelineStep, outcome: string } | null> {
  const now = deps.now ?? Date.now
  const { model } = deps.embedder
  const snapshot = await readPipeline(meetingId, model, deps)
  if (!snapshot) return null
  const step = unattendedStep(snapshot, { model, now: now(), busy })
  if (!step) return null
  return { step, outcome: await takeStep(step, meetingId, deps) }
}
