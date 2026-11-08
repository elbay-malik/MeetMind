import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serialize } from '../../server/utils/db/local'
import { readyWindowCount } from '../../server/utils/db/windows'
import { deleteMeeting } from '../../server/utils/meeting-deletion'
import { advancePipeline, type PipelineDeps } from '../../server/utils/pipeline/advance'
import { reportTick, sweepOnce, type SweepOutcome } from '../../server/utils/pipeline/sweep'
import { DAILY_LIMIT_MESSAGE, EmbeddingError } from '../../server/utils/qa/embedder'
import { planWindows } from '../../server/utils/qa/windows'
import { withoutLogs } from '../../server/utils/quiet-logs'
import { restartExtraction } from '../../server/utils/summary/steps'
import { SummarizationError } from '../../server/utils/summary/summarizer'
import { TranscriptionError } from '../../server/utils/transcription/transcriber'
import { longLine, pipelineHarness, scriptedProviders, segmentsOf, shortLine, tallied, type ScriptedProviders } from './helpers/pipeline'

/**
 * The cron sweeper over the local drivers and scripted providers: what one tick does, what it
 * leaves alone, and what it spends with nobody watching. Which meeting a tick chooses is
 * tests/unit/sweep-selection.spec.ts. scripts/verify-worker-sweep.mjs does this under workerd.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-sweep-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const harness = pipelineHarness(() => dataDir)
const { repos, db, depsWith, uploadedMeeting, transcribedMeeting, stored } = harness

const NOON = Date.parse('2026-11-03T12:00:00.000Z')
const FIVE_MINUTES = 5 * 60_000

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOON)
  const all = db()
  for (const key of await all.getKeys()) await all.removeItem(key)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const lines = (count: number, line: (i: number) => string = longLine) => Array.from({ length: count }, (_, i) => line(i))
const nextTick = () => vi.setSystemTime(Date.now() + FIVE_MINUTES)
const sweep = (deps: PipelineDeps, demoMeetingId: unknown = '') => sweepOnce(deps, { demoMeetingId })
const meetingOf = async (id: string) => (await repos().meetings.get(id))!

/** The most a tick can spend, against 50 on the free plan. The case that reaches it is below, by name. */
const WORST_CASE_SUBREQUESTS = 23

/** Tick until nothing can move, holding every tick to what one may spend. */
async function sweepUntilIdle(deps: PipelineDeps, maxTicks = 300, demoMeetingId: unknown = '') {
  const counted = tallied(deps)
  const outcomes: SweepOutcome[] = []
  for (let i = 0; i < maxTicks; i++) {
    const outcome = await sweep(counted.deps, demoMeetingId)
    const spent = counted.take()
    expect(spent.calls.filter(call => call === 'pipeline.nextForSweep')).toHaveLength(1)
    expect(spent.claims, 'more than one claim').toBeLessThanOrEqual(1)
    expect(spent.providerCalls, 'more than one provider request').toBeLessThanOrEqual(1)
    expect(spent.subrequests).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS)
    if (outcome.kind === 'idle') return outcomes
    outcomes.push(outcome)
    nextTick()
  }
  throw new Error(`still moving after ${maxTicks} ticks: ${JSON.stringify(outcomes.slice(-3))}`)
}

/** Many more ticks than any bound here: a day, with the clock going round. */
const A_DAY_OF_TICKS = 288

async function idleForADay(deps: PipelineDeps, providers: ScriptedProviders) {
  const before = providers.calls.length
  for (let i = 0; i < A_DAY_OF_TICKS; i++) {
    await sweep(deps)
    nextTick()
  }
  expect(providers.calls.length, 'a provider was asked with nobody watching').toBe(before)
}

