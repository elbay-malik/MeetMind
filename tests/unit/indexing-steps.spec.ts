import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '../../shared/types/meeting'
import { createLocalSlotRepository } from '../../server/utils/db/slots-local'
import { readyWindowCount } from '../../server/utils/db/windows'
import {
  DAILY_LIMIT_MESSAGE,
  dailyLimitReached,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  EmbeddingInputTooLongError,
  MAX_BATCH_TOKENS,
  type Embedder,
} from '../../server/utils/qa/embedder'
import {
  advanceIndexing,
  INDEX_BATCH,
  INDEX_PAGE_SEGMENTS,
  INDEX_STEP_LEASE_MS,
  MAX_INDEX_ATTEMPTS,
  MAX_INDEX_PAGE_SEGMENTS,
  MAX_INDEX_RESTARTS,
  type IndexingDeps,
} from '../../server/utils/qa/steps'
import { hashedTokenVector } from '../../server/utils/qa/stub'
import { planWindows, WINDOW_TOKEN_BUDGET } from '../../server/utils/qa/windows'
import { createWorkersAiEmbedder } from '../../server/utils/qa/workers-ai'
import { RETRY_COOLDOWN_MS, RETRYABLE_PARK_MS } from '../../server/utils/summary/steps'
import { estimateTokens } from '../../server/utils/summary/plan'
import { indexingHarness } from './helpers/indexing'

/**
 * Step-wise indexing (ADR-0012, step 8) against the local drivers: a page of the
 * transcript at a time, one batch per step, and a last step that marks the index
 * complete only if it all adds up.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-isteps-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})
afterEach(() => vi.unstubAllGlobals())

const harness = indexingHarness(() => dataDir)
const { repos, db, now, advanceClock, resetClock, meetingWith, depsWith, drive } = harness
beforeEach(() => resetClock())

const transcript = (count: number, tag = 't'): TranscriptSegment[] =>
  Array.from({ length: count }, (_, i) => ({
    idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `${tag} segment ${i} discusses topic ${i}`,
  }))

/** Lines near the window budget, so each is a window and the token cap binds well before the count. */
const wordyTranscript = (count: number): TranscriptSegment[] =>
  Array.from({ length: count }, (_, i) => ({
    idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800,
    text: Array.from({ length: 500 }, (_, k) => `word${i}x${k}`).join(' '),
  }))

