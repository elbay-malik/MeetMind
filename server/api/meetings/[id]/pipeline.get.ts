import type { PipelineResponse } from '#shared/types/meeting'
import { useMeetingRepository, usePipelineRepository, useTranscriptIndexRepository } from '../../../utils/db'
import { isPublicDemo } from '../../../utils/demo-meeting'
import { notFound, requireMeetingId } from '../../../utils/http'
import { assessPipeline, readPipeline, toPipelineResponse, withNoStepOnOffer } from '../../../utils/pipeline/assess'
import { withoutInternals } from '../../../utils/pipeline/errors'
import { useEmbedder } from '../../../utils/qa'

/**
 * How far this meeting has got, and what `POST .../advance` would be told, for a tab that
 * is not driving (ADR-0012 §1). Open on the public demo, like every other read, because
 * it can only read: no provider call, no claim, no slot, no write. Only the embedder's
 * model name is taken from the embedder, since "complete" is complete for a model.
 *
 * On the demo that POST can only answer 403, so this does not say `continue`, or offer a
 * retry, which no caller there could act on: see {@link withNoStepOnOffer}.
 */
export default defineEventHandler(async (event): Promise<PipelineResponse> => {
  const id = requireMeetingId(event)
  const assessed = await withoutInternals(async () => {
    const { model } = useEmbedder(event)
    const snapshot = await readPipeline(id, model, {
      meetings: useMeetingRepository(event),
      pipeline: usePipelineRepository(event),
      index: useTranscriptIndexRepository(event),
    })
    return snapshot && assessPipeline(snapshot, { model, now: Date.now() })
  })
  if (!assessed) throw notFound('Meeting not found')
  const answer = toPipelineResponse(assessed, Date.now())
  return isPublicDemo(event, id) ? withNoStepOnOffer(answer) : answer
})
