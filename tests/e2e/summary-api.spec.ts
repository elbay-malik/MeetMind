import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { quoteStartsAt } from '../../server/utils/summary/reconcile'
import type { CreateMeetingResponse, ExtractionStepResponse, Meeting, MeetingSummary, TranscriptSegment } from '../../shared/types/meeting'

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

/** One extraction step: a 200 when done, a 202 with progress otherwise. */
async function step(id: string): Promise<{ status: number, body: unknown }> {
  const res = await fetch(`/api/meetings/${id}/summarize`, { method: 'POST' })
  return { status: res.status, body: await res.json() }
}

/**
 * Drive extraction to the end, as the progress page does: one step per
 * request, waiting (shortened here) when told to. A refusal or failure rejects
 * with its status code, like `$fetch` would.
 */
async function summarize(id: string): Promise<{ meeting: Meeting, summary: MeetingSummary }> {
  for (let i = 0; i < 50; i++) {
    const { status, body } = await step(id)
    if (status === 200) return body as { meeting: Meeting, summary: MeetingSummary }
    if (status !== 202) throw Object.assign(new Error(JSON.stringify(body)), { statusCode: status })
    const progress = body as ExtractionStepResponse
    if (progress.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(progress.retryAfterMs ?? 0, 6000) + 20))
  }
  throw new Error(`extraction of ${id} did not finish in 50 steps`)
}

/** Reach past the repository interface to simulate the row being physically
 * gone — there is no application flow that deletes a summary directly. */
async function deleteStoredSummary(meetingId: string): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.removeItem(`summaries/${meetingId}`)
}

/** Reach past the repository interface to replace a meeting's whole stored
 * transcript, for shapes the stub transcriber cannot produce on its own
 * (silence, or a transcript needing more than MAX_CHUNKS requests). */
