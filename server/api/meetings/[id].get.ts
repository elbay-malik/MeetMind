import type { Meeting } from '#shared/types/meeting'
import { useMeetingRepository } from '../../utils/db'
import { notFound, requireMeetingId } from '../../utils/http'

export default defineEventHandler(async (event): Promise<{ meeting: Meeting }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  return { meeting }
})
