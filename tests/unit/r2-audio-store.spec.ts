import { afterEach, describe, expect, it, vi } from 'vitest'
import { createR2AudioStore } from '../../server/utils/storage/r2'

const store = createR2AudioStore({
  accountId: '0123456789abcdef',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'meetmind-audio',
})

const KEY = 'meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio.ogg'

/** Stub the global fetch aws4fetch calls, capturing the signed requests. */
function stubFetch(responses: Response[]) {
  const calls: Request[] = []
  const queue = [...responses]
  vi.stubGlobal('fetch', async (input: Request) => {
    calls.push(input)
    return queue.shift() ?? new Response(null, { status: 500 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('presignPut', () => {
  it('signs a path-style R2 URL carrying the requested lifetime', async () => {
    const upload = await store.presignPut({
      key: KEY, contentType: 'audio/ogg', contentLength: 8_500_000, expiresInSec: 900,
    })
    const url = new URL(upload.url)

    expect(url.origin).toBe('https://0123456789abcdef.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/meetmind-audio/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/)
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // Host-only signature: the browser may send any content-type, which is why
    // the completion route verifies the stored object instead.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')

    expect(upload.method).toBe('PUT')
    expect(upload.headers).toEqual({ 'content-type': 'audio/ogg' })
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('never omits the lifetime, which would silently mean 24 hours', async () => {
    const upload = await store.presignPut({
      key: KEY, contentType: 'audio/ogg', contentLength: 1, expiresInSec: 60,
    })
    expect(new URL(upload.url).searchParams.get('X-Amz-Expires')).toBe('60')
  })

  it('produces different signatures for different keys', async () => {
    const sig = async (key: string) => new URL((await store.presignPut({
      key, contentType: 'audio/ogg', contentLength: 1, expiresInSec: 60,
    })).url).searchParams.get('X-Amz-Signature')
    expect(await sig('meetings/a/audio.ogg')).not.toBe(await sig('meetings/b/audio.ogg'))
  })
})

describe('head', () => {
  it('reports the stored size and media type', async () => {
    const calls = stubFetch([new Response(null, {
      status: 200,
      headers: { 'content-length': '8500000', 'content-type': 'audio/ogg' },
    })])
    expect(await store.head(KEY)).toEqual({ size: 8_500_000, contentType: 'audio/ogg' })
    expect(calls[0]!.method).toBe('HEAD')
    expect(new URL(calls[0]!.url).pathname).toBe(`/meetmind-audio/${KEY}`)
    // Header-signed (not query-signed) for server-to-server calls.
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//)
  })

  it('returns null when the object is absent', async () => {
    stubFetch([new Response(null, { status: 404 })])
    expect(await store.head(KEY)).toBeNull()
  })

  it('throws rather than reporting a zero-byte object on a server error', async () => {
    stubFetch([new Response(null, { status: 503 }), new Response(null, { status: 503 }), new Response(null, { status: 503 })])
    await expect(store.head(KEY)).rejects.toThrow(/503/)
  })
})

describe('delete', () => {
  it('sends an authenticated DELETE', async () => {
    const calls = stubFetch([new Response(null, { status: 204 })])
    await store.delete(KEY)
    expect(calls[0]!.method).toBe('DELETE')
  })

  it('treats a missing object as already deleted', async () => {
    stubFetch([new Response(null, { status: 404 })])
    await expect(store.delete(KEY)).resolves.toBeUndefined()
  })

  it('throws when the store rejects the delete', async () => {
    stubFetch([new Response(null, { status: 403 })])
    await expect(store.delete(KEY)).rejects.toThrow(/403/)
  })
})
