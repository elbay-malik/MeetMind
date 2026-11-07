import type { TranscriptSegment } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { readThroughDemoCache } from '../../../utils/demo-cache'
import { notFound, requireMeetingId } from '../../../utils/http'

/**
 * A meeting's stored transcript, empty until transcription has run.
 *
 * On the public demo, once transcription has finished, it is read from the edge cache
 * (see {@link readThroughDemoCache}): nothing on the demo can redo it, and the meeting row,
 * read here every time, decides which entry is current.
 */
export default defineEventHandler(async (event): Promise<{ segments: TranscriptSegment[] }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  return readThroughDemoCache(
    event,
    meeting,
    'transcript',
    { finished: transcriptionFinished(meeting) },
    async () => ({ segments: await useTranscriptRepository(event).listForMeeting(id) }),
  )
})