/** An embedder that records every request, and throws whatever a test queues. */
function scripted(model = 'model-a') {
  const calls: string[][] = []
  const queued: Array<unknown | (() => Promise<void>)> = []
  const embedder: Embedder = {
    kind: 'stub',
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts) {
      calls.push(texts)
      const next = queued.shift()
      if (typeof next === 'function') await (next as () => Promise<void>)()
      else if (next) throw next
      return texts.map(t => hashedTokenVector(t))
    },
    async embedQuery(text) {
      return hashedTokenVector(text)
    },
  }
  return { embedder, calls, texts: () => calls.flat(), queue: (...items: unknown[]) => queued.push(...items) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const newId = () => randomUUID()
const runOf = async (id: string) => (await repos().pipeline.listRuns(id)).find(r => r.stage === 'search_index')
const stateOf = (id: string, model = 'model-a') => repos().index.readState(id, model)
const keysOf = (id: string) => repos().index.listKeys(id)
const clearBlock = () => db().removeItem('slots/workers-ai-embed')

/** Lose a step's lease as a kill would: it ran out with nobody releasing it. */
async function expireLease(id: string): Promise<void> {
  const ledger = await db().getItem<{ runs: { search_index: { stepLeaseUntil: number } } }>(`pipeline/${id}`)
  ledger!.runs.search_index.stepLeaseUntil = Date.now() - 1_000
  await db().setItem(`pipeline/${id}`, ledger)
}

/** Everything on the transcript side of a step, recorded, over the real local repositories. */
function spying(deps: IndexingDeps) {
  const pages: Array<{ from: number, limit: number, returned: number }> = []
  const keyReads: Array<{ from: number, to: number } | undefined> = []
  return {
    pages,
    keyReads,
    deps: {
      ...deps,
      transcripts: {
        async listFrom(id: string, from: number, limit: number) {
          const page = await deps.transcripts.listFrom(id, from, limit)
          pages.push({ from, limit, returned: page.segments.length })
          return page
        },
      },
      index: {
        readState: deps.index.readState,
        async listKeys(id: string, range?: { from: number, to: number }) {
          keyReads.push(range)
          return deps.index.listKeys(id, range)
        },
      },
    } satisfies IndexingDeps,
  }
}

describe('one step', () => {
  it('makes at most one provider request, of at most INDEX_BATCH windows, reading one page and its keys', async () => {
    const id = newId()
    const segments = transcript(1_200)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    expect(plan.length).toBeGreaterThan(INDEX_BATCH * 4)
    const { embedder, calls } = scripted()
    const spy = spying(depsWith(embedder))

    let requests = 0
    for (;;) {
      const before = calls.length
      const pagesBefore = spy.pages.length
      const keysBefore = spy.keyReads.length
      const outcome = await advanceIndexing(id, spy.deps)
      requests++
      expect(calls.length - before).toBeLessThanOrEqual(1)
      expect(calls.at(-1)!.length).toBeLessThanOrEqual(INDEX_BATCH)
      expect(spy.pages.length - pagesBefore).toBeLessThanOrEqual(1)
      expect(spy.keyReads.length - keysBefore).toBeLessThanOrEqual(1)
      if (outcome.kind === 'done') break
      expect(outcome.kind).toBe('progress')
    }

    // A read never grows with the meeting: the deps it is given have no whole read at
    // all, and each page and key range stays the size of a step.
    expect(spy.pages.every(p => p.limit === INDEX_PAGE_SEGMENTS && p.returned <= INDEX_PAGE_SEGMENTS)).toBe(true)
    for (const range of spy.keyReads) {
      expect(range, 'a key read with no range reads every window').toBeDefined()
      expect(range!.to - range!.from).toBeLessThan(INDEX_BATCH)
    }
    // The batches, and one last step to finish.
    expect(requests).toBe(Math.ceil(plan.length / INDEX_BATCH) + 1)
  })

  it('stays inside the token cap when windows are at the full budget, which 16 of would not be', async () => {
    const id = newId()
    const segments = wordyTranscript(60)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    expect(plan.every(w => estimateTokens(w.text) <= WINDOW_TOKEN_BUDGET)).toBe(true)
    // The premise: a batch of 16 of these would be over the cap.
    expect(plan.slice(0, INDEX_BATCH).reduce((sum, w) => sum + estimateTokens(w.text), 0)).toBeGreaterThan(MAX_BATCH_TOKENS)

    const { embedder, calls, texts } = scripted()
    const outcomes = await drive(id, depsWith(embedder))
    expect(outcomes.at(-1)!.kind).toBe('done')
    for (const call of calls) {
      expect(call.length).toBeLessThan(INDEX_BATCH)
      expect(call.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)
    }
    expect(texts()).toEqual(plan.map(w => w.text))
  })

  it('sends a window over the cap on its own, as one request, rather than never', async () => {
    const id = newId()
    // Each line is one window, far over the window budget: lines are never split.
    const big = Array.from({ length: 3 }, (_, i) => ({
      idx: i, startMs: i * 60_000, endMs: i * 60_000 + 50_000,
      text: Array.from({ length: 9_000 }, (_, k) => `word${i}x${k}`).join(' '),
    }))
    await meetingWith(id, big)
    const { embedder, calls } = scripted()
    await drive(id, depsWith(embedder))
    expect(calls.map(c => c.length)).toEqual([1, 1, 1])
    expect(estimateTokens(calls[0]![0]!)).toBeGreaterThan(MAX_BATCH_TOKENS)
  })

  it('is one HTTP request through the real driver, and a failure is not retried inside the step', async () => {
    const id = newId()
    await meetingWith(id, wordyTranscript(40))
    const fetched = vi.fn(async (_url: string, init: RequestInit) => {
      const { text } = JSON.parse(init.body as string) as { text: string[] }
      return Response.json({
        success: true,
        result: { data: text.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.1)), shape: [text.length, EMBEDDING_DIMENSIONS] },
      })
    })
    vi.stubGlobal('fetch', fetched)
    const embedder = createWorkersAiEmbedder({ accountId: 'a', apiToken: 't', maxAttempts: 1 })
    const deps = depsWith(embedder)

    const first = await advanceIndexing(id, deps)
    expect(first).toMatchObject({ kind: 'progress', next: 'continue' })
    expect(fetched).toHaveBeenCalledTimes(1)

    fetched.mockImplementationOnce(async () => new Response('down', { status: 500 }))
    const second = await advanceIndexing(id, deps)
    expect(fetched).toHaveBeenCalledTimes(2)
    expect(second).toMatchObject({ kind: 'progress', next: 'wait' })
  })

  it('answers with how far it has got, and the total once the plan has ended', async () => {
    const id = newId()
    const segments = transcript(300)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    const { embedder } = scripted()
    const outcomes = await drive(id, depsWith(embedder))

    const progress = outcomes.filter(o => o.kind === 'progress').map(o => o.kind === 'progress' ? o.progress : null)
    expect(progress[0]).toEqual({ done: INDEX_BATCH, total: null, lastError: null })
    expect(progress.map(p => p!.done)).toEqual([...progress.map(p => p!.done)].sort((a, b) => a - b))
    expect(progress.at(-1)).toEqual({ done: plan.length, total: plan.length, lastError: null })
    expect(outcomes.at(-1)).toEqual({
      kind: 'done',
      index: { state: 'ready', windowCount: plan.length, indexedCount: plan.length, model: 'model-a' },
    })
  })

  it('stores exactly the whole plan, hash for hash, read a page at a time', async () => {
    const id = newId()
    const segments = transcript(777)
    await meetingWith(id, segments)
    await drive(id, depsWith(scripted().embedder))
    const plan = await planWindows(segments)
    expect(await keysOf(id)).toEqual(plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'model-a' })))
    expect(await stateOf(id)).toMatchObject({ marker: { complete: true, windowCount: plan.length, model: 'model-a' } })
  })

  it('reads a larger page when a window does not fit in one, and goes back to the usual size after', async () => {
    const id = newId()
    // One character costs 5 tokens, so 300 of these fit a window, over one page's worth.
    const lines: TranscriptSegment[] = Array.from({ length: 700 }, (_, i) => ({ idx: i, startMs: 0, endMs: 0, text: '字' }))
    await meetingWith(id, lines)
    const plan = await planWindows(lines)
    expect(plan[0]!.lastSegmentIdx).toBeGreaterThan(INDEX_PAGE_SEGMENTS)

    const { embedder, texts } = scripted()
    const spy = spying(depsWith(embedder))
    const outcomes = await drive(id, spy.deps)
    expect(outcomes.at(-1)!.kind).toBe('done')
    expect(texts()).toEqual(plan.map(w => w.text))
    // Each window that needed more got more, and the page after it started small again.
    expect(spy.pages.map(p => p.limit)).toEqual([INDEX_PAGE_SEGMENTS, INDEX_PAGE_SEGMENTS * 2, INDEX_PAGE_SEGMENTS, INDEX_PAGE_SEGMENTS * 2])
  })

  it('gives up plainly on a window no page can hold, rather than read without limit', async () => {
    const id = newId()
    // Costing nothing and taking no time, so nothing ever closes the window.
    await meetingWith(id, Array.from({ length: MAX_INDEX_PAGE_SEGMENTS + 5 }, (_, i) => ({ idx: i, startMs: 0, endMs: 0, text: ' ' })))
    const { embedder, calls } = scripted()
    const spy = spying(depsWith(embedder))
    const outcome = (await drive(id, spy.deps)).at(-1)!
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 422, resumes: false })
    expect(calls).toHaveLength(0)
    expect(Math.max(...spy.pages.map(p => p.limit))).toBe(MAX_INDEX_PAGE_SEGMENTS)
    expect((await repos().meetings.get(id))!.status).toBe('ready')
  })

  it.each([
    ['summarizing', {}],
    ['indexing', {}],
    ['ready', {}],
    ['failed', { failedStage: 'summarization' as const, errorMessage: 'extraction failed' }],
  ] as const)('runs from %s to complete, leaving the meeting exactly where it was', async (status, patch) => {
    const id = newId()
    const created = await meetingWith(id, transcript(100), status, patch)
    const outcome = (await drive(id, depsWith(scripted().embedder))).at(-1)!
    expect(outcome.kind).toBe('done')
    const after = await repos().meetings.get(id)
    expect(after).toMatchObject({ status, failedStage: created.failedStage, errorMessage: created.errorMessage })
  })

  it.each([
    ['uploaded', {}],
    ['transcribing', {}],
    ['failed', { failedStage: 'transcription' as const, errorMessage: 'Whisper failed' }],
  ] as const)('refuses a meeting that is %s, with no claim and no spending', async (status, patch) => {
    const id = newId()
    const created = await meetingWith(id, transcript(5), status, patch)
    const { embedder, calls } = scripted()
    expect(await advanceIndexing(id, depsWith(embedder))).toMatchObject({
      kind: 'refused', statusCode: 409, message: expect.stringMatching(/no finished transcript/),
    })
    expect(calls).toHaveLength(0)
    expect(await runOf(id)).toBeUndefined()
    expect((await repos().meetings.get(id))!.updatedAt).toBe(created.updatedAt)
  })

  it('refuses a meeting that is not there', async () => {
    expect(await advanceIndexing(newId(), depsWith(scripted().embedder))).toMatchObject({ kind: 'refused', statusCode: 404 })
  })

  it('answers a finished index without a claim, spending nothing and moving nothing', async () => {
    const id = newId()
    await meetingWith(id, transcript(30))
    await drive(id, depsWith(scripted().embedder))
    const updatedAt = (await repos().meetings.get(id))!.updatedAt
    const again = scripted()
    expect(await advanceIndexing(id, depsWith(again.embedder))).toMatchObject({ kind: 'done', index: { state: 'ready' } })
    expect(again.calls).toHaveLength(0)
    // A claim would move this, and restart a failed extraction's cooldown.
    expect((await repos().meetings.get(id))!.updatedAt).toBe(updatedAt)
  })
})

