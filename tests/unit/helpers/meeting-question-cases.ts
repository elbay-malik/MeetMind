import { beforeEach, describe, expect, it } from 'vitest'
import { utcDay } from '../../../server/utils/db/demo-questions'
import type { MeetingQuestionRepository } from '../../../server/utils/db/meeting-questions'

/**
 * Every other meeting's daily count of questions (ADR-0020), as stored state: the same cases for
 * the local driver (tests/unit/meeting-question-repository.spec.ts) and the Supabase driver over
 * a real Postgres (tests/postgrest/meeting-questions.spec.ts).
 */

export interface MeetingQuestionDriver {
  repo: MeetingQuestionRepository
  /** A meeting to count against, which the table's key needs to exist. */
  seed(id: string): Promise<void>
  /** Puts a count down for a day and meeting, as if a take had left it there. */
  setCount(day: string, meetingId: string, taken: number): Promise<void>
  /** Every count there is, as `<day> <meeting>` and what it is. */
  counts(): Promise<Record<string, number>>
  clear(): Promise<void>
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DAY = 86_400_000

export function describeMeetingQuestions(name: string, get: () => MeetingQuestionDriver): void {
  const today = () => utcDay(Date.now())

  describe(`each meeting's count, on ${name}`, () => {
    beforeEach(async () => {
      await get().clear()
      await get().seed(A)
      await get().seed(B)
    })

    it('starts every day under its limit, and reading writes nothing', async () => {
      const { repo, counts } = get()
      expect(await repo.overCount({ limit: 1, meetingId: A })).toBe(false)
      expect(await counts()).toEqual({})
    })

    it('takes up to the limit and no further, and the gate agrees', async () => {
      const { repo, counts } = get()
      expect(await repo.take({ limit: 2, meetingId: A })).toBe(true)
      expect(await repo.overCount({ limit: 2, meetingId: A })).toBe(false)
      expect(await repo.take({ limit: 2, meetingId: A })).toBe(true)
      expect(await repo.overCount({ limit: 2, meetingId: A })).toBe(true)
      expect(await repo.take({ limit: 2, meetingId: A })).toBe(false)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 2 })
    })

    it('keeps each meeting\'s count apart', async () => {
      const { repo, counts } = get()
      expect(await repo.take({ limit: 1, meetingId: A })).toBe(true)
      expect(await repo.overCount({ limit: 1, meetingId: A })).toBe(true)
      expect(await repo.overCount({ limit: 1, meetingId: B })).toBe(false)
      expect(await repo.take({ limit: 1, meetingId: B })).toBe(true)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 1, [`${today()} ${B}`]: 1 })
    })

    it('counts a meeting named in capitals as the same one', async () => {
      const { repo, counts } = get()
      expect(await repo.take({ limit: 2, meetingId: A.toUpperCase() })).toBe(true)
      expect(await repo.take({ limit: 2, meetingId: A })).toBe(true)
      expect(await repo.overCount({ limit: 2, meetingId: A.toUpperCase() })).toBe(true)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 2 })
    })

    it('never reads a limit lowered below the count as room', async () => {
      const { repo, setCount, counts } = get()
      await setCount(today(), A, 5)
      expect(await repo.overCount({ limit: 3, meetingId: A })).toBe(true)
      expect(await repo.take({ limit: 3, meetingId: A })).toBe(false)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 5 })
    })

    it.each([0, -1])('takes nothing with a limit of %i, and writes no row for it', async (limit) => {
      const { repo, counts } = get()
      expect(await repo.overCount({ limit, meetingId: A })).toBe(true)
      expect(await repo.take({ limit, meetingId: A })).toBe(false)
      expect(await counts()).toEqual({})
    })

    it('reads only today, and the next take deletes earlier days of every meeting', async () => {
      const { repo, setCount, counts } = get()
      const yesterday = utcDay(Date.now() - DAY)
      await setCount(yesterday, A, 99)
      await setCount(utcDay(Date.now() - 40 * DAY), B, 7)
      expect(await repo.overCount({ limit: 1, meetingId: A })).toBe(false)
      expect(Object.keys(await counts())).toHaveLength(2)
      expect(await repo.take({ limit: 1, meetingId: A })).toBe(true)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 1 })
    })

    it('grants exactly the limit among many at once', async () => {
      const { repo, counts } = get()
      const taken = await Promise.all(Array.from({ length: 30 }, () => repo.take({ limit: 7, meetingId: A })))
      expect(taken.filter(Boolean)).toHaveLength(7)
      expect(await counts()).toEqual({ [`${today()} ${A}`]: 7 })
    })
  })
}