describe('one tick', () => {
  it('takes a meeting with no tab open from uploaded to ready, its index complete', async () => {
    const providers = scriptedProviders(lines(6))
    const id = await uploadedMeeting()
    const outcomes = await sweepUntilIdle(depsWith(providers))
    const plan = await planWindows(segmentsOf(lines(6)))

    const meeting = await meetingOf(id)
    expect(meeting.status).toBe('ready')
    expect(readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a')).toBe(plan.length)
    expect((await repos().transcripts.listFrom(id, 0, 100)).segments.map(s => s.text)).toEqual(lines(6))
    expect(await depsWith(providers).summaries.getForMeeting(id)).toMatchObject({ provider: 'stub' })

    // Nothing skipped, nothing twice.
    expect(providers.count('whisper')).toBe(1)
    expect(providers.sent.chunks).toEqual([0, 1, 2, 3, 4, 5])
    expect(providers.sent.windows).toEqual(plan.map(w => w.text))
    expect(outcomes.every(o => o.kind === 'step')).toBe(true)
    expect(new Set(outcomes.map(o => o.kind === 'step' && o.step))).toEqual(new Set(['transcription', 'extraction', 'indexing']))
  })

  it('takes the steps /advance takes, and stores what they store', async () => {
    const swept = scriptedProviders(lines(4))
    const sweptId = await uploadedMeeting()
    await sweepUntilIdle(depsWith(swept))

    const driven = scriptedProviders(lines(4))
    const drivenId = await uploadedMeeting()
    const deps = depsWith(driven)
    for (let i = 0; i < 100; i++) {
      const outcome = await advancePipeline(drivenId, deps)
      if (outcome.kind !== 'assessed') throw new Error(outcome.kind)
      if (outcome.assessment.answer.next === 'done') break
      vi.setSystemTime(Date.now() + 1_000)
    }

    expect(swept.calls).toEqual(driven.calls)
    expect(swept.sent).toEqual(driven.sent)
    const content = async (id: string) => ({
      lines: (await repos().transcripts.listFrom(id, 0, 100)).segments,
      summary: (await depsWith(swept).summaries.getForMeeting(id))!.summary,
      index: readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a'),
      status: (await meetingOf(id)).status,
    })
    expect(await content(sweptId)).toEqual(await content(drivenId))
  })

  it('spends the most on a first chunk that loses its claim while out at the provider', async () => {
    // The same path as /advance's worst, in pipeline-advance.spec.ts, less the read after a
    // step nobody is waiting to hear about, plus choosing the meeting.
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    for (let i = 0; i < 10 && (await meetingOf(id)).status !== 'summarizing'; i++) await sweep(deps)

    const ledger = () => db().getItem<{ runs: { summarization: { stepLeaseUntil: number } } }>(`pipeline/${id}`)
    providers.during.chunk.push(async () => {
      const held = await ledger()
      held!.runs.summarization.stepLeaseUntil = Date.now() - 1
      await db().setItem(`pipeline/${id}`, held)
      expect(await deps.pipeline.claimStep(id, 'summarization', { status: 'indexing', leaseMs: 60_000, chunkNo: 0 })).not.toBeNull()
    })

    const counted = tallied(deps)
    const outcome = await sweep(counted.deps)
    const spent = counted.take()
    expect(spent.subrequests).toBe(WORST_CASE_SUBREQUESTS)
    expect(spent.claims).toBe(1)
    expect(spent.providerCalls).toBe(1)
    expect(outcome).toMatchObject({ kind: 'step', step: 'extraction' })
  })

  it('spends the same at most on a long meeting as on a short one', async () => {
    const short = tallied(depsWith(scriptedProviders(lines(3))))
    await uploadedMeeting()
    let shortest = 0
    for (let i = 0; i < 40; i++) {
      await sweep(short.deps)
      shortest = Math.max(shortest, short.take().subrequests)
      nextTick()
    }
    const all = db()
    for (const key of await all.getKeys()) await all.removeItem(key)

    const long = tallied(depsWith(scriptedProviders(lines(39))))
    await uploadedMeeting()
    let longest = 0
    for (let i = 0; i < 150; i++) {
      await sweep(long.deps)
      longest = Math.max(longest, long.take().subrequests)
      nextTick()
    }
    expect(longest).toBe(shortest)
    expect(longest).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS)
  })

  it('reads the database on a tick with nothing to do, and nothing else, which is the keep-alive', async () => {
    const counted = tallied(depsWith(scriptedProviders([])))
    expect(await sweep(counted.deps)).toEqual({ kind: 'idle' })
    const spent = counted.take()
    expect(spent.calls).toEqual(['pipeline.nextForSweep'])
    expect(spent.subrequests).toBe(1)
    expect(await db().getItem('sweep/state')).toMatchObject({ lastTickAt: NOON })

    nextTick()
    await sweep(counted.deps)
    expect(counted.take().calls).toEqual(['pipeline.nextForSweep'])
    expect(await db().getItem('sweep/state')).toMatchObject({ lastTickAt: NOON + FIVE_MINUTES })
  })

  it('changes nothing of a meeting it has no step for', async () => {
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const providers = scriptedProviders([])
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    const before = await stored(id)
    expect(await sweep(deps)).toEqual({ kind: 'idle' })
    expect(await stored(id)).toEqual(before)
  })
})

