import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting } from '../../shared/types/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-audio-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

// Distinct bytes so a served window can be checked against its offset.
const audio = new Uint8Array(5000).map((_, i) => i % 251)

async function uploadedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
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

  it('404s for an unknown meeting, a malformed id, and one with no audio yet', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio')).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/audio')).status).toBe(404)

    const { meeting } = await $fetch<CreateMeetingResponse>('/api/meetings', {
      method: 'POST',
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
})
