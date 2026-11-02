import type { SearchIndexStatus } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { refuseOnPublicDemo } from '../../../utils/demo-meeting'
import { conflict, notFound, requireMeetingId, retryLater } from '../../../utils/http'
import { useEmbedder } from '../../../utils/qa'
import { EmbeddingError, EmbeddingInputTooLongError } from '../../../utils/qa/embedder'
import { indexMeeting } from '../../../utils/qa/indexing'
import { indexingInFlight } from '../../../utils/qa/in-flight'

/**
 * Index a meeting's transcript for questions (ADR-0007). Idempotent and
 * resumable: windows already stored for this transcript and model are skipped,
 * and a run the provider's daily limit stops partway keeps what it stored.
 */
export default defineEventHandler(async (event): Promise<{ index: SearchIndexStatus }> => {
  const id = requireMeetingId(event)
  refuseOnPublicDemo(event, id)

  let run = indexingInFlight.get(id)
  if (!run) {
    const meetings = useMeetingRepository(event)
    const transcripts = useTranscriptRepository(event)
    const embedder = useEmbedder(event)
    const repo = useTranscriptIndexRepository(event)
    // Registered BEFORE the meeting is read, not after. The delete route
    // relies on it: once it has deleted the row it waits for whatever run is
    // registered here, and only a run registered before its own read is
    // guaranteed to be visible by then. A request that joins this run shares
    // its checks and its outcome, 404 and 409 included.
    run = (async () => {
      const meeting = await meetings.get(id)
      if (!meeting) throw notFound('Meeting not found')
      if (!transcriptionFinished(meeting)) {
        throw conflict(`Meeting is ${meeting.status}; it has no finished transcript to index yet`)
      }
      const segments = await transcripts.listForMeeting(id)
      return indexMeeting({ meetingId: id, segments, embedder, repo })
    })().finally(() => indexingInFlight.delete(id))
    indexingInFlight.set(id, run)
  }

  try {
    return { index: await run }
  }
  catch (err) {
    if (err instanceof EmbeddingError) {
      throw createError({
        statusCode: err.statusCode,
        statusMessage: 'Indexing failed',
        // Said explicitly, because the difference matters to whoever retries:
        // what was already embedded is kept, so trying again later resumes. Not
        // for a passage over the limit, which stops the next run at the same place.
        message: err instanceof EmbeddingInputTooLongError
          ? err.message
          : `${err.message} Passages indexed so far are kept; indexing again resumes from there.`,
        data: err.retryAt ? retryLater(event, err.retryAt) : undefined,
      })
    }
    throw err
  }
})
