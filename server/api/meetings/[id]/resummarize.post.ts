import type { ExtractionStepResponse, MeetingSummary, PublicMeeting } from '#shared/types/meeting'
import { requireAdmin } from '../../../utils/admin'
import { useTranscriptIndexRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useExtractionStepDeps } from '../../../utils/pipeline/deps'
import { publicMessage, toPublicMeeting, withoutLastError } from '../../../utils/public-errors'
import { useStepEmbedder } from '../../../utils/qa'
import { restartExtraction } from '../../../utils/summary/steps'

/**
 * Make a finished meeting's summary again from its stored transcript. Admin-only, with the
 * same check as the admin delete (ADR-0011's resummarize addendum): with no token configured
 * the route answers 404, like one that does not exist.
 *
 * Unlike every other route that moves a pipeline, this one is not refused on the public demo
 * (ADR-0015): the token, not the meeting's id, is what admits the caller, and it is how an
 * operator replaces the demo's summary without unsetting `NUXT_PUBLIC_DEMO_MEETING_ID`.
 *
 * It takes the first step itself, planning, which makes no provider call. 202 with progress
 * then, after which the page's `/advance` or the cron sweeper takes the chunks, and the
 * sweeper does so for the demo too. 200 with `{ meeting, summary }` when there was nothing
 * to extract. 409 when the meeting is not finished, and nothing has moved.
 */
export default defineEventHandler(async (event): Promise<{ meeting: PublicMeeting, summary: MeetingSummary } | ExtractionStepResponse> => {
  // Before anything that touches the meeting, as in the delete.
  await requireAdmin(event)
  const id = requireMeetingId(event)

  const outcome = await restartExtraction(id, {
    ...useExtractionStepDeps(event),
    index: useTranscriptIndexRepository(event),
    model: useStepEmbedder(event).model,
  })

  switch (outcome.kind) {
    case 'done':
      return { meeting: toPublicMeeting(outcome.meeting), summary: outcome.summary }
    case 'progress':
      setResponseStatus(event, 202)
      return {
        meeting: toPublicMeeting(outcome.meeting),
        progress: withoutLastError(outcome.progress),
        next: outcome.next,
        retryAt: outcome.retryAt?.toISOString() ?? null,
        retryAfterMs: outcome.retryAt ? Math.max(0, outcome.retryAt.getTime() - Date.now()) : null,
      }
    case 'failed':
      throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage, message: publicMessage('extraction', outcome) })
    case 'refused': {
      const message = publicMessage('extraction', outcome)
      throw outcome.statusCode === 404 ? notFound(message) : conflict(message)
    }
  }
})
