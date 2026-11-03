import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Meeting, MeetingStatus } from '../../../shared/types/meeting'
import type { PipelineRepository, PipelineStage, SweepOptions } from '../../../server/utils/db/pipeline'
import type { SlotProvider } from '../../../server/utils/db/slots'
import { unattendedStep, type PipelineSnapshot, type PipelineStep } from '../../../server/utils/pipeline/assess'
import { DAILY_LIMIT_MESSAGE } from '../../../server/utils/qa/embedder'

/**
 * Which meetings the sweeper may be told to look at, as stored state: the same cases for the local
 * driver (tests/unit/sweep-selection.spec.ts) and for the Supabase driver over a real Postgres
 * (tests/postgrest/sweep-selection.spec.ts). Each is held to `unattendedStep` as well, which is what
 * actually takes the step, so the mirror cannot drift from it on either driver without a failure.
 */

export const MODEL = 'model-a'
const OTHER_MODEL = 'model-b'
const HOUR = 3_600_000

export interface RunSeed {
  leaseInMs?: number
  retryInMs?: number
  lastError?: string
  cursor?: Record<string, unknown>
  attempts?: number
}

export interface MeetingSeed {
  status: MeetingStatus
  failedStage?: Meeting['failedStage']
  errorMessage?: string
  runs?: Partial<Record<PipelineStage, RunSeed>>
  chunks?: { done: number, total: number }
  /** Lines of transcript. Past transcription, 2 unless a case says otherwise. */
  lines?: number
  windows?: { count: number, model: string }
  marker?: { model: string, complete: boolean, windowCount?: number }
  /** How long ago the row was touched, or created, when that is what a case is about. */
  updatedAgoMs?: number
  createdAgoMs?: number
  /** When it was created, to the millisecond, for a case about two created at the same instant. */
  createdAt?: string
}

export interface SlotSeed {
  blockedInMs?: number
  nextInMs?: number
}

export interface SweepCase {
  name: string
  meeting: MeetingSeed
  slots?: Partial<Record<SlotProvider, SlotSeed>>
  /** What the sweeper's selection should do with it. */
  picks: boolean
  /** What the step decision says of it. Only ever differs from `picks` where a case says why. */
  step: PipelineStep | null
}

const WHISPER_BLOCKED = { 'groq-whisper': { blockedInMs: HOUR } }
const CHAT_BLOCKED = { 'groq-chat': { blockedInMs: HOUR } }
const CHAT_SLOT_TAKEN = { 'groq-chat': { nextInMs: 30_000 } }
const EMBED_BLOCKED = { 'workers-ai-embed': { blockedInMs: HOUR } }
const EMBED_SLOT_TAKEN = { 'workers-ai-embed': { nextInMs: 30_000 } }
const REPLY = { reply: { size: 10, byteOffset: 0, parsed: false } }
const LIVE = { leaseInMs: 60_000 }
const PARKED = { retryInMs: 60_000 }
const LONG_PAST = { retryInMs: -HOUR }
const SOME = { done: 1, total: 3 }
const ALL = { done: 3, total: 3 }
const COOLED = { updatedAgoMs: HOUR }

