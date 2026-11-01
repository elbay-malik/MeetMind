import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingStatus, TranscriptSegment } from '../../shared/types/meeting'
import { whisperReplyKey } from '../../shared/utils/meeting'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { createLocalPipelineRepository } from '../../server/utils/db/pipeline-local'
import { createLocalSlotRepository } from '../../server/utils/db/slots-local'
import { createLocalSummaryRepository } from '../../server/utils/db/summaries-local'
import { createLocalTranscriptRepository } from '../../server/utils/db/transcripts-local'
import { createLocalAudioStore } from '../../server/utils/storage/local'
import { CHUNK_BUDGET_TOKENS } from '../../server/utils/summary/groq'
import { planChunks } from '../../server/utils/summary/plan'
import { advanceExtraction, MAX_CHUNKS, MAX_STEP_ATTEMPTS, RETRY_COOLDOWN_MS, RETRYABLE_PARK_MS } from '../../server/utils/summary/steps'
import { createStubSummarizer } from '../../server/utils/summary/stub'
import { normalizeSegments } from '../../server/utils/transcription/normalize'
import {
  advanceTranscription,
  MAX_PAGE_BYTES,
  MAX_WHISPER_ATTEMPTS,
  PAGE_BYTES,
  PAGE_STEP_LEASE_MS,
  SEGMENTS_PER_PAGE,
  WHISPER_STEP_LEASE_MS,
  type TranscriptionDeps,
  type TranscriptionOutcome,
} from '../../server/utils/transcription/steps'
import { TranscriptionError, type Transcriber } from '../../server/utils/transcription/transcriber'

/**
 * Step-wise transcription (ADR-0012, step 7) against the local drivers: one
 * Whisper call, then one step per page of its stored reply, then the step that
 * hands over to extraction with the plan already written.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-tsteps-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const db = () => createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
const store = () => createLocalAudioStore({ dataDir, secret: 'test' })
const repos = () => ({
  meetings: createLocalMeetingRepository({ dataDir }),
  pipeline: createLocalPipelineRepository({ dataDir }),
  transcripts: createLocalTranscriptRepository({ dataDir }),
  summaries: createLocalSummaryRepository({ dataDir }),
  slots: createLocalSlotRepository({ dataDir: join(dataDir, randomUUID()) }),
})

const AUDIO = new Uint8Array(500).fill(7)

async function newMeeting(status: MeetingStatus = 'uploaded', patch: Partial<Meeting> = {}): Promise<Meeting> {
  const id = randomUUID()
  const meeting = await repos().meetings.create({
    id,
    title: 'Planning',
    status,
    sourceFileName: 'planning.m4a',
    sourceBytes: 1000,
    sourceMime: 'audio/mp4',
    durationSec: 180,
    audioKey: `meetings/${id}/audio.ogg`,
    audioBytes: AUDIO.byteLength,
    audioMime: 'audio/ogg',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
    failedStage: null,
    ...patch,
  })
  await store().put(meeting.audioKey, AUDIO, 'audio/ogg')
  return meeting
}

/** Segments in Whisper's own shape, with its extra fields. */
function whisperSegments(count: number, words = 12) {
  return Array.from({ length: count }, (_, i) => ({
    id: i, seek: i * 100, start: i * 2, end: i * 2 + 1.5,
    text: ` Line ${i} ${Array.from({ length: words }, (_, w) => `word${w}`).join(' ')}.`,
    tokens: [1, 2, 3, 4], temperature: 0, avg_logprob: -0.1, compression_ratio: 1.2, no_speech_prob: 0.01,
  }))
}

const replyOf = (segments: { end?: unknown }[]) => new TextEncoder().encode(JSON.stringify({
  task: 'transcribe', language: 'english',
  duration: Math.max(0, ...segments.map(s => (typeof s.end === 'number' ? s.end : 0))),
  text: 'the whole transcript', segments, x_groq: { id: 'req_1' },
}))

/** A transcriber that answers with `reply`, counting calls and throwing whatever a test queues. */
function scripted(reply: Uint8Array = replyOf(whisperSegments(5))) {
  const queued: unknown[] = []
  let calls = 0
  const transcriber: Transcriber = {
    kind: 'stub',
    async transcribe() {
      calls++
      const failure = queued.shift()
      if (failure) throw failure
      return reply
    },
  }
  return { transcriber, calls: () => calls, queue: (...errors: unknown[]) => queued.push(...errors) }
}

function clock() {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    advance: (ms: number) => {
      offset += ms
    },
  }
}

function depsWith(transcriber: Transcriber, time = clock()): TranscriptionDeps & { time: ReturnType<typeof clock>, slots: ReturnType<typeof repos>['slots'] } {
  const { meetings, pipeline, slots } = repos()
  return { meetings, pipeline, slots, store: store(), transcriber, now: time.now, time }
}

const rejects = (message: string) => () => Promise.reject(new Error(message))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Call until the run is done or stops, as the progress page does. Returns every outcome. */
async function drive(id: string, deps: ReturnType<typeof depsWith>, maxSteps = 400): Promise<TranscriptionOutcome[]> {
  const outcomes: TranscriptionOutcome[] = []
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await advanceTranscription(id, deps)
    outcomes.push(outcome)
    if (outcome.kind !== 'progress') return outcomes
    if (outcome.next === 'wait') {
      if (outcome.retryAt!.getTime() - deps.time.now() > 2500) deps.time.advance(outcome.retryAt!.getTime() - deps.time.now() + 1)
      else await sleep(5)
    }
  }
  throw new Error(`did not finish in ${maxSteps} steps`)
}

