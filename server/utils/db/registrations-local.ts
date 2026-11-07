import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import { utcDay } from './demo-questions'
import type { RegistrationRepository } from './registrations'
import { serialize } from './local'

const storages = new Map<string, Promise<Storage>>()

function storageFor(base: string): Promise<Storage> {
  let existing = storages.get(base)
  if (!existing) {
    existing = import('unstorage/drivers/fs').then(({ default: fsDriver }) =>
      createStorage({ driver: fsDriver({ base }) }))
    storages.set(base, existing)
  }
  return existing
}

const QUEUE = 'meeting-registrations'
const dayKey = (day: string) => `meeting-registrations/${day}`

/**
 * JSON files under `<dataDir>/db/`, one per UTC day, for development and tests. Every take is a
 * read-modify-write on one chain, which stands in for the row lock `take_meeting_registration`
 * relies on. A deliberate mirror of that function: tests/unit/helpers/registration-cases.ts holds
 * both to the same cases.
 */
export function createLocalRegistrationRepository(options: { dataDir: string }): RegistrationRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async take(limit) {
      if (limit <= 0) return false
      const s = await storageFor(base)
      return serialize(QUEUE, async () => {
        const today = utcDay(Date.now())
        for (const key of await s.getKeys('meeting-registrations')) {
          const day = key.split(':').at(-1)!.replace(/\.json$/, '')
          if (day < today) await s.removeItem(dayKey(day))
        }
        const taken = (await s.getItem<number>(dayKey(today))) ?? 0
        if (taken >= limit) return false
        await s.setItem<number>(dayKey(today), taken + 1)
        return true
      })
    },
  }
}
