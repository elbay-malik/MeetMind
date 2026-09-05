import { useAudioStore } from '../../utils/storage'
import { badRequest, notFound } from '../../utils/http'

/**
 * Upload endpoint for the LOCAL audio store only. It plays the role R2 plays
 * in production: accept a PUT for exactly the key, media type and byte count
 * the server granted when it minted the URL, within the grant's lifetime.
 * With R2 configured this route does not exist (404).
 */
export default defineEventHandler(async (event) => {
  const store = useAudioStore(event)
  if (store.kind !== 'local') throw notFound()

  const token = getRouterParam(event, 'token') ?? ''
  const grant = await store.verifyGrant(token)
  if (!grant) throw createError({ statusCode: 403, statusMessage: 'Upload URL is invalid or expired' })

  const contentType = (getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (contentType !== grant.contentType) {
    throw badRequest(`Content-Type must be ${grant.contentType}`)
  }

  // Insist on a declared length so nothing is buffered before the size check
  // (chunked bodies would otherwise be read to completion first).
  const declaredLength = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(declaredLength)) {
    throw createError({ statusCode: 411, statusMessage: 'Content-Length is required' })
  }
  if (declaredLength !== grant.contentLength) {
    throw createError({ statusCode: 413, statusMessage: 'Body size does not match the upload grant' })
  }

  const body = await readRawBody(event, false)
  const bytes = body ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array()
  if (bytes.byteLength !== grant.contentLength) {
    throw createError({ statusCode: 413, statusMessage: 'Body size does not match the upload grant' })
  }

  await store.put(grant.key, bytes, grant.contentType)
  return sendNoContent(event, 204)
})