describe('a step\'s subrequests', () => {
  /**
   * Every repository method and every provider call here is one request on Workers,
   * against the free plan's 50. Paging aside, which these reads do not need: a page is
   * one request whatever its size, and the keys of one batch are under a page.
   */
  function counting(deps: IndexingDeps) {
    let count = 0
    const counted = <T extends object>(target: T): T => new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          count++
          return (value as (...a: unknown[]) => unknown).apply(object, args)
        }
      },
    })
    return {
      take: () => {
        const taken = count
        count = 0
        return taken
      },
      deps: {
        ...deps,
        meetings: counted(deps.meetings),
        pipeline: counted(deps.pipeline),
        transcripts: counted(deps.transcripts),
        index: counted(deps.index),
        slots: counted(deps.slots),
        embedder: counted(deps.embedder),
      } satisfies IndexingDeps,
    }
  }

  async function perStep(lines: number) {
    const id = newId()
    await meetingWith(id, transcript(lines))
    const counter = counting(depsWith(scripted().embedder))
    const steps: Array<{ kind: string, subrequests: number }> = []
    for (;;) {
      const outcome = await advanceIndexing(id, counter.deps)
      steps.push({ kind: outcome.kind, subrequests: counter.take() })
      if (outcome.kind !== 'progress') return steps
    }
  }

  it('stays the same however long the meeting, and well inside the 50 a Worker has', async () => {
    const short = await perStep(200)
    const long = await perStep(6_000)
    expect(long.length).toBeGreaterThan(short.length * 10)
    const batches = (steps: typeof short) => steps.filter(s => s.kind === 'progress').map(s => s.subrequests)
    // The meeting, its state, the run, the claim, the page, the keys, the slot, the
    // provider and the write. ADR-0012's table says about 6; it did not count the
    // reads either side of a step, as step 7's addendum also found. A pass's first step
    // reads the state once more, under its claim.
    expect(batches(long)[0]).toBe(10)
    expect(batches(short)[0]).toBe(10)
    expect(new Set(batches(long).slice(1))).toEqual(new Set([9]))
    expect(new Set(batches(short).slice(1))).toEqual(new Set([9]))
    // The last step: the meeting, its state, the run, the claim, and the finish.
    expect(long.at(-1)).toEqual({ kind: 'done', subrequests: 5 })
    expect(short.at(-1)).toEqual({ kind: 'done', subrequests: 5 })
  })

  it('costs two reads to answer for a finished index', async () => {
    const id = newId()
    await meetingWith(id, transcript(100))
    const counter = counting(depsWith(scripted().embedder))
    await drive(id, counter.deps)
    counter.take()
    await advanceIndexing(id, counter.deps)
    expect(counter.take()).toBe(2)
  })
})

