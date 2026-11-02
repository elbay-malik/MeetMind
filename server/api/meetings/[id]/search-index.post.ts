import type { IndexingStepResponse, SearchIndexStatus } from '#shared/types/meeting'
import { useMeetingRepository, usePipelineRepository, useSlotRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId, retryLater } from '../../../utils/http'
import { useStepEmbedder } from '../../../utils/qa'
import { advanceIndexing } from '../../../utils/qa/steps'

/**
 * Index a meeting's transcript for questions, one step per request (ADR-0012): the next
 * batch of windows, or the last step that marks the index complete.
 *
 * 200 with `{ index }` once it is complete. 202 with progress while it is not:
 * `next: 'continue'` means call again now, `wait` means call again at `retryAt`. Windows
 * already stored for this transcript and model are skipped, so a run the provider's
 * daily limit stopped keeps what it stored and carries on from there, and a failure
 * here never touches the meeting's status.
 *
 * Safe to call from any number of tabs at once: each step is claimed under a token, so
 * concurrent callers take turns rather than each spend the provider's quota.
 */
export default defineEventHandler(async (event): Promise<{ index: SearchIndexStatus } | IndexingStepResponse> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)
  const outcome = await advanceIndexing(id, {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    transcripts: useTranscriptRepository(event),
    index: useTranscriptIndexRepository(event),
    slots: useSlotRepository(event),
    embedder: useStepEmbedder(event),
    embedIntervalMs: Number(useRuntimeConfig(event).embedIntervalMs),
  })

  switch (outcome.kind) {
    case 'done':
      return { index: outcome.index }
    case 'progress': {
      setResponseStatus(event, 202)
      const retryAfterMs = outcome.retryAt ? Math.max(0, outcome.retryAt.getTime() - Date.now()) : null
      if (retryAfterMs !== null) setResponseHeader(event, 'retry-after', Math.ceil(retryAfterMs / 1000))
      return {
        progress: outcome.progress,
        next: outcome.next,
        retryAt: outcome.retryAt?.toISOString() ?? null,
        retryAfterMs,
      }
    }
    case 'failed':
      throw createError({
        statusCode: outcome.statusCode,
        statusMessage: 'Indexing failed',
        // Said explicitly, because the difference matters to whoever retries: what was
        // already embedded is kept, so trying again later resumes. Not for a passage
        // over the limit, which stops the next run at the same place.
        message: outcome.resumes
          ? `${outcome.message} Passages indexed so far are kept; indexing again resumes from there.`
          : outcome.message,
        data: outcome.retryAt ? retryLater(event, outcome.retryAt) : undefined,
      })
    case 'refused':
      throw outcome.statusCode === 404 ? notFound(outcome.message) : conflict(outcome.message)
  }
})
