import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalAudioStore } from '../../server/utils/storage/local'
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
