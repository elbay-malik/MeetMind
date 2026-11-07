import { beforeEach, describe, expect, it } from 'vitest'
import { utcDay } from '../../../server/utils/db/demo-questions'
import type { RegistrationRepository } from '../../../server/utils/db/registrations'

/**
 * The whole app's daily count of new meetings (ADR-0020), as stored state: the same cases for
 * the local driver (tests/unit/registration-repository.spec.ts) and the Supabase driver over a
 * real Postgres (tests/postgrest/registrations.spec.ts).
 */

export interface RegistrationDriver {
  repo: RegistrationRepository
  /** Puts a count down for a day, as if a take had left it there. */
  setCount(day: string, taken: number): Promise<void>
  /** Every day that has a count, and what it is. */
  counts(): Promise<Record<string, number>>
  clear(): Promise<void>
}

const DAY = 86_400_000

export function describeRegistrations(name: string, get: () => RegistrationDriver): void {
  const today = () => utcDay(Date.now())

  describe(`the day's new meetings, on ${name}`, () => {
    beforeEach(() => get().clear())

    it('takes up to the limit and no further', async () => {
      const { repo, counts } = get()
      expect(await repo.take(2)).toBe(true)
      expect(await repo.take(2)).toBe(true)
      expect(await repo.take(2)).toBe(false)
      expect(await counts()).toEqual({ [today()]: 2 })
    })

    it('never reads a limit lowered below the count as room', async () => {
      const { repo, setCount, counts } = get()
      await setCount(today(), 5)
      expect(await repo.take(3)).toBe(false)
      expect(await counts()).toEqual({ [today()]: 5 })
    })

    it.each([0, -1])('takes nothing with a limit of %i, and writes no row for it', async (limit) => {
      const { repo, counts } = get()
      expect(await repo.take(limit)).toBe(false)
      expect(await counts()).toEqual({})
    })

    it('counts only today, and a take deletes earlier days, granted or not', async () => {
      const { repo, setCount, counts } = get()
      await setCount(utcDay(Date.now() - DAY), 99)
      await setCount(utcDay(Date.now() - 40 * DAY), 7)
      expect(await repo.take(1)).toBe(true)
      expect(await counts()).toEqual({ [today()]: 1 })
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
}