const run = async (id: string) => (await repos().pipeline.listRuns(id)).find(r => r.stage === 'transcription')
const getMeeting = async (id: string) => (await repos().meetings.get(id))!
const transcript = (id: string) => repos().transcripts.listForMeeting(id)
const replyStored = async (id: string) => (await store().head(whisperReplyKey(id))) !== null

/** Move the meeting's and the run's stamps back, past a cooldown or a lease. */
async function expireLease(id: string) {
  const s = db()
  const ledger = (await s.getItem<{ runs: { transcription: { stepLeaseUntil: number | null } } }>(`pipeline/${id}`))!
  ledger.runs.transcription.stepLeaseUntil = Date.now() - 1000
  await s.setItem(`pipeline/${id}`, ledger)
}

describe('the happy path', () => {
  it('makes one provider call, stores every line, and hands over to extraction', async () => {
    const script = scripted()
    const deps = depsWith(script.transcriber)
    const m = await newMeeting()
    const outcomes = await drive(m.id, deps)

    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing', errorMessage: null, failedStage: null } })
    expect(script.calls()).toBe(1)
    const stored = await transcript(m.id)
    expect(stored.map(s => s.idx)).toEqual([0, 1, 2, 3, 4])
    expect(stored[1]).toMatchObject({ startMs: 2000, endMs: 3500 })
    expect(stored[0]!.text.startsWith('Line 0')).toBe(true)
  })

  it('answers progress between steps: first the reply\'s size, then how much of it is read', async () => {
    const reply = replyOf(whisperSegments(5))
    const deps = depsWith(scripted(reply).transcriber)
    const m = await newMeeting()
    const first = await advanceTranscription(m.id, deps)
    expect(first).toMatchObject({
      kind: 'progress',
      meeting: { status: 'transcribing' },
      next: 'continue',
      progress: { done: 0, total: reply.byteLength, segments: 0, lastError: null },
    })
    const second = await advanceTranscription(m.id, deps)
    expect(second).toMatchObject({ kind: 'progress', progress: { total: reply.byteLength, segments: 5 } })
    expect((second as { progress: { done: number } }).progress.done).toBeGreaterThan(0)
  })

  it('stores the raw reply under meetings/ until the last page, then removes it', async () => {
    const deps = depsWith(scripted().transcriber)
    const m = await newMeeting()
    await advanceTranscription(m.id, deps)
    expect(whisperReplyKey(m.id).startsWith(`meetings/${m.id}/`)).toBe(true)
    expect(await replyStored(m.id)).toBe(true)
    await drive(m.id, deps)
    expect(await replyStored(m.id)).toBe(false)
  })

  it('reads a segment split across a page boundary, and multi-byte text cut by one', async () => {
    // Long enough that page boundaries land inside objects, characters included.
    const segments = Array.from({ length: 400 }, (_, i) => ({ start: i, end: i + 0.5, text: `行 ${i} 日本語のテキスト🎉 ${'é'.repeat(200)}` }))
    const reply = replyOf(segments)
    expect(reply.byteLength).toBeGreaterThan(2 * PAGE_BYTES)
    const deps = depsWith(scripted(reply).transcriber)
    const m = await newMeeting()
    await drive(m.id, deps)
    const stored = await transcript(m.id)
    expect(stored.map(s => s.idx)).toEqual(segments.map((_, i) => i))
    expect(stored.map(s => s.text)).toEqual(segments.map(s => s.text))
  })

  it('bounds a page at SEGMENTS_PER_PAGE, and does not parse the whole reply', async () => {
    const reply = replyOf(whisperSegments(SEGMENTS_PER_PAGE * 3 + 7))
    const deps = depsWith(scripted(reply).transcriber)
    const m = await newMeeting()
    const parse = vi.spyOn(JSON, 'parse')
    const counts: number[] = []
    try {
      await advanceTranscription(m.id, deps)
      for (;;) {
        const outcome = await advanceTranscription(m.id, deps)
        if (outcome.kind !== 'progress') break
        counts.push(outcome.progress.segments)
      }
      const replyText = new TextDecoder().decode(reply)
      expect(parse.mock.calls.some(([text]) => text === replyText)).toBe(false)
    }
    finally {
      parse.mockRestore()
    }
    const steps = counts.map((c, i) => c - (counts[i - 1] ?? 0))
    expect(Math.max(...steps)).toBeLessThanOrEqual(SEGMENTS_PER_PAGE)
    expect((await transcript(m.id)).length).toBe(SEGMENTS_PER_PAGE * 3 + 7)
  })

  // findActiveSegment binary-searches startMs, and no step can sort the whole
  // reply any more, so order across pages is kept by moving a late line up.
  it('keeps lines in time order across pages, even when the reply does not', async () => {
    const segments = [
      ...Array.from({ length: SEGMENTS_PER_PAGE }, (_, i) => ({ start: 100 + i, end: 100.5 + i, text: `early ${i}` })),
      { start: 50, end: 60, text: 'from before the last page' },
      { start: 300, end: 301, text: 'in order again' },
    ]
    const deps = depsWith(scripted(replyOf(segments)).transcriber)
    const m = await newMeeting()
    await drive(m.id, deps)
    const stored = await transcript(m.id)
    expect(stored.map(s => s.startMs)).toEqual([...stored.map(s => s.startMs)].sort((a, b) => a - b))
    expect(stored.find(s => s.text === 'from before the last page')).toMatchObject({ startMs: 199_000, endMs: 199_000 })
    expect(stored.at(-1)).toMatchObject({ startMs: 300_000, endMs: 301_000 })
  })

  describe('with a line whose timestamp is wrong', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `line ${i}` }))
    const stored = async (reply: Uint8Array) => {
      const m = await newMeeting()
      expect((await drive(m.id, depsWith(scripted(reply).transcriber))).at(-1)).toMatchObject({ kind: 'done' })
      return transcript(m.id)
    }
    const envelope = (segments: unknown[], duration?: number) => new TextEncoder().encode(JSON.stringify({ task: 'transcribe', duration, text: 'x', segments }))

    // One bad line used to lift the floor for every page after it, for good.
    it('moves only that line when it starts past the end of the audio', async () => {
      const segments = lines(828)
      segments[50] = { start: 3600, end: 3602, text: 'wrong' }
      const result = await stored(envelope(segments, 1656))
      expect(result[50]).toMatchObject({ text: 'wrong', startMs: 98_000, endMs: 98_000 })
      result.filter(s => s.idx !== 50).forEach(s => expect(s).toMatchObject({ startMs: s.idx * 2000, endMs: s.idx * 2000 + 1500 }))
    })

    it('moves it when it is the last of its page, which has no later line to show it is wrong', async () => {
      const segments = lines(250)
      segments[SEGMENTS_PER_PAGE - 1] = { start: 3600, end: 3602, text: 'wrong' }
      const result = await stored(envelope(segments, 500))
      expect(result[SEGMENTS_PER_PAGE - 1]).toMatchObject({ text: 'wrong', startMs: 196_000 })
      expect(result[SEGMENTS_PER_PAGE]).toMatchObject({ startMs: SEGMENTS_PER_PAGE * 2000 })
      expect(result.at(-1)).toMatchObject({ startMs: 249 * 2000 })
    })

    it('moves it when it is inside the audio, or the reply does not say how long that is', async () => {
      const segments = lines(250)
      segments[50] = { start: 450, end: 451, text: 'wrong' }
      const result = await stored(envelope(segments))
      expect(result[50]).toMatchObject({ text: 'wrong', startMs: 98_000 })
      expect(result[150]).toMatchObject({ startMs: 300_000, endMs: 301_500 })
    })
  })

  it('keeps the cursor small however long the meeting is', async () => {
    const deps = depsWith(scripted(replyOf(whisperSegments(3000, 40))).transcriber)
    const m = await newMeeting()
    const sizes: number[] = []
    for (let i = 0; i < 400; i++) {
      const outcome = await advanceTranscription(m.id, deps)
      if (outcome.kind !== 'progress') break
      sizes.push(JSON.stringify((await run(m.id))!.cursor).length)
    }
    expect(Math.max(...sizes)).toBeLessThan(5000)
  })

  it('takes a genuinely silent recording to summarizing with no lines', async () => {
    const deps = depsWith(scripted(replyOf([])).transcriber)
    const m = await newMeeting()
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
    expect(await transcript(m.id)).toEqual([])
  })

  it('leaves no lines of an earlier attempt past the new end', async () => {
    const deps = depsWith(scripted(replyOf(whisperSegments(3))).transcriber)
    const m = await newMeeting()
    await repos().transcripts.replaceForMeeting(m.id, Array.from({ length: 50 }, (_, idx) => ({ idx, startMs: idx, endMs: idx, text: 'old' })))
    await drive(m.id, deps)
    const stored = await transcript(m.id)
    expect(stored.map(s => s.idx)).toEqual([0, 1, 2])
    expect(stored.some(s => s.text === 'old')).toBe(false)
  })

  it('reads a segment bigger than a page by widening the window for that page', async () => {
    const huge = 'x'.repeat(PAGE_BYTES * 3)
    const deps = depsWith(scripted(replyOf([{ start: 0, end: 1, text: 'first' }, { start: 1, end: 2, text: huge }, { start: 2, end: 3, text: 'last' }])).transcriber)
    const m = await newMeeting()
    await drive(m.id, deps)
    expect((await transcript(m.id)).map(s => s.text)).toEqual(['first', huge, 'last'])
  })

  it('fails a segment too big for any page, rather than reading on without bound', async () => {
    const deps = depsWith(scripted(replyOf([{ start: 0, end: 1, text: 'x'.repeat(MAX_PAGE_BYTES * 2) }])).transcriber)
    const m = await newMeeting()
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'failed', statusCode: 502, message: expect.stringMatching(/too large/) })
  })
})