export const SWEEP_CASES: SweepCase[] = [
  // Nothing has happened to it, or nothing can.
  { name: 'waiting on its upload', meeting: { status: 'pending_upload' }, picks: false, step: null },
  { name: 'a rejected upload', meeting: { status: 'failed', failedStage: 'upload', errorMessage: 'rejected' }, picks: false, step: null },

  // Transcription.
  { name: 'uploaded', meeting: { status: 'uploaded' }, picks: true, step: 'transcription' },
  { name: 'uploaded, with Whisper blocked', meeting: { status: 'uploaded' }, slots: WHISPER_BLOCKED, picks: false, step: null },
  { name: 'uploaded, with another provider blocked', meeting: { status: 'uploaded' }, slots: { ...CHAT_BLOCKED, ...EMBED_BLOCKED }, picks: true, step: 'transcription' },
  { name: 'transcribing, with a step live', meeting: { status: 'transcribing', runs: { transcription: LIVE } }, picks: false, step: null },
  { name: 'transcribing, parked', meeting: { status: 'transcribing', runs: { transcription: PARKED } }, picks: false, step: null },
  { name: 'transcribing, its park over', meeting: { status: 'transcribing', runs: { transcription: LONG_PAST } }, picks: true, step: 'transcription' },
  { name: 'transcribing, needing Whisper while it is blocked', meeting: { status: 'transcribing', runs: { transcription: LONG_PAST } }, slots: WHISPER_BLOCKED, picks: false, step: null },
  { name: 'transcribing, on a page of its reply while Whisper is blocked', meeting: { status: 'transcribing', runs: { transcription: { cursor: REPLY } } }, slots: WHISPER_BLOCKED, picks: true, step: 'transcription' },
  { name: 'failed at transcription, cooled down', meeting: { status: 'failed', failedStage: 'transcription', errorMessage: 'it broke', ...COOLED }, picks: false, step: null },
  { name: 'failed at transcription for good', meeting: { status: 'failed', failedStage: 'transcription', errorMessage: 'The meeting audio is missing from storage', ...COOLED }, picks: false, step: null },

  // Extraction.
  { name: 'summarizing, with no plan yet', meeting: { status: 'summarizing' }, picks: true, step: 'extraction' },
  { name: 'summarizing, with a plan and the chat slot free', meeting: { status: 'summarizing', chunks: { done: 0, total: 3 } }, picks: true, step: 'extraction' },
  { name: 'indexing, a chunk left, the chat slot free', meeting: { status: 'indexing', chunks: SOME }, picks: true, step: 'extraction' },
  { name: 'indexing, with a chunk live', meeting: { status: 'indexing', chunks: SOME, runs: { summarization: LIVE, search_index: LIVE } }, picks: false, step: null },
  { name: 'indexing, a chunk parked and the index parked', meeting: { status: 'indexing', chunks: SOME, runs: { summarization: PARKED, search_index: PARKED } }, picks: false, step: null },
  { name: 'indexing, a chunk parked and the index free', meeting: { status: 'indexing', chunks: SOME, runs: { summarization: PARKED } }, picks: true, step: 'indexing' },
  { name: 'indexing, the chat slot taken, the index free', meeting: { status: 'indexing', chunks: SOME }, slots: CHAT_SLOT_TAKEN, picks: true, step: 'indexing' },
  { name: 'indexing, Groq blocked, the index free', meeting: { status: 'indexing', chunks: SOME }, slots: CHAT_BLOCKED, picks: true, step: 'indexing' },
  { name: 'indexing, Groq blocked and the embedding slot taken', meeting: { status: 'indexing', chunks: SOME }, slots: { ...CHAT_BLOCKED, ...EMBED_SLOT_TAKEN }, picks: false, step: null },
  { name: 'indexing, planning with Groq blocked', meeting: { status: 'indexing' }, slots: CHAT_BLOCKED, picks: true, step: 'extraction' },
  { name: 'indexing, every chunk done and the index free', meeting: { status: 'indexing', chunks: ALL }, picks: true, step: 'indexing' },
  { name: 'indexing, every chunk done and the index parked: the summary is written', meeting: { status: 'indexing', chunks: ALL, runs: { search_index: PARKED } }, picks: true, step: 'extraction' },
  { name: 'indexing, every chunk done with both providers blocked: the summary asks neither', meeting: { status: 'indexing', chunks: ALL }, slots: { ...CHAT_BLOCKED, ...EMBED_BLOCKED }, picks: true, step: 'extraction' },

  // A failed extraction: never retried, and its index still goes on.
  { name: 'failed at extraction, cooled down, the index not started', meeting: { status: 'failed', failedStage: 'summarization', errorMessage: 'it broke', ...COOLED }, picks: true, step: 'indexing' },
  { name: 'failed at extraction, cooled down, the index finished', meeting: { status: 'failed', failedStage: 'summarization', errorMessage: 'it broke', ...COOLED, marker: { model: MODEL, complete: true, windowCount: 1 }, windows: { count: 1, model: MODEL } }, picks: false, step: null },
  { name: 'too long to extract, the index not started', meeting: { status: 'failed', failedStage: 'summarization', errorMessage: 'This transcript would need 41 sequential requests, over the 40 limit.', ...COOLED }, picks: true, step: 'indexing' },

  // The index of a finished meeting.
  { name: 'ready, the index finished', meeting: { status: 'ready', marker: { model: MODEL, complete: true, windowCount: 2 }, windows: { count: 2, model: MODEL } }, picks: false, step: null },
  { name: 'ready, with no speech', meeting: { status: 'ready', lines: 0 }, picks: false, step: null },
  { name: 'ready, the index not started', meeting: { status: 'ready' }, picks: true, step: 'indexing' },
  { name: 'ready, the index part way', meeting: { status: 'ready', marker: { model: MODEL, complete: false }, windows: { count: 1, model: MODEL } }, picks: true, step: 'indexing' },
  { name: 'ready, a step of the index live', meeting: { status: 'ready', runs: { search_index: LIVE } }, picks: false, step: null },
  { name: 'ready, the index parked', meeting: { status: 'ready', runs: { search_index: PARKED } }, picks: false, step: null },
  { name: 'ready, parked at the daily limit', meeting: { status: 'ready', runs: { search_index: { retryInMs: HOUR, lastError: DAILY_LIMIT_MESSAGE } } }, picks: false, step: null },
  { name: 'ready, the daily limit over', meeting: { status: 'ready', runs: { search_index: { retryInMs: -1_000, lastError: DAILY_LIMIT_MESSAGE } } }, picks: true, step: 'indexing' },
  { name: 'ready, the index parked after it kept stopping, however long ago', meeting: { status: 'ready', runs: { search_index: { retryInMs: -HOUR, lastError: 'Indexing hit a problem on the server.' } } }, picks: false, step: null },
  { name: 'ready, the index after one failure', meeting: { status: 'ready', runs: { search_index: { retryInMs: -1_000, lastError: 'Indexing hit a problem on the server.', attempts: 1 } } }, picks: false, step: null },
  { name: 'ready, the index stopped', meeting: { status: 'ready', runs: { search_index: { lastError: 'A passage is too long.' } } }, picks: false, step: null },
  { name: 'ready, the daily limit with no time to end', meeting: { status: 'ready', runs: { search_index: { lastError: DAILY_LIMIT_MESSAGE } } }, picks: false, step: null },
  { name: 'ready, Workers AI blocked', meeting: { status: 'ready' }, slots: EMBED_BLOCKED, picks: false, step: null },
  { name: 'ready, the embedding slot taken', meeting: { status: 'ready' }, slots: EMBED_SLOT_TAKEN, picks: false, step: null },
  { name: 'ready, Groq blocked, which the index does not use', meeting: { status: 'ready' }, slots: CHAT_BLOCKED, picks: true, step: 'indexing' },

  // Another model's work, which nothing unattended replaces.
  { name: 'ready, finished under another model', meeting: { status: 'ready', marker: { model: OTHER_MODEL, complete: true, windowCount: 2 }, windows: { count: 2, model: OTHER_MODEL } }, picks: false, step: null },
  { name: 'ready, part way under another model', meeting: { status: 'ready', marker: { model: OTHER_MODEL, complete: false }, windows: { count: 1, model: OTHER_MODEL } }, picks: false, step: null },
  { name: 'ready, no marker and another model\'s windows', meeting: { status: 'ready', windows: { count: 1, model: OTHER_MODEL } }, picks: false, step: null },
  { name: 'ready, a marker of another model with nothing stored', meeting: { status: 'ready', marker: { model: OTHER_MODEL, complete: false } }, picks: false, step: null },
  { name: 'ready, a pass under another model with nothing stored', meeting: { status: 'ready', runs: { search_index: { cursor: { pass: { model: OTHER_MODEL, textHash: 'x', nextWindow: 0, nextSegment: 0, pageSegments: 256, planned: false } } } } }, picks: false, step: null },

  // The one difference, on purpose: telling takes hashing the transcript, which is not a cost to
  // pay per meeting looked at. It only costs a tick's help, as a tab still finishes it.
  { name: 'ready, a complete marker that no longer adds up', meeting: { status: 'ready', marker: { model: MODEL, complete: true, windowCount: 3 }, windows: { count: 1, model: MODEL } }, picks: false, step: 'indexing' },
]

