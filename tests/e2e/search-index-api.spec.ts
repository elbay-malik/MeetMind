import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, SearchIndexStatus, TranscriptSegment } from '../../shared/types/meeting'
import { driveTranscription } from './helpers/transcribe'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-index-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function uploadedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title: 'Index test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return done.meeting
}

async function transcribedMeeting(): Promise<Meeting> {
  const meeting = await uploadedMeeting()
  return (await driveTranscription(meeting.id)).meeting
}

const status = async (id: string) =>
  (await $fetch<{ index: SearchIndexStatus }>(`/api/meetings/${id}/search-index`)).index
const index = async (id: string) =>
  (await $fetch<{ index: SearchIndexStatus }>(`/api/meetings/${id}/search-index`, { method: 'POST' })).index

/** A transcript longer than the stub produces, so it plans into several windows. */
const longTranscript = (tag: string): TranscriptSegment[] =>
  Array.from({ length: 40 }, (_, i) => ({
    idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `${tag} line ${i} about subject ${i}`,
  }))

async function setStoredTranscript(meetingId: string, segments: TranscriptSegment[]): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meetingId}`, segments)
}

describe('search index', () => {
  it('is unavailable, and refuses to index, before transcription has finished', async () => {
    const meeting = await uploadedMeeting()
    expect(await status(meeting.id)).toMatchObject({ state: 'unavailable', windowCount: 0 })

    const res = await fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/no finished transcript/)
  })

  it('goes from none to ready once indexed, and names the stub model it used', async () => {
    const meeting = await transcribedMeeting()
    const before = await status(meeting.id)
    expect(before).toMatchObject({ state: 'none', indexedCount: 0, model: 'stub-hashed-tokens-v2' })
    expect(before.windowCount).toBeGreaterThan(0)

    const after = await index(meeting.id)
    expect(after).toEqual({ ...before, state: 'ready', indexedCount: before.windowCount })
    // Read back independently, not just the POST's own report.
    expect(await status(meeting.id)).toEqual(after)
  })

  it('is idempotent: indexing an indexed meeting again leaves it ready', async () => {
    const meeting = await transcribedMeeting()
    const first = await index(meeting.id)
    expect(await index(meeting.id)).toEqual(first)
  })

  it('reports a replaced transcript as incomplete, and indexing brings it back to ready', async () => {
    // The staleness is recomputed from the transcript on every read, so nothing
    // has to remember to mark the index out of date when the transcript changes.
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, longTranscript('before'))
    const ready = await index(meeting.id)
    expect(ready.state).toBe('ready')
    expect(ready.windowCount).toBeGreaterThan(1)

    await setStoredTranscript(meeting.id, longTranscript('after'))
    expect(await status(meeting.id)).toMatchObject({ state: 'incomplete', indexedCount: 0 })
    expect(await index(meeting.id)).toMatchObject({ state: 'ready', indexedCount: ready.windowCount })
  })

  it('is ready with zero windows for a silent recording', async () => {
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, [])
    expect(await index(meeting.id)).toEqual({
      state: 'ready', windowCount: 0, indexedCount: 0, model: 'stub-hashed-tokens-v2',
    })
  })

  it('lets concurrent requests for one meeting all finish with the same ready index', async () => {
    // A double click or a second tab joins the run already in flight. How many
    // windows were actually embedded is not observable from here; the unit
    // tests prove a repeat run spends nothing. What must hold is that every
    // caller gets a consistent, complete answer.
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, longTranscript('concurrent'))
    const results = await Promise.all([index(meeting.id), index(meeting.id), index(meeting.id)])
    for (const result of results) expect(result).toEqual(results[0])
    expect(results[0]!.state).toBe('ready')
  })

  it('404s for unknown and malformed ids', async () => {
    for (const method of ['GET', 'POST']) {
      expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/search-index', { method })).status).toBe(404)
      expect((await fetch('/api/meetings/not-a-uuid/search-index', { method })).status).toBe(404)
    }
  })
})