describe('the incremental plan', () => {
  it('stores the same plan planChunks makes of the transcript, across pages', async () => {
    const reply = replyOf(whisperSegments(800, 60))
    const deps = depsWith(scripted(reply).transcriber)
    const m = await newMeeting()
    await drive(m.id, deps)

    const stored = await transcript(m.id)
    const expected = planChunks(normalizeSegments(whisperSegments(800, 60)), CHUNK_BUDGET_TOKENS)
    expect(expected.length, 'the case spans several chunks').toBeGreaterThan(3)
    expect(stored.length).toBe(800)
    const chunks = await repos().pipeline.listChunks(m.id)
    expect(chunks.map(c => ({ segFrom: c.segFrom, segTo: c.segTo, estTokens: c.estTokens }))).toEqual(
      expected.map(c => ({ segFrom: c.segments[0]!.idx, segTo: c.segments.at(-1)!.idx, estTokens: c.estimatedTokens })),
    )
  })

  it('lets extraction start without reading the whole transcript back', async () => {
    const deps = depsWith(scripted(replyOf(whisperSegments(5))).transcriber)
    const m = await newMeeting()
    await drive(m.id, deps)

    const { meetings, pipeline, transcripts, summaries } = repos()
    const listForMeeting = vi.fn(transcripts.listForMeeting)
    const outcome = await advanceExtraction(m.id, {
      meetings, pipeline, summaries, summarizer: createStubSummarizer(), transcripts: { ...transcripts, listForMeeting },
    })
    expect(outcome).toMatchObject({ kind: 'progress', meeting: { status: 'indexing' }, progress: { done: 1, total: 1 } })
    expect(listForMeeting).not.toHaveBeenCalled()
  })

  it('still plans from the transcript for a meeting transcribed before plans were stored', async () => {
    const m = await newMeeting('summarizing')
    await repos().transcripts.replaceForMeeting(m.id, normalizeSegments(whisperSegments(3)))
    const { meetings, pipeline, transcripts, summaries } = repos()
    const outcome = await advanceExtraction(m.id, { meetings, pipeline, transcripts, summaries, summarizer: createStubSummarizer() })
    expect(outcome).toMatchObject({ kind: 'progress', progress: { done: 0, total: 1 } })
  })

  it('does not reuse a plan that already has results: it belongs to an earlier extraction', async () => {
    const m = await newMeeting('summarizing')
    const { meetings, pipeline, transcripts, summaries } = repos()
    await transcripts.replaceForMeeting(m.id, normalizeSegments(whisperSegments(3)))
    const deps = { meetings, pipeline, transcripts, summaries, summarizer: createStubSummarizer() }
    await advanceExtraction(m.id, deps)
    await advanceExtraction(m.id, deps)
    const earlier = (await pipeline.listRuns(m.id)).find(r => r.stage === 'summarization')!.runId
    expect((await pipeline.listChunks(m.id)).every(c => c.result)).toBe(true)
    await db().setItem(`meetings/${m.id}`, { ...(await getMeeting(m.id)), status: 'summarizing' })

    expect(await advanceExtraction(m.id, deps)).toMatchObject({ kind: 'progress', progress: { done: 0, total: 1 } })
    expect((await pipeline.listRuns(m.id)).find(r => r.stage === 'summarization')!.runId).not.toBe(earlier)
  })

  it('refuses a transcript over MAX_CHUNKS as failed/summarization, keeping the transcript, with the reply gone', async () => {
    const deps = depsWith(scripted(replyOf(whisperSegments(MAX_CHUNKS * 3, 1500))).transcriber)
    const m = await newMeeting()
    const outcomes = await drive(m.id, deps)
    expect(outcomes.at(-1)).toMatchObject({
      kind: 'done',
      meeting: { status: 'failed', failedStage: 'summarization', errorMessage: expect.stringMatching(/over the 40 limit/) },
    })
    expect((await transcript(m.id)).length).toBe(MAX_CHUNKS * 3)
    expect(await repos().pipeline.listChunks(m.id)).toEqual([])
    expect(await replyStored(m.id)).toBe(false)

    // Extraction then refuses the same way, as it always has.
    await db().setItem(`meetings/${m.id}`, { ...(await getMeeting(m.id)), updatedAt: new Date(Date.now() - RETRY_COOLDOWN_MS - 1000).toISOString() })
    const { meetings, pipeline, transcripts, summaries } = repos()
    const retried = await advanceExtraction(m.id, { meetings, pipeline, transcripts, summaries, summarizer: createStubSummarizer() })
    expect(retried).toMatchObject({ kind: 'failed', statusCode: 413 })
  })

  it('discards an older extraction run: a new transcript\'s plan is the only plan', async () => {
    const m = await newMeeting('summarizing')
    const { pipeline, transcripts } = repos()
    await transcripts.replaceForMeeting(m.id, normalizeSegments(whisperSegments(3)))
    const old = (await pipeline.claimStep(m.id, 'summarization', { status: 'summarizing', leaseMs: 60_000, newRun: true }))!
    await pipeline.planChunks(m.id, old.token, [{ chunkNo: 0, segFrom: 0, segTo: 2, estTokens: 10 }, { chunkNo: 1, segFrom: 3, segTo: 4, estTokens: 10 }])
    await pipeline.releaseStep(m.id, 'summarization', old.token, { error: 'old', retryAt: null })

    await db().setItem(`meetings/${m.id}`, { ...(await getMeeting(m.id)), status: 'uploaded' })
    await drive(m.id, depsWith(scripted(replyOf(whisperSegments(2))).transcriber))

    const runs = await pipeline.listRuns(m.id)
    expect(runs.find(r => r.stage === 'summarization')).toMatchObject({ lastError: null, stepLeaseUntil: null })
    expect(runs.find(r => r.stage === 'summarization')!.runId).not.toBe(old.runId)
    expect((await pipeline.listChunks(m.id)).map(c => [c.segFrom, c.segTo])).toEqual([[0, 1]])
  })
})

