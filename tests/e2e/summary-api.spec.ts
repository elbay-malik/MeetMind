import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { normalise } from '../../server/utils/summary/reconcile'
import type { CreateMeetingResponse, Meeting, MeetingSummary } from '../../shared/types/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-summary-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    // Makes the stub also emit one unsupported citation, so this suite can
    // prove reconciliation drops it over the real route rather than only in
    // reconcile()'s own unit tests. The stub's normal quotes are all real, so
    // without this nothing here ever exercises the drop path end to end.
    NUXT_SUMMARY_STUB_CANARY: 'true',
  },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

/** Take a meeting all the way to transcribed, which is what extraction needs. */
async function transcribedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title: 'Summary test',
      sourceFileName: 'meeting.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 10,
      audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
  return done.meeting
}

const summarize = (id: string) =>
  $fetch<{ meeting: Meeting, summary: MeetingSummary }>(`/api/meetings/${id}/summarize`, { method: 'POST' })

/** Reach past the repository interface to simulate the row being physically
 * gone — there is no application flow that deletes a summary directly. */
async function deleteStoredSummary(meetingId: string): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.removeItem(`summaries/${meetingId}`)
}

/** Simulate the retry cooldown having elapsed, without a real 60s wait. */
async function backdateUpdatedAt(id: string, msAgo: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, updatedAt: new Date(Date.now() - msAgo).toISOString() })
}

