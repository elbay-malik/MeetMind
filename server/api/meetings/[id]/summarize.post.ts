import type { ExtractionStepResponse, Meeting, MeetingSummary } from '#shared/types/meeting'
import {
  useMeetingRepository,
  usePipelineRepository,
  useSummaryRepository,
  useTranscriptRepository,
} from '../../../utils/db'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useStepSummarizer } from '../../../utils/summary'
import { advanceExtraction } from '../../../utils/summary/steps'

/**
 * Extract decisions and action items from a meeting's transcript, one step per
 * request (ADR-0012): plan the chunks, extract one chunk, or finalize.
 *
 * 200 with `{ meeting, summary }` once the summary is stored. 202 with
 * progress while it is not: `next: 'continue'` means call again now, `wait`
 * means call again at `retryAt`. A step that fails the run answers with the
 * failure's status, and the meeting is then `failed` with the reason.
 *
 * Safe to call from any number of tabs at once: each step is claimed under a
 * token, so concurrent callers take turns rather than repeat a chunk, and a
 * caller that finds a step running is told when to look again.
 */
export default defineEventHandler(async (event): Promise<{ meeting: Meeting, summary: MeetingSummary } | ExtractionStepResponse> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)
  const outcome = await advanceExtraction(id, {
    meetings: useMeetingRepository(event),
    pipeline: usePipelineRepository(event),
    transcripts: useTranscriptRepository(event),
    summaries: useSummaryRepository(event),
    summarizer: useStepSummarizer(event),
  })

  switch (outcome.kind) {
    case 'done':
      return { meeting: outcome.meeting, summary: outcome.summary }
    case 'progress': {
      setResponseStatus(event, 202)
      const retryAfterMs = outcome.retryAt ? Math.max(0, outcome.retryAt.getTime() - Date.now()) : null
      if (retryAfterMs !== null) setResponseHeader(event, 'retry-after', Math.ceil(retryAfterMs / 1000))
      return {
        meeting: outcome.meeting,
        progress: outcome.progress,
        next: outcome.next,
        retryAt: outcome.retryAt?.toISOString() ?? null,
        retryAfterMs,
      }
    }
    case 'failed':
      throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage, message: outcome.message })
    case 'refused':
      throw outcome.statusCode === 404 ? notFound(outcome.message) : conflict(outcome.message)
  }
})