describe('the public demo', () => {
  it('is not moved, however ready it is', async () => {
    const providers = scriptedProviders(lines(2))
    const demo = await uploadedMeeting()
    const counted = tallied(depsWith(providers))
    expect(await sweep(counted.deps, demo)).toEqual({ kind: 'idle' })
    expect(await sweep(counted.deps, ` ${demo.toUpperCase()}\n`)).toEqual({ kind: 'idle' })
    expect(counted.take().claims).toBe(0)
    expect(providers.calls).toEqual([])
    expect((await meetingOf(demo)).status).toBe('uploaded')
  })

  it('is not moved even when the database answers with it anyway', async () => {
    // Read, since only an extraction step may be taken of it and only its rows say whether
    // there is one, and then left as it is.
    const providers = scriptedProviders(lines(2))
    const demo = await uploadedMeeting()
    const deps = depsWith(providers)
    const counted = tallied({ ...deps, pipeline: { ...deps.pipeline, nextForSweep: async () => ({ meetingId: demo, busy: [] }) } })
    const before = await stored(demo)
    expect(await sweep(counted.deps, demo)).toEqual({ kind: 'no-step' })
    expect(counted.take().claims).toBe(0)
    expect(providers.calls).toEqual([])
    expect(await stored(demo)).toEqual(before)
  })

  it('has the summary an operator asked for again written, and nothing else of it moved', async () => {
    const providers = scriptedProviders(lines(3))
    const demo = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    const old = { summary: 'An earlier summary.', decisions: [], actionItems: [], provider: 'groq' as const }
    await deps.summaries.replaceForMeeting(demo, old)
    const finished = await meetingOf(demo)
    const { transcript, windows } = await stored(demo) as { transcript: unknown, windows: unknown }
    const audio = await deps.store.get(finished.audioKey)
    const asked = providers.calls.length

    const restarted = await restartExtraction(demo, { ...deps, model: 'model-a' })
    expect(restarted).toMatchObject({ kind: 'progress', meeting: { status: 'indexing' }, progress: { done: 0, total: 3 } })
    // The old summary is kept until the new one replaces it.
    expect(await deps.summaries.getForMeeting(demo)).toEqual(old)

    nextTick()
    const outcomes = await sweepUntilIdle(deps, 300, demo)
    expect(outcomes.map(o => o.kind === 'step' && o.step)).toEqual(['extraction', 'extraction', 'extraction', 'extraction'])
    expect(providers.calls.slice(asked)).toEqual(['chunk', 'chunk', 'chunk'])

    const after = await meetingOf(demo)
    expect(after).toMatchObject({ status: 'ready', errorMessage: null, failedStage: null })
    // What the demo's edge cache keys on, so the new summary is read under a new key.
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(finished.updatedAt))
    const summary = await deps.summaries.getForMeeting(demo)
    expect(summary).toMatchObject({ provider: 'stub' })
    expect(summary!.summary).not.toBe(old.summary)
    expect(await stored(demo)).toMatchObject({ transcript, windows })
    expect(await deps.store.get(finished.audioKey)).toEqual(audio)
    expect(readyWindowCount(await repos().index.readState(demo, 'model-a'), 'model-a')).not.toBeNull()
  })

  it('goes unnamed to the database when the setting is not an id, as that can be no meeting', async () => {
    const deps = depsWith(scriptedProviders([]))
    const nextForSweep = vi.fn(deps.pipeline.nextForSweep)
    for (const setting of ['', '   ', 'not-a-uuid', undefined, null, 12345]) {
      await sweep({ ...deps, pipeline: { ...deps.pipeline, nextForSweep } }, setting)
      expect(nextForSweep.mock.lastCall![0].excludeId).toBeNull()
    }
  })
})

