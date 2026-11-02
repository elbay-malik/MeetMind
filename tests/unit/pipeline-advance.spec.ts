import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineResponse } from '../../shared/types/meeting'
import { audioObjectKey, whisperReplyKey } from '../../shared/utils/meeting'
import { readyWindowCount } from '../../server/utils/db/windows'
import { deleteMeeting } from '../../server/utils/meeting-deletion'
import { advancePipeline, type PipelineDeps } from '../../server/utils/pipeline/advance'
import { LONGEST_INDEX_WAIT_MS } from '../../server/utils/pipeline/assess'
import { dailyLimitReached, DAILY_RESET_MARGIN_MS, EmbeddingError, EmbeddingInputTooLongError } from '../../server/utils/qa/embedder'
import { advanceIndexing, UNATTENDED_PARK_MS } from '../../server/utils/qa/steps'
import { hashedTokenVector, STUB_EMBEDDING_MODEL } from '../../server/utils/qa/stub'
import { planWindows } from '../../server/utils/qa/windows'
import { WORKERS_AI_EMBEDDING_MODEL } from '../../server/utils/qa/workers-ai'
import { MAX_CHUNKS, RETRY_COOLDOWN_MS, RETRYABLE_PARK_MS } from '../../server/utils/summary/steps'
import { SummarizationError } from '../../server/utils/summary/summarizer'
import { TranscriptionError } from '../../server/utils/transcription/transcriber'
import { longLine, pipelineHarness, scriptedProviders, segmentsOf, shortLine, tallied, type ScriptedProviders } from './helpers/pipeline'

/**
 * `POST .../advance` over the local drivers and scripted providers: whichever step is next,
 * one per request, with what a driver is told taken from what is stored. The table it
 * chooses from is tests/unit/pipeline-priority.spec.ts, row by row.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-advance-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const harness = pipelineHarness(() => dataDir)
const { repos, db, depsWith, uploadedMeeting, transcribedMeeting, advance, read, stored, store } = harness

const NOON = Date.parse('2026-11-03T12:00:00.000Z')
const NEXT_MIDNIGHT = Date.parse('2026-11-04T00:00:00.000Z')

// One clock for the steps, the leases, the slots and the cooldowns. Only `Date`: the file
// drivers still need real timers.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOON)
  await Promise.all(['groq-chat', 'groq-whisper', 'workers-ai-embed'].map(p => db().removeItem(`slots/${p}`)))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const tick = (ms: number) => vi.setSystemTime(Date.now() + ms)
const lines = (count: number, line: (i: number) => string = longLine) => Array.from({ length: count }, (_, i) => line(i))

/** The most a request can spend, against 50 on the free plan. The case that reaches it is below, by name. */
const WORST_CASE_SUBREQUESTS = 27
/** No meeting of these sizes takes more requests than this to get anywhere, or to stop. */
const STEP_BOUND = 300

/** Call until told to stop, as `driveToDone` does, moving the clock through each wait. Returns every answer. */
async function driveToDone(id: string, deps: PipelineDeps, maxSteps = STEP_BOUND): Promise<PipelineResponse[]> {
  const answers: PipelineResponse[] = []
  for (let i = 0; i < maxSteps; i++) {
    const answer = await advance(id, deps)
    answers.push(answer)
    if (answer.next === 'done' || answer.next === 'failed') return answers
    if (answer.next === 'wait') tick((answer.retryAfterMs ?? 0) + 1)
  }
  throw new Error(`${id} was not finished after ${maxSteps} requests: ${JSON.stringify(answers.slice(-3))}`)
}

/**
 * {@link driveToDone}, failing the moment a `continue` turns out to have meant nothing, or a
 * request spends more than one request may, on any path through it.
 */
async function driveHoldingToContinue(id: string, deps: PipelineDeps, maxSteps = STEP_BOUND): Promise<PipelineResponse[]> {
  const answers: PipelineResponse[] = []
  const counted = tallied(deps)
  let before = await stored(id)
  for (let i = 0; i < maxSteps; i++) {
    const answer = await advance(id, counted.deps)
    const spent = counted.take()
    expect(spent.subrequests).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS)
    expect(spent.claims).toBeLessThanOrEqual(1)
    expect(spent.providerCalls).toBeLessThanOrEqual(1)
    const after = await stored(id)
    if (answers.at(-1)?.next === 'continue') {
      expect(after, 'told to continue, and the next call changed nothing').not.toEqual(before)
    }
    before = after
    answers.push(answer)
    if (answer.next === 'done' || answer.next === 'failed') return answers
    if (answer.next === 'wait') tick((answer.retryAfterMs ?? 0) + 1)
  }
  throw new Error(`${id} was not finished after ${maxSteps} requests: ${JSON.stringify(answers.slice(-3))}`)
}

/** Call until `until` holds of the answer. */
async function advanceUntil(id: string, deps: PipelineDeps, until: (answer: PipelineResponse) => boolean): Promise<PipelineResponse> {
  for (let i = 0; i < STEP_BOUND; i++) {
    const answer = await advance(id, deps)
    if (until(answer)) return answer
    if (answer.next === 'wait') tick((answer.retryAfterMs ?? 0) + 1)
    if (answer.next === 'done' || answer.next === 'failed') throw new Error(`stopped early: ${JSON.stringify(answer)}`)
  }
  throw new Error('never got there')
}

const inExtraction = (answer: PipelineResponse) => answer.progress.stage === 'summarization'
const meetingOf = async (id: string) => (await repos().meetings.get(id))!
const stateOf = (id: string, model = 'model-a') => repos().index.readState(id, model)
const runOf = async (id: string, stage: string) => (await repos().pipeline.listRuns(id)).find(r => r.stage === stage)
const busy = (retryAt: number) => new SummarizationError('busy', 429, true, { kind: 'busy', retryAt: new Date(retryAt) })
const rateLimited = (retryAt: number) => new SummarizationError('rate limited', 429, true, { kind: 'rate-limited', retryAt: new Date(retryAt) })

/** One request, proving it stopped: nothing claimed, sent or written, and no change of mind. */
async function expectNothingMoves(id: string, deps: PipelineDeps, answer: PipelineResponse) {
  const before = await stored(id)
  const counted = tallied(deps)
  expect(await advance(id, counted.deps)).toEqual(answer)
  const spent = counted.take()
  expect(spent.claims).toBe(0)
  expect(spent.providerCalls).toBe(0)
  expect(await stored(id)).toEqual(before)
}

