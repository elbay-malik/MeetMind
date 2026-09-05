import { AwsClient } from 'aws4fetch'
import type {
  AudioStore,
  ByteWindow,
  OpenedAudio,
  PresignPutInput,
  StoredAudio,
  StoredObject,
} from './audio-store'

export interface R2Options {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/**
 * Cloudflare R2 through its S3-compatible API, signed with aws4fetch (SigV4
 * on Web Crypto — runs on Node and Cloudflare Workers alike). The browser
 * PUTs to a presigned URL; the server only ever HEADs or DELETEs objects.
 *
 * The bucket needs a CORS rule allowing PUT from the app origin with the
 * `content-type` header (see README → Storage setup).
 */
export interface R2AudioStore extends AudioStore {
  readonly kind: 'r2'
}

export function createR2AudioStore(options: R2Options): R2AudioStore {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 2,
  })
  const endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`

  const objectUrl = (key: string) => {
    const url = new URL(endpoint)
    // Path-style addressing: /<bucket>/<key>, each key segment URL-encoded.
    url.pathname = `/${options.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
    return url
  }

  return {
    kind: 'r2',

    async presignPut(input: PresignPutInput) {
      const url = objectUrl(input.key)
      // Must be set before signing; aws4fetch otherwise defaults to 24 h.
      url.searchParams.set('X-Amz-Expires', String(input.expiresInSec))
      // Host-only signature (X-Amz-SignedHeaders=host), as in Cloudflare's own
      // example: aws4fetch deliberately leaves content-type/content-length out
      // of the signature, so neither can be pinned here. Size and type are
      // verified after the upload by the completion route instead.
      const signed = await client.sign(
        new Request(url, { method: 'PUT' }),
        { aws: { signQuery: true } },
      )
      return {
        url: signed.url,
        method: 'PUT' as const,
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(Date.now() + input.expiresInSec * 1000).toISOString(),
      }
    },

    async head(key): Promise<StoredObject | null> {
      const res = await client.fetch(objectUrl(key).href, { method: 'HEAD' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`R2 HEAD ${key} failed with HTTP ${res.status}`)
      // Treating a missing length as 0 would fail the size check and delete a
      // perfectly good upload. Note Number(null) is 0, not NaN, so the header's
      // presence has to be checked before converting it.
      const declared = res.headers.get('content-length')
      const length = declared === null ? Number.NaN : Number(declared)
      if (!Number.isFinite(length)) {
        throw new Error(`R2 HEAD ${key} returned no usable content-length`)
      }
      return { size: length, contentType: res.headers.get('content-type') }
    },

    async get(key, maxBytes): Promise<StoredAudio | null> {
      const res = await client.fetch(objectUrl(key).href, { method: 'GET' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`R2 GET ${key} failed with HTTP ${res.status}`)
      // Refuse before buffering. The object is still writable for as long as the
      // presigned PUT lives, so its size at completion does not bind here.
      const declared = Number(res.headers.get('content-length'))
      if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`R2 object ${key} is ${declared} bytes, over the ${maxBytes}-byte limit`)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error(`R2 object ${key} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit`)
      }
      // Trust the body over the header: the length we act on is the length we
      // actually received.
      return { bytes, size: bytes.byteLength, contentType: res.headers.get('content-type') }
    },

    async openRange(key, window: ByteWindow | null): Promise<OpenedAudio | null> {
      // aws4fetch treats `range` as unsignable, so this needs no signing change.
      const headers = window ? { range: `bytes=${window.start}-${window.end}` } : undefined
      const res = await client.fetch(objectUrl(key).href, { method: 'GET', headers })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`R2 GET ${key} failed with HTTP ${res.status}`)
      if (!res.body) throw new Error(`R2 GET ${key} returned no body`)

      // A 206 reports the authoritative total in Content-Range. A 200 means the
      // range was ignored and we are holding the whole object.
      const contentRange = res.headers.get('content-range')
      const total = contentRange
        ? Number(contentRange.split('/').pop())
        : Number(res.headers.get('content-length'))
      if (!Number.isFinite(total)) throw new Error(`R2 GET ${key} reported no usable length`)

      const served: ByteWindow = res.status === 206 && window
        ? window
        : { start: 0, end: Math.max(0, total - 1) }

      return { body: res.body, size: total, contentType: res.headers.get('content-type'), window: served }
    },

    async delete(key) {
      const res = await client.fetch(objectUrl(key).href, { method: 'DELETE' })
      // S3 semantics: 204 on success, and deleting a missing key is not an error.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed with HTTP ${res.status}`)
      }
    },
  }
}