describe('a finished transcript is never replaced', () => {
  const finished: TranscriptSegment[] = [{ idx: 0, startMs: 0, endMs: 900, text: 'The real transcript.' }]

  it.each(['summarizing', 'indexing', 'ready'] as const)('%s: answers done, makes no call, claims nothing', async (status) => {
    const script = scripted()
    const m = await newMeeting(status)
    await repos().transcripts.replaceForMeeting(m.id, finished)
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'done', meeting: { status } })
    expect(script.calls()).toBe(0)
    expect(await repos().pipeline.listRuns(m.id)).toEqual([])
    expect(await transcript(m.id)).toEqual(finished)
  })

  it('failed in extraction: refuses, pointing at the right route, and touches nothing', async () => {
    const script = scripted()
    const m = await newMeeting('failed', { failedStage: 'summarization', errorMessage: 'boom' })
    await repos().transcripts.replaceForMeeting(m.id, finished)
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'refused', statusCode: 409, message: expect.stringMatching(/retry summarisation/) })
    expect(script.calls()).toBe(0)
    expect(await transcript(m.id)).toEqual(finished)
  })

  // The fence itself. The status check above is a read a straggler already did.
  it('a straggler holding the live token cannot write once the meeting has moved on', async () => {
    const m = await newMeeting('uploaded')
    const { pipeline, transcripts } = repos()
    const claim = (await pipeline.claimStep(m.id, 'transcription', { status: 'uploaded', moveTo: 'transcribing', leaseMs: 60_000 }))!
    await transcripts.replaceForMeeting(m.id, finished)
    await db().setItem(`meetings/${m.id}`, { ...(await getMeeting(m.id)), status: 'ready' })

    const page = { fromIdx: 0, segments: [{ idx: 0, startMs: 0, endMs: 1, text: 'overwrite' }], cursor: {} }
    expect(await pipeline.appendSegments(m.id, claim.token, page)).toBe(false)
    expect(await pipeline.finishTranscription(m.id, claim.token, { chunks: [], refusal: null })).toBe(false)
    expect(await transcript(m.id)).toEqual(finished)
    expect((await getMeeting(m.id)).status).toBe('ready')
  })
})

