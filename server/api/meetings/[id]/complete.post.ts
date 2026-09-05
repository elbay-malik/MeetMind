import type { Meeting } from '#shared/types/meeting'
import { AUDIO_MIME, MAX_AUDIO_BYTES } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'

/**
 * Confirm that the audio the browser uploaded actually landed in storage with
 * the declared size, then mark the meeting `uploaded`. A mismatched or
 * oversized object is deleted and the meeting marked `failed` — the server
 * never trusts the client's word for what reached the bucket.
 */
export default defineEventHandler(async (event): Promise<{ meeting: Meeting }> => {
  const id = requireMeetingId(event)
  const repo = useMeetingRepository(event)
  const store = useAudioStore(event)

  const meeting = await repo.get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (meeting.status === 'uploaded') return { meeting }
  if (meeting.status !== 'pending_upload') {
    throw conflict(`Meeting is ${meeting.status}; upload can no longer be completed`)
  }

  const object = await store.head(meeting.audioKey)
  if (!object) throw conflict('Audio has not reached storage yet')

  const reject = async (errorMessage: string) => {
    await store.delete(meeting.audioKey)
    await repo.update(id, { status: 'failed', errorMessage })
    return conflict(errorMessage)
  }

  if (object.size !== meeting.audioBytes || object.size > MAX_AUDIO_BYTES) {
    throw await reject(
      `Uploaded audio was ${object.size} bytes, expected ${meeting.audioBytes}; object deleted`,
    )
  }

  // R2 signs only the host, so the browser could have stored any media type
  // under this key. Check what actually landed. A store that reports no type
  // tells us nothing, so only a positive mismatch is rejected.
  const storedType = object.contentType?.split(';')[0]!.trim().toLowerCase()
  if (storedType && storedType !== AUDIO_MIME) {
    throw await reject(`Uploaded object is ${storedType}, expected ${AUDIO_MIME}; object deleted`)
  }

  const updated = await repo.update(id, {
    status: 'uploaded',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
  })
  if (!updated) throw notFound('Meeting not found')
  return { meeting: updated }
})
