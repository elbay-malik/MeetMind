import type { Meeting } from '#shared/types/meeting'
import { AUDIO_MIME, MAX_AUDIO_BYTES } from '#shared/utils/meeting'
import type { AudioStore } from './storage/audio-store'
import type { MeetingRepository } from './db/meetings'

/** Why a stored object was refused, or `null` when it is exactly what we expected. */
export function inspectStoredAudio(
  meeting: Pick<Meeting, 'audioBytes'>,
  object: { size: number, contentType: string | null },
): string | null {
  if (object.size !== meeting.audioBytes || object.size > MAX_AUDIO_BYTES) {
    return `Uploaded audio was ${object.size} bytes, expected ${meeting.audioBytes}`
  }
  // R2 signs only the host, so the browser could have stored any media type
  // under this key. A store that reports no type tells us nothing, so only a
  // positive mismatch is refused.
  const storedType = object.contentType?.split(';')[0]?.trim().toLowerCase()
  if (storedType && storedType !== AUDIO_MIME) {
    return `Uploaded object is ${storedType}, expected ${AUDIO_MIME}`
  }
  return null
}

/**
 * Record a failed upload and try to remove the object behind it.
 *
 * The row is always written, even when deletion fails: a meeting left at
 * `pending_upload` would keep claiming the upload is still in flight, whereas a
 * stranded object is only wasted bytes that a later sweep can collect. The
 * message says which of the two happened so nobody has to guess.
 */
export async function failMeetingUpload(
  store: Pick<AudioStore, 'delete'>,
  repo: Pick<MeetingRepository, 'update'>,
  meeting: Pick<Meeting, 'id' | 'audioKey'>,
  reason: string,
): Promise<string> {
  let errorMessage = `${reason}; object deleted`
  try {
    await store.delete(meeting.audioKey)
  }
  catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    errorMessage = `${reason}; object could not be deleted and needs sweeping (${detail})`
  }
  // `'upload'`, not `'transcription'`: this function has just DELETED the
  // object (or failed to, in which case it is still the wrong one), so there
  // is no audio for any route to work from. Recording it as a transcription
  // failure made the progress page offer "Try transcription again", which
  // could only ever return "The meeting audio is missing from storage" — the
  // same 409 on every attempt, with no other action offered and no way back
  // to `pending_upload`. Naming the stage that actually failed lets both
  // retry routes decline it and lets the UI say so.
  await repo.update(meeting.id, { status: 'failed', errorMessage, failedStage: 'upload' })
  return errorMessage
}