describe('POST /api/meetings/:id/summarize', () => {
  it('extracts a summary and advances the meeting to ready', async () => {
    const meeting = await transcribedMeeting()
    expect(meeting.status).toBe('summarizing')

    const { meeting: after, summary } = await summarize(meeting.id)

    expect(after.status).toBe('ready')
    expect(after.errorMessage).toBeNull()
    expect(summary.summary).not.toBe('')
    // Without a key the stub runs, and it must say so rather than pass as real.
    expect(summary.provider).toBe('stub')
  })

  it('cites a real transcript segment for every item', async () => {
    // The property that matters: nothing reaches storage that the transcript
    // does not support.
    const meeting = await transcribedMeeting()
    const { summary } = await summarize(meeting.id)
    const { segments } = await $fetch<{ segments: { idx: number, startMs: number, text: string }[] }>(
      `/api/meetings/${meeting.id}/transcript`,
    )

    const byIdx = new Map(segments.map(s => [s.idx, s]))
    for (const item of [...summary.decisions, ...summary.actionItems]) {
      const cited = byIdx.get(item.segmentIdx)
      expect(cited, `cited segment ${item.segmentIdx} does not exist`).toBeDefined()
      expect(item.startMs).toBe(cited!.startMs)
      // Same rule reconciliation itself checks against — a raw substring
      // check would reject a validly-stored quote that only differs from the
      // segment by punctuation (reconciliation normalizes both sides first).
      // The COMPLETE quote, not a prefix: only checking the first 20
      // characters would pass a citation whose spoken opening is real but
      // whose remaining words were fabricated.
      expect(normalise(cited!.text)).toContain(normalise(item.quote))
    }
  })

  it('drops a fabricated citation that does not occur in the transcript', async () => {
    // The stub (with the canary env on) always includes one item whose quote
    // is guaranteed absent from the transcript. If reconciliation's rejection
    // were ever disabled, this is what would catch it — over the real HTTP
    // route, not just inside reconcile()'s own unit tests.
    const meeting = await transcribedMeeting()
    const { summary } = await summarize(meeting.id)
    const texts = [...summary.decisions.map(d => d.decision), ...summary.actionItems.map(a => a.task)]
    expect(texts.some(t => t.includes('[canary]'))).toBe(false)
  })

  it('numbers items gaplessly and in time order', async () => {
    const meeting = await transcribedMeeting()
    const { summary } = await summarize(meeting.id)
    for (const list of [summary.decisions, summary.actionItems]) {
      expect(list.map(i => i.idx)).toEqual(list.map((_, i) => i))
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.startMs).toBeGreaterThanOrEqual(list[i - 1]!.startMs)
      }
    }
  })

  it('persists the summary for later reads', async () => {
    const meeting = await transcribedMeeting()
    const { summary } = await summarize(meeting.id)
    const stored = await $fetch<{ summary: MeetingSummary }>(`/api/meetings/${meeting.id}/summary`)
    expect(stored.summary).toEqual(summary)
  })

  it('is idempotent: a second call returns the stored summary', async () => {
    const meeting = await transcribedMeeting()
    const first = await summarize(meeting.id)
    const second = await summarize(meeting.id)
    expect(second.summary).toEqual(first.summary)
    expect(second.meeting.status).toBe('ready')
  })

  it('refuses a meeting with no transcript, without moving it', async () => {
    const { meeting } = await $fetch<CreateMeetingResponse>('/api/meetings', {
      method: 'POST',
      body: {
        title: 'No transcript',
        sourceFileName: 'a.mp4',
        sourceBytes: 1,
        sourceMime: null,
        durationSec: null,
        audioBytes: audio.byteLength,
      },
    })
    const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(409)

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('pending_upload')
    expect(after.errorMessage).toBeNull()
  })

  it('lets exactly one of several concurrent callers do the work', async () => {
    const meeting = await transcribedMeeting()
    const attempts = await Promise.allSettled([
      summarize(meeting.id), summarize(meeting.id), summarize(meeting.id),
    ])
    for (const loser of attempts.filter(a => a.status === 'rejected')) {
      expect((loser as PromiseRejectedResult).reason?.statusCode).toBe(409)
    }
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('ready')
  })

  it('does not hand out a stale summary while a fresh extraction is genuinely in progress', async () => {
    // Re-transcription cascades a stale summary's citations away but leaves
    // meeting_summaries itself in place (see ADR-0006), so a meeting mid a
    // FRESH extraction run can still have an old summary sitting in storage.
    // Simulates that exact shape directly, since there is no re-transcription
    // route yet to reach it through: complete one extraction, then move the
    // meeting back to `indexing` without touching the stored summary.
    const meeting = await transcribedMeeting()
    await summarize(meeting.id)
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.update(meeting.id, { status: 'indexing' })

    const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('repairs a ready meeting whose summary row is missing rather than getting stuck', async () => {
    // No route in this app ever deletes a summary row; this simulates the row
    // being gone some other way (manual intervention, a bug in something
    // else) to prove `ready` isn't a dead end once that happens: nothing else
    // can ever put a meeting back in `ready`, so reclaiming it here cannot
    // collide with another worker's legitimate progress.
    const meeting = await transcribedMeeting()
    await summarize(meeting.id)
    await deleteStoredSummary(meeting.id)

    const { summary: stillMissing } = await $fetch<{ summary: MeetingSummary | null }>(
      `/api/meetings/${meeting.id}/summary`,
    )
    expect(stillMissing).toBeNull()

    const { meeting: repaired, summary } = await summarize(meeting.id)
    expect(repaired.status).toBe('ready')
    expect(summary.summary).not.toBe('')
  })

  it('explains a cooldown-refused retry instead of claiming there is no transcript', async () => {
    // The generic conflict message used to say "it has no transcript ready to
    // summarise" even when the transcript was perfectly fine and the real
    // reason was the cooldown — exactly the case the progress page's "Try
    // extraction again" button reaches for a summarization failure.
    const meeting = await transcribedMeeting()
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.update(meeting.id, { status: 'failed', failedStage: 'summarization', errorMessage: 'boom' })

    const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.message).toMatch(/wait \d+s/)
    expect(body.message).not.toMatch(/no transcript/)

    await backdateUpdatedAt(meeting.id, 61_000)
    const { meeting: recovered } = await summarize(meeting.id)
    expect(recovered.status).toBe('ready')
  })

  it('404s for unknown and malformed ids', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/summarize', { method: 'POST' })).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/summarize', { method: 'POST' })).status).toBe(404)
  })
})

describe('GET /api/meetings/:id/summary', () => {
  it('returns null before extraction has run', async () => {
    const meeting = await transcribedMeeting()
    const { summary } = await $fetch<{ summary: MeetingSummary | null }>(`/api/meetings/${meeting.id}/summary`)
    expect(summary).toBeNull()
  })

  it('404s for an unknown meeting', async () => {
    expect((await fetch('/api/meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/summary')).status).toBe(404)
  })
})