describe('one request', () => {
  /** A whole drive, checking every request as it goes, and how much each spent. */
  async function driveCounting(count: number, line?: (i: number) => string) {
    const providers = scriptedProviders(lines(count, line))
    const id = await uploadedMeeting()
    const counted = tallied(depsWith(providers))
    const answers: PipelineResponse[] = []
    const spent: Array<ReturnType<typeof counted.take>> = []
    for (let i = 0; i < STEP_BOUND; i++) {
      const before = providers.calls.length
      const answer = await advance(id, counted.deps)
      const request = counted.take()
      spent.push(request)
      answers.push(answer)
      expect(providers.calls.length - before, 'more than one provider request').toBeLessThanOrEqual(1)
      expect(request.claims, 'more than one claim').toBeLessThanOrEqual(1)
      expect(request.subrequests).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS)
      if (answer.next !== 'continue') break
    }
    return { id, providers, answers, spent }
  }

  it('takes a meeting from uploaded to ready, its index complete, and leaves no stage out', async () => {
    const { id, providers, answers } = await driveCounting(8)
    const plan = await planWindows(segmentsOf(lines(8)))

    expect(answers.at(-1)).toEqual({
      status: 'ready',
      progress: { stage: 'search_index', done: plan.length, total: plan.length, etaSeconds: null },
      index: { state: 'complete', done: plan.length, total: plan.length, retryAt: null },
      next: 'done',
      retryAt: null,
      retryAfterMs: null,
    })

    // Read back from what is stored, not from the answers.
    expect((await repos().transcripts.listFrom(id, 0, 100)).segments.map(s => s.text)).toEqual(lines(8))
    const { summaries } = depsWith(providers)
    expect(await summaries.getForMeeting(id)).toMatchObject({ provider: 'stub' })
    expect(readyWindowCount(await stateOf(id), 'model-a')).toBe(plan.length)
    expect(await store().head(whisperReplyKey(id))).toBeNull()

    // Exactly what each stage costs at the provider: nothing skipped, nothing twice.
    expect(providers.count('whisper')).toBe(1)
    expect(providers.sent.chunks).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(providers.sent.windows).toEqual(plan.map(w => w.text))
  })

  it('runs the stages in the table\'s order: every chunk before the index, and the summary last of all', async () => {
    const { providers, answers } = await driveCounting(4)
    expect(providers.calls[0]).toBe('whisper')
    expect(providers.calls.lastIndexOf('chunk')).toBeLessThan(providers.calls.indexOf('embed'))
    // Row 4 comes before row 5, so the meeting is not ready until the index is finished.
    const firstReady = answers.findIndex(a => a.status === 'ready')
    expect(answers[firstReady]!.index.state).toBe('complete')
  })

  it('reports figures that never run backwards, on a stage that only moves forward', async () => {
    const { answers } = await driveCounting(8)
    const order = ['transcription', 'summarization', 'search_index']
    expect([...new Set(answers.map(a => a.progress.stage))]).toEqual(order)
    for (const [earlier, later] of answers.slice(1).map((a, i) => [answers[i]!, a] as const)) {
      expect(order.indexOf(later.progress.stage)).toBeGreaterThanOrEqual(order.indexOf(earlier.progress.stage))
      expect(later.index.done).toBeGreaterThanOrEqual(earlier.index.done)
      if (later.progress.stage !== earlier.progress.stage) continue
      expect(later.progress.done).toBeGreaterThanOrEqual(earlier.progress.done)
      if (earlier.progress.total !== null) expect(later.progress.total).toBe(earlier.progress.total)
    }
    expect(answers.every(a => a.progress.etaSeconds === null)).toBe(true)
  })

  it('spends the same at most on a long meeting as on a short one', async () => {
    const short = await driveCounting(4)
    const long = await driveCounting(MAX_CHUNKS - 1)
    const most = (run: { spent: Array<{ subrequests: number }> }) => Math.max(...run.spent.map(r => r.subrequests))
    expect(long.spent.length).toBeGreaterThan(short.spent.length * 3)
    expect(most(long)).toBe(most(short))
    // A transcript read whole would be the one read here that grows with the meeting.
    expect(long.spent.flatMap(r => r.calls)).not.toContain('transcripts.listForMeeting')
  })

  it('reads no chunk\'s result to choose a step, only when extraction is the step', async () => {
    const { spent } = await driveCounting(MAX_CHUNKS - 1)
    const indexSteps = spent.filter(r => r.calls.includes('embedder.embedDocuments'))
    expect(indexSteps.length).toBeGreaterThan(0)
    for (const request of indexSteps) expect(request.calls).not.toContain('pipeline.listChunks')
    expect(spent.some(r => r.calls.includes('pipeline.countChunks'))).toBe(true)
  })

  // The longest path there is through one request: the first chunk of a plan, which reads the
  // plan twice to find its way there, whose step then outlives its lease.
  it('spends the most on a first chunk that loses its claim while out at the provider', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, answer => answer.status === 'summarizing')

    const ledger = () => db().getItem<{ runs: { summarization: { stepLeaseUntil: number } } }>(`pipeline/${id}`)
    providers.during.chunk.push(async () => {
      const held = await ledger()
      held!.runs.summarization.stepLeaseUntil = Date.now() - 1
      await db().setItem(`pipeline/${id}`, held)
      expect(await deps.pipeline.claimStep(id, 'summarization', { status: 'indexing', leaseMs: 60_000, chunkNo: 0 })).not.toBeNull()
    })

    const counted = tallied(deps)
    const answer = await advance(id, counted.deps)
    const spent = counted.take()
    expect(spent.subrequests).toBe(WORST_CASE_SUBREQUESTS)
    expect(spent.claims).toBe(1)
    expect(spent.providerCalls).toBe(1)
    // The other step has the chunk, and this one is told so, with nothing stored of its own.
    expect(answer).toMatchObject({ status: 'indexing', next: 'continue', progress: { done: 0, total: 3 } })
    expect(providers.count('chunk')).toBe(1)
    expect((await deps.pipeline.listChunks(id))[0]!.result).toBeNull()
  })

  it.each<[string, () => Promise<string>, number]>([
    ['a chunk parked on its slot, the counts included', async () => {
      const id = await transcribedMeeting(segmentsOf(lines(2)), 'indexing')
      const { pipeline } = repos()
      const claim = (await pipeline.claimStep(id, 'summarization', { status: 'indexing', leaseMs: 1_000 }))!
      await pipeline.planChunks(id, claim.token, [{ chunkNo: 0, segFrom: 0, segTo: 1, estTokens: 10 }])
      await pipeline.releaseStep(id, 'summarization', claim.token, { error: null, retryAt: new Date(NOON + 60_000) })
      await repos().index.upsertWindows(id, (await planWindows(segmentsOf(lines(2)))).map(w => ({ ...w, model: 'model-a', embedding: hashedTokenVector(w.text) })))
      const parked = (await pipeline.claimStep(id, 'search_index', { status: 'indexing', leaseMs: 1_000 }))!
      await pipeline.releaseStep(id, 'search_index', parked.token, { error: null, retryAt: new Date(NOON + 60_000) })
      return id
    }, 5],
    ['a finished meeting, whose chunks are not counted again', async () => {
      const id = await uploadedMeeting()
      await driveToDone(id, depsWith(scriptedProviders(lines(1))))
      expect((await repos().pipeline.listRuns(id)).map(run => run.stage)).toContain('summarization')
      return id
    }, 3],
    ['a failure cooling down before there is a transcript', async () => {
      const id = await uploadedMeeting()
      const providers = scriptedProviders([])
      providers.queue('whisper', new TranscriptionError('quota', 429, true))
      await advance(id, depsWith(providers))
      return id
    }, 2],
  ])('spends only the reads on %s, with no step to take', async (_name, arrange, reads) => {
    const id = await arrange()
    const counted = tallied(depsWith(scriptedProviders([])))
    await advance(id, counted.deps)
    const spent = counted.take()
    expect(spent.subrequests).toBe(reads)
    expect(spent.claims).toBe(0)
  })

  it('is not moved past a meeting nobody has confirmed the upload of', async () => {
    const providers = scriptedProviders(lines(2))
    const id = randomUUID()
    await harness.meetingWith(id, [], 'pending_upload')
    expect(await advancePipeline(id, depsWith(providers))).toEqual({ kind: 'not-uploaded' })
    expect(providers.calls).toEqual([])
  })

  it('says so of a meeting that does not exist, and writes nothing for it', async () => {
    const id = randomUUID()
    expect(await advancePipeline(id, depsWith(scriptedProviders([])))).toEqual({ kind: 'missing' })
    expect(await db().getItem(`pipeline/${id}`)).toBeNull()
  })
})

