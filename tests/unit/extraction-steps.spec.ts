import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Meeting, MeetingStatus, TranscriptSegment } from '../../shared/types/meeting'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { createLocalPipelineRepository } from '../../server/utils/db/pipeline-local'
import { createLocalSummaryRepository } from '../../server/utils/db/summaries-local'
import { createLocalTranscriptRepository } from '../../server/utils/db/transcripts-local'
import { mergeReconciled } from '../../server/utils/summary/reconcile'
import {
  advanceExtraction,
  LIVE_STEP_POLL_MS,
  MAX_CHUNKS,
  RETRY_COOLDOWN_MS,
  type ExtractionDeps,
  type ExtractionOutcome,
} from '../../server/utils/summary/steps'
import { createStubSummarizer } from '../../server/utils/summary/stub'
import { SummarizationError, type Summarizer } from '../../server/utils/summary/summarizer'

/**
 * Step-wise extraction (ADR-0012, step 6) against the local drivers: one step
 * per call, at most one provider request per step, and everything a step
 * learns left in the run ledger for whichever call comes next.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-steps-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const repos = () => ({
  meetings: createLocalMeetingRepository({ dataDir }),
  pipeline: createLocalPipelineRepository({ dataDir }),
  transcripts: createLocalTranscriptRepository({ dataDir }),
  summaries: createLocalSummaryRepository({ dataDir }),
})

/**
 * Each segment alone is most of a chunk's token budget, so every segment is
 * its own chunk: three segments, three chunks, three provider calls.
 */
function longSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, idx) => ({
    idx,
    startMs: idx * 60_000,
    endMs: idx * 60_000 + 59_000,
    text: `Topic ${idx} was discussed at length. ${Array.from({ length: 1500 }, (_, w) => `w${idx}x${w}`).join(' ')}`,
  }))
}

async function newMeeting(status: MeetingStatus, segments: TranscriptSegment[] = longSegments(3), patch: Partial<Meeting> = {}): Promise<Meeting> {
  const id = randomUUID()
  const { meetings, transcripts } = repos()
  const meeting = await meetings.create({
    id,
    title: 'Planning',
    status,
    sourceFileName: 'planning.m4a',
    sourceBytes: 1000,
    sourceMime: 'audio/mp4',
    durationSec: 180,
    audioKey: `meetings/${id}/audio.ogg`,
    audioBytes: 500,
    audioMime: 'audio/ogg',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
    failedStage: null,
    ...patch,
  })
  await transcripts.replaceForMeeting(id, segments)
  return meeting
}

/**
 * The stub summarizer, counting calls by each chunk's first segment and
 * throwing whatever errors a test queues for a chunk, in order.
 */
function scripted() {
  const stub = createStubSummarizer()
  const calls: number[] = []
  const queued = new Map<number, unknown[]>()
  const summarizer: Summarizer = {
    kind: 'stub',
    summarize: stub.summarize,
    async summarizeChunk(input) {
      const first = input.segments[0]!.idx
      calls.push(first)
      const failure = queued.get(first)?.shift()
      if (failure) throw failure
      return stub.summarizeChunk(input)
    },
  }
  return {
    summarizer,
    calls,
    callsOf: (segIdx: number) => calls.filter(c => c === segIdx).length,
    queue: (segIdx: number, ...errors: unknown[]) => queued.set(segIdx, [...(queued.get(segIdx) ?? []), ...errors]),
  }
}

/** A test clock: real time, plus however far a test has moved it on. */
function clock() {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    advance: (ms: number) => {
      offset += ms
    },
  }
}

function depsWith(summarizer: Summarizer, now?: () => number): ExtractionDeps {
  return { ...repos(), summarizer, now }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Call until the run is done or stops, as the progress page does, with each
 * wait cut short. Returns every outcome, the last one last.
 */
async function drive(meetingId: string, deps: ExtractionDeps, maxSteps = 30): Promise<ExtractionOutcome[]> {
  const outcomes: ExtractionOutcome[] = []
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await advanceExtraction(meetingId, deps)
    outcomes.push(outcome)
    if (outcome.kind !== 'progress') return outcomes
    if (outcome.next === 'wait') await sleep(5)
  }
  throw new Error(`still running after ${maxSteps} steps: ${JSON.stringify(outcomes.at(-1))}`)
}

