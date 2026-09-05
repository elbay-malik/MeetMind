import type { TranscriptSegment } from '#shared/types/meeting'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'

/** A meeting's stored transcript, empty until transcription has run. */
export default defineEventHandler(async (event): Promise<{ segments: TranscriptSegment[] }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  return { segments: await useTranscriptRepository(event).listForMeeting(id) }
})
