import type { Meeting } from '#shared/types/meeting'
import { MAX_AUDIO_BYTES } from '#shared/utils/meeting'
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

  if (object.size !== meeting.audioBytes || object.size > MAX_AUDIO_BYTES) {
    await store.delete(meeting.audioKey)
    const errorMessage
      = `Uploaded audio was ${object.size} bytes, expected ${meeting.audioBytes}; object deleted`
    await repo.update(id, { status: 'failed', errorMessage })
    throw conflict(errorMessage)
  }

  const updated = await repo.update(id, {
    status: 'uploaded',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
  })
  if (!updated) throw notFound('Meeting not found')
  return { meeting: updated }
})
