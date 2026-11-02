import type { PipelineResponse } from '#shared/types/meeting'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { advancePipeline } from '../../../utils/pipeline/advance'
import { toPipelineResponse } from '../../../utils/pipeline/assess'
import { usePipelineDeps } from '../../../utils/pipeline/deps'
import { withoutInternals } from '../../../utils/pipeline/errors'

/**
 * Take this meeting's next step, whichever it is, one per request (ADR-0012 §1): one
 * transcription step, one chunk, one batch of the index, or the step that writes the
 * summary. At most one provider request and one claim.
 *
 * Answers 200 with where that leaves it, including when a step failed or another
 * caller got there first: the request did what it could, and `next` says what comes next.
 * See {@link PipelineResponse}. It says nothing of why a step failed, which can be in a
 * provider's or a database's own words.
 *
 * Nobody has to have asked for any stage. So this never replaces an index holding another
 * model's or transcript's work, which takes `POST .../search-index`, and never repairs a
 * `ready` meeting with no summary, which takes `POST .../summarize`.
 *
 * Safe to call from any number of tabs at once: each step is claimed under a token.
 */
export default defineEventHandler(async (event): Promise<PipelineResponse> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)

  const outcome = await withoutInternals(() => advancePipeline(id, usePipelineDeps(event)))
  if (outcome.kind === 'missing') throw notFound('Meeting not found')
  if (outcome.kind === 'not-uploaded') throw conflict('Meeting is pending_upload; it has no audio ready to transcribe')

  const answer = toPipelineResponse(outcome.assessment, Date.now())
  if (answer.next === 'wait' && answer.retryAfterMs !== null) {
    setResponseHeader(event, 'retry-after', Math.ceil(answer.retryAfterMs / 1000))
  }
  return answer
})
