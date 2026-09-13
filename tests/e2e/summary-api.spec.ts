import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
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
      expect(cited!.text.toLowerCase()).toContain(item.quote.toLowerCase().slice(0, 20))
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
