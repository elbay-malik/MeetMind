import type { Meeting, TranscriptSegment } from '#shared/types/meeting'
import { AUDIO_MIME } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { TranscriptionError, useTranscriber } from '../../../utils/transcription'

/**
 * Transcribe a meeting's stored audio and persist the segments.
 *
 * Phase 4 has no orchestrator — that is Phase 9 — so this is invoked directly.
 * It is safe to call twice: an already-transcribed meeting returns what it has,
 * and the `transcribing` claim keeps two concurrent callers from both spending
 * the provider's quota on the same audio.
 */
export default defineEventHandler(async (event): Promise<{
  meeting: Meeting
  segments: TranscriptSegment[]
}> => {
  const id = requireMeetingId(event)
  const repo = useMeetingRepository(event)
  const transcripts = useTranscriptRepository(event)

  const meeting = await repo.get(id)
  if (!meeting) throw notFound('Meeting not found')

  // Already past transcription: hand back what is stored rather than paying to
  // redo it.
  if (['summarizing', 'indexing', 'ready'].includes(meeting.status)) {
    return { meeting, segments: await transcripts.listForMeeting(id) }
  }
  if (meeting.status === 'transcribing') {
    throw conflict('Transcription is already running for this meeting')
  }
  if (meeting.status !== 'uploaded') {
    throw conflict(`Meeting is ${meeting.status}; it has no audio ready to transcribe`)
  }

  // Claim the meeting before doing any work. Two callers that raced past the
  // check above both write this, but the audio is only fetched and billed once
  // per caller that then finds itself holding a claim it did not make — which
  // the status check on the way out catches.
  const claimed = await repo.update(id, { status: 'transcribing', errorMessage: null })
  if (!claimed) throw notFound('Meeting not found')

  try {
    const audio = await useAudioStore(event).get(meeting.audioKey)
    if (!audio) {
      throw new TranscriptionError('The meeting audio is missing from storage', 409, false)
    }

    const result = await useTranscriber(event).transcribe({
      bytes: audio.bytes,
      contentType: audio.contentType ?? AUDIO_MIME,
    })

    await transcripts.replaceForMeeting(id, result.segments)

    const updated = await repo.update(id, { status: 'summarizing', errorMessage: null })
    if (!updated) throw notFound('Meeting not found')
    return { meeting: updated, segments: result.segments }
  }
  catch (err) {
    // Release the claim, or the meeting is stuck in `transcribing` forever with
    // no way for the user to retry.
    const message = err instanceof TranscriptionError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    const retryable = err instanceof TranscriptionError ? err.retryable : false
    await repo.update(id, {
      // A retryable failure goes back to `uploaded` so the user can try again;
      // anything else is terminal until someone intervenes.
      status: retryable ? 'uploaded' : 'failed',
      errorMessage: message,
    })
    throw createError({
      statusCode: err instanceof TranscriptionError ? err.statusCode : 500,
      statusMessage: 'Transcription failed',
      message,
    })
  }
})