describe('with nobody watching', () => {
  it('asks Whisper twice at most for a meeting that keeps failing, and then never again', async () => {
    const providers = scriptedProviders([])
    providers.keepFailing('whisper', () => new TranscriptionError('Groq said no, secret-body', 503, true))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    expect(providers.count('whisper')).toBe(2)
    expect(await meetingOf(id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })
    await idleForADay(deps, providers)
  })

  it('does not retry a Whisper 429 after its cooldown, which is a click', async () => {
    const providers = scriptedProviders(lines(1))
    providers.queue('whisper', new TranscriptionError('quota', 429, true))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    expect(providers.count('whisper')).toBe(1)
    await idleForADay(deps, providers)
    expect(await meetingOf(id)).toMatchObject({ status: 'failed', failedStage: 'transcription' })

    // Which is all it takes: the row is as a click on the page would find it.
    await advancePipeline(id, deps)
    expect(providers.count('whisper')).toBe(2)
  })

  it('asks for a chunk twice at most, stops that stage for good, and still finishes the index', async () => {
    const providers = scriptedProviders(lines(2))
    providers.keepFailing('chunk', () => new SummarizationError('Groq said no', 502, true))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    expect(providers.count('chunk')).toBe(2)
    expect(await meetingOf(id)).toMatchObject({ status: 'failed', failedStage: 'summarization' })
    expect(readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a')).toBeGreaterThan(0)
    await idleForADay(deps, providers)
  })

  it('stops a chunk that keeps being refused with a 429 at the third, as a tab would', async () => {
    const providers = scriptedProviders(lines(2))
    providers.keepFailing('chunk', () => new SummarizationError('slow down', 429, true, { kind: 'rate-limited', retryAt: new Date(Date.now() + 60_000) }))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    expect(providers.count('chunk')).toBe(3)
    expect((await meetingOf(id)).status).toBe('failed')
    await idleForADay(deps, providers)
  })

  it('stops an index at its first failure, with no `failed` to stop in and 288 ticks a day to retry on', async () => {
    const providers = scriptedProviders(lines(3))
    providers.keepFailing('embed', () => new EmbeddingError('The embedding service answered 500', 502, true))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await sweepUntilIdle(deps)
    expect(providers.count('embed')).toBe(1)
    await idleForADay(deps, providers)

    // A page is what carries it on, as it always has.
    await advancePipeline(id, deps)
    expect(providers.count('embed')).toBe(2)
  })

  it('stops an index that was refused, or whose step keeps dying, the same way', async () => {
    const refused = scriptedProviders(lines(3))
    refused.queue('embed', new EmbeddingError('Workers AI refused this account', 403, false))
    await uploadedMeeting()
    const deps = depsWith(refused)
    await sweepUntilIdle(deps)
    expect(refused.count('embed')).toBe(1)
    await idleForADay(deps, refused)
  })

  it('stops a finalize that keeps failing, whatever its count of attempts says, once it fails the run', async () => {
    const providers = scriptedProviders(lines(1))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const failing = { ...deps, pipeline: { ...deps.pipeline, finalizeSummary: async () => {
      throw new Error('the database refused')
    } } }
    for (let i = 0; i < 40; i++) {
      await sweep(failing).catch(() => {})
      nextTick()
    }
    expect((await meetingOf(id)).status).toBe('failed')
    const before = await stored(id)
    expect(await sweep(failing)).toEqual({ kind: 'idle' })
    expect(await stored(id)).toEqual(before)
  })

  describe('at the daily limit', () => {
    const midnight = Date.parse('2026-11-04T00:00:00.000Z')
    const limit = () => new EmbeddingError(DAILY_LIMIT_MESSAGE, 429, true, new Date(midnight))

    it('does not ask again until it resets, for this meeting or another, and carries on from there', async () => {
      const providers = scriptedProviders(lines(2))
      providers.queue('embed', limit())
      const first = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
      const second = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
      const deps = depsWith(providers)

      await sweep(deps)
      expect(providers.count('embed')).toBe(1)
      const asked = providers.calls.length
      expect(await repos().slots.blockedUntil('workers-ai-embed')).not.toBeNull()

      while (Date.now() + FIVE_MINUTES < midnight) {
        const counted = tallied(deps)
        expect(await sweep(counted.deps)).toEqual({ kind: 'idle' })
        expect(counted.take().claims).toBe(0)
        nextTick()
      }
      expect(providers.calls.length).toBe(asked)

      vi.setSystemTime(midnight + 1)
      await sweepUntilIdle(deps)
      for (const id of [first, second]) expect(readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a')).toBeGreaterThan(0)
    })

    it('asks once a day at most while the limit keeps being there', async () => {
      const providers = scriptedProviders(lines(2))
      providers.keepFailing('embed', () => {
        const next = Math.ceil((Date.now() + 1) / 86_400_000) * 86_400_000
        return new EmbeddingError(DAILY_LIMIT_MESSAGE, 429, true, new Date(next))
      })
      await transcribedMeeting(segmentsOf(lines(2)), 'ready')
      const deps = depsWith(providers)
      for (let i = 0; i < 3 * A_DAY_OF_TICKS; i++) {
        await sweep(deps)
        nextTick()
      }
      expect(providers.count('embed')).toBeLessThanOrEqual(4)
    })
  })

  it('leaves a provider alone while it is blocked, and moves what does not need it instead', async () => {
    const providers = scriptedProviders(lines(1))
    await repos().slots.noteRateLimit('groq-whisper', 60 * 60_000)
    const waiting = await uploadedMeeting()
    const moving = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const deps = depsWith(providers)
    const counted = tallied(deps)

    expect(await sweep(counted.deps)).toMatchObject({ kind: 'step', step: 'indexing' })
    counted.take()
    nextTick()
    await sweep(counted.deps)
    counted.take()
    nextTick()
    expect(await sweep(counted.deps)).toEqual({ kind: 'idle' })
    expect(counted.take().claims).toBe(0)
    expect(providers.count('whisper')).toBe(0)
    expect((await meetingOf(waiting)).status).toBe('uploaded')
    expect(readyWindowCount(await repos().index.readState(moving, 'model-a'), 'model-a')).toBeGreaterThan(0)

    vi.setSystemTime(Date.now() + 60 * 60_000)
    expect(await sweep(deps)).toMatchObject({ kind: 'step', step: 'transcription' })
    expect(providers.count('whisper')).toBe(1)
  })

  it('claims nothing it would only find it cannot do, so a slot miss costs a meeting nothing', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    for (let i = 0; i < 10 && (await meetingOf(id)).status !== 'summarizing'; i++) await sweep(deps)
    const claims = await repos().pipeline.listRuns(id)

    // A question has just taken the slot, and the index holds nothing yet, parked for now.
    await repos().slots.reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 0 })
    await repos().slots.reserve('workers-ai-embed', { intervalMs: 60_000, maxWaitMs: 0 })
    const before = await stored(id)
    const counted = tallied(deps)
    expect(await sweep(counted.deps)).toEqual({ kind: 'idle' })
    expect(counted.take().claims).toBe(0)
    expect(providers.count('chunk')).toBe(0)
    expect(await stored(id)).toEqual(before)
    expect(await repos().pipeline.listRuns(id)).toEqual(claims)
  })

  it('leaves another model\'s index alone, as /advance does', async () => {
    const providers = scriptedProviders(lines(1), { model: 'model-b' })
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    await repos().index.upsertWindows(id, (await planWindows(segmentsOf(lines(1)))).map(w => ({ ...w, model: 'model-a', embedding: [] })))
    const before = await stored(id)
    expect(await sweep(depsWith(providers))).toEqual({ kind: 'idle' })
    expect(providers.calls).toEqual([])
    expect(await stored(id)).toEqual(before)
  })

  it('does not repair a ready meeting with no summary, as /advance does not', async () => {
    const providers = scriptedProviders(lines(1))
    await transcribedMeeting([], 'ready')
    expect(await sweep(depsWith(providers))).toEqual({ kind: 'idle' })
    expect(providers.calls).toEqual([])
  })
})

