import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { Meeting } from '#shared/types/meeting'
import { pausesDemoQuestions } from '#shared/utils/meeting'
import { utcDay, type DemoQuestionRepository } from './demo-questions'
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

const QUEUE = 'demo-questions'
const dayKey = (day: string) => `demo-questions/${day}`

/**
 * JSON files under `<dataDir>/db/` for development and tests, one per UTC day. Every take is a
 * read-modify-write on one chain, which stands in for the row lock `take_demo_question`
 * relies on. A deliberate mirror of that function and `demo_question_gate`:
 * tests/unit/helpers/demo-question-cases.ts holds both to the same cases.
 */
export function createLocalDemoQuestionRepository(options: { dataDir: string }): DemoQuestionRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async gate({ limit, demoMeetingId }) {
      const s = await storageFor(base)
      const taken = await serialize(QUEUE, async () => (await s.getItem<number>(dayKey(utcDay(Date.now())))) ?? 0)
      const demo = demoMeetingId.toLowerCase()
      const now = Date.now()
      let extractionPending = false
      for (const key of await s.getKeys('meetings')) {
        const id = key.split(':').at(-1)!
        if (id.toLowerCase() === demo) continue
        const row = await serialize(id, () => s.getItem<Pick<Meeting, 'status' | 'failedStage' | 'updatedAt'>>(`meetings/${id}`))
        if (row && pausesDemoQuestions(row, now)) {
          extractionPending = true
          break
        }
      }
      return { overCount: taken >= limit, extractionPending }
    },

    async take(limit) {
      if (limit <= 0) return false
      const s = await storageFor(base)
      return serialize(QUEUE, async () => {
        const today = utcDay(Date.now())
        for (const key of await s.getKeys('demo-questions')) {
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