describe('GET .../pipeline', () => {
  it('answers what the next POST would be told, at every point of a drive, and changes nothing', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const counted = tallied(deps)

    for (let i = 0; i < STEP_BOUND; i++) {
      const before = await stored(id)
      const calls = providers.calls.length
      const looked = await read(id, counted.deps)
      const spent = counted.take()
      expect(spent.claims).toBe(0)
      expect(spent.providerCalls).toBe(0)
      expect(spent.calls.every(call => ['meetings.get', 'pipeline.listRuns', 'pipeline.countChunks', 'index.readState'].includes(call))).toBe(true)
      expect(providers.calls.length).toBe(calls)
      expect(await stored(id)).toEqual(before)
      if (looked.next === 'done') break
      const answer = await advance(id, deps)
      expect(await read(id, counted.deps)).toEqual(answer)
      counted.take()
    }
    expect((await read(id, deps)).next).toBe('done')
  })

  it('reserves no slot and reads no block, whatever is pending', async () => {
    const id = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
    const providers = scriptedProviders([])
    const reserve = vi.fn()
    const looked = await read(id, depsWith(providers, { slots: { ...repos().slots, reserve } }))
    expect(looked.next).toBe('continue')
    expect(reserve).not.toHaveBeenCalled()
    expect(await db().getItem(`pipeline/${id}`)).toBeNull()
  })
})

describe('extraction and the index, side by side', () => {
  it('indexes during extraction\'s gaps, makes no call on a parked slot, and goes back when it frees', async () => {
    const providers = scriptedProviders(lines(4))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)

    const slotAt = NOON + 60_000
    providers.queue('chunk', busy(slotAt))
    const parked = await advance(id, deps)
    // Nothing was sent, but the claim that found out cost a request, and there is more to do.
    expect(parked).toMatchObject({ status: 'indexing', next: 'continue', progress: { stage: 'summarization', done: 0, total: 4 } })
    const chunkCalls = providers.count('chunk')

    const indexed = await advanceUntil(id, deps, answer => answer.index.state === 'complete' || answer.next === 'wait')
    expect(providers.count('embed')).toBeGreaterThan(0)
    expect(providers.count('chunk')).toBe(chunkCalls)
    // Questions can be asked before extraction has finished.
    expect(indexed).toMatchObject({ status: 'indexing', index: { state: 'complete' } })
    expect(readyWindowCount(await stateOf(id), 'model-a')).not.toBeNull()

    // Nothing runnable, so it says when, and asks no provider until then.
    const waiting = await advance(id, deps)
    expect(waiting).toMatchObject({ next: 'wait', retryAt: new Date(slotAt).toISOString(), retryAfterMs: slotAt - NOON })
    await expectNothingMoves(id, deps, waiting)
    expect(providers.count('chunk')).toBe(chunkCalls)

    vi.setSystemTime(slotAt)
    expect((await advance(id, deps)).progress.done).toBe(1)
    expect(providers.count('chunk')).toBe(chunkCalls + 1)
    const last = await driveToDone(id, deps)
    expect(last.at(-1)).toMatchObject({ status: 'ready', next: 'done' })
    expect(providers.count('chunk')).toBe(chunkCalls + 4)
  })

  it('does not hold a chunk up for an index parked on its own slot, nor the reverse', async () => {
    const providers = scriptedProviders(lines(30))
    const id = await uploadedMeeting()
    const deps = depsWith(providers, { embedIntervalMs: 30_000 })
    await advanceUntil(id, deps, inExtraction)

    // The chunk is parked, so the index goes, and then parks on a slot of its own.
    providers.queue('chunk', busy(NOON + 60_000))
    await advance(id, deps)
    await advance(id, deps)
    expect(providers.count('embed')).toBe(1)
    await advance(id, deps)
    const run = await runOf(id, 'search_index')
    expect(run?.retryAt?.getTime()).toBeGreaterThan(Date.now())
    expect(providers.count('embed')).toBe(1)

    // Waiting, for the earlier of the two.
    expect(await advance(id, deps)).toMatchObject({ next: 'wait', retryAt: run!.retryAt!.toISOString() })

    // Now the chunk's slot is free and the index's has just been parked again: the chunk goes.
    await db().removeItem('slots/workers-ai-embed')
    vi.setSystemTime(run!.retryAt!.getTime())
    await advance(id, deps)
    expect(providers.count('embed')).toBe(2)
    vi.setSystemTime(NOON + 60_000)
    const chunks = providers.count('chunk')
    await advance(id, deps)
    expect(providers.count('chunk')).toBe(chunks + 1)
    expect(providers.count('embed')).toBe(2)
  })
})

