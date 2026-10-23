import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalAudioStore } from '../../server/utils/storage/local'
import { RangeNotSatisfiableError } from '../../server/utils/storage/audio-store'
import { signToken } from '../../server/utils/signed-token'

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-store-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const tokenOf = (url: string) => url.split('/').at(-1)!

describe('createLocalAudioStore', () => {
  it('mints a same-origin upload URL whose grant round-trips', async () => {
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const upload = await store.presignPut({
      key: 'meetings/abc/audio.ogg', contentType: 'audio/ogg', contentLength: 42, expiresInSec: 600,
    })
    expect(upload.method).toBe('PUT')
    expect(upload.url).toMatch(/^\/api\/uploads\//)
    expect(upload.headers).toEqual({ 'content-type': 'audio/ogg' })

    const grant = await store.verifyGrant(tokenOf(upload.url))
    expect(grant).toMatchObject({ v: 1, key: 'meetings/abc/audio.ogg', contentType: 'audio/ogg', contentLength: 42 })
    expect(new Date(upload.expiresAt).getTime()).toBe(grant!.exp * 1000)
  })

  it('rejects expired grants and grants signed with another secret', async () => {
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const upload = await store.presignPut({
      key: 'meetings/abc/audio.ogg', contentType: 'audio/ogg', contentLength: 1, expiresInSec: 60,
    })
    const token = tokenOf(upload.url)
    expect(await store.verifyGrant(token, Date.now() + 61_000)).toBeNull()
    const other = createLocalAudioStore({ dataDir, secret: 'different' })
    expect(await other.verifyGrant(token)).toBeNull()
  })

  it('rejects a correctly signed grant whose payload is malformed', async () => {
    // Signed by us, so the HMAC checks out — the shape must be validated too,
    // which is what protects the route if the payload ever changes shape.
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const exp = Math.floor(Date.now() / 1000) + 600
    const valid = { v: 1, key: 'meetings/abc/audio.ogg', contentType: 'audio/ogg', contentLength: 42, exp }
    expect(await store.verifyGrant(await signToken(valid, 's3cret'))).not.toBeNull()

    for (const bad of [
      { ...valid, v: 2 },
      { ...valid, key: '' },
      { ...valid, contentType: undefined },
      { ...valid, contentLength: undefined },
      { ...valid, contentLength: -1 },
      { ...valid, contentLength: 1.5 },
      { ...valid, exp: 'soon' },
      'not-an-object',
    ]) {
      expect(await store.verifyGrant(await signToken(bad, 's3cret')), JSON.stringify(bad)).toBeNull()
    }
  })

  it('writes, inspects and deletes objects under <dataDir>/audio', async () => {
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const key = 'meetings/xyz/audio.ogg'
    expect(await store.head(key)).toBeNull()

    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await store.put(key, bytes, 'audio/ogg')
    expect(await store.head(key)).toMatchObject({ size: 5, contentType: 'audio/ogg' })
    // A validator that tracks the bytes, so a same-length replacement is a miss.
    expect((await store.head(key))!.etag).toMatch(/^"[a-z0-9]+-5"$/)
    expect(await readFile(join(dataDir, 'audio', 'meetings', 'xyz', 'audio.ogg'))).toEqual(Buffer.from(bytes))

    await store.delete(key)
    expect(await store.head(key)).toBeNull()
    await expect(store.delete(key)).resolves.toBeUndefined()
  })

  it('refuses keys that try to escape the store', async () => {
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    await expect(store.put('../escape.ogg', new Uint8Array([1]), 'audio/ogg')).rejects.toThrow()
  })
})

/**
 * The route no longer HEADs before reading a window: it derives the window from
 * the length on the meeting row, which `complete.post.ts` verified against
 * storage. That shifts two obligations onto this driver, because an object stays
 * writable while its presigned PUT lives and so can outlive that length.
 */
describe('openRange', () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251)

  async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return out
  }

  it('clamps a window running past the end, so the window cannot overstate the body', async () => {
    // The returned window becomes the response's content-length. createReadStream
    // tolerates an `end` past EOF and simply stops, so an unclamped window would
    // promise bytes the stream never sends — a truncated response a client
    // cannot distinguish from a dropped connection.
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const key = 'meetings/clamp/audio.ogg'
    await store.put(key, bytes, 'audio/ogg')

    const opened = await store.openRange(key, { start: 900, end: 4999 })
    expect(opened!.window).toEqual({ start: 900, end: 999 })
    expect(opened!.size).toBe(1000)
    expect((await drain(opened!.body)).byteLength).toBe(100)
  })

  it('refuses a window starting past the end, reporting the true length', async () => {
    // R2 answers 416 with `bytes */<size>` here. The route turns that into a
    // truthful 416, and it cannot source the length itself — the number it holds
    // is the stale one.
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const key = 'meetings/past-eof/audio.ogg'
    await store.put(key, bytes, 'audio/ogg')
    await store.put(key, bytes.slice(0, 100), 'audio/ogg')

    const failure = await store.openRange(key, { start: 500, end: 999 }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(RangeNotSatisfiableError)
    expect((failure as RangeNotSatisfiableError).size).toBe(100)
  })

  it('serves an empty object as an empty window rather than refusing it', async () => {
    // No window is satisfiable, but `bytes 0--1/0` is the honest answer and the
    // 416 path above must not swallow it.
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const key = 'meetings/empty/audio.ogg'
    await store.put(key, new Uint8Array(0), 'audio/ogg')

    const opened = await store.openRange(key, { start: 0, end: 99 })
    expect(opened!.size).toBe(0)
    expect(opened!.window).toEqual({ start: 0, end: -1 })
    expect((await drain(opened!.body)).byteLength).toBe(0)
  })

  it('carries a validator, so serving a range needs no second request', async () => {
    const store = createLocalAudioStore({ dataDir, secret: 's3cret' })
    const key = 'meetings/etag/audio.ogg'
    await store.put(key, bytes, 'audio/ogg')

    const opened = await store.openRange(key, { start: 0, end: 9 })
    expect(opened!.etag).toMatch(/^"[a-z0-9]+-1000"$/)
  })
})
