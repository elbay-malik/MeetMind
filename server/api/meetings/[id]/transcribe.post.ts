import type { Meeting, TranscriptionStepResponse } from '#shared/types/meeting'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useTranscriptionStepDeps } from '../../../utils/pipeline/deps'
import { advanceTranscription } from '../../../utils/transcription/steps'

/**
 * Transcribe a meeting's stored audio, one step per request (ADR-0012): the
 * Whisper call, one page of its reply, or the last step that hands the meeting
 * to extraction.
 *
 * 200 with `{ meeting }` once the transcript is stored; read it from
 * `GET .../transcript`. 202 with progress while it is not: `next: 'continue'`
 * means call again now, `wait` means call again at `retryAt`. A step that fails
 * the run answers with the failure's status, and the meeting is then `failed`
 * with the reason.
 *
 * Safe to call from any number of tabs at once: each step is claimed under a
 * token, so concurrent callers take turns rather than each spend the provider's
 * quota, and a finished transcript is never replaced.
 */
export default defineEventHandler(async (event): Promise<{ meeting: Meeting } | TranscriptionStepResponse> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)
  const outcome = await advanceTranscription(id, useTranscriptionStepDeps(event))

  switch (outcome.kind) {
    case 'done':
      return { meeting: outcome.meeting }
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
      if (outcome.retryAt) {
        setResponseHeader(event, 'retry-after', Math.max(1, Math.ceil((outcome.retryAt.getTime() - Date.now()) / 1000)))
      }
      throw createError({ statusCode: outcome.statusCode, statusMessage: 'Transcription failed', message: outcome.message })
    case 'refused':
      throw outcome.statusCode === 404 ? notFound(outcome.message) : conflict(outcome.message)
  }
})