describe('an index parked at the daily limit', () => {
  /** A meeting whose extraction is parked, and whose first index batch is refused for the day. */
  async function refusedDuringExtraction(count = 3) {
    const providers = scriptedProviders(lines(count))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)
    providers.queue('chunk', busy(NOON + 60_000))
    providers.queue('embed', dailyLimitReached(new Date(NOON)))
    await advance(id, deps)
    await advance(id, deps)
    return { providers, id, deps }
  }

  it('leaves the status alone and never answers failed, and extraction carries on', async () => {
    const { providers, id, deps } = await refusedDuringExtraction()
    expect((await runOf(id, 'search_index'))?.retryAt?.getTime()).toBe(NEXT_MIDNIGHT)

    // Waiting on the chunk's minute, not the limit's hours.
    const waiting = await advance(id, deps)
    expect(waiting).toMatchObject({
      status: 'indexing', next: 'wait', retryAt: new Date(NOON + 60_000).toISOString(),
      index: { state: 'parked', retryAt: new Date(NEXT_MIDNIGHT).toISOString() },
    })

    const answers = await driveHoldingToContinue(id, deps)
    expect(answers.every(a => a.next !== 'failed')).toBe(true)
    expect(answers.every(a => (a.retryAfterMs ?? 0) <= 60_000 || a.next === 'done')).toBe(true)
    expect(providers.count('chunk')).toBe(4)
    expect(await meetingOf(id)).toMatchObject({ status: 'ready', errorMessage: null, failedStage: null })
    // The summary is stored, with the index not: no provider request after the first refusal.
    expect(await depsWith(providers).summaries.getForMeeting(id)).not.toBeNull()
    expect(providers.count('embed')).toBe(1)
  })

  it('answers done, not a sleep of hours, once nothing else is left, and says when the rest can go', async () => {
    const { id, deps } = await refusedDuringExtraction()
    const last = (await driveToDone(id, deps)).at(-1)!
    expect(last).toMatchObject({
      status: 'ready',
      next: 'done',
      retryAt: new Date(NEXT_MIDNIGHT).toISOString(),
      progress: { stage: 'search_index', etaSeconds: null },
      index: { state: 'parked', retryAt: new Date(NEXT_MIDNIGHT).toISOString() },
    })
    // Asked again, the same, for free, for as long as anyone asks. A read says the same.
    await expectNothingMoves(id, deps, { ...last, retryAfterMs: NEXT_MIDNIGHT - Date.now() })
    expect(await read(id, deps)).toEqual({ ...last, retryAfterMs: NEXT_MIDNIGHT - Date.now() })
  })

  it('picks up where it stopped once the day has passed, from whichever driver opens it next', async () => {
    const { providers, id, deps } = await refusedDuringExtraction()
    await driveToDone(id, deps)
    vi.setSystemTime(NEXT_MIDNIGHT + 1)
    const last = (await driveToDone(id, deps)).at(-1)!
    expect(last).toMatchObject({ next: 'done', retryAt: null, index: { state: 'complete' } })
    expect(providers.count('embed')).toBeGreaterThan(1)
    expect(readyWindowCount(await stateOf(id), 'model-a')).not.toBeNull()
  })

  it('is waited out just before the limit resets, when the wait is only minutes', async () => {
    const providers = scriptedProviders(lines(1))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    vi.setSystemTime(NEXT_MIDNIGHT - LONGEST_INDEX_WAIT_MS)
    providers.queue('embed', dailyLimitReached())
    expect(await advance(id, depsWith(providers))).toMatchObject({ status: 'ready', next: 'wait', retryAt: new Date(NEXT_MIDNIGHT).toISOString(), index: { state: 'building' } })
  })

  it('is waited out in the minutes after the limit resets, however it was refused', async () => {
    const providers = scriptedProviders(lines(1))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    vi.setSystemTime(NEXT_MIDNIGHT)
    providers.queue('embed', dailyLimitReached())
    expect(await advance(id, depsWith(providers))).toMatchObject({
      next: 'wait', retryAt: new Date(NEXT_MIDNIGHT + DAILY_RESET_MARGIN_MS).toISOString(),
    })
  })

  it('stops another meeting too, the block being the account\'s, with nothing sent for it', async () => {
    const first = scriptedProviders(lines(1))
    const refused = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    first.queue('embed', dailyLimitReached())
    await advance(refused, depsWith(first))

    const second = scriptedProviders(lines(1))
    const other = await transcribedMeeting(segmentsOf(['another meeting altogether']), 'ready')
    expect(await advance(other, depsWith(second))).toMatchObject({
      status: 'ready', next: 'done', retryAt: new Date(NEXT_MIDNIGHT).toISOString(), index: { state: 'parked' },
    })
    expect(second.calls).toEqual([])
  })
})

