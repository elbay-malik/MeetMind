import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, TranscriptSegment } from '../../shared/types/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-transcribe-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

/** Register a meeting, upload its audio and confirm it — the Phase 3 flow. */
async function uploadedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title: 'Transcription test',
      sourceFileName: 'meeting.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 10,
      audioBytes: audio.byteLength,
    },
  })
  const put = await fetch(upload.url, {
    method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio,
  })
  expect(put.status).toBe(204)
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return done.meeting
}

const transcribe = (id: string) =>
  $fetch<{ meeting: Meeting, segments: TranscriptSegment[] }>(`/api/meetings/${id}/transcribe`, { method: 'POST' })

describe('POST /api/meetings/:id/transcribe', () => {
  it('transcribes uploaded audio and advances the meeting', async () => {
    const meeting = await uploadedMeeting()
    expect(meeting.status).toBe('uploaded')

    const { meeting: after, segments } = await transcribe(meeting.id)

    expect(after.status).toBe('summarizing')
    expect(after.errorMessage).toBeNull()
    expect(segments.length).toBeGreaterThan(0)
    // Stored segments must satisfy the same invariants the database enforces.
    for (const [i, s] of segments.entries()) {
      expect(s.idx).toBe(i)
      expect(s.startMs).toBeGreaterThanOrEqual(0)
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs)
      expect(s.text.trim()).not.toBe('')
    }
  })

  it('persists the transcript for later reads', async () => {
    const meeting = await uploadedMeeting()
    const { segments } = await transcribe(meeting.id)
    const stored = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(stored.segments).toEqual(segments)
  })

  it('is idempotent: a second call returns the stored transcript unchanged', async () => {
    const meeting = await uploadedMeeting()
    const first = await transcribe(meeting.id)
    const second = await transcribe(meeting.id)
    expect(second.segments).toEqual(first.segments)
    expect(second.meeting.status).toBe('summarizing')
  })

  it('refuses a meeting whose audio never arrived', async () => {
    const { meeting } = await $fetch<CreateMeetingResponse>('/api/meetings', {
      method: 'POST',
      body: {
        title: 'Never uploaded',
        sourceFileName: 'a.mp4',
        sourceBytes: 1,
        sourceMime: null,
        durationSec: null,
        audioBytes: audio.byteLength,
      },
    })
    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(409)

    // The meeting must not be left claimed as transcribing.
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('pending_upload')
  })

  it('404s for unknown and malformed ids', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/transcribe', { method: 'POST' })).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/transcribe', { method: 'POST' })).status).toBe(404)
  })

  it('never leaves two concurrent callers both transcribing', async () => {
    const meeting = await uploadedMeeting()
    const results = await Promise.allSettled([transcribe(meeting.id), transcribe(meeting.id)])
    const ok = results.filter(r => r.status === 'fulfilled')
    // Whichever interleaving happens, the meeting ends up transcribed exactly
    // once and never stuck mid-claim.
    expect(ok.length).toBeGreaterThanOrEqual(1)
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('summarizing')
    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(segments.map(s => s.idx)).toEqual(segments.map((_, i) => i))
  })
})

describe('GET /api/meetings/:id/transcript', () => {
  it('returns an empty transcript before transcription has run', async () => {
    const meeting = await uploadedMeeting()
    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(segments).toEqual([])
  })

  it('404s for an unknown meeting', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/transcript')).status).toBe(404)
  })
})
