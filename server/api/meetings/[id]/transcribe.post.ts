import type { Meeting, TranscriptSegment } from '#shared/types/meeting'
import { AUDIO_MIME } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useTranscriber } from '../../../utils/transcription'
import { TranscriptionError } from '../../../utils/transcription/transcriber'

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

  // Claim atomically. The checks above are a courtesy for the common case; this
  // is what actually stops two callers both spending the transcription quota on
  // the same audio, because only one of them can move the row out of `uploaded`.
  const claimed = await repo.claim(id, 'uploaded', { status: 'transcribing', errorMessage: null })
  if (!claimed) {
    // Someone else got there first, or the meeting moved on. Re-read rather than
    // guess which.
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    if (['summarizing', 'indexing', 'ready'].includes(current.status)) {
      return { meeting: current, segments: await transcripts.listForMeeting(id) }
    }
    throw conflict(`Meeting is ${current.status}; transcription cannot start`)
  }

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
