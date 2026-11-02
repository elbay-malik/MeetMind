import { requireAdmin } from '../../utils/admin'
import { useMeetingRepository, usePipelineRepository } from '../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../utils/http'
import { deleteMeeting, DeletionIncompleteError, removeMeetingData } from '../../utils/meeting-deletion'

/**
 * Delete a meeting and everything stored for it: the audio object, the row, the
 * transcript, the summary and the search windows. Admin-only (ADR-0011) -- the
 * app has no users, so any wider permission would let anyone delete anyone's
 * meeting.
 *
 * This is what makes the storage budget reversible. The budget is derived from
 * the rows, so the meeting's bytes stop counting the moment its row is gone.
 *
 * Answers 204 when deleted, 404 when there is no such meeting, and 409 with a
 * `Retry-After` while something could still write the meeting's data. The
 * decisions are in `deleteMeeting`; this only maps them to HTTP.
 */
export default defineEventHandler(async (event) => {
  // Before anything that touches the meeting, so an unauthenticated caller
  // cannot even learn whether an id exists.
  await requireAdmin(event)
  const id = requireMeetingId(event)

  let outcome
  try {
    outcome = await deleteMeeting(id, {
      meetings: useMeetingRepository(event),
      pipeline: usePipelineRepository(event),
      removeData: (meetingId, audioKey) => removeMeetingData(event, meetingId, audioKey),
    })
  }
  catch (err) {
    if (!(err instanceof DeletionIncompleteError)) throw err
    throw createError({
      statusCode: 500,
      statusMessage: 'Delete incomplete',
      message: 'Some of the meeting\'s stored data could not be removed. Repeat the request to finish.',
      cause: err.cause,
    })
  }

  if (outcome.kind === 'not-found') throw notFound('Meeting not found')
  if (outcome.kind === 'blocked') {
    setResponseHeader(event, 'Retry-After', outcome.retryAfterSec)
    throw conflict(`Meeting cannot be deleted yet. ${outcome.reason}.`)
  }
  setResponseStatus(event, 204)
  return null
})
