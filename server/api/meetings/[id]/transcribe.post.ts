import { isError } from 'h3'
import type { Meeting, TranscriptSegment } from '#shared/types/meeting'
import { AUDIO_MIME, MAX_AUDIO_BYTES } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useTranscriber } from '../../../utils/transcription'
import { TranscriptionError } from '../../../utils/transcription/transcriber'

/**
 * How long a claim is honoured before another caller may take it over. A crash,
 * a deploy or a Workers eviction between claiming and finishing would otherwise
 * leave the meeting in `transcribing` with nothing running and no way back.
 */
const CLAIM_LEASE_MS = 15 * 60_000

/** Statuses that mean transcription has already happened. */
const PAST_TRANSCRIPTION = ['summarizing', 'indexing', 'ready']

/**
 * Transcribe a meeting's stored audio and persist the segments.
 *
 * Phase 4 has no orchestrator — that is Phase 9 — so this is invoked directly.
 * It is safe to call twice: an already-transcribed meeting returns what it has,
 * and the claim keeps concurrent callers from both spending the provider's quota.
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
  if (PAST_TRANSCRIPTION.includes(meeting.status)) {
    return { meeting, segments: await transcripts.listForMeeting(id) }
  }

  const claimed = await claim(repo, meeting)
  if (!claimed) {
    // Lost the race, or the meeting moved on. Re-read rather than guess which.
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    if (PAST_TRANSCRIPTION.includes(current.status)) {
      return { meeting: current, segments: await transcripts.listForMeeting(id) }
    }
    throw conflict(current.status === 'transcribing'
      ? 'Transcription is already running for this meeting'
      : `Meeting is ${current.status}; it has no audio ready to transcribe`)
  }

  try {
    const audio = await useAudioStore(event).get(meeting.audioKey, MAX_AUDIO_BYTES)
    if (!audio) {
      throw new TranscriptionError('The meeting audio is missing from storage', 409, false)
    }
    if (audio.size !== meeting.audioBytes) {
      // The object changed after we verified it at upload.
      throw new TranscriptionError(
        `Stored audio is ${audio.size} bytes, expected ${meeting.audioBytes}`, 409, false,
      )
    }

    const result = await useTranscriber(event).transcribe({
      bytes: audio.bytes,
      contentType: audio.contentType ?? AUDIO_MIME,
    })

    await transcripts.replaceForMeeting(id, result.segments)

    const updated = await repo.update(id, { status: 'summarizing', errorMessage: null })
    // The transcript is stored either way; a missing row here is not a reason to
    // discard it.
    return { meeting: updated ?? { ...claimed, status: 'summarizing' }, segments: result.segments }
  }
  catch (err) {
    // An h3 error already says what it means; do not rewrite it as a 500 or
    // record it as a transcription failure. h3 marks these with a static on the
    // class, so its own predicate is the only correct test.
    if (isError(err)) {
      await repo.update(id, { status: 'uploaded', errorMessage: null })
      throw err
    }

    const transcription = err instanceof TranscriptionError ? err : null
    const message = transcription?.message ?? (err instanceof Error ? err.message : String(err))
    // Default to retryable. A storage or database blip is transient, and the
    // worse mistake is parking a perfectly good meeting on `failed`, which
    // nothing can move again.
    const retryable = transcription ? transcription.retryable : true
    await repo.update(id, {
      status: retryable ? 'uploaded' : 'failed',
      errorMessage: message,
    })
    throw createError({
      statusCode: transcription?.statusCode ?? 500,
      statusMessage: 'Transcription failed',
      message,
    })
  }
})

/**
 * Take the meeting for transcription, if it is ours to take. Also recovers a
 * claim whose holder is gone: `transcribing` older than the lease is stale,
 * since nothing renews it.
 */
async function claim(
  repo: ReturnType<typeof useMeetingRepository>,
  meeting: Meeting,
): Promise<Meeting | null> {
  const patch = { status: 'transcribing' as const, errorMessage: null }
  if (meeting.status === 'uploaded') return repo.claim(meeting.id, 'uploaded', patch)

  const staleSince = Date.now() - CLAIM_LEASE_MS
  if (meeting.status === 'transcribing' && new Date(meeting.updatedAt).getTime() < staleSince) {
    return repo.claim(meeting.id, 'transcribing', patch)
  }
  // `failed` is recoverable: the audio is still there, and the user asking again
  // is exactly the retry the status was recorded for.
  if (meeting.status === 'failed') return repo.claim(meeting.id, 'failed', patch)
  return null
}
