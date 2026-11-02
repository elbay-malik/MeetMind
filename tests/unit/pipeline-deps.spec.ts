import { describe, expect, it, vi } from 'vitest'

/**
 * Both ways into a step are built here, and what makes a step one step is in what they are
 * built from: a summarizer and an embedder of one attempt each, with no wait for a slot. A
 * driver handed the whole-request versions would still pass everything else, spending several
 * provider requests in one request.
 */

const useRuntimeConfig = vi.hoisted(() => vi.fn(() => ({ embedIntervalMs: 1234 })))
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig }))
vi.mock('../../server/utils/qa', () => ({
  useStepEmbedder: () => 'the step embedder',
  useEmbedder: () => 'the whole-request embedder',
}))
vi.mock('../../server/utils/summary', () => ({
  useStepSummarizer: () => 'the step summarizer',
  useSummarizer: () => 'the whole-request summarizer',
}))
vi.mock('../../server/utils/transcription', () => ({ useTranscriber: () => 'the transcriber' }))
vi.mock('../../server/utils/storage', () => ({ useAudioStore: () => 'the store' }))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => 'meetings',
  usePipelineRepository: () => 'pipeline',
  useSlotRepository: () => 'slots',
  useSummaryRepository: () => 'summaries',
  useTranscriptIndexRepository: () => 'index',
  useTranscriptRepository: () => 'transcripts',
}))

const { useExtractionStepDeps, useIndexingStepDeps, usePipelineDeps, useTranscriptionStepDeps } = await import('../../server/utils/pipeline/deps')

const event = {} as never

describe('what a step runs with', () => {
  it('gives /advance every provider and store of a step, and only the step versions', () => {
    expect(usePipelineDeps(event)).toEqual({
      meetings: 'meetings',
      pipeline: 'pipeline',
      transcripts: 'transcripts',
      summaries: 'summaries',
      index: 'index',
      slots: 'slots',
      store: 'the store',
      transcriber: 'the transcriber',
      summarizer: 'the step summarizer',
      embedder: 'the step embedder',
      embedIntervalMs: 1234,
    })
  })

  it('gives each per-stage route the same, so a step does not change with the route that took it', () => {
    const all = usePipelineDeps(event)
    for (const stage of [useTranscriptionStepDeps(event), useExtractionStepDeps(event), useIndexingStepDeps(event)]) {
      expect(all).toMatchObject(stage)
    }
  })
})