/** What a driver under test has to do for these cases. */
export interface SweepDriver {
  pipeline: Pick<PipelineRepository, 'nextForSweep' | 'nextExpired'>
  seed: (id: string, meeting: MeetingSeed) => Promise<void>
  seedSlots: (slots: Partial<Record<SlotProvider, SlotSeed>>) => Promise<void>
  /** Remove every meeting, and every slot's state. */
  clear: () => Promise<void>
  snapshot: (id: string) => Promise<PipelineSnapshot>
}

const options = (excludeId: string | null = null): SweepOptions => ({ model: MODEL, excludeId, limitError: DAILY_LIMIT_MESSAGE })

/** The same questions of either driver. Both have to answer them the same. */
export function describeSweepSelection(name: string, driver: () => SweepDriver) {
  describe(`what ${name} picks`, () => {
    beforeEach(() => driver().clear())

    it.each(SWEEP_CASES.map(c => [c.name, c] as const))('%s', async (_name, sweepCase) => {
      const { pipeline, seed, seedSlots, snapshot } = driver()
      const id = randomUUID()
      await seed(id, sweepCase.meeting)
      await seedSlots(sweepCase.slots ?? {})

      const { meetingId, busy } = await pipeline.nextForSweep(options())
      expect(meetingId).toBe(sweepCase.picks ? id : null)
      expect(unattendedStep(await snapshot(id), { model: MODEL, now: Date.now(), busy })).toBe(sweepCase.step)
    })

    it('never picks the public demo, however ready it is to move', async () => {
      const { pipeline, seed } = driver()
      const demo = randomUUID()
      await seed(demo, { status: 'uploaded' })
      expect((await pipeline.nextForSweep(options(demo))).meetingId).toBeNull()
      // Written as it may be configured, in capitals.
      expect((await pipeline.nextForSweep(options(demo.toUpperCase()))).meetingId).toBeNull()
      const other = randomUUID()
      await seed(other, { status: 'uploaded' })
      expect((await pipeline.nextForSweep(options(demo))).meetingId).toBe(other)
    })

    it('says which providers cannot be asked, whether or not a meeting can move', async () => {
      const { pipeline, seedSlots } = driver()
      expect(await pipeline.nextForSweep(options())).toEqual({ meetingId: null, busy: [] })
      await seedSlots({ 'groq-chat': { nextInMs: 30_000 }, 'groq-whisper': { nextInMs: 30_000 }, 'workers-ai-embed': { blockedInMs: HOUR } })
      // Whisper reserves no slot, so only its block counts.
      expect((await pipeline.nextForSweep(options())).busy.sort()).toEqual(['groq-chat', 'workers-ai-embed'])
      await seedSlots({ 'groq-chat': { blockedInMs: -1_000, nextInMs: -1_000 }, 'groq-whisper': { blockedInMs: HOUR }, 'workers-ai-embed': { blockedInMs: -1_000, nextInMs: -1_000 } })
      expect((await pipeline.nextForSweep(options())).busy).toEqual(['groq-whisper'])
    })

    it('goes round every meeting that can move, in turn, and back to the first', async () => {
      const { pipeline, seed } = driver()
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      for (const [i, id] of ids.entries()) await seed(id, { status: 'uploaded', createdAgoMs: (3 - i) * HOUR })
      const picked: Array<string | null> = []
      for (let i = 0; i < 7; i++) picked.push((await pipeline.nextForSweep(options())).meetingId)
      expect(picked).toEqual([...ids, ...ids, ids[0]])
    })

    it('gives a new meeting its turn, without going back over the ones before it', async () => {
      const { pipeline, seed } = driver()
      const old = randomUUID()
      await seed(old, { status: 'uploaded', createdAgoMs: 2 * HOUR })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(old)
      const fresh = randomUUID()
      await seed(fresh, { status: 'uploaded', createdAgoMs: HOUR })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(fresh)
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(old)
    })

    it('leaves out a meeting that cannot move, whichever its place in the rotation', async () => {
      const { pipeline, seed } = driver()
      const [first, stuck, last] = [randomUUID(), randomUUID(), randomUUID()]
      await seed(first, { status: 'uploaded', createdAgoMs: 3 * HOUR })
      await seed(stuck, { status: 'ready', runs: { search_index: { retryInMs: HOUR, lastError: DAILY_LIMIT_MESSAGE } }, createdAgoMs: 2 * HOUR })
      await seed(last, { status: 'ready', createdAgoMs: HOUR })
      const picked: Array<string | null> = []
      for (let i = 0; i < 4; i++) picked.push((await pipeline.nextForSweep(options())).meetingId)
      expect(picked).toEqual([first, last, first, last])
    })

    // A known limit (ADR-0012), held here so that it stays the one the documents describe: the
    // reads are fixed, so what cannot move still takes a place, and a complete meeting never gives it up.
    it('looks at the 50 finished transcripts touched last, whether or not they can move', async () => {
      const { pipeline, seed } = driver()
      const behind = randomUUID()
      await seed(behind, { status: 'ready', updatedAgoMs: 2 * HOUR })
      const complete = { status: 'ready', marker: { model: MODEL, complete: true } } as const
      for (let i = 0; i < 49; i++) await seed(randomUUID(), { ...complete, updatedAgoMs: HOUR - i * 1_000 })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(behind)
      await seed(randomUUID(), { ...complete, updatedAgoMs: 0 })
      expect((await pipeline.nextForSweep(options())).meetingId).toBeNull()
      expect((await pipeline.nextForSweep(options())).meetingId).toBeNull()
    })

    it('looks at the 50 in progress that have waited longest, whether or not they can move', async () => {
      const { pipeline, seed } = driver()
      const stuck = { status: 'transcribing', runs: { transcription: LIVE } } as const
      const newest = randomUUID()
      await seed(newest, { status: 'uploaded', updatedAgoMs: 1_000 })
      for (let i = 0; i < 49; i++) await seed(randomUUID(), { ...stuck, updatedAgoMs: HOUR + i * 1_000 })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(newest)
      await seed(randomUUID(), { ...stuck, updatedAgoMs: 2 * HOUR })
      expect((await pipeline.nextForSweep(options())).meetingId).toBeNull()
    })

    it('gives no place among the 50 finished to a meeting that failed at transcription', async () => {
      const { pipeline, seed } = driver()
      const behind = randomUUID()
      await seed(behind, { status: 'ready', updatedAgoMs: 2 * HOUR })
      for (let i = 0; i < 50; i++) await seed(randomUUID(), { status: 'failed', failedStage: 'transcription', errorMessage: 'it broke', updatedAgoMs: HOUR - i * 1_000 })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(behind)
    })

    it('gives two meetings created at the same instant a turn each', async () => {
      const { pipeline, seed } = driver()
      const createdAt = new Date(Date.now() - HOUR).toISOString()
      const [first, second] = [randomUUID(), randomUUID()].sort()
      await seed(first!, { status: 'uploaded', createdAt })
      await seed(second!, { status: 'uploaded', createdAt })
      const picked: Array<string | null> = []
      for (let i = 0; i < 4; i++) picked.push((await pipeline.nextForSweep(options())).meetingId)
      expect(picked).toEqual([first, second, first, second])
    })

    it('moves on from the last meeting it chose, even if nothing was ever done with it', async () => {
      // Nothing here takes a step, as a tick killed straight after choosing would not: the
      // meeting's own row has not changed, and that must not make it the next choice too.
      const { pipeline, seed } = driver()
      const [one, two] = [randomUUID(), randomUUID()]
      await seed(one, { status: 'uploaded', createdAgoMs: 2 * HOUR })
      await seed(two, { status: 'uploaded', createdAgoMs: HOUR })
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(one)
      expect((await pipeline.nextForSweep(options())).meetingId).toBe(two)
    })
  })
}

