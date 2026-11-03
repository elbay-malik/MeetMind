import type { ExtractionStepResponse, MeetingSummary, PublicMeeting } from '#shared/types/meeting'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useExtractionStepDeps } from '../../../utils/pipeline/deps'
import { publicMessage, toPublicMeeting, withoutLastError } from '../../../utils/public-errors'
import { advanceExtraction } from '../../../utils/summary/steps'

/**
 * Extract decisions and action items from a meeting's transcript, one step per
 * request (ADR-0012): plan the chunks, extract one chunk, or finalize.
 *
 * 200 with `{ meeting, summary }` once the summary is stored. 202 with
 * progress while it is not: `next: 'continue'` means call again now, `wait`
 * means call again at `retryAt`. A step that fails the run answers with the
 * failure's status and a sentence that is safe to show (`publicMessage`), and the
 * meeting is then `failed`, with the reason in storage.
 *
 * Safe to call from any number of tabs at once: each step is claimed under a
 * token, so concurrent callers take turns rather than repeat a chunk, and a
 * caller that finds a step running is told when to look again.
 */
export default defineEventHandler(async (event): Promise<{ meeting: PublicMeeting, summary: MeetingSummary } | ExtractionStepResponse> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)
  const outcome = await advanceExtraction(id, useExtractionStepDeps(event))

  switch (outcome.kind) {
    case 'done':
      return { meeting: toPublicMeeting(outcome.meeting), summary: outcome.summary }
    case 'progress': {
      setResponseStatus(event, 202)
      const retryAfterMs = outcome.retryAt ? Math.max(0, outcome.retryAt.getTime() - Date.now()) : null
      if (retryAfterMs !== null) setResponseHeader(event, 'retry-after', Math.ceil(retryAfterMs / 1000))
      return {
        meeting: toPublicMeeting(outcome.meeting),
        progress: withoutLastError(outcome.progress),
        next: outcome.next,
        retryAt: outcome.retryAt?.toISOString() ?? null,
        retryAfterMs,
      }
    }
    case 'failed':
      throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage, message: publicMessage('extraction', outcome) })
    case 'refused': {
      const message = publicMessage('extraction', outcome)
      throw outcome.statusCode === 404 ? notFound(message) : conflict(message)
    }
  }
})
