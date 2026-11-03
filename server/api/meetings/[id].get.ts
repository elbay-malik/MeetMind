import type { PublicMeeting } from '#shared/types/meeting'
import { useMeetingRepository } from '../../utils/db'
import { notFound, requireMeetingId } from '../../utils/http'
import { toPublicMeeting } from '../../utils/public-errors'

export default defineEventHandler(async (event): Promise<{ meeting: PublicMeeting }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  return { meeting: toPublicMeeting(meeting) }
})
