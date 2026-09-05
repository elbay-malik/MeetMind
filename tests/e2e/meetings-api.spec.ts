import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting } from '../../shared/types/meeting'
import { MAX_AUDIO_BYTES } from '../../shared/utils/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

// Each run gets its own data root so the local drivers never touch ./.data.
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-e2e-'))

await setup({
  rootDir,
  // The app is built by `pnpm test:e2e` beforehand (building inside vitest
  // trips a CJS/ESM interop bug in the Vue SFC compiler), so run the server
  // straight from the regular .output directory.
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
  },
})

const audio = new Uint8Array(4096).map((_, i) => i % 251)

const validBody = {
  title: 'Weekly sync',
  sourceFileName: 'weekly-sync.mp4',
  sourceBytes: 1_045_800_000,
  sourceMime: 'video/mp4',
  durationSec: 3600,
  audioBytes: audio.byteLength,
}

async function register(overrides: Partial<typeof validBody> = {}) {
  return $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: { ...validBody, ...overrides },
  })
}

function putAudio(url: string, body: Uint8Array, contentType = 'audio/ogg') {
  return fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body })
}

const audioPath = (m: Meeting) => join(dataDir, 'audio', ...m.audioKey.split('/'))

describe('POST /api/meetings', () => {
  it('registers a pending meeting and issues a local upload URL', async () => {
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(201)
    const { meeting, upload } = (await res.json()) as CreateMeetingResponse
    expect(meeting.status).toBe('pending_upload')
    expect(meeting.title).toBe('Weekly sync')
    expect(meeting.audioBytes).toBe(audio.byteLength)
    expect(meeting.audioMime).toBe('audio/ogg')
    expect(meeting.audioKey).toBe(`meetings/${meeting.id}/audio.ogg`)
    expect(meeting.uploadedAt).toBeNull()
    expect(upload.method).toBe('PUT')
    expect(upload.url).toMatch(/^\/api\/uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(upload.headers['content-type']).toBe('audio/ogg')
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('rejects malformed payloads', async () => {
    for (const body of [
      { ...validBody, audioBytes: MAX_AUDIO_BYTES + 1 },
      { ...validBody, audioBytes: 0 },
      { ...validBody, title: '' },
      { ...validBody, extra: true },
      {},
    ]) {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('upload → complete', () => {
  it('stores the audio, verifies it and marks the meeting uploaded', async () => {
    const { meeting, upload } = await register()

    const put = await putAudio(upload.url, audio)
    expect(put.status).toBe(204)

    const stored = await readFile(audioPath(meeting))
    expect(stored.byteLength).toBe(audio.byteLength)
    expect(Buffer.from(audio).equals(stored)).toBe(true)

    const { meeting: done } = await $fetch<{ meeting: Meeting }>(
      `/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    expect(done.status).toBe('uploaded')
    expect(done.uploadedAt).not.toBeNull()
    expect(done.errorMessage).toBeNull()

    const { meeting: fetched } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(fetched).toEqual(done)

    const { meetings } = await $fetch<{ meetings: Meeting[] }>('/api/meetings')
    expect(meetings.map(m => m.id)).toContain(meeting.id)
    expect(meetings[0]!.createdAt >= meetings.at(-1)!.createdAt).toBe(true)
  })

  it('completing twice is idempotent', async () => {
    const { meeting, upload } = await register()
    await putAudio(upload.url, audio)
    const first = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    const second = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    expect(second.meeting).toEqual(first.meeting)
  })

  it('refuses to complete before the audio arrived', async () => {
    const { meeting } = await register()
    const res = await fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    expect(res.status).toBe(409)
    const { meeting: still } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(still.status).toBe('pending_upload')
  })

  it('deletes a stored object whose size differs from the declaration and fails the meeting', async () => {
    const { meeting } = await register()
    // Bypass the guarded upload route: plant an object of the wrong size.
    const path = audioPath(meeting)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, new Uint8Array(audio.byteLength + 1))
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: 'audio/ogg', size: audio.byteLength + 1 }))

    const res = await fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    expect(res.status).toBe(409)
    await expect(stat(path)).rejects.toThrow()
    const { meeting: failed } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(failed.status).toBe('failed')
    expect(failed.errorMessage).toMatch(/expected 4096/)

    // A failed meeting cannot be resurrected by uploading afterwards.
    const again = await fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
    expect(again.status).toBe(409)
  })
})

describe('PUT /api/uploads/:token (local store guard rails)', () => {
  it('rejects forged or malformed tokens', async () => {
    const { upload } = await register()
    const [body, mac] = upload.url.split('/').at(-1)!.split('.') as [string, string]
    const forged = `${body}.${mac.slice(0, -2)}AA`
    expect((await putAudio(`/api/uploads/${forged}`, audio)).status).toBe(403)
    expect((await putAudio('/api/uploads/garbage', audio)).status).toBe(403)
  })

  it('rejects the wrong media type', async () => {
    const { meeting, upload } = await register()
    expect((await putAudio(upload.url, audio, 'video/mp4')).status).toBe(400)
    await expect(stat(audioPath(meeting))).rejects.toThrow()
  })

  it('requires a Content-Length header (no chunked bodies)', async () => {
    const { meeting, upload } = await register()
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(audio)
        controller.close()
      },
    })
    const res = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'audio/ogg' },
      body: chunked,
      // @ts-expect-error -- undici needs duplex for stream bodies; not in lib.dom's RequestInit
      duplex: 'half',
    })
    expect(res.status).toBe(411)
    await expect(stat(audioPath(meeting))).rejects.toThrow()
  })

  it('rejects a body whose size does not match the grant', async () => {
    const { meeting, upload } = await register()
    expect((await putAudio(upload.url, audio.slice(0, 100))).status).toBe(413)
    expect((await putAudio(upload.url, new Uint8Array(audio.byteLength + 7))).status).toBe(413)
    await expect(stat(audioPath(meeting))).rejects.toThrow()
    expect((await fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })).status).toBe(409)
  })
})

describe('GET /api/meetings/:id', () => {
  it('404s for unknown and malformed ids', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid')).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/complete', { method: 'POST' })).status).toBe(404)
  })
})