/** What a driver under test has to do for the purge's selection, which is about age and leases. */
export function describeExpirySelection(name: string, driver: () => SweepDriver & { pipeline: Pick<PipelineRepository, 'nextExpired'> }) {
  const DAY = 24 * HOUR
  const DEMO = '99999999-9999-4999-8999-999999999999'
  const ask = (days = 30) => driver().pipeline.nextExpired({ days, excludeId: DEMO })

  describe(`what ${name} says has expired`, () => {
    beforeEach(() => driver().clear())

    it('says nothing has, of a meeting inside its days', async () => {
      await driver().seed(randomUUID(), { status: 'ready', createdAgoMs: 29 * DAY })
      expect(await ask()).toBeNull()
    })

    it('says so of a meeting past them, whatever its status', async () => {
      for (const status of ['pending_upload', 'uploaded', 'transcribing', 'indexing', 'ready'] as const) {
        const id = randomUUID()
        await driver().clear()
        await driver().seed(id, { status, createdAgoMs: 31 * DAY })
        expect(await ask(), status).toBe(id)
      }
    })

    it('says so of a failed one too', async () => {
      const id = randomUUID()
      await driver().seed(id, { status: 'failed', failedStage: 'transcription', errorMessage: 'it broke', createdAgoMs: 31 * DAY })
      expect(await ask()).toBe(id)
    })

    it('goes by when the meeting was created, however recently it was touched', async () => {
      const id = randomUUID()
      await driver().seed(id, { status: 'ready', createdAgoMs: 31 * DAY, updatedAgoMs: 0 })
      expect(await ask()).toBe(id)
    })

    it('says nothing of one touched long ago that is inside its days', async () => {
      await driver().seed(randomUUID(), { status: 'ready', createdAgoMs: DAY, updatedAgoMs: 40 * DAY })
      expect(await ask()).toBeNull()
    })

    it('honours the days it is given, one way and the other', async () => {
      const id = randomUUID()
      await driver().seed(id, { status: 'ready', createdAgoMs: 3 * DAY })
      expect(await ask(4)).toBeNull()
      expect(await ask(2)).toBe(id)
    })

    it('answers the oldest', async () => {
      const [older, newer] = [randomUUID(), randomUUID()]
      await driver().seed(newer, { status: 'ready', createdAgoMs: 31 * DAY })
      await driver().seed(older, { status: 'ready', createdAgoMs: 60 * DAY })
      expect(await ask()).toBe(older)
    })

    it('never answers the public demo, however old, written either way', async () => {
      await driver().seed(DEMO, { status: 'ready', createdAgoMs: 400 * DAY })
      expect(await ask()).toBeNull()
      expect(await driver().pipeline.nextExpired({ days: 30, excludeId: DEMO.toUpperCase() })).toBeNull()
    })

    it('passes over a meeting a step is live on, and answers the next', async () => {
      const [live, next] = [randomUUID(), randomUUID()]
      await driver().seed(live, { status: 'indexing', createdAgoMs: 60 * DAY, runs: { summarization: { leaseInMs: 60_000 } } })
      await driver().seed(next, { status: 'ready', createdAgoMs: 31 * DAY })
      expect(await ask()).toBe(next)
    })

    it('answers one whose lease has run out, as a step that died leaves it', async () => {
      const id = randomUUID()
      await driver().seed(id, { status: 'indexing', createdAgoMs: 60 * DAY, runs: { summarization: { leaseInMs: -60_000 } } })
      expect(await ask()).toBe(id)
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses to look with %s days, which has no safe reading', async (days) => {
      await expect(driver().pipeline.nextExpired({ days, excludeId: DEMO })).rejects.toThrow(/positive whole number/)
    })

    it('refuses to look with no demo named', async () => {
      await expect(driver().pipeline.nextExpired({ days: 30, excludeId: '' })).rejects.toThrow(/public demo must be named/)
    })
  })
}
