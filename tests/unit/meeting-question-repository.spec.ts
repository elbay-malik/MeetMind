import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { createStorage, type Storage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { createLocalMeetingQuestionRepository } from '../../server/utils/db/meeting-questions-local'
import { describeMeetingQuestions, type MeetingQuestionDriver } from './helpers/meeting-question-cases'

let dataDir: string
let db: Storage

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-meeting-questions-'))
  db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const driver = (): MeetingQuestionDriver => ({
  repo: createLocalMeetingQuestionRepository({ dataDir }),
  // The local count keys nothing on the meeting's row, so there is nothing to seed.
  seed: async () => {},
  setCount: (day, meetingId, taken) => db.setItem(`meeting-questions/${day}/${meetingId}`, taken),
  async counts() {
    const keys = await db.getKeys('meeting-questions')
    return Object.fromEntries(await Promise.all(keys.map(async (key) => {
      const [, day, meetingId] = key.split(':')
      return [`${day} ${meetingId}`, await db.getItem<number>(key)]
    })))
  },
  async clear() {
    for (const key of await db.getKeys('meeting-questions')) await db.removeItem(key)
  },
})

describeMeetingQuestions('the local driver', driver)
