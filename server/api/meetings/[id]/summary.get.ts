import type { MeetingSummary } from '#shared/types/meeting'
import { useMeetingRepository, useSummaryRepository } from '../../../utils/db'
import { readThroughDemoCache } from '../../../utils/demo-cache'
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
 *
 * Checked again after the read, not just before it: a `ready` meeting whose
 * summary row is missing (a broken invariant nothing in this app causes
 * today) is reclaimable back to `indexing` as a repair (see
 * summarize.post.ts), and that reclaim's own five-write sequence can start
 * while THIS request's `getForMeeting` is already in flight. The first check
 * alone would let a `ready` read moments earlier stand for a summary actually
 * read mid-repair; re-reading the status right after closes that window down
 * to whatever is left between this second read and the response being sent,
 * which is not literally zero but is no longer application logic.
 *
 * On the public demo a `ready` summary is read from the edge cache (see
 * {@link readThroughDemoCache}). Both status checks still decide what is stored: an answer
 * of null, from either one, is sent but never kept, and neither is one read while the row
 * changed.
 */
export default defineEventHandler(async (event): Promise<{ summary: MeetingSummary | null }> => {
  const id = requireMeetingId(event)
  const repo = useMeetingRepository(event)
  const meeting = await repo.get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (meeting.status !== 'ready') return { summary: null }

  // Kept only if the row did not move while the summary was read, so an entry always
  // belongs to the row whose `updatedAt` names it.
  let unchanged = false
  return readThroughDemoCache(
    event,
    meeting,
    'summary',
    { finished: true, cacheable: answer => unchanged && answer.summary !== null },
    async () => {
      const summary = await useSummaryRepository(event).getForMeeting(id)

      const after = await repo.get(id)
      if (after?.status !== 'ready') return { summary: null }

      unchanged = after.updatedAt === meeting.updatedAt
      return { summary }
    },
  )
})
