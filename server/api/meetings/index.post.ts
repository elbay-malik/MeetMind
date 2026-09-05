import { createMeetingBodySchema } from '#shared/schemas/meeting'
import type { CreateMeetingResponse } from '#shared/types/meeting'
import { AUDIO_MIME, audioObjectKey } from '#shared/utils/meeting'
import { useAudioStore } from '../../utils/storage'
import { useMeetingRepository } from '../../utils/db'
import { badRequest } from '../../utils/http'

/** How long the browser has to PUT the audio after registering the meeting. */
const UPLOAD_URL_TTL_SEC = 15 * 60

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
 */
export default defineEventHandler(async (event): Promise<CreateMeetingResponse> => {
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
  })

  setResponseStatus(event, 201)
  return { meeting, upload }
})
