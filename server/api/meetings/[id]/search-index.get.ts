import type { SearchIndexStatus } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'
import { useEmbedder } from '../../../utils/qa'
import { indexStatus } from '../../../utils/qa/indexing'
import { planWindows } from '../../../utils/qa/windows'

/**
 * Whether this meeting can be asked questions yet. Recomputed from the current
 * transcript every time rather than stored, so a replaced transcript shows up
 * as `incomplete` immediately, without anything having to remember to mark it.
 */
export default defineEventHandler(async (event): Promise<{ index: SearchIndexStatus }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')

  const { model } = useEmbedder(event)
  if (!transcriptionFinished(meeting)) {
    return { index: { state: 'unavailable', windowCount: 0, indexedCount: 0, model } }
  }

  const segments = await useTranscriptRepository(event).listForMeeting(id)
  const plan = await planWindows(segments)
  const keys = await useTranscriptIndexRepository(event).listKeys(id)
  return { index: indexStatus(plan, keys, model) }
})
