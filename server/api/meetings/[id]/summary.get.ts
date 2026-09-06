import type { MeetingSummary } from '#shared/types/meeting'
import { useMeetingRepository, useSummaryRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'

/** A meeting's stored summary, or null until extraction has run. */
export default defineEventHandler(async (event): Promise<{ summary: MeetingSummary | null }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  return { summary: await useSummaryRepository(event).getForMeeting(id) }
})
