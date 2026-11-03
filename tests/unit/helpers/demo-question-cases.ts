import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Meeting, MeetingStatus } from '../../../shared/types/meeting'
import { extractionInProgress } from '../../../shared/utils/meeting'
import { utcDay, type DemoQuestionRepository } from '../../../server/utils/db/demo-questions'

/**
 * The public demo's count and its question about extraction, as stored state: the same cases
 * for the local driver (tests/unit/demo-question-repository.spec.ts) and the Supabase driver over
 * a real Postgres (tests/postgrest/demo-questions.spec.ts). Each extraction case is held to
 * `extractionInProgress` as well, so neither driver's copy can drift from it without a failure.
 */

export interface DemoQuestionDriver {
  repo: DemoQuestionRepository
  seed(id: string, meeting: { status: MeetingStatus, failedStage?: Meeting['failedStage'] }): Promise<void>
  /** Puts a count down for a day, as if a take had left it there. */
  setCount(day: string, taken: number): Promise<void>
  /** Every day that has a count, and what it is. */
  counts(): Promise<Record<string, number>>
  clear(): Promise<void>
}

const DEMO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DAY = 86_400_000

export function describeDemoQuestions(name: string, get: () => DemoQuestionDriver): void {
  const today = () => utcDay(Date.now())

  describe(`the demo's count, on ${name}`, () => {
    beforeEach(() => get().clear())

    it('starts every day under its limit, and reading writes nothing', async () => {
      const { repo, counts } = get()
      expect(await repo.gate({ limit: 1, demoMeetingId: DEMO })).toEqual({ overCount: false, extractionPending: false })
      expect(await counts()).toEqual({})
    })

    it('takes up to the limit and no further, and the gate agrees', async () => {
      const { repo, counts } = get()
      expect(await repo.take(2)).toBe(true)
      expect((await repo.gate({ limit: 2, demoMeetingId: DEMO })).overCount).toBe(false)
      expect(await repo.take(2)).toBe(true)
      expect((await repo.gate({ limit: 2, demoMeetingId: DEMO })).overCount).toBe(true)
      expect(await repo.take(2)).toBe(false)
      expect(await repo.take(2)).toBe(false)
      expect(await counts()).toEqual({ [today()]: 2 })
    })

    it('never reads a limit lowered below the count as room', async () => {
      const { repo, setCount, counts } = get()
      await setCount(today(), 5)
      expect((await repo.gate({ limit: 3, demoMeetingId: DEMO })).overCount).toBe(true)
      expect(await repo.take(3)).toBe(false)
      expect(await counts()).toEqual({ [today()]: 5 })
    })

    it.each([0, -1])('takes nothing with a limit of %i, and writes no row for it', async (limit) => {
      const { repo, counts } = get()
      expect((await repo.gate({ limit, demoMeetingId: DEMO })).overCount).toBe(true)
      expect(await repo.take(limit)).toBe(false)
      expect(await counts()).toEqual({})
    })

    it('reads only today, and the next take deletes earlier days', async () => {
      const { repo, setCount, counts } = get()
      const yesterday = utcDay(Date.now() - DAY)
      const longAgo = utcDay(Date.now() - 40 * DAY)
      await setCount(yesterday, 99)
      await setCount(longAgo, 7)
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO })).overCount).toBe(false)
      expect(await counts()).toEqual({ [yesterday]: 99, [longAgo]: 7 })
      expect(await repo.take(1)).toBe(true)
      expect(await counts()).toEqual({ [today()]: 1 })
    })

    it('still deletes earlier days when today has run out', async () => {
      const { repo, setCount, counts } = get()
      await setCount(today(), 1)
      await setCount(utcDay(Date.now() - DAY), 9)
      expect(await repo.take(1)).toBe(false)
      expect(await counts()).toEqual({ [today()]: 1 })
    })

    it('grants exactly the limit among many at once', async () => {
      const { repo, counts } = get()
      const taken = await Promise.all(Array.from({ length: 30 }, () => repo.take(7)))
      expect(taken.filter(Boolean)).toHaveLength(7)
      expect(await counts()).toEqual({ [today()]: 7 })
    })
  })

  describe(`whether an extraction is pending, on ${name}`, () => {
    beforeEach(() => get().clear())

    const STATES: Array<[MeetingStatus, Meeting['failedStage']]> = [
      ['pending_upload', null],
      ['uploaded', null],
      ['transcribing', null],
      ['summarizing', null],
      ['indexing', null],
      ['ready', null],
      ['failed', 'upload'],
      ['failed', 'transcription'],
      ['failed', 'summarization'],
    ]

    it.each(STATES)('a meeting %s (%s) reads as assess.ts reads it', async (status, failedStage) => {
      const { repo, seed } = get()
      await seed(randomUUID(), { status, failedStage })
      const { extractionPending } = await repo.gate({ limit: 1, demoMeetingId: DEMO })
      expect(extractionPending).toBe(extractionInProgress({ status, failedStage }))
    })

    it('says so for those three states and no others, so the cases above are not vacuous', () => {
      expect(STATES.filter(([status, failedStage]) => extractionInProgress({ status, failedStage }))).toEqual([
        ['summarizing', null],
        ['indexing', null],
        ['failed', 'summarization'],
      ])
    })

    it('leaves the demo\'s own row out, whatever state it is in, and in capitals too', async () => {
      const { repo, seed } = get()
      await seed(DEMO, { status: 'failed', failedStage: 'summarization' })
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO })).extractionPending).toBe(false)
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO.toUpperCase() })).extractionPending).toBe(false)
      await seed(randomUUID(), { status: 'indexing' })
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO })).extractionPending).toBe(true)
    })

    it('finds one among many that are not', async () => {
      const { repo, seed } = get()
      for (let i = 0; i < 5; i++) await seed(randomUUID(), { status: 'ready' })
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO })).extractionPending).toBe(false)
      await seed(randomUUID(), { status: 'summarizing' })
      expect((await repo.gate({ limit: 1, demoMeetingId: DEMO })).extractionPending).toBe(true)
    })

    it('says both at once, as they are read separately', async () => {
      const { repo, seed, setCount } = get()
      await seed(randomUUID(), { status: 'summarizing' })
      await setCount(today(), 1)
      expect(await repo.gate({ limit: 1, demoMeetingId: DEMO })).toEqual({ overCount: true, extractionPending: true })
    })
  })
}