describe('leases and concurrent drivers', () => {
  it('claims Whisper under the long lease and a page under the short one', async () => {
    const m = await newMeeting()
    let during: PipelineRunLike | undefined
    type PipelineRunLike = Awaited<ReturnType<typeof run>>
    const transcriber: Transcriber = {
      kind: 'stub',
      async transcribe() {
        during = await run(m.id)
        return replyOf(whisperSegments(2))
      },
    }
    const deps = depsWith(transcriber)
    await advanceTranscription(m.id, deps)
    const whisperLease = during!.stepLeaseUntil!.getTime() - Date.now()
    expect(whisperLease).toBeGreaterThan(WHISPER_STEP_LEASE_MS - 5000)
    expect(whisperLease).toBeLessThanOrEqual(WHISPER_STEP_LEASE_MS)

    const claimStep = vi.spyOn(deps.pipeline, 'claimStep')
    await advanceTranscription(m.id, deps)
    expect(claimStep.mock.calls[0]![2].leaseMs).toBe(PAGE_STEP_LEASE_MS)
  })

  it('lets concurrent drivers converge on one provider call and one transcript', async () => {
    const script = scripted(replyOf(whisperSegments(250)))
    const deps = depsWith(script.transcriber)
    const m = await newMeeting()
    const results = await Promise.all([drive(m.id, deps), drive(m.id, deps), drive(m.id, deps)])
    for (const outcomes of results) expect(outcomes.at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
    expect(script.calls()).toBe(1)
    expect((await transcript(m.id)).map(s => s.idx)).toEqual(Array.from({ length: 250 }, (_, i) => i))
  })

  it('tells a caller who finds a step live to wait, without calling the provider', async () => {
    const script = scripted()
    const m = await newMeeting('transcribing')
    const { pipeline } = repos()
    await pipeline.claimStep(m.id, 'transcription', { status: 'transcribing', leaseMs: 60_000 })
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(script.calls()).toBe(0)
  })

  it('resumes after a killed Whisper step, once its lease has run out', async () => {
    const script = scripted()
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await repos().pipeline.claimStep(m.id, 'transcription', { status: 'uploaded', moveTo: 'transcribing', resetAttempts: true, leaseMs: 60_000 })
    await expireLease(m.id)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
    expect(script.calls()).toBe(1)
  })

  it('does not spend Whisper more than twice on a step that keeps being killed', async () => {
    const script = scripted()
    const m = await newMeeting()
    const { pipeline } = repos()
    await pipeline.claimStep(m.id, 'transcription', { status: 'uploaded', moveTo: 'transcribing', resetAttempts: true, leaseMs: 60_000 })
    for (let i = 1; i < MAX_WHISPER_ATTEMPTS; i++) {
      await expireLease(m.id)
      await pipeline.claimStep(m.id, 'transcription', { status: 'transcribing', leaseMs: 60_000 })
    }
    await expireLease(m.id)
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 502, message: expect.stringMatching(/stopped without an answer/) })
    expect(script.calls()).toBe(0)
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
  })

  it('resumes after a killed page from the last written cursor, without Whisper again', async () => {
    const script = scripted(replyOf(whisperSegments(250)))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(m.id, deps)
    await advanceTranscription(m.id, deps)
    const before = (await run(m.id))!.cursor
    const killed = (await deps.pipeline.claimStep(m.id, 'transcription', { status: 'transcribing', leaseMs: 60_000 }))!
    expect(killed.cursor).toEqual(before)
    await expireLease(m.id)

    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
    expect(script.calls()).toBe(1)
    expect((await transcript(m.id)).map(s => s.idx)).toEqual(Array.from({ length: 250 }, (_, i) => i))
    // The killed step's late write matches nothing.
    expect(await deps.pipeline.appendSegments(m.id, killed.token, { fromIdx: 0, segments: [], cursor: {} })).toBe(false)
    expect((await transcript(m.id)).length).toBe(250)
  })

  it('fails a page that keeps being killed, keeping the cursor so a retry does not spend Whisper', async () => {
    const script = scripted(replyOf(whisperSegments(250)))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(m.id, deps)
    await advanceTranscription(m.id, deps)
    for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
      await deps.pipeline.claimStep(m.id, 'transcription', { status: 'transcribing', leaseMs: 60_000 })
      await expireLease(m.id)
    }
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', statusCode: 500 })
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
    expect((await run(m.id))!.cursor).toHaveProperty('reply')

    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
    expect(script.calls()).toBe(1)
    expect((await transcript(m.id)).length).toBe(250)
  })
})