describe('failure and termination', () => {
  const down = () => new TranscriptionError('Whisper is down', 502, true)
  const chunkDown = () => new SummarizationError('Groq is down', 502, true)
  const embedDown = () => new EmbeddingError('Embedding service is unavailable (HTTP 503).', 502, true)

  /**
   * Every provider failing every way it can, for as long as it is asked: a driver reaches an
   * answer that tells it to stop, within a bound, and each `continue` on the way meant
   * something. `calls` is the most each provider is asked.
   */
  it.each<[string, (p: ScriptedProviders) => void, Partial<PipelineResponse> & { status: string }, Partial<Record<'whisper' | 'chunk' | 'embed', number>>]>([
    ['Whisper 5xx', p => p.keepFailing('whisper', down), { status: 'failed', next: 'failed' }, { whisper: 2, chunk: 0, embed: 0 }],
    ['Whisper refusing', p => p.keepFailing('whisper', () => new TranscriptionError('refused', 400, false)), { status: 'failed', next: 'failed' }, { whisper: 1, chunk: 0, embed: 0 }],
    ['Whisper 429', p => p.keepFailing('whisper', () => new TranscriptionError('quota', 429, true)), { status: 'failed', next: 'failed' }, { whisper: 1, chunk: 0, embed: 0 }],
    ['chat 5xx', p => p.keepFailing('chunk', chunkDown), { status: 'failed', next: 'failed' }, { chunk: 2 }],
    ['chat refusing', p => p.keepFailing('chunk', () => new SummarizationError('refused', 400, false)), { status: 'failed', next: 'failed' }, { chunk: 1 }],
    ['chat 429', p => p.keepFailing('chunk', () => rateLimited(Date.now() + 1_000)), { status: 'failed', next: 'failed' }, { chunk: 3 }],
    ['embedding 5xx', p => p.keepFailing('embed', embedDown), { status: 'ready', next: 'done', index: { state: 'parked' } as never }, { embed: 2 }],
    ['embedding out of capacity', p => p.keepFailing('embed', () => new EmbeddingError('out of capacity', 503, false)), { status: 'ready', next: 'done', index: { state: 'parked' } as never }, { embed: 1 }],
    ['embedding rejecting our credentials', p => p.keepFailing('embed', () => new EmbeddingError('rejected', 502, false)), { status: 'ready', next: 'done', index: { state: 'parked' } as never }, { embed: 1 }],
    ['a passage over the model\'s limit', p => p.keepFailing('embed', () => new EmbeddingInputTooLongError(9_000)), { status: 'ready', next: 'done', retryAt: null, index: { state: 'stopped' } as never }, { embed: 1 }],
    ['the daily limit', p => p.keepFailing('embed', () => dailyLimitReached()), { status: 'ready', next: 'done', index: { state: 'parked' } as never }, { embed: 1 }],
  ])('%s, for ever, ends a driver\'s loop', async (_name, fail, end, calls) => {
    const providers = scriptedProviders(lines(3))
    fail(providers)
    const id = await uploadedMeeting()
    const deps = depsWith(providers)

    const last = (await driveHoldingToContinue(id, deps)).at(-1)!
    expect(last).toMatchObject(end)
    for (const [kind, most] of Object.entries(calls)) {
      expect(providers.count(kind as 'whisper'), kind).toBeLessThanOrEqual(most)
    }
    // A driver that has stopped costs nothing more for being told so again.
    if (last.retryAt && Date.parse(last.retryAt) > Date.now()) {
      await expectNothingMoves(id, deps, { ...last, retryAfterMs: Date.parse(last.retryAt) - Date.now() })
    }
  })

  it('an index failure still leaves the meeting ready, with the summary written', async () => {
    const providers = scriptedProviders(lines(2))
    providers.keepFailing('embed', embedDown)
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const last = (await driveToDone(id, deps)).at(-1)!
    expect(last.status).toBe('ready')
    expect(await depsWith(providers).summaries.getForMeeting(id)).not.toBeNull()
    expect(Date.parse(last.retryAt!)).toBe(Date.now() + UNATTENDED_PARK_MS)
    expect(await meetingOf(id)).toMatchObject({ errorMessage: null })
  })

  it('tries a stopped index again only after its park, once per driver', async () => {
    const providers = scriptedProviders(lines(1))
    providers.keepFailing('embed', () => new EmbeddingError('out of capacity', 503, false))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const deps = depsWith(providers)
    await driveToDone(id, deps)
    expect(providers.count('embed')).toBe(1)
    tick(UNATTENDED_PARK_MS + 1)
    await driveToDone(id, deps)
    expect(providers.count('embed')).toBe(2)
  })

  it('leaves alone an index a passage over the limit stopped, until someone asks', async () => {
    const providers = scriptedProviders(lines(1))
    providers.keepFailing('embed', () => new EmbeddingInputTooLongError(9_000))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const deps = depsWith(providers)
    const last = (await driveToDone(id, deps)).at(-1)!
    tick(24 * 3_600_000)
    await expectNothingMoves(id, deps, last)
    expect(providers.count('embed')).toBe(1)
  })

  it('a refusal an explicit request got stops the driver as well, rather than repeating it', async () => {
    const providers = scriptedProviders(lines(1))
    providers.queue('embed', new EmbeddingError('out of capacity', 503, false))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const deps = depsWith(providers)
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'failed', retryAt: null })
    expect(await advance(id, deps)).toMatchObject({ next: 'done', index: { state: 'stopped' } })
    expect(providers.count('embed')).toBe(1)
    // And the explicit request is what gets it going again.
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress' })
    expect(await advance(id, deps)).toMatchObject({ next: 'done', index: { state: 'complete' } })
  })

  it('a pass that keeps not adding up parks rather than going round for ever', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await transcribedMeeting(segmentsOf(lines(3)), 'ready')
    const deps = depsWith(providers)
    const last = (await driveHoldingToContinue(id, {
      ...deps,
      pipeline: { ...deps.pipeline, finishIndex: async () => 'changed' },
    })).at(-1)!
    expect(last).toMatchObject({ status: 'ready', next: 'done', index: { state: 'parked' } })
  })

  it('retries a failed extraction only after its cooldown, from the chunk that failed, with no help', async () => {
    const providers = scriptedProviders(lines(4))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)
    await advance(id, deps)
    await advance(id, deps)
    const before = providers.count('chunk')
    expect(before).toBe(2)
    providers.queue('chunk', new SummarizationError('refused', 400, false))

    // The failure, then the index in the gap it leaves, which moves the row each time.
    const stopped = (await driveToDone(id, deps)).at(-1)!
    expect(stopped).toMatchObject({ status: 'failed', next: 'failed', index: { state: 'complete' }, progress: { stage: 'summarization', done: 2, total: 4 } })
    expect(providers.count('chunk')).toBe(before + 1)

    // Asked again at any point in the cooldown, nothing moves. It ends where it was said to.
    const cooldown = stopped.retryAfterMs!
    expect(cooldown).toBeGreaterThanOrEqual(RETRY_COOLDOWN_MS)
    tick(cooldown - 1)
    await expectNothingMoves(id, deps, { ...stopped, retryAfterMs: 1 })

    tick(1)
    const resumed = await advance(id, deps)
    expect(resumed).toMatchObject({ status: 'indexing', next: 'continue', progress: { done: 3, total: 4 } })
    expect(await meetingOf(id)).toMatchObject({ errorMessage: null, failedStage: null })
    const last = (await driveToDone(id, deps)).at(-1)!
    expect(last).toMatchObject({ status: 'ready', next: 'done' })
    // Finished chunks were not sent again: the refused one never reached `sent`.
    expect(providers.sent.chunks).toEqual([0, 1, 2, 3])
    expect(providers.count('chunk')).toBe(before + 3)
  })

  it('retries a failed transcription only after its cooldown', async () => {
    const providers = scriptedProviders(lines(1))
    providers.queue('whisper', new TranscriptionError('quota', 429, true))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)

    const stopped = await advance(id, deps)
    expect(stopped).toMatchObject({ status: 'failed', next: 'failed', progress: { stage: 'transcription' } })
    await expectNothingMoves(id, deps, stopped)
    expect(providers.count('whisper')).toBe(1)
    tick(stopped.retryAfterMs!)
    expect(await advance(id, deps)).toMatchObject({ status: 'transcribing', next: 'continue' })
    expect(providers.count('whisper')).toBe(2)
  })

  describe('a failure no retry can help', () => {
    it('is over the chunk limit: failed, with no time to retry, after the index it can still have', async () => {
      const providers = scriptedProviders(lines(MAX_CHUNKS + 1))
      const id = await uploadedMeeting()
      const deps = depsWith(providers)

      const last = (await driveHoldingToContinue(id, deps)).at(-1)!
      expect(last).toMatchObject({ status: 'failed', next: 'failed', retryAt: null, retryAfterMs: null, index: { state: 'complete' } })
      expect(providers.count('chunk')).toBe(0)
      expect(providers.count('embed')).toBeGreaterThan(0)

      // A day later, nothing has changed its mind, and no plan is attempted.
      tick(24 * 3_600_000)
      const counted = tallied(deps)
      await advance(id, counted.deps)
      expect(counted.take().calls).not.toContain('transcripts.listForMeeting')
      await expectNothingMoves(id, deps, last)
    })

    it('is audio gone from storage: failed, no provider call, and no claim from then on', async () => {
      const providers = scriptedProviders(lines(1))
      const id = await uploadedMeeting()
      await store().delete(audioObjectKey(id))
      const deps = depsWith(providers)

      const last = await advance(id, deps)
      expect(last).toMatchObject({ status: 'failed', next: 'failed', retryAt: null })
      expect(providers.calls).toEqual([])
      tick(3_600_000)
      await expectNothingMoves(id, deps, last)
    })

    it('is a rejected upload: failed, with nothing to do at all', async () => {
      const id = randomUUID()
      await harness.meetingWith(id, [], 'failed', { failedStage: 'upload', errorMessage: 'The upload was rejected' })
      const deps = depsWith(scriptedProviders([]))
      const answer = await advance(id, deps)
      expect(answer).toMatchObject({ status: 'failed', next: 'failed', retryAt: null, progress: { stage: 'upload' }, index: { state: 'unavailable' } })
      await expectNothingMoves(id, deps, answer)
    })
  })

  it('finishes a recording with no speech as done, ready and with nothing to index', async () => {
    const providers = scriptedProviders([])
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const answers = await driveHoldingToContinue(id, deps)
    expect(answers.at(-1)).toEqual({
      status: 'ready',
      progress: { stage: 'search_index', done: 0, total: 0, etaSeconds: null },
      index: { state: 'complete', done: 0, total: 0, retryAt: null },
      next: 'done',
      retryAt: null,
      retryAfterMs: null,
    })
    expect(providers.calls).toEqual(['whisper'])
    await expectNothingMoves(id, deps, answers.at(-1)!)
  })

  it('a step that keeps throwing stops in the end, by the run\'s own count, however often it is asked', async () => {
    const providers = scriptedProviders(lines(1))
    const id = await transcribedMeeting(segmentsOf(lines(1)))
    const deps = depsWith(providers)
    const broken = { ...deps, transcripts: { ...deps.transcripts, listForMeeting: () => Promise.reject(new Error('relation "transcript_segments" is broken')) } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    let answer: PipelineResponse | null = null
    let thrown = 0
    for (let i = 0; i < 20 && answer?.next !== 'failed'; i++) {
      answer = await advance(id, broken).catch(() => {
        thrown++
        return null
      })
    }
    expect(thrown).toBeGreaterThan(0)
    expect(answer).toMatchObject({ status: 'failed', next: 'failed' })
    expect(JSON.stringify(answer)).not.toContain('transcript_segments')
  })

  it('never says continue when a slot will not free: only wait, for as long as that lasts', async () => {
    const providers = scriptedProviders(lines(2))
    providers.keepFailing('chunk', () => busy(Date.now() + 60_000))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const answer = await advanceUntil(id, deps, a => a.index.state === 'complete' && a.next === 'wait')
    expect(answer).toMatchObject({ status: 'indexing', next: 'wait' })
    for (let i = 0; i < 5; i++) {
      tick(60_001)
      // The chunk tries when told to, parks again, and that is not a failure.
      expect(await advance(id, deps)).toMatchObject({ next: 'wait', status: 'indexing' })
    }
  })

  it('a short retryable failure of the index is waited out, and carries on by itself', async () => {
    const providers = scriptedProviders(lines(2))
    providers.queue('embed', embedDown())
    const id = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
    const deps = depsWith(providers)
    expect(await advance(id, deps)).toMatchObject({ status: 'ready', next: 'wait', retryAfterMs: RETRYABLE_PARK_MS })
    tick(RETRYABLE_PARK_MS + 1)
    const last = (await driveToDone(id, deps)).at(-1)!
    expect(last).toMatchObject({ next: 'done', retryAt: null, index: { state: 'complete' } })
  })
})

