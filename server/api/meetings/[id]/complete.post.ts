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

  // Claim-gated on the status this handler already checked above, rather than a
  // plain update: between that read and this write another caller can fail the
  // same meeting (failMeetingUpload, from a concurrent complete), and an
  // unconditional write would resurrect it as `uploaded` with the failure's
  // errorMessage cleared and its audio already deleted.
  //
  // failedStage is set explicitly, not left alone: the pairing the database
  // enforces is a property of the resulting ROW, so moving `status` out of
  // `failed` without clearing the stage is exactly the combination
  // `meetings_failed_stage_matches_status` refuses. Reachable only via the race
  // above today, which is why it went unnoticed — the repository's patch-level
  // validation cannot see it, since this patch is perfectly consistent on its own.
  const updated = await repo.claim(id, 'pending_upload', {
    status: 'uploaded',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
    failedStage: null,
  })
  if (!updated) {
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    if (current.status === 'uploaded') return { meeting: current }
    throw conflict(`Meeting is ${current.status}; upload can no longer be completed`)
  }
  return { meeting: updated }
})