async function setStoredTranscript(meetingId: string, segments: TranscriptSegment[]): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meetingId}`, segments)
}

/** Simulate a silent recording: transcription completed but found no speech.
 * The stub transcriber always produces at least one segment, so this reaches
 * past it directly rather than needing a real silent fixture. */
const emptyTheTranscript = (meetingId: string) => setStoredTranscript(meetingId, [])

/** Simulate the retry cooldown having elapsed, without a real 60s wait. */
async function backdateUpdatedAt(id: string, msAgo: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, updatedAt: new Date(Date.now() - msAgo).toISOString() })
}

describe('POST /api/meetings/:id/summarize', () => {
  it('answers 202 with progress while steps remain, starting with the plan', async () => {
    const meeting = await transcribedMeeting()
    const { status, body } = await step(meeting.id)
    expect(status).toBe(202)
    const progress = body as ExtractionStepResponse
    expect(progress.meeting.status).toBe('indexing')
    expect(progress.progress).toEqual({ done: 0, total: 1, lastError: null })
    expect(progress.next).toBe('continue')
    expect(progress.retryAt).toBeNull()
    expect(progress.retryAfterMs).toBeNull()
  })

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
    const items = [...summary.decisions, ...summary.actionItems]
    // Without this the loop below is skipped entirely on an empty summary, so a
    // regression that drops EVERY item — attestQuote always null — passed.
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      const cited = byIdx.get(item.segmentIdx)
      expect(cited, `cited segment ${item.segmentIdx} does not exist`).toBeDefined()
      expect(item.startMs).toBe(cited!.startMs)
      // The IDENTICAL contract reconciliation itself checks against, not an
      // approximation of it: a plain normalise().includes() both accepts a
      // mid-word fabrication ("approved" inside "disapproved") and rejects a
      // legitimate no-space-script citation that differs from the transcript
      // only by punctuation — the two bugs occurs() exists to avoid,
      // reintroduced here if this check does not share its exact rules. And a
      // quote may run on into the next segment, so it is checked from where it
      // begins rather than against the one segment's text.
      expect(quoteStartsAt(segments, item.segmentIdx, item.quote)).toBe(true)
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
    // And the drop must be SELECTIVE. `[].some()` is false, so a regression
    // that rejected every citation — the opposite failure — passed this test
    // too. The stub's real, verbatim quotes have to survive alongside it.
    expect(summary.decisions.length).toBeGreaterThan(0)
    expect(summary.decisions.every(d => d.decision.startsWith('[stub]'))).toBe(true)
  })

  it('numbers items gaplessly and in time order', async () => {
    const meeting = await transcribedMeeting()
    const { summary } = await summarize(meeting.id)
    for (const list of [summary.decisions, summary.actionItems]) {
      // `[]` equals `[]` and the ordering loop never runs on fewer than two
      // items, so without this an empty result passed as "ordered".
      expect(list.length).toBeGreaterThanOrEqual(2)
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
    // The stub is deterministic, so recomputing from scratch would produce an
    // identical object and pass a plain equality check. Change what is STORED
    // and require the second call to hand that back, not a fresh extraction.
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    const marked = { ...first.summary, summary: 'marker: served from storage' }
    await storage.setItem(`summaries/${meeting.id}`, marked)

    const second = await summarize(meeting.id)
    expect(second.summary.summary).toBe('marker: served from storage')
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

  it('converges concurrent drivers on one stored summary', async () => {
    // Each step is claimed under a token, so concurrent drivers take turns
    // rather than refuse each other: every one of them reaches the end. That
    // each chunk is extracted exactly once is proven where the provider calls
    // can be counted, in extraction-steps.spec.ts.
    const meeting = await transcribedMeeting()
    const results = await Promise.all([summarize(meeting.id), summarize(meeting.id), summarize(meeting.id)])
    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('ready')
    const { summary: stored } = await $fetch<{ summary: MeetingSummary }>(`/api/meetings/${meeting.id}/summary`)
    for (const result of results) expect(result.summary).toEqual(stored)
  })

  it('does not hand out a stale summary while a fresh extraction is in progress', async () => {
    // Re-transcription cascades a stale summary's citations away but leaves
    // meeting_summaries itself in place (see ADR-0006), so a meeting mid a
    // FRESH extraction can still have an old summary sitting in storage. There
    // is no re-transcription route yet, so this puts the meeting back where one
    // would leave it -- transcribed, summary row untouched -- and marks the old
    // summary so a stale answer would show.
    const meeting = await transcribedMeeting()
    await summarize(meeting.id)
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    const old = await storage.getItem<MeetingSummary>(`summaries/${meeting.id}`)
    await storage.setItem(`summaries/${meeting.id}`, { ...old, summary: 'stale summary from before' })
    await createLocalMeetingRepository({ dataDir }).update(meeting.id, { status: 'summarizing' })

    const first = await step(meeting.id)
    expect(first.status).toBe(202)
    expect(JSON.stringify(first.body)).not.toContain('stale summary from before')
    const { summary } = await summarize(meeting.id)
    expect(summary.summary).not.toBe('stale summary from before')
  })

  it('finishes a silent recording with an empty summary instead of getting stuck in summarizing', async () => {
    // A meeting that finished transcription with zero segments (real
    // silence) is a valid outcome, not "not ready yet" — refusing it here
    // left it permanently stuck in `summarizing`, since nothing else ever
    // moves a meeting out of that status once transcription has already
    // completed.
    const meeting = await transcribedMeeting()
    await emptyTheTranscript(meeting.id)

    const { meeting: after, summary } = await summarize(meeting.id)
    expect(after.status).toBe('ready')
    expect(summary.decisions).toEqual([])
    expect(summary.actionItems).toEqual([])
  })

  it('persists a diagnosable failure for a too-long transcript instead of a silent stuck state', async () => {
    // The chunk-count limit used to throw 413 before ever claiming the
    // meeting, so nothing was ever persisted — the meeting stayed in
    // `summarizing` forever, and every future call hit the exact same 413
    // with no visible error and no way to resolve it. Each segment here is
    // already over CHUNK_BUDGET_TOKENS alone, so planChunks gives each its
    // own chunk regardless of packing — 41 of them clears MAX_CHUNKS (40).
    const meeting = await transcribedMeeting()
    const bigText = Array.from({ length: 4000 }, () => 'word').join(' ')
    const tooLong: TranscriptSegment[] = Array.from({ length: 41 }, (_, i) => ({
      idx: i, startMs: i * 1000, endMs: i * 1000 + 900, text: bigText,
    }))
    await setStoredTranscript(meeting.id, tooLong)

    const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(413)

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe('failed')
    expect(after.failedStage).toBe('summarization')
    expect(after.errorMessage).toMatch(/too long|sequential requests/i)
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
