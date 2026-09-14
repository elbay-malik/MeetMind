import type { SearchIndexStatus } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useEmbedder } from '../../../utils/qa'
import { EmbeddingError } from '../../../utils/qa/embedder'
import { indexMeeting } from '../../../utils/qa/indexing'

/**
 * Runs already in flight in this process, by meeting. A second request for the
 * same meeting — a double click, or a second tab — joins the first run instead
 * of embedding the same windows twice against a daily quota.
 *
 * Per process only, like the Groq pacer. Two processes can still both index one
 * meeting; that costs quota but not correctness, since every write is an
 * idempotent upsert of the same windows, keyed by index and hash.
 */
const inFlight = new Map<string, Promise<SearchIndexStatus>>()

/**
 * Index a meeting's transcript for questions (ADR-0007). Idempotent and
 * resumable: windows already stored for this transcript and model are skipped,
 * and a run the embedding quota stops partway keeps what it stored.
 */
export default defineEventHandler(async (event): Promise<{ index: SearchIndexStatus }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (!transcriptionFinished(meeting)) {
    throw conflict(`Meeting is ${meeting.status}; it has no finished transcript to index yet`)
  }

  let run = inFlight.get(id)
  if (!run) {
    const embedder = useEmbedder(event)
    const repo = useTranscriptIndexRepository(event)
    run = useTranscriptRepository(event).listForMeeting(id)
      .then(segments => indexMeeting({ meetingId: id, segments, embedder, repo }))
      .finally(() => inFlight.delete(id))
    inFlight.set(id, run)
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
        // what was already embedded is kept, so trying again later resumes.
        message: `${err.message} Windows indexed so far are kept; indexing again resumes from there.`,
      })
    }
    throw err
  }
})
