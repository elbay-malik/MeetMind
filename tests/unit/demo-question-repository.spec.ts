import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { createStorage, type Storage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { createLocalDemoQuestionRepository } from '../../server/utils/db/demo-questions-local'
import { describeDemoQuestions, type DemoQuestionDriver } from './helpers/demo-question-cases'

let dataDir: string
let db: Storage

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-demo-questions-'))
  db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const clearTable = async (table: string) => {
  for (const key of await db.getKeys(table)) await db.removeItem(key)
}

const driver = (): DemoQuestionDriver => ({
  repo: createLocalDemoQuestionRepository({ dataDir }),
  seed: (id, { updatedAgoMs, ...meeting }) => db.setItem(`meetings/${id}`, {
    id,
    ...meeting,
    failedStage: meeting.failedStage ?? null,
    updatedAt: new Date(Date.now() - (updatedAgoMs ?? 0)).toISOString(),
  }),
  setCount: (day, taken) => db.setItem(`demo-questions/${day}`, taken),
  async counts() {
    const keys = await db.getKeys('demo-questions')
    return Object.fromEntries(await Promise.all(keys.map(async key => [key.split(':').at(-1)!, await db.getItem<number>(key)])))
  },
  async clear() {
    await clearTable('meetings')
    await clearTable('demo-questions')
  },
})

describeDemoQuestions('the local driver', driver)