describe('questions, which share the Groq slot', () => {
  /** A chunk step's summarizer as the real one takes its slot: at no wait, or a hold. */
  function pacedSummarizer(providers: ScriptedProviders, deps: PipelineDeps): PipelineDeps {
    return {
      ...deps,
      summarizer: {
        ...providers.summarizer,
        async summarizeChunk(input) {
          const slot = await deps.slots.reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 0 })
          if (!slot.granted) throw new SummarizationError('busy', 429, true, { kind: 'busy', retryAt: slot.retryAt })
          return providers.summarizer.summarizeChunk(input)
        },
      },
    }
  }

  it('find a slot free for at least 4 of every 5 minutes, however long the sweeper has work', async () => {
    const providers = scriptedProviders(lines(10))
    await uploadedMeeting()
    const deps = pacedSummarizer(providers, depsWith(providers))
    let ticks = 0
    let chunks = 0
    while (ticks < 40 && chunks < 8) {
      const before = providers.count('chunk')
      await sweep(deps)
      ticks++
      if (providers.count('chunk') > before) {
        chunks++
        // Inside the question's 20 s wait, this one tick's slot can still be in the way.
        const atOnce = await repos().slots.reserve('groq-chat', { intervalMs: 0, maxWaitMs: 20_000 })
        expect(atOnce.granted).toBe(false)
      }
      // A minute on, and from there to the next tick, a question has it to itself.
      vi.setSystemTime(Date.now() + 60_001)
      const asked = await repos().slots.reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 20_000 })
      expect(asked.granted).toBe(true)
      vi.setSystemTime(Date.now() + FIVE_MINUTES - 60_001)
    }
    expect(chunks).toBe(8)
  })

  it('are refused on every meeting once a tick has used up the day, as ADR-0012 says, and the tick stops asking', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    await repos().slots.noteRateLimit('groq-chat', 6 * 60 * 60_000)
    expect((await repos().slots.reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 20_000 })).granted).toBe(false)
    const before = providers.count('chunk')
    await sweepUntilIdle(deps, 12)
    expect(providers.count('chunk')).toBe(before)
    expect((await meetingOf(id)).status).not.toBe('failed')
  })

  it('go first when one has just taken the slot: the tick asks nothing, and costs the chunk nothing', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = pacedSummarizer(providers, depsWith(providers))
    for (let i = 0; i < 10 && (await meetingOf(id)).status !== 'summarizing'; i++) await sweep(deps)
    await repos().slots.reserve('groq-chat', { intervalMs: 60_000, maxWaitMs: 0 })
    await sweep(deps)
    expect(providers.count('chunk')).toBe(0)
    expect((await repos().pipeline.listChunks(id)).every(chunk => chunk.attempts === 0)).toBe(true)
  })
})