const rateLimited = (retryAt: Date) =>
  new SummarizationError('Summarization quota is exhausted for now.', 429, false, { kind: 'rate-limited', retryAt })
const busy = (retryAt: Date) =>
  new SummarizationError('Summarization is queued behind other requests.', 429, false, { kind: 'busy', retryAt })
const transient = () => new SummarizationError('Summarization service is unavailable (HTTP 503).', 502, true)
const permanent = () => new SummarizationError('Summarization service refused the request (HTTP 400).', 502, false)

const chunkAttempts = async (meetingId: string) => (await repos().pipeline.listChunks(meetingId)).map(c => c.attempts)

describe('advanceExtraction: a whole run', () => {
  it('plans, extracts each chunk in its own step, then finalizes to ready', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const outcomes = await drive(m.id, depsWith(s.summarizer))

    expect(outcomes.map(o => o.kind === 'progress' ? `${o.progress.done}/${o.progress.total}` : o.kind))
      .toEqual(['0/3', '1/3', '2/3', '3/3', 'done'])
    expect(s.calls).toEqual([0, 1, 2])

    const done = outcomes.at(-1)!
    if (done.kind !== 'done') throw new Error('not done')
    expect(done.meeting.status).toBe('ready')
    const segments = longSegments(3)
    const stub = createStubSummarizer()
    const parts = await Promise.all(segments.map(seg => stub.summarizeChunk({ segments: [seg] })))
    const { summary, decisions, actionItems } = mergeReconciled(parts)
    expect(done.summary).toEqual({ summary, decisions, actionItems, provider: 'stub' })
    expect(await repos().summaries.getForMeeting(m.id)).toEqual(done.summary)
  })

  it('moves the meeting to indexing with the planning step, and answers continue', async () => {
    const m = await newMeeting('summarizing')
    const first = await advanceExtraction(m.id, depsWith(scripted().summarizer))
    expect(first).toMatchObject({ kind: 'progress', next: 'continue', retryAt: null, progress: { done: 0, total: 3, lastError: null } })
    expect((await repos().meetings.get(m.id))!.status).toBe('indexing')
  })

  it('returns the stored summary once ready, without a provider call', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    await drive(m.id, depsWith(s.summarizer))
    const again = await advanceExtraction(m.id, depsWith(s.summarizer))
    expect(again.kind).toBe('done')
    expect(s.calls).toHaveLength(3)
  })

  it('finishes a silent recording in one step, with an empty summary', async () => {
    const m = await newMeeting('summarizing', [])
    const s = scripted()
    const outcome = await advanceExtraction(m.id, depsWith(s.summarizer))
    expect(outcome).toMatchObject({ kind: 'done', meeting: { status: 'ready' }, summary: { decisions: [], actionItems: [] } })
    expect(s.calls).toEqual([])
  })

  it('fails a transcript needing more than MAX_CHUNKS requests before sending any', async () => {
    const m = await newMeeting('summarizing', longSegments(MAX_CHUNKS + 1))
    const s = scripted()
    const outcome = await advanceExtraction(m.id, depsWith(s.summarizer))
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 413 })
    const after = (await repos().meetings.get(m.id))!
    expect(after).toMatchObject({ status: 'failed', failedStage: 'summarization' })
    expect(after.errorMessage).toMatch(/41 sequential requests/)
    expect(await repos().pipeline.listChunks(m.id)).toEqual([])
    expect(s.calls).toEqual([])
  })

  it('repairs a ready meeting whose summary row is missing with a new run', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    await drive(m.id, depsWith(s.summarizer))
    const runBefore = (await repos().pipeline.listRuns(m.id))[0]!.runId
    await repos().summaries.deleteForMeeting(m.id)

    const outcomes = await drive(m.id, depsWith(s.summarizer))
    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'ready' } })
    expect((await repos().pipeline.listRuns(m.id))[0]!.runId).not.toBe(runBefore)
    expect(s.calls).toEqual([0, 1, 2, 0, 1, 2])
  })

  it('refuses a meeting with no transcript yet without moving it, and 404s an unknown one', async () => {
    const m = await newMeeting('uploaded')
    expect(await advanceExtraction(m.id, depsWith(scripted().summarizer))).toMatchObject({ kind: 'refused', statusCode: 409 })
    expect((await repos().meetings.get(m.id))!.status).toBe('uploaded')
    expect(await repos().pipeline.listRuns(m.id)).toEqual([])
    expect(await advanceExtraction(randomUUID(), depsWith(scripted().summarizer))).toMatchObject({ kind: 'refused', statusCode: 404 })
  })
})

