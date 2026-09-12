import type { MeetingSummary } from '#shared/types/meeting'
import { useMeetingRepository, useSummaryRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'

/**
 * A meeting's stored summary, or null until extraction has finished.
 *
 * Gated on `status === 'ready'` rather than returning whatever is in the
 * summary tables: `replaceForMeeting` is five sequential, non-transactional
 * writes (delete decisions, delete action items, upsert summary, insert
 * decisions, insert action items — PostgREST has no cross-call transaction),
 * so an ordinary transient failure on any one of them leaves a readable but
 * wrong record, for instance the old summary paired with empty items. The
 * meeting only reaches `ready` once every step has completed, so trusting that
 * status is what keeps a reader from ever observing a mid-write state.
 */
export default defineEventHandler(async (event): Promise<{ summary: MeetingSummary | null }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (meeting.status !== 'ready') return { summary: null }
  return { summary: await useSummaryRepository(event).getForMeeting(id) }
})