describe('the durable claim', () => {
  it('has two concurrent drivers embed each window at most once', async () => {
    const id = newId()
    const segments = transcript(600)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    const { embedder, texts } = scripted()
    const deps = depsWith(embedder)

    const [a, b] = await Promise.all([drive(id, deps), drive(id, deps)])
    expect(a.at(-1)).toMatchObject({ kind: 'done', index: { windowCount: plan.length } })
    expect(b.at(-1)).toEqual(a.at(-1))

    const embedded = texts()
    expect(new Set(embedded).size).toBe(embedded.length)
    expect([...embedded].sort()).toEqual(plan.map(w => w.text).sort())
  })

  it.each([
    ['after its state read', 'readState'],
    ['after its run read', 'listRuns'],
    ['just before its claim', 'claimStep'],
  ] as const)('does not reopen an index another driver finishes %s', async (_name, method) => {
    const id = newId()
    const segments = transcript(40)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    const { embedder, calls } = scripted()
    const deps = depsWith(embedder)
    // Up to the last step, which is what the other driver is about to do.
    for (;;) {
      const run = await runOf(id)
      if ((run?.cursor as { pass?: { planned?: boolean } } | undefined)?.pass?.planned) break
      await advanceIndexing(id, deps)
    }
    const spent = calls.length

    let finished = false
    const finishFirst = async () => {
      if (finished) return
      finished = true
      expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'done', index: { windowCount: plan.length } })
    }
    const stale: IndexingDeps = {
      ...deps,
      index: {
        ...deps.index,
        async readState(...args) {
          const state = await deps.index.readState(...args)
          if (method === 'readState') await finishFirst()
          return state
        },
      },
      pipeline: {
        ...deps.pipeline,
        async listRuns(...args) {
          const runs = await deps.pipeline.listRuns(...args)
          if (method === 'listRuns') await finishFirst()
          return runs
        },
        async claimStep(...args) {
          if (method === 'claimStep') await finishFirst()
          return deps.pipeline.claimStep(...args)
        },
      },
    }

    expect(await advanceIndexing(id, stale)).toMatchObject({ kind: 'done', index: { windowCount: plan.length } })
    expect(finished).toBe(true)
    expect((await stateOf(id)).marker).toMatchObject({ windowCount: plan.length, complete: true })
    expect(readyWindowCount(await stateOf(id), 'model-a')).toBe(plan.length)
    // It let go of the step it claimed, and nothing was spent on any of this.
    expect(await runOf(id)).toMatchObject({ stepLeaseUntil: null, retryAt: null, attempts: 0, lastError: null })
    expect(calls).toHaveLength(spent)
  })

  it('tells a second caller to wait while a step is live, and spends nothing for it', async () => {
    const id = newId()
    await meetingWith(id, transcript(100))
    const gate = deferred()
    const first = scripted()
    first.queue(() => gate.promise)
    const inFlight = advanceIndexing(id, depsWith(first.embedder))
    await vi.waitFor(() => expect(first.calls).toHaveLength(1))

    const second = scripted()
    const answer = await advanceIndexing(id, depsWith(second.embedder))
    expect(answer).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(second.calls).toHaveLength(0)

    gate.resolve()
    expect(await inFlight).toMatchObject({ kind: 'progress', next: 'continue' })
  })

  it('writes nothing from a step that lost its lease, even though it paid for the embedding', async () => {
    const id = newId()
    const segments = transcript(100)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)

    const gate = deferred()
    const straggler = scripted()
    straggler.queue(() => gate.promise)
    const stragglerStep = advanceIndexing(id, depsWith(straggler.embedder))
    await vi.waitFor(() => expect(straggler.calls).toHaveLength(1))

    // Its lease runs out, and another caller takes the step over and finishes the batch.
    await expireLease(id)
    const taker = scripted()
    expect(await advanceIndexing(id, depsWith(taker.embedder))).toMatchObject({ kind: 'progress', next: 'continue' })
    const after = await db().getItem(`windows/${id}`)
    const cursorAfter = (await runOf(id))!.cursor

    gate.resolve()
    // Told how things stand, not that its write happened.
    expect(await stragglerStep).toMatchObject({ kind: 'progress', progress: { done: plan.slice(0, INDEX_BATCH).length } })
    expect(await db().getItem(`windows/${id}`)).toEqual(after)
    expect((await runOf(id))!.cursor).toEqual(cursorAfter)
  })

  it('resumes a step that was killed, re-embedding only that batch', async () => {
    const id = newId()
    const segments = transcript(300)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)

    const first = scripted()
    const deps = depsWith(first.embedder)
    await advanceIndexing(id, deps)
    expect(first.calls).toHaveLength(1)

    // Killed mid-request: claimed, and nothing after that.
    const killed = await repos().pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: INDEX_STEP_LEASE_MS })
    expect(killed!.attempts).toBe(1)
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(first.calls).toHaveLength(1)
    await expireLease(id)

    const outcomes = await drive(id, deps)
    expect(outcomes.at(-1)!.kind).toBe('done')
    expect(first.texts()).toEqual(plan.map(w => w.text))
  })

  it('parks a batch that keeps dying rather than spend on it for ever, then tries again', async () => {
    const id = newId()
    await meetingWith(id, transcript(100))
    const { embedder, calls } = scripted()
    const deps = depsWith(embedder)
    for (let i = 0; i < MAX_INDEX_ATTEMPTS; i++) {
      expect(await repos().pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: INDEX_STEP_LEASE_MS })).not.toBeNull()
      await expireLease(id)
    }

    const outcome = await advanceIndexing(id, deps)
    expect(outcome).toMatchObject({ kind: 'failed', statusCode: 502, resumes: true })
    expect(calls).toHaveLength(0)
    const run = (await runOf(id))!
    expect(run.stepLeaseUntil).toBeNull()
    expect(run.retryAt!.getTime() - now()).toBeGreaterThan(RETRY_COOLDOWN_MS - 5_000)
    expect((await repos().meetings.get(id))!.status).toBe('ready')

    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(calls).toHaveLength(0)

    advanceClock(RETRY_COOLDOWN_MS + 1)
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress', next: 'continue' })
    expect(calls).toHaveLength(1)
  })
})

