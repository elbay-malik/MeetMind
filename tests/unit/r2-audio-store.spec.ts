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
      headers: { 'content-length': '8500000', 'content-type': 'audio/ogg', 'etag': '"abc123"' },
    })])
    expect(await store.head(KEY)).toMatchObject({ size: 8_500_000, contentType: 'audio/ogg' })
    expect(calls[0]!.method).toBe('HEAD')
    expect(new URL(calls[0]!.url).pathname).toBe(`/meetmind-audio/${KEY}`)
    // Header-signed (not query-signed) for server-to-server calls.
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//)
  })

  it('carries R2 own validator through, rather than synthesising one', async () => {
    stubFetch([new Response(null, {
      status: 200,
      headers: { 'content-length': '10', 'etag': '"abc123"' },
    })])
    expect((await store.head(KEY))!.etag).toBe('"abc123"')
  })

  it('reports no validator when the store did not send one', async () => {
    stubFetch([new Response(null, { status: 200, headers: { 'content-length': '10' } })])
    expect((await store.head(KEY))!.etag).toBeNull()
  })

  it('returns null when the object is absent', async () => {
    stubFetch([new Response(null, { status: 404 })])
    expect(await store.head(KEY)).toBeNull()
  })

  it('throws rather than reporting zero bytes when the length header is missing', async () => {
    // Reporting 0 would fail the size check and delete a good upload. Built by
    // hand because `new Response` supplies a content-length of its own.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/ogg' }),
    }))
    await expect(store.head(KEY)).rejects.toThrow(/content-length/)
  })

  it('throws rather than reporting a zero-byte object on a server error', async () => {
    stubFetch([new Response(null, { status: 503 }), new Response(null, { status: 503 }), new Response(null, { status: 503 })])
    await expect(store.head(KEY)).rejects.toThrow(/503/)
  })
})

describe('openRange', () => {
  const body = () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })

  it('asks R2 for exactly the window, and reports the size from Content-Range', async () => {
    const calls = stubFetch([new Response(body(), {
      status: 206,
      headers: { 'content-range': 'bytes 100-199/5000', 'content-type': 'audio/ogg' },
    })])

    const opened = await store.openRange(KEY, { start: 100, end: 199 })

    expect(calls[0]!.headers.get('range')).toBe('bytes=100-199')
    // The object's true size, not the slice's length.
    expect(opened).toMatchObject({ size: 5000, window: { start: 100, end: 199 }, contentType: 'audio/ogg' })
  })

  it('believes Content-Range over the window we asked for', async () => {
    // A store may serve a different window than requested; the response is
    // authoritative and the 206 we forward must describe what was actually sent.
    stubFetch([new Response(body(), { status: 206, headers: { 'content-range': 'bytes 0-99/5000' } })])
    const opened = await store.openRange(KEY, { start: 100, end: 199 })
    expect(opened!.window).toEqual({ start: 0, end: 99 })
  })

  it('refuses a 206 with no usable Content-Range rather than mistaking the slice for the object', async () => {
    // Falling back to Content-Length here would report the slice length as the
    // whole object's size, and every later range would be computed against it.
    for (const headers of [{}, { 'content-range': 'bytes */5000' }, { 'content-range': 'garbage' }]) {
      stubFetch([new Response(body(), { status: 206, headers })])
      await expect(store.openRange(KEY, { start: 0, end: 99 })).rejects.toThrow(/Content-Range/)
      vi.unstubAllGlobals()
    }
  })

  it('rejects a Content-Range whose window falls outside the object', async () => {
    stubFetch([new Response(body(), { status: 206, headers: { 'content-range': 'bytes 100-9999/5000' } })])
    await expect(store.openRange(KEY, { start: 100, end: 9999 })).rejects.toThrow(/Content-Range/)
  })

  it('treats a 200 as the whole object, which is what an ignored range means', async () => {
    stubFetch([new Response(body(), { status: 200, headers: { 'content-length': '5000' } })])
    const opened = await store.openRange(KEY, { start: 100, end: 199 })
    expect(opened).toMatchObject({ size: 5000, window: { start: 0, end: 4999 } })
  })

  it('sends no range header when asked for the whole object', async () => {
    const calls = stubFetch([new Response(body(), { status: 200, headers: { 'content-length': '5000' } })])
    await store.openRange(KEY, null)
    expect(calls[0]!.headers.get('range')).toBeNull()
  })

  it('returns null for a missing object', async () => {
    stubFetch([new Response(null, { status: 404 })])
    expect(await store.openRange(KEY, null)).toBeNull()
  })

  it('throws on a server error rather than returning an empty stream', async () => {
    stubFetch([new Response(null, { status: 503 }), new Response(null, { status: 503 }), new Response(null, { status: 503 })])
    await expect(store.openRange(KEY, null)).rejects.toThrow(/503/)
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
