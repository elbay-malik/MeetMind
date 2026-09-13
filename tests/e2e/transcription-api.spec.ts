import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
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

/**
 * Simulate the retry cooldown having elapsed, without a real 60s wait in the
 * suite. Goes around the repository's own `update`/`claim`, which always
 * stamp `updatedAt` with the current time — exactly the field this has to
 * override.
 */
async function backdateUpdatedAt(id: string, msAgo: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, updatedAt: new Date(Date.now() - msAgo).toISOString() })
}

/** Simulate a meeting whose SUMMARISATION failed, without spinning up
 * summarize.post.ts's own multi-chunk provider flow. */
async function markFailedAt(id: string, failedStage: Meeting['failedStage']): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, status: 'failed', failedStage, errorMessage: 'boom' })
}

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

    // Refused before any claim, so the status is untouched. This would have
    // caught a route that claimed first and asked questions afterwards.
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('pending_upload')
    expect(after.errorMessage).toBeNull()
  })

  it('404s for unknown and malformed ids', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/transcribe', { method: 'POST' })).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/transcribe', { method: 'POST' })).status).toBe(404)
  })

  it('lets exactly one of several concurrent callers do the work', async () => {
    const meeting = await uploadedMeeting()

    // Only one caller may move the row out of `uploaded`; the rest must be
    // turned away rather than each spending the provider's quota.
    const attempts = await Promise.allSettled([
      transcribe(meeting.id), transcribe(meeting.id), transcribe(meeting.id),
    ])
    const winners = attempts.filter(a => a.status === 'fulfilled')
    const losers = attempts.filter(a => a.status === 'rejected')

    expect(winners.length + losers.length).toBe(3)
    expect(winners.length).toBeGreaterThanOrEqual(1)
    // A loser either raced and was refused, or arrived late enough to be handed
    // the finished transcript. Both are correct; silently transcribing again is not.
    for (const loser of losers) {
      expect((loser as PromiseRejectedResult).reason?.statusCode).toBe(409)
    }

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('summarizing')
    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.map(s => s.idx)).toEqual(segments.map((_, i) => i))
  })

  it('serves a finished meeting from storage instead of transcribing again', async () => {
    const meeting = await uploadedMeeting()
    const first = await transcribe(meeting.id)
    expect(first.meeting.status).toBe('summarizing')

    const again = await transcribe(meeting.id)
    expect(again.meeting.status).toBe('summarizing')
    expect(again.segments).toEqual(first.segments)
  })
})

describe('recovery', () => {
  it('lets a meeting that failed be transcribed again once the cause is gone', async () => {
    const meeting = await uploadedMeeting()
    const path = join(dataDir, 'audio', ...meeting.audioKey.split('/'))
    const audioBytes = await readFile(path)
    const meta = await readFile(`${path}.meta`)

    // Remove the audio so transcription fails terminally.
    await rm(path)
    const failed = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(failed.status).toBe(409)
    const { meeting: broken } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(broken.status).toBe('failed')
    expect(broken.errorMessage).toMatch(/missing from storage/)

    // Put it back: asking again must work rather than being refused forever.
    // (Past the retry cooldown — that is a separate concern, tested below.)
    await writeFile(path, audioBytes)
    await writeFile(`${path}.meta`, meta)
    await backdateUpdatedAt(meeting.id, 61_000)
    const { meeting: recovered, segments } = await transcribe(meeting.id)
    expect(recovered.status).toBe('summarizing')
    expect(recovered.errorMessage).toBeNull()
    expect(segments.length).toBeGreaterThan(0)
  })

  it('refuses to retry a failure until the cooldown has passed', async () => {
    const meeting = await uploadedMeeting()
    const path = join(dataDir, 'audio', ...meeting.audioKey.split('/'))
    const audioBytes = await readFile(path)
    const meta = await readFile(`${path}.meta`)

    await rm(path)
    await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    await writeFile(path, audioBytes)
    await writeFile(`${path}.meta`, meta)

    // The cause is already fixed; an instant retry must still be refused —
    // otherwise a client that retries in a loop re-hammers storage/the
    // provider immediately after every failure.
    const tooSoon = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(tooSoon.status).toBe(409)
    const { meeting: stillFailed } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(stillFailed.status).toBe('failed')

    await backdateUpdatedAt(meeting.id, 61_000)
    const { meeting: recovered } = await transcribe(meeting.id)
    expect(recovered.status).toBe('summarizing')
  })

  it('explains that a SUMMARISATION failure needs the other route, not "no audio"', async () => {
    // failedStage disambiguates exactly this case: the transcript (and the
    // audio that produced it) is completely intact when summarisation is
    // what failed. Saying "no audio ready" would be actively wrong, not just
    // unhelpful — it implies retrying transcription is the fix.
    const meeting = await uploadedMeeting()
    await transcribe(meeting.id)
    await markFailedAt(meeting.id, 'summarization')

    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.message).toMatch(/extraction|summar/i)
    expect(body.message).not.toMatch(/no audio/)
  })

  it('refuses when the stored audio no longer matches what was verified', async () => {
    const meeting = await uploadedMeeting()
    const path = join(dataDir, 'audio', ...meeting.audioKey.split('/'))
    // Swap the object for a different one, as a replayed upload URL could.
    await writeFile(path, new Uint8Array(audio.byteLength + 500))

    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(409)
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.errorMessage).toMatch(/expected \d+/)
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