/**
 * /advance runs with nobody having asked to index, and a page will call it by itself. With a
 * provider's settings missing, the stub is "another model" (SEC-16), so opening a meeting
 * must not be enough to replace its index.
 */
describe('an index nobody asked to replace', () => {
  const REAL = WORKERS_AI_EMBEDDING_MODEL
  const LOST_SETTINGS = STUB_EMBEDDING_MODEL
  const text = lines(40, shortLine)
  /** Enough windows for one explicit step not to be all of them. */
  const longText = lines(1_200, shortLine)

  const asModel = (model: string) => scriptedProviders(text, { model })

  /** A finished meeting whose index is finished too, under `model`. */
  async function indexedBy(model: string, transcript = text): Promise<string> {
    const id = await transcribedMeeting(segmentsOf(transcript), 'ready')
    const providers = asModel(model)
    await driveToDone(id, depsWith(providers))
    expect(readyWindowCount(await stateOf(id, model), model)).not.toBeNull()
    return id
  }

  /** An explicit run under `model`, one request in. */
  async function halfBuiltBy(model: string): Promise<string> {
    const id = await transcribedMeeting(segmentsOf(longText), 'ready')
    const deps = depsWith(scriptedProviders(longText, { model }))
    await advanceIndexing(id, deps)
    const state = await stateOf(id, model)
    expect(state.marker).toMatchObject({ model, complete: false })
    expect(state.storedForModel).toBeGreaterThan(0)
    return id
  }

  async function expectHandsOff(id: string, model: string) {
    const providers = asModel(model)
    const deps = depsWith(providers)
    const before = await stored(id)
    const counted = tallied(deps)
    const answer = await advance(id, counted.deps)
    expect(answer).toMatchObject({ status: 'ready', next: 'done', retryAt: null, index: { state: 'held' } })
    expect(counted.take().claims).toBe(0)
    expect(providers.calls).toEqual([])
    expect(await stored(id)).toEqual(before)
    // However long it is left and however often it is asked.
    tick(3_600_000)
    expect((await driveHoldingToContinue(id, deps)).at(-1)).toMatchObject({ next: 'done', index: { state: 'held' } })
    expect(providers.calls).toEqual([])
    expect(await stored(id)).toEqual(before)
  }

  it('is not started over when it is finished, under another model', async () => {
    const id = await indexedBy(REAL)
    await expectHandsOff(id, LOST_SETTINGS)
    // Nothing was lost: with the settings back, it is as it was, and spends nothing.
    const back = asModel(REAL)
    expect(await advance(id, depsWith(back))).toMatchObject({ next: 'done', index: { state: 'complete' } })
    expect(back.calls).toEqual([])
  })

  it('is not overwritten when it is half built, under another model', async () => {
    const id = await halfBuiltBy(REAL)
    await expectHandsOff(id, LOST_SETTINGS)
    // The hazard, to show what stops it: the explicit route does start over from here.
    const explicit = asModel(LOST_SETTINGS)
    await advanceIndexing(id, depsWith(explicit))
    expect(explicit.count('embed')).toBe(1)
    expect((await stateOf(id, LOST_SETTINGS)).storedForModel).toBeGreaterThan(0)
  })

  it('is not touched when it is another model\'s, from before there were markers', async () => {
    const id = await transcribedMeeting(segmentsOf(text), 'ready')
    const plan = await planWindows(segmentsOf(text))
    await repos().index.upsertWindows(id, plan.map(w => ({ ...w, model: REAL, embedding: hashedTokenVector(w.text) })))
    await expectHandsOff(id, LOST_SETTINGS)
  })

  it('is not carried on past another model\'s windows, even under a pass of this model', async () => {
    const id = await indexedBy(REAL, longText)
    // Someone asked, once: one explicit step of a rebuild, with the rest still the old model's.
    const deps = depsWith(asModel(LOST_SETTINGS))
    await advanceIndexing(id, deps)
    const state = await stateOf(id, LOST_SETTINGS)
    expect(state.storedForModel).toBeGreaterThan(0)
    expect(state.storedForModel).toBeLessThan(state.storedWindows)
    await expectHandsOff(id, LOST_SETTINGS)
  })

  it('is not replaced when it is finished, under this model, for a transcript since replaced', async () => {
    const id = await indexedBy(REAL)
    await repos().transcripts.replaceForMeeting(id, segmentsOf(lines(40, i => `a different line ${i}`)))
    await expectHandsOff(id, REAL)
  })

  it('is built when it is missing, and carried on when it is half built, under this model', async () => {
    const missing = asModel(REAL)
    const id = await transcribedMeeting(segmentsOf(text), 'ready')
    expect((await driveToDone(id, depsWith(missing))).at(-1)).toMatchObject({ next: 'done', index: { state: 'complete' } })
    expect(missing.count('embed')).toBeGreaterThan(0)

    const half = await halfBuiltBy(REAL)
    expect((await driveToDone(half, depsWith(asModel(REAL)))).at(-1)).toMatchObject({ next: 'done', index: { state: 'complete' } })
  })

  it('needs an explicit request to replace, and then an index of the new model is finished', async () => {
    const id = await indexedBy(REAL)
    const deps = depsWith(asModel('model-2'))
    for (let i = 0; i < STEP_BOUND; i++) {
      const outcome = await advanceIndexing(id, deps)
      if (outcome.kind === 'done') break
      if (outcome.kind === 'progress' && outcome.next === 'wait') tick(2_000)
    }
    expect(await advance(id, deps)).toMatchObject({ next: 'done', index: { state: 'complete' } })
  })

  describe('in the step itself, whoever got there first', () => {
    it('refuses before any claim', async () => {
      const id = await indexedBy(REAL)
      const before = await stored(id)
      const providers = asModel(LOST_SETTINGS)
      expect(await advanceIndexing(id, depsWith(providers), { unattended: true })).toMatchObject({ kind: 'refused', statusCode: 409 })
      expect(await stored(id)).toEqual(before)
    })

    it('reads again under its claim, and gives the claim back if the index has become another model\'s', async () => {
      const id = await transcribedMeeting(segmentsOf(text), 'ready')
      const providers = asModel(LOST_SETTINGS)
      const deps = depsWith(providers)
      const clean = await deps.index.readState(id, LOST_SETTINGS)
      const foreign = { ...clean, marker: { textHash: clean.transcriptHash, model: REAL, windowCount: 3, complete: true }, storedWindows: 3 }
      const readState = vi.fn().mockResolvedValueOnce(clean).mockResolvedValue(foreign)

      const outcome = await advanceIndexing(id, { ...deps, index: { ...deps.index, readState } }, { unattended: true })
      expect(outcome).toMatchObject({ kind: 'refused' })
      expect(providers.calls).toEqual([])
      expect(await runOf(id, 'search_index')).toMatchObject({ stepLeaseUntil: null, attempts: 0 })
      expect(await db().getItem(`windows/${id}`)).toBeNull()
    })

    /** A run part way through a pass of the real model, with no marker and no windows: a marker removed by hand. */
    async function passOfAnotherModelAndNothingElse(): Promise<string> {
      const id = await transcribedMeeting(segmentsOf(text), 'ready')
      const { transcriptHash } = await stateOf(id, LOST_SETTINGS)
      await db().setItem(`pipeline/${id}`, {
        runs: {
          search_index: {
            runId: randomUUID(), stepToken: null, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: null,
            cursor: { pass: { textHash: transcriptHash, model: REAL, nextWindow: 16, nextSegment: 160, pageSegments: 256, planned: false } },
          },
        },
        chunks: [],
      })
      return id
    }

    it('does not start over from a pass of another model, with or without a marker saying so', async () => {
      const id = await passOfAnotherModelAndNothingElse()
      const providers = asModel(LOST_SETTINGS)
      expect(await advanceIndexing(id, depsWith(providers), { unattended: true })).toMatchObject({ kind: 'refused' })
      expect(providers.calls).toEqual([])
    })

    // The step refuses this, so an assessment saying `continue` would be saying it for ever.
    it('is held by that pass, not told to continue to a step that will only refuse', async () => {
      await expectHandsOff(await passOfAnotherModelAndNothingElse(), LOST_SETTINGS)
    })
  })
})

