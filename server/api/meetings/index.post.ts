import { createMeetingBodySchema } from '#shared/schemas/meeting'
import type { CreateMeetingResponse } from '#shared/types/meeting'
import { AUDIO_MIME, audioObjectKey } from '#shared/utils/meeting'
import { useAudioStore } from '../../utils/storage'
import { useMeetingRepository, useRegistrationRepository } from '../../utils/db'
import { requireDrivers } from '../../utils/drivers'
import { badRequest } from '../../utils/http'
import { requireInviteCode } from '../../utils/invite'
import { toPublicMeeting } from '../../utils/public-errors'
import { takeRegistration } from '../../utils/registration-limit'
import { assertStorageBudget, UPLOAD_URL_TTL_SEC } from '../../utils/storage-budget'

/**
 * The registration payload is a few hundred bytes. h3 buffers the whole body
 * before any schema runs and applies no limit of its own, so bound it here
 * rather than letting an arbitrary body into memory.
 */
const MAX_BODY_BYTES = 4096

/**
 * Register a meeting and hand the browser a one-shot upload URL for its
 * compressed audio. The row starts as `pending_upload`; the client confirms
 * the upload via `POST /api/meetings/:id/complete`.
 *
 * Nothing else creates a meeting, and everything that spends quota needs one, so
 * this is where uploading is closed to anyone without the invite code (ADR-0015), and
 * where the whole app's daily ceiling on new meetings is counted (ADR-0020).
 */
export default defineEventHandler(async (event): Promise<CreateMeetingResponse> => {
  await requireInviteCode(event)
  requireDrivers(event)

  // Checked before reading, so an oversized body is refused rather than buffered.
  const declaredLength = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(declaredLength)) {
    throw createError({ statusCode: 411, statusMessage: 'Content-Length is required' })
  }
  if (declaredLength > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  const parsed = createMeetingBodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw badRequest('Invalid meeting payload', parsed.error)
  const input = parsed.data

  // Before minting the URL, not after: the presigned PUT is the capability that
  // spends storage, so a refusal has to come first. Checked against the bytes
  // this upload would add, so the ceiling cannot be stepped over by one large
  // recording.
  await assertStorageBudget(event, input.audioBytes)

  // Last before the URL, so only a request with a valid code and body that the store has room
  // for uses one of the day's new meetings, and over the ceiling nothing is minted.
  await takeRegistration(event, useRegistrationRepository(event))

  const id = crypto.randomUUID()
  const audioKey = audioObjectKey(id)

  const upload = await useAudioStore(event).presignPut({
    key: audioKey,
    contentType: AUDIO_MIME,
    contentLength: input.audioBytes,
    expiresInSec: UPLOAD_URL_TTL_SEC,
  })

  const meeting = await useMeetingRepository(event).create({
    id,
    title: input.title,
    status: 'pending_upload',
    sourceFileName: input.sourceFileName,
    sourceBytes: input.sourceBytes,
    sourceMime: input.sourceMime,
    durationSec: input.durationSec,
    audioKey,
    audioBytes: input.audioBytes,
    audioMime: AUDIO_MIME,
    uploadedAt: null,
    errorMessage: null,
    failedStage: null,
  })

  setResponseStatus(event, 201)
  return { meeting: toPublicMeeting(meeting), upload }
})
