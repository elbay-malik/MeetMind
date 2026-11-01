import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, TranscriptionStepResponse, TranscriptSegment } from '../../shared/types/meeting'
import { whisperReplyKey } from '../../shared/utils/meeting'
import { driveTranscription } from './helpers/transcribe'

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

const storedSegments = async (id: string) =>
  (await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${id}/transcript`)).segments

/** Drive transcription to the end, and read back the transcript it stored. */
const transcribe = async (id: string) => {
  const { meeting } = await driveTranscription(id)
  return { meeting, segments: await storedSegments(id) }
}

const replyPath = (id: string) => join(dataDir, 'audio', ...whisperReplyKey(id).split('/'))
const exists = (path: string) => access(path).then(() => true, () => false)

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

/** Put a meeting into an in-flight status with nothing actually running it —
 * the crashed/evicted worker the claim lease exists for. */
async function setStatus(id: string, status: Meeting['status']): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, status, updatedAt: new Date().toISOString() })
}

/** A run ledger as the local pipeline driver stores it, with one transcription step in flight. */
async function writeLedger(id: string, stepLeaseUntil: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`pipeline/${id}`, {
    runs: {
      transcription: {
        runId: crypto.randomUUID(), cursor: {}, stepToken: crypto.randomUUID(), stepLeaseUntil,
        attempts: 1, lastError: null, retryAt: null,
      },
    },
    chunks: [],
  })
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

  it('does one step per request: 202 with progress, then 200 once the transcript is stored', async () => {
    const meeting = await uploadedMeeting()

    const whisper = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(whisper.status).toBe(202)
    const first = (await whisper.json()) as TranscriptionStepResponse
    expect(first.meeting.status).toBe('transcribing')
    expect(first.next).toBe('continue')
    expect(first.retryAt).toBeNull()
    expect(first.retryAfterMs).toBeNull()
    expect(first.progress).toMatchObject({ done: 0, segments: 0, lastError: null })
    expect(first.progress.total).toBeGreaterThan(0)
    // The reply is stored unparsed, under the prefix the lifecycle rule covers.
    const raw = await readFile(replyPath(meeting.id), 'utf8')
    expect(raw).toContain('"segments"')
    expect(raw.length).toBe(first.progress.total)

    const page = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(page.status).toBe(202)
    const second = (await page.json()) as TranscriptionStepResponse
    expect(second.progress.segments).toBeGreaterThan(0)
    expect(second.progress.done).toBeGreaterThan(0)

    const last = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(last.status).toBe(200)
    expect(((await last.json()) as { meeting: Meeting }).meeting.status).toBe('summarizing')
    expect(await exists(replyPath(meeting.id))).toBe(false)
    expect((await storedSegments(meeting.id)).length).toBe(second.progress.segments)
  })

  it('tells a caller who finds a step live when to look again, and spends nothing', async () => {
    const meeting = await uploadedMeeting()
    await setStatus(meeting.id, 'transcribing')
    await writeLedger(meeting.id, Date.now() + 60_000)
    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(202)
    const step = (await res.json()) as TranscriptionStepResponse
    expect(step.next).toBe('wait')
    expect(step.retryAfterMs).toBeGreaterThan(0)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await exists(replyPath(meeting.id))).toBe(false)
  })

  it('persists the transcript for later reads', async () => {
    const meeting = await uploadedMeeting()
    const { segments } = await transcribe(meeting.id)
    expect(segments.length).toBeGreaterThan(0)
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

  it('lets several concurrent drivers converge on one transcript', async () => {
    const meeting = await uploadedMeeting()

    // Each step is claimed under a token, so they take turns rather than each
    // spend the provider's quota; the unit tier counts the provider calls.
    const results = await Promise.all([
      transcribe(meeting.id), transcribe(meeting.id), transcribe(meeting.id),
    ])
    for (const { meeting: after } of results) expect(after.status).toBe('summarizing')

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('summarizing')
    const segments = await storedSegments(meeting.id)
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

  // The first test of what PAST_TRANSCRIPTION has always promised (ADR-0012 §3).
  it.each(['summarizing', 'indexing', 'ready'] as const)('never replaces the transcript of a %s meeting', async (status) => {
    const meeting = await uploadedMeeting()
    const finished: TranscriptSegment[] = [{ idx: 0, startMs: 0, endMs: 900, text: 'The real, finished transcript.' }]
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    await storage.setItem(`transcripts/${meeting.id}`, finished)
    await setStatus(meeting.id, status)

    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { meeting: Meeting }).meeting.status).toBe(status)
    expect(await storedSegments(meeting.id)).toEqual(finished)
    expect(await exists(replyPath(meeting.id))).toBe(false)
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

  it('reclaims a transcribing meeting whose step is gone, once its lease has expired', async () => {
    const meeting = await uploadedMeeting()
    await setStatus(meeting.id, 'transcribing')

    // Inside the step's lease: a live worker must not be trampled. Told to look
    // again rather than refused: it may well be alive and about to finish.
    await writeLedger(meeting.id, Date.now() + 60_000)
    const tooSoon = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(tooSoon.status).toBe(202)
    expect(((await tooSoon.json()) as TranscriptionStepResponse).next).toBe('wait')

    await writeLedger(meeting.id, Date.now() - 1000)
    const { meeting: recovered, segments } = await transcribe(meeting.id)
    expect(recovered.status).toBe('summarizing')
    expect(segments.length).toBeGreaterThan(0)
  })

  it('takes over a transcribing meeting that holds no step at all, at once', async () => {
    // What a meeting left by the old blocking route looks like after a deploy.
    const meeting = await uploadedMeeting()
    await setStatus(meeting.id, 'transcribing')
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

  // Only the progress page asks for the next step, so nothing is running here.
  it('does not tell the meeting page a paused run is running, or that part of a transcript is all of it', async () => {
    const { id } = await uploadedMeeting()
    const step = () => fetch(`/api/meetings/${id}/transcribe`, { method: 'POST' })
    const page = async () => (await fetch(`/meetings/${id}`)).text()

    expect((await step()).status).toBe(202)
    const none = await page()
    expect(none).not.toContain('Transcription is running')
    expect(none).toContain('Transcription is not finished')

    expect((await step()).status).toBe(202)
    const partial = await page()
    expect(partial).toMatch(/2(<!--.*?-->)? transcript segments so far/)
    expect(partial).toContain('This transcript is not finished')

    expect((await step()).status).toBe(200)
    const finished = await page()
    expect(finished).not.toContain('so far')
    expect(finished).not.toContain('This transcript is not finished')
  })
})