describe('two at once', () => {
  it('spends one provider call on a chunk both asked for, and neither is told it failed', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)
    const answers = await Promise.all([advance(id, deps), advance(id, deps)])
    expect(providers.count('chunk')).toBe(1)
    for (const answer of answers) expect(['continue', 'wait']).toContain(answer.next)
  })

  it('answers a truthful wait when the only step left is in flight', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)
    // The index first, so that a chunk in flight is all there is.
    providers.queue('chunk', busy(NOON + 1))
    await advance(id, deps)
    await advanceUntil(id, deps, a => a.index.state === 'complete')
    vi.setSystemTime(NOON + 2)

    let inFlight!: () => void
    const entered = new Promise<void>(resolve => (inFlight = resolve))
    let finish!: () => void
    const held = new Promise<void>(resolve => (finish = resolve))
    providers.during.chunk.push(async () => {
      inFlight()
      await held
    })
    const first = advance(id, deps)
    await entered

    const before = await stored(id)
    const second = await advance(id, deps)
    expect(second).toMatchObject({ status: 'indexing', next: 'wait', retryAfterMs: 2_000 })
    expect(await stored(id)).toEqual(before)
    expect(providers.count('chunk')).toBe(2)

    finish()
    expect((await first).progress.done).toBe(1)
  })

  it('runs an index batch alongside a chunk in flight, since each stage has its own claim', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await advanceUntil(id, deps, inExtraction)

    let inFlight!: () => void
    const entered = new Promise<void>(resolve => (inFlight = resolve))
    let finish!: () => void
    const held = new Promise<void>(resolve => (finish = resolve))
    providers.during.chunk.push(async () => {
      inFlight()
      await held
    })
    const first = advance(id, deps)
    await entered

    expect(await advance(id, deps)).toMatchObject({ next: 'continue' })
    expect(providers.count('embed')).toBe(1)
    finish()
    await first
  })

  it('takes a whole meeting through two drivers, spending what one would', async () => {
    const providers = scriptedProviders(lines(6))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const plan = await planWindows(segmentsOf(lines(6)))
    const driver = async () => {
      for (let i = 0; i < STEP_BOUND; i++) {
        const answer = await advance(id, deps)
        if (answer.next === 'done' || answer.next === 'failed') return answer
        if (answer.next === 'wait') {
          tick(Math.min(answer.retryAfterMs ?? 0, 2_000) + 1)
          await new Promise(resolve => setImmediate(resolve))
        }
      }
      throw new Error('a driver did not stop')
    }
    const [one, other] = await Promise.all([driver(), driver()])
    expect(one).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
    expect(other).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
    expect(providers.count('whisper')).toBe(1)
    expect(providers.sent.chunks).toEqual([0, 1, 2, 3, 4, 5])
    expect(providers.sent.windows).toEqual(plan.map(w => w.text))
  })
})