describe('the marker', () => {
  it('goes incomplete at the first batch and complete only at the last step', async () => {
    const id = newId()
    await meetingWith(id, transcript(100))
    expect((await stateOf(id)).marker).toBeNull()
    const deps = depsWith(scripted().embedder)

    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress' })
    expect((await stateOf(id)).marker).toMatchObject({ complete: false, model: 'model-a', windowCount: 0 })

    // Every window stored, and still not complete until the last step says so.
    const plan = await planWindows(transcript(100))
    expect((await keysOf(id)).length).toBe(plan.length)
    expect((await stateOf(id)).marker!.complete).toBe(false)

    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'done' })
    const state = await stateOf(id)
    expect(state.marker).toEqual({ complete: true, model: 'model-a', windowCount: plan.length, textHash: state.transcriptHash })
  })

  it('treats a meeting indexed by older code as incomplete, and finishes it without spending', async () => {
    const id = newId()
    const segments = transcript(300)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    // As the old route left it: every window stored, and no marker, since it had none.
    await repos().index.upsertWindows(id, plan.map(w => ({ ...w, model: 'model-a', embedding: hashedTokenVector(w.text) })))
    expect((await stateOf(id)).marker).toBeNull()

    const { embedder, calls } = scripted()
    const outcomes = await drive(id, depsWith(embedder))
    expect(calls).toHaveLength(0)
    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', index: { windowCount: plan.length } })
    expect((await stateOf(id)).marker!.complete).toBe(true)
  })

  it('replaces another model\'s index a batch at a time, removing nothing a step has not replaced', async () => {
    const id = newId()
    const segments = transcript(300)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    await drive(id, depsWith(scripted('model-old').embedder))
    expect(await stateOf(id, 'model-old')).toMatchObject({ marker: { complete: true, model: 'model-old' }, storedForModel: plan.length })

    // One step under another model: the hazard ADR-0012's step 8 must not widen.
    const newer = scripted('model-new')
    const deps = depsWith(newer.embedder)
    await advanceIndexing(id, deps)
    expect(newer.calls).toHaveLength(1)
    expect(newer.calls[0]).toHaveLength(INDEX_BATCH)
    const keys = await keysOf(id)
    expect(keys).toHaveLength(plan.length)
    expect(keys.filter(k => k.model === 'model-new').map(k => k.idx)).toEqual(plan.slice(0, INDEX_BATCH).map(w => w.idx))
    expect(keys.filter(k => k.model === 'model-old')).toHaveLength(plan.length - INDEX_BATCH)
    // Neither model has a whole index now, and the marker says so for both.
    expect((await stateOf(id, 'model-old')).marker).toMatchObject({ complete: false, model: 'model-new' })

    const outcomes = await drive(id, deps)
    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', index: { windowCount: plan.length, model: 'model-new' } })
    expect(newer.texts()).toEqual(plan.map(w => w.text))
    expect(new Set((await keysOf(id)).map(k => k.model))).toEqual(new Set(['model-new']))
  })

  it('starts the plan over when the model changes under a run, and when the transcript does', async () => {
    const id = newId()
    const segments = transcript(300)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    await advanceIndexing(id, depsWith(scripted('model-a').embedder))

    const other = scripted('model-b')
    await drive(id, depsWith(other.embedder))
    expect(other.texts()).toEqual(plan.map(w => w.text))

    const edited = segments.map(s => s.idx === 5 ? { ...s, text: 'said differently' } : s)
    await repos().transcripts.replaceForMeeting(id, edited)
    const again = scripted('model-b')
    const outcomes = await drive(id, depsWith(again.embedder))
    expect(outcomes.at(-1)!.kind).toBe('done')
    const after = await planWindows(edited)
    expect(again.texts()).toEqual(after.filter((w, i) => w.contentHash !== plan[i]!.contentHash).map(w => w.text))
  })

  it('goes round again when the last step finds the windows do not add up, and stops going round', async () => {
    const id = newId()
    const segments = transcript(30)
    await meetingWith(id, segments)
    const { embedder, calls } = scripted()
    const deps = depsWith(embedder)
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress' })
    // A window lost since this run stored it.
    await db().setItem(`windows/${id}`, [])
    const outcomes = await drive(id, deps)
    expect(outcomes.at(-1)!.kind).toBe('done')
    expect(calls).toHaveLength(2)

    // A driver whose last step always refuses cannot circle for ever.
    const stubborn = newId()
    await meetingWith(stubborn, segments)
    const refusing = { ...repos().pipeline, finishIndex: async () => 'changed' as const }
    const stuck = await drive(stubborn, depsWith(scripted().embedder, { pipeline: refusing }))
    expect(stuck.at(-1)).toMatchObject({ kind: 'failed', statusCode: 500, resumes: true })
    expect(stuck.filter(o => o.kind === 'progress').length).toBeLessThanOrEqual(2 * (MAX_INDEX_RESTARTS + 1))
    expect((await runOf(stubborn))!.retryAt!.getTime()).toBeGreaterThan(now())
  })
})

