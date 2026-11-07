import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import { utcDay } from './demo-questions'
import type { MeetingQuestionRepository } from './meeting-questions'
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

const QUEUE = 'meeting-questions'
/** In lower case, as a UUID in capitals is the same row to Postgres. */
const countKey = (day: string, meetingId: string) => `meeting-questions/${day}/${meetingId.toLowerCase()}`

/**
 * JSON files under `<dataDir>/db/`, one per UTC day and meeting, for development and tests. Every
 * take is a read-modify-write on one chain, which stands in for the row lock
 * `take_meeting_question` relies on. A deliberate mirror of that function and
 * `meeting_question_gate`: tests/unit/helpers/meeting-question-cases.ts holds both to the same
 * cases. Unlike the table, nothing here goes with a deleted meeting: its count stays until the
 * next day's first take deletes it, and no new meeting can have its id.
 */
export function createLocalMeetingQuestionRepository(options: { dataDir: string }): MeetingQuestionRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async overCount({ limit, meetingId }) {
      const s = await storageFor(base)
      const taken = await serialize(QUEUE, async () => (await s.getItem<number>(countKey(utcDay(Date.now()), meetingId))) ?? 0)
      return taken >= limit
    },

    async take({ limit, meetingId }) {
      if (limit <= 0) return false
      const s = await storageFor(base)
      return serialize(QUEUE, async () => {
        const today = utcDay(Date.now())
        for (const key of await s.getKeys('meeting-questions')) {
          const day = key.split(':')[1]
          if (day && day < today) await s.removeItem(key)
        }
        const key = countKey(today, meetingId)
        const taken = (await s.getItem<number>(key)) ?? 0
        if (taken >= limit) return false
        await s.setItem<number>(key, taken + 1)
        return true
      })
    },
  }
}