describe('deletion during a step', () => {
  /** A meeting old enough for its upload URL not to be what blocks a delete. */
  const pastUploadWindow = () => tick(3_600_000)

  const deletionDeps = (deps: PipelineDeps) => ({
    meetings: deps.meetings,
    pipeline: deps.pipeline,
    removeData: async (id: string) => {
      await deps.pipeline.deleteForMeeting(id)
      await deps.index.deleteForMeeting(id)
      await deps.transcripts.deleteForMeeting(id)
      await deps.summaries.deleteForMeeting(id)
    },
  })

  it('is refused while the step is live, as with any stage', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
    pastUploadWindow()
    const deps = depsWith(providers)
    let blocked: unknown
    providers.during.embed.push(async () => {
      blocked = await deleteMeeting(id, deletionDeps(deps))
    })
    await advance(id, deps)
    expect(blocked).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/pipeline step is running/) })
    expect(await meetingOf(id)).toBeTruthy()
  })

  it('goes straight through for a run parked until the limit resets, and then the answer is that it is gone', async () => {
    const providers = scriptedProviders(lines(1))
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    pastUploadWindow()
    const deps = depsWith(providers)
    providers.queue('embed', dailyLimitReached())
    expect(await advance(id, deps)).toMatchObject({ next: 'done', index: { state: 'parked' } })
    expect(await deleteMeeting(id, deletionDeps(deps))).toEqual({ kind: 'deleted' })
    expect(await advancePipeline(id, deps)).toEqual({ kind: 'missing' })
  })

  it('leaves nothing behind when the row goes while a step is out at the provider', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
    const deps = depsWith(providers)
    const removal = deletionDeps(deps)
    providers.during.embed.push(async () => {
      await db().removeItem(`meetings/${id}`)
      await removal.removeData(id)
    })
    expect(await advancePipeline(id, deps)).toEqual({ kind: 'missing' })
    expect(await db().getItem(`windows/${id}`)).toBeNull()
    expect(await db().getItem(`meetings/${id}`)).toBeNull()
  })
})