describe('quota', () => {
  const nextMidnight = () => {
    const at = new Date()
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)
  }

  it('parks until 00:00 UTC at the daily limit, spends nothing until then, and resumes without re-spending', async () => {
    await clearBlock()
    const id = newId()
    const segments = transcript(600)
    const created = await meetingWith(id, segments, 'indexing')
    const plan = await planWindows(segments)
    const { embedder, calls, texts, queue } = scripted()
    const deps = depsWith(embedder)

    await advanceIndexing(id, deps)
    queue(dailyLimitReached())
    const refused = await advanceIndexing(id, deps)
    expect(refused).toMatchObject({ kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE, resumes: true })
    expect(refused.kind === 'failed' && refused.retryAt!.getTime()).toBe(nextMidnight())
    expect(calls).toHaveLength(2)

    // Kept, and the run parked with no lease: a parked run holds nothing.
    expect((await keysOf(id)).map(k => k.idx)).toEqual(plan.slice(0, INDEX_BATCH).map(w => w.idx))
    const run = (await runOf(id))!
    expect(run.retryAt!.getTime()).toBe(nextMidnight())
    expect(run.stepLeaseUntil).toBeNull()
    expect(run.lastError).toBe(DAILY_LIMIT_MESSAGE)
    // The attempt was refunded: nothing was spent on a refusal.
    expect(run.attempts).toBe(0)
    // Indexing never touches the meeting's status (ADR-0012 §5).
    const parked = await repos().meetings.get(id)
    expect(parked).toMatchObject({ status: created.status, failedStage: null, errorMessage: null })

    // Every other meeting holds off too: the allowance is the account's.
    expect((await repos().slots.blockedUntil('workers-ai-embed'))!.getTime()).toBeGreaterThan(nextMidnight() - 5_000)

    // Asked again before then: the same plain answer, with no claim and no request.
    const again = await advanceIndexing(id, deps)
    expect(again).toMatchObject({ kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE })
    expect(calls).toHaveLength(2)
    expect((await repos().meetings.get(id))!.updatedAt).toBe(parked!.updatedAt)

    // The day after.
    advanceClock(nextMidnight() - now() + 1)
    await clearBlock()
    const outcomes = await drive(id, deps)
    expect(outcomes.at(-1)).toMatchObject({ kind: 'done', index: { windowCount: plan.length } })
    // Every window once, but for the one batch the provider refused.
    const sent = texts()
    expect(calls[1]).toEqual(calls[2])
    expect(sent.slice(0, INDEX_BATCH)).toEqual(plan.slice(0, INDEX_BATCH).map(w => w.text))
    expect(sent.slice(INDEX_BATCH * 2)).toEqual(plan.slice(INDEX_BATCH).map(w => w.text))
  })

  it('tells a caller that lost the claim to the step hitting the limit the same as anyone, not to sit and wait', async () => {
    await clearBlock()
    const id = newId()
    await meetingWith(id, transcript(100))
    const gate = deferred()
    const first = scripted()
    first.queue(async () => {
      await gate.promise
      throw dailyLimitReached()
    })
    const deps = depsWith(first.embedder)

    // The run is free when this caller reads it. By its claim the other holds the
    // lease, and by the time it looks again the other has been refused and parked it.
    let other: Promise<unknown> | undefined
    const second = scripted()
    const lost = await advanceIndexing(id, depsWith(second.embedder, {
      pipeline: {
        ...deps.pipeline,
        async claimStep(...args) {
          other = advanceIndexing(id, deps)
          await vi.waitFor(() => expect(first.calls).toHaveLength(1))
          const claim = await deps.pipeline.claimStep(...args)
          expect(claim).toBeNull()
          gate.resolve()
          await other
          return claim
        },
      },
    }))

    await expect(other).resolves.toMatchObject({ kind: 'failed', statusCode: 429 })
    expect(lost).toMatchObject({ kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE, resumes: true })
    expect(lost.kind === 'failed' && lost.retryAt).toEqual((await runOf(id))!.retryAt)
    expect(second.calls).toHaveLength(0)
    await clearBlock()
  })

  it('parks a meeting on another meeting\'s block without sending anything', async () => {
    await clearBlock()
    const until = Date.now() + 6 * 60 * 60 * 1000
    await repos().slots.noteRateLimit('workers-ai-embed', until - Date.now())
    const id = newId()
    await meetingWith(id, transcript(30))
    const { embedder, calls } = scripted()
    const refused = await advanceIndexing(id, depsWith(embedder))
    expect(refused).toMatchObject({ kind: 'failed', statusCode: 429, message: DAILY_LIMIT_MESSAGE, resumes: true })
    expect(calls).toHaveLength(0)
    expect((await runOf(id))!.attempts).toBe(0)
    await clearBlock()
  })

  it('finishes without the provider when only stored windows are left, block or no block', async () => {
    await clearBlock()
    const id = newId()
    const segments = transcript(30)
    await meetingWith(id, segments)
    const plan = await planWindows(segments)
    await repos().index.upsertWindows(id, plan.map(w => ({ ...w, model: 'model-a', embedding: hashedTokenVector(w.text) })))
    await repos().slots.noteRateLimit('workers-ai-embed', 60 * 60 * 1000)
    const { embedder, calls } = scripted()
    expect((await drive(id, depsWith(embedder))).at(-1)!.kind).toBe('done')
    expect(calls).toHaveLength(0)
    await clearBlock()
  })

  it('waits for a slot taken by another request, refunding the attempt and sending nothing', async () => {
    await clearBlock()
    const id = newId()
    await meetingWith(id, transcript(30))
    const slots = createLocalSlotRepository({ dataDir: join(dataDir, randomUUID()) })
    await slots.reserve('workers-ai-embed', { intervalMs: 60_000, maxWaitMs: 0 })
    const { embedder, calls } = scripted()
    const outcome = await advanceIndexing(id, depsWith(embedder, { slots, embedIntervalMs: 60_000 }))
    expect(outcome).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(outcome.kind === 'progress' && outcome.retryAt!.getTime()).toBeGreaterThan(Date.now())
    expect(calls).toHaveLength(0)
    expect((await runOf(id))!.attempts).toBe(0)
  })

  it('does not read a pacing wait as the daily limit once that has reset', async () => {
    await clearBlock()
    const id = newId()
    await meetingWith(id, transcript(100))
    const { embedder, queue } = scripted()
    queue(dailyLimitReached())
    expect(await advanceIndexing(id, depsWith(embedder))).toMatchObject({ kind: 'failed', statusCode: 429 })
    const midnight = (await runOf(id))!.retryAt!.getTime()
    await clearBlock()

    const slots = createLocalSlotRepository({ dataDir: join(dataDir, randomUUID()) })
    await slots.reserve('workers-ai-embed', { intervalMs: 60_000, maxWaitMs: 0 })
    const later = () => midnight + 1
    const deps = depsWith(embedder, { slots, embedIntervalMs: 60_000, now: later })
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'progress', next: 'wait', progress: { lastError: null } })
    expect((await runOf(id))!.lastError).toBeNull()
  })

  it('keeps going if the block could not be recorded, since the run\'s own park still holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = newId()
    await meetingWith(id, transcript(30))
    const { embedder, queue, calls } = scripted()
    queue(dailyLimitReached())
    const real = repos().slots
    const deps = depsWith(embedder, {
      slots: { ...real, reserve: async () => ({ granted: true, slotAt: new Date() }), noteRateLimit: async () => {
        throw new Error('database down')
      } },
    })
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'failed', statusCode: 429 })
    expect(await advanceIndexing(id, deps)).toMatchObject({ kind: 'failed', statusCode: 429 })
    expect(calls).toHaveLength(1)
    warn.mockRestore()
  })
})