describe('advanceExtraction: interruptions', () => {
  it('waits on a live step without claiming, then resumes a killed one without redoing finished chunks', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const deps = depsWith(s.summarizer)
    await advanceExtraction(m.id, deps) // plan
    await advanceExtraction(m.id, deps) // chunk 0

    // A step that claimed chunk 1 and was killed before it answered.
    const killed = await repos().pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 50, chunkNo: 1 })
    expect(killed).not.toBeNull()
    const blocked = await advanceExtraction(m.id, deps)
    expect(blocked).toMatchObject({ kind: 'progress', next: 'wait' })
    if (blocked.kind !== 'progress') throw new Error('unreachable')
    expect(blocked.retryAt!.getTime()).toBeLessThanOrEqual(Date.now() + LIVE_STEP_POLL_MS)
    expect(s.calls).toEqual([0])

    await sleep(60)
    const outcomes = await drive(m.id, deps)
    expect(outcomes.at(-1)!.kind).toBe('done')
    expect(s.calls).toEqual([0, 1, 2])
  })

  it('fails a chunk whose claims keep ending without an answer, without another provider call', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const deps = depsWith(s.summarizer)
    await advanceExtraction(m.id, deps) // plan
    for (let i = 0; i < 2; i++) {
      await repos().pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 1, chunkNo: 0 })
      await sleep(5)
    }
    const outcome = await advanceExtraction(m.id, deps)
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 502 })
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.message).toMatch(/chunk 1 of 3 stopped without an answer 2 times/)
    expect((await repos().meetings.get(m.id))!.status).toBe('failed')
    expect(s.calls).toEqual([])
  })

  it('makes two concurrent drivers call each chunk exactly once', async () => {
    const m = await newMeeting('summarizing', longSegments(4))
    const s = scripted()
    const deps = depsWith(s.summarizer)
    const [a, b] = await Promise.all([drive(m.id, deps, 200), drive(m.id, deps, 200)])
    expect(a.at(-1)!.kind).toBe('done')
    expect(b.at(-1)!.kind).toBe('done')
    expect([...s.calls].sort()).toEqual([0, 1, 2, 3])
    const [last, other] = [a.at(-1)!, b.at(-1)!]
    if (last.kind !== 'done' || other.kind !== 'done') throw new Error('unreachable')
    expect(other.summary).toEqual(last.summary)
  })
})