describe('429 during transcription', () => {
  const quota = (retryAfterMs: number | null) => new TranscriptionError('Transcription quota is exhausted for now.', 429, true, retryAfterMs)

  it('fails to failed/transcription, whatever the attempt, keeping its status code', async () => {
    const script = scripted()
    script.queue(quota(null))
    const m = await newMeeting()
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 429, message: expect.stringMatching(/quota/) })
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription', errorMessage: expect.stringMatching(/quota/) })
  })

  it('refuses a retry inside the fixed cooldown, with no provider call', async () => {
    const script = scripted()
    script.queue(quota(null))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(m.id, deps)
    const refused = await advanceTranscription(m.id, deps)
    expect(refused).toMatchObject({ kind: 'refused', statusCode: 409, message: expect.stringMatching(/wait \d+s/) })
    expect(script.calls()).toBe(1)

    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
    expect(script.calls()).toBe(2)
  })

  it('lets Retry-After lengthen the cooldown, and says so', async () => {
    const script = scripted()
    const retryAfterMs = 10 * RETRY_COOLDOWN_MS
    script.queue(quota(retryAfterMs))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    const failed = await advanceTranscription(m.id, deps)
    expect(failed).toMatchObject({ kind: 'failed', statusCode: 429 })
    expect((failed as { retryAt: Date }).retryAt.getTime()).toBeGreaterThan(Date.now() + RETRY_COOLDOWN_MS)

    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'refused', message: expect.stringMatching(/wait \d+s/) })
    expect(script.calls()).toBe(1)

    deps.time.advance(retryAfterMs)
    expect((await advanceTranscription(m.id, deps)).kind).toBe('progress')
    expect(script.calls()).toBeGreaterThanOrEqual(1)
  })

  it('never lets Retry-After shorten the cooldown', async () => {
    const script = scripted()
    script.queue(quota(1000))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(m.id, deps)
    deps.time.advance(2000)
    expect((await advanceTranscription(m.id, deps)).kind).toBe('refused')
  })

  it('records the block for every meeting: another one parks without calling the provider, spending no attempt', async () => {
    const script = scripted()
    script.queue(quota(60_000))
    const a = await newMeeting()
    const b = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(a.id, deps)
    expect(script.calls()).toBe(1)

    const parked = await advanceTranscription(b.id, deps)
    expect(parked).toMatchObject({ kind: 'progress', next: 'wait', meeting: { status: 'transcribing' } })
    expect((parked as { retryAt: Date }).retryAt.getTime()).toBeGreaterThan(Date.now())
    expect(script.calls()).toBe(1)
    expect((await run(b.id))!.attempts).toBe(0)
  })

  it('still reports the 429 when the block cannot be recorded', async () => {
    const script = scripted()
    script.queue(quota(60_000))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const failing = { ...deps, slots: { ...deps.slots, noteRateLimit: rejects('db down') } }
      expect(await advanceTranscription(m.id, failing)).toMatchObject({ kind: 'failed', statusCode: 429 })
    }
    finally {
      warn.mockRestore()
    }
  })
})

