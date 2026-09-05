import type { Meeting } from '#shared/types/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { failMeetingUpload, inspectStoredAudio } from '../../../utils/verify-upload'

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

  const refusal = inspectStoredAudio(meeting, object)
  if (refusal) throw conflict(await failMeetingUpload(store, repo, meeting, refusal))

  const updated = await repo.update(id, {
    status: 'uploaded',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
  })
  if (!updated) throw notFound('Meeting not found')
  return { meeting: updated }
})