describe('advanceExtraction: failures and retries', () => {
  it('parks a retryable failure and retries the chunk on the next step', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    s.queue(1, transient())
    const outcomes = await drive(m.id, depsWith(s.summarizer))

    const parked = outcomes.find(o => o.kind === 'progress' && o.progress.lastError)
    expect(parked).toMatchObject({ next: 'continue', progress: { lastError: expect.stringMatching(/HTTP 503/) } })
    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'ready' } })
    expect(s.calls).toEqual([0, 1, 1, 2])
  })

  it('fails the run when the second attempt fails too', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    s.queue(1, transient(), transient())
    const outcome = (await drive(m.id, depsWith(s.summarizer))).at(-1)
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 502, message: expect.stringMatching(/HTTP 503/) })
    expect(await repos().meetings.get(m.id)).toMatchObject({ status: 'failed', failedStage: 'summarization' })
  })

  it('retries a failed run only from the chunk that failed, after the cooldown', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    s.queue(1, permanent())
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'failed', statusCode: 502 })

    const tooSoon = await advanceExtraction(m.id, deps)
    expect(tooSoon).toMatchObject({ kind: 'refused', statusCode: 409, message: expect.stringMatching(/wait \d+s/) })

    time.advance(RETRY_COOLDOWN_MS + 1000)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done', meeting: { status: 'ready', errorMessage: null } })
    expect(s.calls).toEqual([0, 1, 1, 2])
  })

  it('starts the failed chunk\'s attempts over on a retry, so one more transient failure parks it', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    s.queue(0, transient(), transient())
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'failed' })
    expect(await chunkAttempts(m.id)).toEqual([2, 0, 0])

    time.advance(RETRY_COOLDOWN_MS + 1000)
    s.queue(0, transient())
    const retried = await advanceExtraction(m.id, deps)
    expect(retried).toMatchObject({ kind: 'progress', next: 'continue', meeting: { status: 'indexing' } })
    expect(await chunkAttempts(m.id)).toEqual([1, 0, 0])
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
  })

  it('parks a 429 until the provider\'s retry time without spending an attempt, then completes', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    const until = new Date(time.now() + 30_000)
    s.queue(1, rateLimited(until))
    await advanceExtraction(m.id, deps) // plan
    await advanceExtraction(m.id, deps) // chunk 0

    const parked = await advanceExtraction(m.id, deps)
    expect(parked).toMatchObject({ kind: 'progress', next: 'wait', retryAt: until })
    expect(await chunkAttempts(m.id)).toEqual([1, 0, 0])
    expect((await repos().meetings.get(m.id))!.status).toBe('indexing')

    // Still parked: nothing is claimed and nothing is sent before then.
    expect(await advanceExtraction(m.id, deps)).toMatchObject({ kind: 'progress', next: 'wait', retryAt: until })
    expect(s.calls).toEqual([0, 1])

    time.advance(31_000)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
    expect(s.calls).toEqual([0, 1, 1, 2])
  })

  it('fails the run on the third 429 in a row for one chunk, and holds the retry until the provider allows it', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    await advanceExtraction(m.id, deps) // plan
    const blockMs = 5 * 60_000
    for (let i = 0; i < 3; i++) s.queue(0, rateLimited(new Date(time.now() + blockMs * (i + 1))))

    let outcome = await advanceExtraction(m.id, deps)
    for (let i = 0; i < 2; i++) {
      expect(outcome).toMatchObject({ kind: 'progress', next: 'wait' })
      time.advance(blockMs + 1000)
      outcome = await advanceExtraction(m.id, deps)
    }
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 429 })
    expect(await repos().meetings.get(m.id)).toMatchObject({ status: 'failed', failedStage: 'summarization' })
    expect(await chunkAttempts(m.id)).toEqual([0, 0, 0])

    // The cooldown is the provider's block when that is longer than the fixed one.
    time.advance(RETRY_COOLDOWN_MS + 1000)
    expect(await advanceExtraction(m.id, deps)).toMatchObject({ kind: 'refused', statusCode: 409 })
    time.advance(blockMs)
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
  })

  it('counts only consecutive 429s: another failure in between starts the count again', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    await advanceExtraction(m.id, deps) // plan
    const soon = () => new Date(time.now() + 1000)
    s.queue(0, rateLimited(soon()), rateLimited(soon()))
    for (let i = 0; i < 2; i++) {
      expect(await advanceExtraction(m.id, deps)).toMatchObject({ kind: 'progress', next: 'wait' })
      time.advance(2000)
    }
    s.queue(0, transient(), rateLimited(soon()), rateLimited(soon()))
    for (let i = 0; i < 3; i++) {
      expect(await advanceExtraction(m.id, deps)).toMatchObject({ kind: 'progress' })
      time.advance(2000)
    }
    expect((await drive(m.id, deps)).at(-1)).toMatchObject({ kind: 'done' })
  })

  it('parks a slot miss without spending an attempt, and without breaking a run of 429s', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    const time = clock()
    const deps = depsWith(s.summarizer, time.now)
    await advanceExtraction(m.id, deps) // plan
    const soon = () => new Date(time.now() + 1000)
    s.queue(0, rateLimited(soon()), busy(soon()), rateLimited(soon()), rateLimited(soon()))
    const outcomes: ExtractionOutcome[] = []
    for (let i = 0; i < 4; i++) {
      outcomes.push(await advanceExtraction(m.id, deps))
      time.advance(2000)
    }
    expect(outcomes.map(o => o.kind)).toEqual(['progress', 'progress', 'progress', 'failed'])
    expect(outcomes[1]).toMatchObject({ next: 'wait' })
    expect(await chunkAttempts(m.id)).toEqual([0, 0, 0])
  })

  it('treats an unexpected error from the step as a retryable failure', async () => {
    const m = await newMeeting('summarizing')
    const s = scripted()
    s.queue(2, new Error('connection reset'))
    const outcomes = await drive(m.id, depsWith(s.summarizer))
    expect(outcomes.some(o => o.kind === 'progress' && o.progress.lastError === 'connection reset')).toBe(true)
    expect(outcomes.at(-1)!.kind).toBe('done')
  })
})
