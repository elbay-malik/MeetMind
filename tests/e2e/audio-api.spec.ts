import { mkdtemp, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting } from '../../shared/types/meeting'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-audio-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret', NUXT_INVITE_CODE: INVITE_CODE },
})

// Distinct bytes so a served window can be checked against its offset.
const audio = new Uint8Array(5000).map((_, i) => i % 251)

async function uploadedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Audio route test',
      sourceFileName: 'meeting.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 30,
      audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return done.meeting
}

const audioUrl = (m: Meeting) => `/api/meetings/${m.id}/audio`

/**
 * These assertions are the ONLY guard on range correctness. The headless browser
 * driver cannot substitute for them: the committed fixture is ~70 KB, which
 * Chromium buffers whole and then seeks within from memory, so it seeks happily
 * against a server that ignores Range entirely. Breaking the route deliberately
 * fails five tests here and none there.
 */
describe('GET /api/meetings/:id/audio', () => {
  it('serves the whole object when no range is asked for', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/ogg')
    expect(res.headers.get('content-length')).toBe(String(audio.byteLength))
    // Without this the browser treats the resource as unseekable even on a 200.
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(audio)
  })

  it('answers the open-ended range browsers open with, as 206', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=0-' } })

    // A 200 here is what silently breaks seeking.
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-${audio.byteLength - 1}/${audio.byteLength}`)
    expect(res.headers.get('content-length')).toBe(String(audio.byteLength))
  })

  it('serves exactly the requested window, from the right offset', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=1000-1099' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1099/${audio.byteLength}`)
    expect(res.headers.get('content-length')).toBe('100')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toHaveLength(100)
    expect(body).toEqual(audio.slice(1000, 1100))
  })

  it('serves a suffix range from the end of the object', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=-50' } })

    expect(res.status).toBe(206)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(audio.slice(-50))
  })

  it('clamps a range that runs past the end', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=4900-999999' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 4900-4999/${audio.byteLength}`)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(audio.slice(4900))
  })

  it('refuses a range beyond the object with 416 and the object size', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=99999-' } })

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${audio.byteLength}`)
  })

  it('never compresses the body, which would turn seeking off in Firefox', async () => {
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting), { headers: { 'accept-encoding': 'gzip, deflate, br' } })

    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('cache-control')).toContain('no-transform')
  })

  it('is cacheable but private, and carries a stable validator', async () => {
    const meeting = await uploadedMeeting()
    const first = await fetch(audioUrl(meeting))
    const second = await fetch(audioUrl(meeting))

    expect(first.headers.get('cache-control')).toContain('private')
    expect(first.headers.get('etag')).toBeTruthy()
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'))
  })

  it('pins the media type instead of reflecting what is stored', async () => {
    // On R2 the browser's PUT decides the object's content type and our
    // signature covers only the host, so an object can carry text/html.
    // Reflecting that would serve attacker-chosen markup from our own origin.
    const meeting = await uploadedMeeting()
    const metaPath = join(dataDir, 'audio', ...meeting.audioKey.split('/')) + '.meta'
    await writeFile(metaPath, JSON.stringify({ contentType: 'text/html', size: audio.byteLength }))

    const res = await fetch(audioUrl(meeting))
    expect(res.headers.get('content-type')).toContain('audio/ogg')
    expect(res.headers.get('content-type')).not.toContain('text/html')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('reports a zero-length object honestly rather than promising a byte', async () => {
    // An inclusive window cannot express "nothing"; rounding it to one byte
    // makes the client wait for a byte that will never arrive.
    const meeting = await uploadedMeeting()
    await writeFile(join(dataDir, 'audio', ...meeting.audioKey.split('/')), new Uint8Array())

    const res = await fetch(audioUrl(meeting))
    expect(res.headers.get('content-length')).toBe('0')
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('changes its validator when the bytes change but the length does not', async () => {
    const meeting = await uploadedMeeting()
    const before = (await fetch(audioUrl(meeting))).headers.get('etag')

    // Same length, different content: a size-derived validator would miss this.
    await new Promise(resolve => setTimeout(resolve, 1100))
    await writeFile(join(dataDir, 'audio', ...meeting.audioKey.split('/')), audio.map(b => b ^ 0xff))

    const after = (await fetch(audioUrl(meeting))).headers.get('etag')
    expect(before).toBeTruthy()
    expect(after).not.toBe(before)
  })

  it('never reflects a store-supplied validator that is not header-safe', async () => {
    // The stored content type is attacker-influenced on R2; a validator built
    // from it, or a malformed one from any store, must not reach the response.
    const meeting = await uploadedMeeting()
    const res = await fetch(audioUrl(meeting))
    const etag = res.headers.get('etag')!
    expect(etag).toMatch(/^(W\/)?"[\x21\x23-\x7e]*"$/)
    expect(etag).not.toContain('audio/ogg')
  })

  it('404s for an unknown meeting, a malformed id, and one with no audio yet', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio')).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/audio')).status).toBe(404)

    const { meeting } = await $fetch<CreateMeetingResponse>('/api/meetings', {
      method: 'POST',
      headers: inviteHeaders,
      body: {
        title: 'Never uploaded',
        sourceFileName: 'a.mp4',
        sourceBytes: 1,
        sourceMime: null,
        durationSec: null,
        audioBytes: 10,
      },
    })
    expect((await fetch(`/api/meetings/${meeting.id}/audio`)).status).toBe(404)
  })

  /**
   * The route takes the object's length from the meeting row rather than HEADing
   * storage on every request — on R2 that HEAD was a second billable Class B
   * operation per request, halving what this route can serve inside the free
   * allowance, and a round-trip on the critical path of every seek.
   *
   * `complete.post.ts` verified that length against storage, but an object stays
   * writable for as long as its presigned PUT lives, so it can be replaced by
   * something shorter afterwards. These two cover that divergence end to end;
   * shrinking the file on disk is the local driver's equivalent of that
   * replacement.
   */
  describe('when the stored object is shorter than the row says', () => {
    async function shrunkTo(bytes: number): Promise<Meeting> {
      const meeting = await uploadedMeeting()
      await truncate(join(dataDir, 'audio', 'meetings', meeting.id, 'audio.ogg'), bytes)
      return meeting
    }

    it('clamps a window that now runs past the end, and sends exactly what it promises', async () => {
      const meeting = await shrunkTo(100)

      const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=0-4999' } })

      expect(res.status).toBe(206)
      // Described by what was actually served, not by the stale length: a
      // content-length over the real body is a truncated response the client
      // cannot tell from a dropped connection.
      expect(res.headers.get('content-range')).toBe('bytes 0-99/100')
      expect(res.headers.get('content-length')).toBe('100')
      expect((await res.arrayBuffer()).byteLength).toBe(100)
    })

    it('answers 416 with the true length for a seek past the real end, not a 500', async () => {
      const meeting = await shrunkTo(100)

      const res = await fetch(audioUrl(meeting), { headers: { range: 'bytes=500-999' } })

      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */100')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
    })
  })
})
