import type { H3Event } from 'h3'
import {
  useMeetingRepository,
  usePipelineRepository,
  useSlotRepository,
  useSummaryRepository,
  useTranscriptIndexRepository,
  useTranscriptRepository,
} from '../db'
import { useStepEmbedder } from '../qa'
import type { IndexingDeps } from '../qa/steps'
import { useAudioStore } from '../storage'
import { useStepSummarizer } from '../summary'
import type { ExtractionDeps } from '../summary/steps'
import { useTranscriber } from '../transcription'
import type { TranscriptionDeps } from '../transcription/steps'
import type { PipelineDeps } from './advance'

/**
 * What one step runs with, built once for a route of its stage and for `/advance` alike, so
 * a step cannot behave differently depending on which route took it.
 */

export function useTranscriptionStepDeps(event: H3Event): TranscriptionDeps {
  return {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    store: useAudioStore(event),
    slots: useSlotRepository(event),
    transcriber: useTranscriber(event),
  }
}

export function useExtractionStepDeps(event: H3Event): ExtractionDeps {
  return {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    transcripts: useTranscriptRepository(event),
    summaries: useSummaryRepository(event),
    summarizer: useStepSummarizer(event),
  }
}

export function useIndexingStepDeps(event: H3Event): IndexingDeps {
  return {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    transcripts: useTranscriptRepository(event),
    index: useTranscriptIndexRepository(event),
    slots: useSlotRepository(event),
    embedder: useStepEmbedder(event),
    embedIntervalMs: Number(useRuntimeConfig(event).embedIntervalMs),
  }
}

export function usePipelineDeps(event: H3Event): PipelineDeps {
  return {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    transcripts: useTranscriptRepository(event),
    summaries: useSummaryRepository(event),
    index: useTranscriptIndexRepository(event),
    slots: useSlotRepository(event),
    store: useAudioStore(event),
    transcriber: useTranscriber(event),
    summarizer: useStepSummarizer(event),
    embedder: useStepEmbedder(event),
    embedIntervalMs: Number(useRuntimeConfig(event).embedIntervalMs),
  }
}
