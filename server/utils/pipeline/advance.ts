import type { MeetingRepository } from '../db/meetings'
import type { SummaryRepository } from '../db/summaries'
import type { TranscriptRepository } from '../db/transcripts'
import type { PipelineRepository } from '../db/pipeline'
import type { SlotRepository } from '../db/slots'
import type { TranscriptIndexRepository } from '../db/windows'
import type { Embedder } from '../qa/embedder'
import { advanceIndexing } from '../qa/steps'
import type { AudioStore } from '../storage/audio-store'
import { advanceExtraction } from '../summary/steps'
import type { Summarizer } from '../summary/summarizer'
import { advanceTranscription } from '../transcription/steps'
import type { Transcriber } from '../transcription/transcriber'
import { assessPipeline, readPipeline, type PipelineAssessment, type PipelineStep } from './assess'

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

async function takeStep(step: PipelineStep, meetingId: string, deps: PipelineDeps): Promise<void> {
  switch (step) {
    case 'transcription':
      await advanceTranscription(meetingId, deps)
      return
    case 'extraction':
      await advanceExtraction(meetingId, deps)
      return
    case 'indexing':
      await advanceIndexing(meetingId, deps, { unattended: true })
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