describe('other failures', () => {
  it('parks a retryable failure for another attempt, then parks longer and says so', async () => {
    await clearBlock()
    const id = newId()
    const segments = transcript(100)
    await meetingWith(id, segments, 'summarizing')
    const { embedder, queue, calls } = scripted()
    const deps = depsWith(embedder)
    const outage = new EmbeddingError('Embedding service is unavailable (HTTP 500).', 502, true)
    queue(outage, outage)

    const first = await advanceIndexing(id, deps)
    expect(first).toMatchObject({ kind: 'progress', next: 'wait', progress: { lastError: outage.message } })
    expect((first.kind === 'progress' && first.retryAt!.getTime())).toBeLessThanOrEqual(now() + RETRYABLE_PARK_MS)

    advanceClock(RETRYABLE_PARK_MS + 1)
    const second = await advanceIndexing(id, deps)
    expect(second).toMatchObject({ kind: 'failed', statusCode: 502, message: outage.message, resumes: true })
    expect(calls).toHaveLength(2)
    expect((await runOf(id))!.retryAt!.getTime()).toBeGreaterThan(now() + RETRY_COOLDOWN_MS - 5_000)
    expect((await repos().meetings.get(id))!.status).toBe('summarizing')

    // After the park, a new try, with attempts of its own.
    advanceClock(RETRY_COOLDOWN_MS + 1)
    expect((await drive(id, deps)).at(-1)!.kind).toBe('done')
  })

  it('counts a database failure like a 5xx, lets go of the step, and tells the caller nothing of the database', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = newId()
    await meetingWith(id, transcript(30))
    const { embedder, calls } = scripted()
    const secret = 'Supabase transcript page select failed (42501): permission denied for table transcript_segments'
    const deps = depsWith(embedder, { transcripts: { listFrom: async () => {
      throw new Error(secret)
    } } })

    const first = await advanceIndexing(id, deps)
    expect(first).toMatchObject({ kind: 'progress', next: 'wait' })
    expect(calls).toHaveLength(0)
    const parked = (await runOf(id))!
    expect(parked.stepLeaseUntil).toBeNull()

    advanceClock(RETRYABLE_PARK_MS + 1)
    const second = await advanceIndexing(id, deps)
    expect(second).toMatchObject({ kind: 'failed', statusCode: 500, resumes: true })

    // Not in the answers, and not on the run, which any later caller is shown.
    for (const told of [JSON.stringify(first), JSON.stringify(second), parked.lastError, (await runOf(id))!.lastError]) {
      expect(told).not.toMatch(/Supabase|42501|transcript_segments/)
    }
    // It is in the log, for whoever runs this.
    expect(warn.mock.calls.map(call => String(call[1]))).toContain(`Error: ${secret}`)
    warn.mockRestore()
  })

  it.each([
    ['a capacity shortage', new EmbeddingError('The embedding service is out of capacity for the moment. Try again shortly.', 503, false), 503, true],
    ['a rejected token', new EmbeddingError('The embedding service rejected our credentials.', 502, false), 502, true],
    ['a passage over the model\'s limit', new EmbeddingInputTooLongError(9_223), 422, false],
  ] as const)('hands %s back at once, with nothing parked and no attempt spent', async (_name, error, statusCode, resumes) => {
    await clearBlock()
    const id = newId()
    await meetingWith(id, transcript(30))
    const { embedder, queue } = scripted()
    queue(error)
    expect(await advanceIndexing(id, depsWith(embedder))).toEqual({ kind: 'failed', statusCode, message: error.message, retryAt: null, resumes })
    const run = (await runOf(id))!
    expect(run).toMatchObject({ attempts: 0, retryAt: null, stepLeaseUntil: null, lastError: error.message })
    expect(await repos().slots.blockedUntil('workers-ai-embed')).toBeNull()
    expect((await repos().meetings.get(id))!.status).toBe('ready')
  })

  it('reports the meeting gone when it was deleted under a step', async () => {
    await clearBlock()
    const id = newId()
    await meetingWith(id, transcript(30))
    const gate = deferred()
    const { embedder, queue } = scripted()
    queue(() => gate.promise)
    const step = advanceIndexing(id, depsWith(embedder))
    await vi.waitFor(() => expect(db().hasItem(`pipeline/${id}`)).resolves.toBe(true))
    await new Promise(resolve => setTimeout(resolve, 20))

    await repos().meetings.delete(id, (await repos().meetings.get(id))!)
    await repos().pipeline.deleteForMeeting(id)
    await repos().index.deleteForMeeting(id)
    gate.resolve()
    expect(await step).toEqual({ kind: 'refused', statusCode: 404, message: 'Meeting not found' })
    // Nothing written back, on the driver with no foreign key to refuse it.
    expect(await db().hasItem(`windows/${id}`)).toBe(false)
    expect(await db().hasItem(`pipeline/${id}`)).toBe(false)
  })
})