describe('beside an open tab', () => {
  it('asks each provider once, with a tab and a tick both on every step', async () => {
    const providers = scriptedProviders(lines(3))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    for (let i = 0; i < 100; i++) {
      await Promise.all([sweep(deps), advancePipeline(id, deps)])
      vi.setSystemTime(Date.now() + FIVE_MINUTES)
      if ((await meetingOf(id)).status === 'ready' && readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a') !== null) break
    }
    expect((await meetingOf(id)).status).toBe('ready')
    expect(providers.count('whisper')).toBe(1)
    expect(providers.sent.chunks).toEqual([0, 1, 2])
    expect(new Set(providers.sent.windows).size).toBe(providers.sent.windows.length)
  })

  // A file being written can be read half way: seen once, as a ledger with no runs in it, by a
  // tick racing a claim. So each of these has to wait its turn in the meeting's own queue.
  it.each<[string, (deps: PipelineDeps) => Promise<unknown>]>([
    ['what a tick chooses', deps => deps.pipeline.nextForSweep({ model: 'model-a', excludeId: null, limitError: 'x' })],
    ['what has expired', deps => deps.pipeline.nextExpired({ days: 1, excludeId: randomUUID() })],
  ])('reads a meeting\'s files for %s only in that meeting\'s queue', async (_name, read) => {
    const id = await transcribedMeeting(segmentsOf(lines(1)), 'ready')
    const row = await db().getItem<Record<string, unknown>>(`meetings/${id}`)
    await db().setItem(`meetings/${id}`, { ...row, createdAt: new Date(NOON - 30 * 86_400_000).toISOString() })

    let release = () => {}
    const writing = serialize(id, () => new Promise<void>((resolve) => {
      release = resolve
    }))
    let answered = false
    const reading = read(depsWith(scriptedProviders([]))).then(() => {
      answered = true
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(answered, 'it read while a write was under way').toBe(false)
    release()
    await Promise.all([writing, reading])
    expect(answered).toBe(true)
  })

  it('loses a claim quietly: the tab has the step, and the tick neither sends nor throws', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const tabDuring = vi.fn(async () => {
      expect(await sweep(deps)).toEqual({ kind: 'idle' })
    })
    providers.during.whisper.push(tabDuring)
    await advancePipeline(id, deps)
    expect(tabDuring).toHaveBeenCalled()
    expect(providers.count('whisper')).toBe(1)
  })

  it('tells a tab it has the step, when the tick got there first', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const tab = vi.fn(async () => {
      const outcome = await advancePipeline(id, deps)
      expect(outcome).toMatchObject({ kind: 'assessed', assessment: { step: null, answer: { next: 'wait' } } })
    })
    providers.during.whisper.push(tab)
    await sweep(deps)
    expect(tab).toHaveBeenCalled()
    expect(providers.count('whisper')).toBe(1)
  })

  it('loses a claim the tab took between the tick\'s read and its own, and does not throw', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    const claimStep = deps.pipeline.claimStep
    const raced = {
      ...deps,
      pipeline: {
        ...deps.pipeline,
        claimStep: async (...args: Parameters<typeof claimStep>) => {
          await claimStep(id, 'transcription', { status: 'uploaded', moveTo: 'transcribing', resetAttempts: true, leaseMs: 60_000 })
          return claimStep(...args)
        },
      },
    }
    expect(await sweep(raced)).toMatchObject({ kind: 'step', step: 'transcription', outcome: expect.stringMatching(/progress|refused/) })
    expect(providers.count('whisper')).toBe(0)
  })

  it('leaves a delete blocked while its step is out, as any other step does', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    // Past the upload window, so the step's lease is all that can be in the way.
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    const during = vi.fn(async () => {
      const outcome = await deleteMeeting(id, { meetings: deps.meetings, pipeline: deps.pipeline, removeData: async () => {} })
      expect(outcome).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/pipeline step is running/) })
    })
    providers.during.whisper.push(during)
    await sweep(deps)
    expect(during).toHaveBeenCalled()
  })

  it('writes nothing back for a meeting deleted during its step, and does not throw', async () => {
    const providers = scriptedProviders(lines(2))
    const id = await uploadedMeeting()
    const deps = depsWith(providers)
    providers.during.whisper.push(async () => {
      await db().removeItem(`meetings/${id}`)
    })
    expect(await sweep(deps)).toMatchObject({ kind: 'step', step: 'transcription' })
    expect(await repos().meetings.get(id)).toBeNull()
    expect((await repos().transcripts.listFrom(id, 0, 10)).segments).toEqual([])
    expect(await sweep(deps)).toEqual({ kind: 'idle' })
    expect(providers.count('whisper')).toBe(1)
  })
})