describe('other failures', () => {
  it('fails at once when the audio is missing, with no provider call', async () => {
    const script = scripted()
    const m = await newMeeting()
    await store().delete(m.audioKey)
    const outcome = await advanceTranscription(m.id, depsWith(script.transcriber))
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 409, message: expect.stringMatching(/missing from storage/) })
    expect(script.calls()).toBe(0)
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
  })

  it('fails at once when the stored audio is not what was verified', async () => {
    const script = scripted()
    const m = await newMeeting()
    await store().put(m.audioKey, new Uint8Array(AUDIO.byteLength + 9), 'audio/ogg')
    expect(await advanceTranscription(m.id, depsWith(script.transcriber))).toMatchObject({ kind: 'failed', message: expect.stringMatching(/expected \d+/) })
    expect(script.calls()).toBe(0)
  })

  it('parks a retryable provider failure once, then fails the run on the second', async () => {
    const script = scripted()
    const outage = () => new TranscriptionError('Transcription service is unavailable (HTTP 503).', 502, true)
    script.queue(outage(), outage())
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)

    const parked = await advanceTranscription(m.id, deps)
    expect(parked).toMatchObject({ kind: 'progress', next: 'wait', progress: { lastError: expect.stringMatching(/unavailable/) } })
    expect(await getMeeting(m.id)).toMatchObject({ status: 'transcribing' })
    expect((parked as { retryAt: Date }).retryAt.getTime() - Date.now()).toBeLessThanOrEqual(RETRYABLE_PARK_MS)
    // Parked, and not to be retried early.
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(script.calls()).toBe(1)

    deps.time.advance(RETRYABLE_PARK_MS + 1)
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', statusCode: 502 })
    expect(script.calls()).toBe(2)
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
  })

  it('fails a non-retryable provider failure at once', async () => {
    const script = scripted()
    script.queue(new TranscriptionError('The transcription service rejected our credentials.', 502, false))
    const m = await newMeeting()
    expect(await advanceTranscription(m.id, depsWith(script.transcriber))).toMatchObject({ kind: 'failed', statusCode: 502 })
    expect(script.calls()).toBe(1)
  })

  it('treats a failure to store the reply as retryable, spending the second attempt only', async () => {
    const script = scripted()
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    const put = vi.fn(async () => {
      throw new Error('R2 down')
    })
    const broken = { ...deps, store: { ...deps.store, put } }
    expect(await advanceTranscription(m.id, broken)).toMatchObject({ kind: 'progress', next: 'wait', progress: { lastError: 'R2 down' } })
    deps.time.advance(RETRYABLE_PARK_MS + 1)
    expect(await advanceTranscription(m.id, broken)).toMatchObject({ kind: 'failed', statusCode: 500 })
    expect(script.calls()).toBe(2)
    expect(put).toHaveBeenCalledTimes(2)
  })

  // A database blip must not throw away a reply that was paid for.
  it('parks a page whose write fails, then carries on from the same place', async () => {
    const script = scripted(replyOf(whisperSegments(5)))
    const m = await newMeeting()
    const deps = depsWith(script.transcriber)
    await advanceTranscription(m.id, deps)
    const blip = { ...deps, pipeline: { ...deps.pipeline, appendSegments: rejects('db blip') } }
    expect(await advanceTranscription(m.id, blip)).toMatchObject({ kind: 'progress', next: 'wait', progress: { lastError: 'db blip' } })
    deps.time.advance(RETRYABLE_PARK_MS + 1)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
    expect(script.calls()).toBe(1)
    expect((await transcript(m.id)).length).toBe(5)
  })

  it.each([
    ['no segments array', new TextEncoder().encode('{"text":"hello"}'), /no segments array/],
    ['a body that is not JSON', new TextEncoder().encode('<html>gateway timeout</html>'), /could not read/],
    ['a reply cut off part-way', replyOf(whisperSegments(5)).subarray(0, 300), /ends early/],
    ['an empty reply', new Uint8Array(0), /ends early/],
    ['a malformed segment', replyOf([{ start: 'soon', end: 1, text: 'x' }]), /unexpected response/],
  ])('fails %s, and the retry asks the provider again', async (_label, bad, message) => {
    let calls = 0
    const good = replyOf(whisperSegments(2))
    const transcriber: Transcriber = {
      kind: 'stub',
      async transcribe() {
        calls++
        return calls === 1 ? bad : good
      },
    }
    const m = await newMeeting()
    const deps = depsWith(transcriber)
    await advanceTranscription(m.id, deps)
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', statusCode: 502, message: expect.stringMatching(message) })
    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
    // Not automatic: it spends quota.
    expect(calls).toBe(1)

    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
    expect(calls).toBe(2)
    expect((await transcript(m.id)).length).toBe(2)
  })

  it('removes the lines of an abandoned attempt when the retry\'s reply is shorter', async () => {
    let calls = 0
    const transcriber: Transcriber = {
      kind: 'stub',
      async transcribe() {
        calls++
        if (calls > 1) return replyOf(whisperSegments(2))
        // Parses for a page, then turns out to be cut off.
        const full = replyOf(whisperSegments(150))
        return full.subarray(0, full.byteLength - 100)
      },
    }
    const m = await newMeeting()
    const deps = depsWith(transcriber)
    await advanceTranscription(m.id, deps)
    await advanceTranscription(m.id, deps)
    expect((await transcript(m.id)).length).toBeGreaterThan(2)
    await drive(m.id, deps).catch(() => {})
    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
    await drive(m.id, deps)
    expect((await transcript(m.id)).map(s => s.idx)).toEqual([0, 1])
  })

  describe('the stored reply', () => {
    it('is gone: fails rather than sending the audio again by itself', async () => {
      const script = scripted()
      const m = await newMeeting()
      const deps = depsWith(script.transcriber)
      await advanceTranscription(m.id, deps)
      await store().delete(whisperReplyKey(m.id))
      expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', statusCode: 502, message: expect.stringMatching(/gone/) })
      expect(script.calls()).toBe(1)
      deps.time.advance(RETRY_COOLDOWN_MS + 1000)
      expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
      expect(script.calls()).toBe(2)
    })

    // A straggling Whisper step's late put: same key, different bytes. Reading
    // on would stitch two replies into one transcript.
    it('changed under the run: fails rather than mixing two replies', async () => {
      const script = scripted(replyOf(whisperSegments(250)))
      const m = await newMeeting()
      const deps = depsWith(script.transcriber)
      await advanceTranscription(m.id, deps)
      await advanceTranscription(m.id, deps)
      await store().put(whisperReplyKey(m.id), replyOf(whisperSegments(251)), 'application/json')
      expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/changed/) })
    })

    it('replaced with the same length: the validator still tells them apart', async () => {
      const script = scripted(replyOf(whisperSegments(250)))
      const m = await newMeeting()
      const deps = depsWith(script.transcriber)
      await advanceTranscription(m.id, deps)
      const cursor = (await run(m.id))!.cursor as { reply: { size: number } }
      await sleep(5)
      const swapped = new TextEncoder().encode(new TextDecoder().decode(replyOf(whisperSegments(250))).replace('Line 0', 'Line 9'))
      expect(swapped.byteLength).toBe(cursor.reply.size)
      await store().put(whisperReplyKey(m.id), swapped, 'application/json')
      expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/changed/) })
    })

    it('that cannot be deleted at the end does not fail a finished transcript', async () => {
      const m = await newMeeting()
      const deps = depsWith(scripted().transcriber)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const stuck = { ...deps, store: { ...deps.store, delete: rejects('R2 down') } }
        expect((await drive(m.id, stuck)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
      }
      finally {
        warn.mockRestore()
      }
    })
  })
})

describe('what cannot be transcribed', () => {
  it('404s for a meeting that does not exist', async () => {
    expect(await advanceTranscription(randomUUID(), depsWith(scripted().transcriber))).toMatchObject({ kind: 'refused', statusCode: 404 })
  })

  it('refuses a meeting whose audio never arrived, moving nothing', async () => {
    const script = scripted()
    const m = await newMeeting('pending_upload')
    expect(await advanceTranscription(m.id, depsWith(script.transcriber))).toMatchObject({ kind: 'refused', statusCode: 409, message: expect.stringMatching(/no audio ready/) })
    expect((await getMeeting(m.id)).status).toBe('pending_upload')
    expect(await repos().pipeline.listRuns(m.id)).toEqual([])
    expect(script.calls()).toBe(0)
  })

  it('refuses a rejected upload as terminal', async () => {
    const m = await newMeeting('failed', { failedStage: 'upload', errorMessage: 'rejected' })
    expect(await advanceTranscription(m.id, depsWith(scripted().transcriber))).toMatchObject({ kind: 'refused', message: expect.stringMatching(/upload the recording again/) })
  })
})

// Two tabs retrying together. The checks in advanceTranscription are on an
// earlier read, so what they found has to be what the claim still finds.
describe('a retry that read the meeting before another tab moved it', () => {
  /** The same deps, stalling once between the read and the claim while `during` runs. */
  function stalledBeforeClaim(deps: ReturnType<typeof depsWith>, during: () => Promise<unknown>) {
    let stalled = false
    const claimStep: typeof deps.pipeline.claimStep = async (...args) => {
      if (!stalled) {
        stalled = true
        await during()
      }
      return deps.pipeline.claimStep(...args)
    }
    return { ...deps, pipeline: { ...deps.pipeline, claimStep } }
  }

  async function killUntilFailed(id: string, deps: ReturnType<typeof depsWith>) {
    for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
      await deps.pipeline.claimStep(id, 'transcription', { status: 'transcribing', leaseMs: 60_000 })
      await expireLease(id)
    }
    expect(await advanceTranscription(id, deps)).toMatchObject({ kind: 'failed', statusCode: 500 })
    deps.time.advance(RETRY_COOLDOWN_MS + 1000)
  }

  it('does not reopen a finished transcript, nor spend Whisper again', async () => {
    const script = scripted(replyOf(whisperSegments(MAX_CHUNKS * 3, 1500)))
    const deps = depsWith(script.transcriber)
    const m = await newMeeting()
    for (let i = 0; i < 400; i++) {
      await advanceTranscription(m.id, deps)
      if (((await run(m.id))!.cursor as { reply: { parsed: boolean } }).reply.parsed) break
    }
    await killUntilFailed(m.id, deps)

    const tabA = stalledBeforeClaim(deps, async () => {
      // Tab B takes the last step: over the limit, so the status stays `failed`.
      expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'done', meeting: { failedStage: 'summarization' } })
    })
    expect(await advanceTranscription(m.id, tabA)).toMatchObject({ kind: 'refused', statusCode: 409, message: expect.stringMatching(/retry summarisation/) })

    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'summarization' })
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'refused', statusCode: 409 })
    expect(script.calls()).toBe(1)
    expect((await transcript(m.id)).length).toBe(MAX_CHUNKS * 3)
  })

  it('does not skip the cooldown of a failure that landed after its read', async () => {
    const script = scripted(replyOf(whisperSegments(250)))
    const deps = depsWith(script.transcriber)
    const m = await newMeeting()
    await advanceTranscription(m.id, deps)
    await advanceTranscription(m.id, deps)
    await killUntilFailed(m.id, deps)
    await store().delete(whisperReplyKey(m.id))

    const tabA = stalledBeforeClaim(deps, async () => {
      // Tab B's retry finds the reply gone, and fails with a fresh cooldown.
      expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'failed', statusCode: 502 })
    })
    expect(await advanceTranscription(m.id, tabA)).toMatchObject({ kind: 'refused', statusCode: 409 })

    expect(await getMeeting(m.id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
    expect(script.calls()).toBe(1)
  })
})

// R2 has no write fence, so a Whisper step that outlives its lease stores its
// reply whatever has happened since.
describe('a Whisper step whose reply arrives after it lost the run', () => {
  /** A transcriber that lets `during` happen while the provider is answering. */
  function answeringAfter(during: () => Promise<unknown>): Transcriber {
    return {
      kind: 'stub',
      async transcribe() {
        await during()
        return replyOf(whisperSegments(5))
      },
    }
  }

  it('removes the reply when the meeting was deleted meanwhile', async () => {
    const m = await newMeeting()
    const deps = depsWith(answeringAfter(async () => {
      const { meetings, pipeline } = repos()
      await meetings.delete(m.id, await getMeeting(m.id))
      await pipeline.deleteForMeeting(m.id)
    }))
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'refused', statusCode: 404 })
    expect(await replyStored(m.id)).toBe(false)
  })

  it('removes the reply when the transcript was finished meanwhile', async () => {
    const m = await newMeeting()
    const other = depsWith(scripted().transcriber)
    const deps = depsWith(answeringAfter(async () => {
      await expireLease(m.id)
      expect((await drive(m.id, other)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'summarizing' } })
    }))
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'done' })
    expect(await replyStored(m.id)).toBe(false)
    expect((await transcript(m.id)).length).toBe(5)
  })

  // Another step may be reading it, and would then fail for a reply gone.
  it('leaves the reply alone while the meeting is still being transcribed', async () => {
    const m = await newMeeting()
    const deps = depsWith(answeringAfter(async () => {
      await expireLease(m.id)
      await repos().pipeline.claimStep(m.id, 'transcription', { status: 'transcribing', leaseMs: 60_000 })
    }))
    expect(await advanceTranscription(m.id, deps)).toMatchObject({ kind: 'progress', meeting: { status: 'transcribing' } })
    expect(await replyStored(m.id)).toBe(true)
  })
})