describe('a meeting that is stuck', () => {
  it('does not starve the rest: every other meeting still gets its turn, tick after tick', async () => {
    const providers = scriptedProviders(lines(2))
    const stuck = await uploadedMeeting()
    vi.setSystemTime(Date.now() + 1_000)
    const other = await uploadedMeeting()
    vi.setSystemTime(Date.now() + 1_000)
    const third = await uploadedMeeting()
    const deps = depsWith(providers)
    // Fails before any claim, as a step killed that early would, so nothing of its own moves.
    const failing = {
      ...deps,
      meetings: {
        ...deps.meetings,
        get: async (id: string) => {
          if (id === stuck) throw new Error('this one kills the invocation')
          return deps.meetings.get(id)
        },
      },
    }

    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 90; i++) {
      await reportTick(() => sweep(failing))
      nextTick()
    }
    expect(log).toHaveBeenCalled()
    for (const id of [other, third]) {
      expect((await meetingOf(id)).status).toBe('ready')
      expect(readyWindowCount(await repos().index.readState(id, 'model-a'), 'model-a')).toBeGreaterThan(0)
    }
    expect((await meetingOf(stuck)).status).toBe('uploaded')
  })
})

describe('what a tick logs', () => {
  const quiet = () => ({
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  })
  const lineCount = (logs: ReturnType<typeof quiet>) => Object.values(logs).reduce((sum, spy) => sum + spy.mock.calls.length, 0)

  it('says nothing for a tick with nothing to do', async () => {
    const logs = quiet()
    await reportTick(async () => ({ kind: 'idle' }))
    await reportTick(async () => ({ kind: 'no-step' }))
    expect(lineCount(logs)).toBe(0)
  })

  it('says one line for a step, naming what kind and nothing more', async () => {
    const logs = quiet()
    await reportTick(async () => ({ kind: 'step', step: 'extraction', outcome: 'progress' }))
    expect(lineCount(logs)).toBe(1)
    expect(logs.info).toHaveBeenCalledWith('[meetmind] sweep: extraction step, progress')
  })

  it('names the kind of a failure, and never its message, which can hold anything', async () => {
    const logs = quiet()
    const secret = 'sk-secret the transcript said this provider body quoted'
    await reportTick(async () => {
      throw new TypeError(secret)
    })
    expect(lineCount(logs)).toBe(1)
    expect(logs.warn).toHaveBeenCalledWith('[meetmind] sweep failed: TypeError')
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret')
  })

  it('does not throw for a thrown value that is not an error', async () => {
    const logs = quiet()
    await expect(reportTick(async () => {
      throw 'the value'
    })).resolves.toBeUndefined()
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('the value')
  })

  it('drops what a step logs on its way, raw errors and all, and prints the one line', async () => {
    const logs = quiet()
    const providers = scriptedProviders(lines(2))
    // The indexing step logs a database's error as it stands, which a route's log can carry.
    const id = await transcribedMeeting(segmentsOf(lines(2)), 'ready')
    const deps = depsWith(providers)
    const leaking = { ...deps, transcripts: { ...deps.transcripts, listFrom: async () => {
      throw new Error('relation "secret_table" does not exist: the transcript text')
    } } }
    await reportTick(() => withoutLogs(() => sweep(leaking)))
    expect(lineCount(logs)).toBe(1)
    expect(logs.info).toHaveBeenCalledWith('[meetmind] sweep: indexing step, progress')
    expect(JSON.stringify(Object.values(logs).map(spy => spy.mock.calls))).not.toMatch(/secret_table|transcript text/)
    // And the error is on the run, in the same plain words a route's caller gets.
    expect((await repos().pipeline.listRuns(id)).find(run => run.stage === 'search_index')!.lastError).toBe('Indexing hit a problem on the server.')
  })

  it('prints no stored error, whatever the meeting holds', async () => {
    const logs = quiet()
    const providers = scriptedProviders(lines(1))
    providers.keepFailing('whisper', () => new TranscriptionError('provider body: secret-word', 500, false))
    await uploadedMeeting()
    const deps = depsWith(providers)
    for (let i = 0; i < 4; i++) {
      await reportTick(() => withoutLogs(() => sweep(deps)))
      nextTick()
    }
    expect(JSON.stringify(Object.values(logs).map(spy => spy.mock.calls))).not.toContain('secret-word')
  })

  it('says how a step went in one word, whichever stage it is and however it went', async () => {
    const logs = quiet()
    const providers = scriptedProviders(lines(2))
    providers.keepFailing('chunk', () => new SummarizationError('provider body: secret-word', 502, true))
    await uploadedMeeting()
    const deps = depsWith(providers)
    for (let i = 0; i < 40; i++) {
      await reportTick(() => withoutLogs(() => sweep(deps)))
      nextTick()
    }
    const said = logs.info.mock.calls.map(([line]) => String(line))
    for (const stage of ['transcription', 'extraction', 'indexing']) expect(said.some(line => line.includes(`${stage} step`)), stage).toBe(true)
    for (const line of said) expect(line).toMatch(/^\[meetmind\] sweep: (transcription|extraction|indexing) step, [a-z-]+$/)
  })

  it('never drops what anything else logs, while a tick is under way in the same isolate', async () => {
    const logs = quiet()
    let release: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tick = withoutLogs(async () => {
      console.warn('a step said this')
      await held
      console.warn('and this')
    })
    console.warn('a request said this')
    release!()
    await tick
    expect(logs.warn.mock.calls).toEqual([['a request said this']])
  })

  it('takes nothing away from a console once a tick is over', async () => {
    const logs = quiet()
    await withoutLogs(async () => {
      console.error('dropped')
    })
    console.error('kept')
    expect(logs.error.mock.calls).toEqual([['kept']])
  })
})

it('copes with a meeting id it read being gone by the time the step reads it', async () => {
  const providers = scriptedProviders([])
  const deps = depsWith(providers)
  const gone = randomUUID()
  expect(await sweep({ ...deps, pipeline: { ...deps.pipeline, nextForSweep: async () => ({ meetingId: gone, busy: [] }) } })).toEqual({ kind: 'no-step' })
})

it('counts a line of transcript the same way, on a meeting of many short lines', async () => {
  const providers = scriptedProviders(lines(300, shortLine))
  const id = await uploadedMeeting()
  await sweepUntilIdle(depsWith(providers))
  expect((await meetingOf(id)).status).toBe('ready')
})
