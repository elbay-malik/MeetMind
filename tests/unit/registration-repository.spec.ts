import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { createStorage, type Storage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { createLocalRegistrationRepository } from '../../server/utils/db/registrations-local'
import { describeRegistrations, type RegistrationDriver } from './helpers/registration-cases'

let dataDir: string
let db: Storage

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-registrations-'))
  db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const driver = (): RegistrationDriver => ({
  repo: createLocalRegistrationRepository({ dataDir }),
  setCount: (day, taken) => db.setItem(`meeting-registrations/${day}`, taken),
  async counts() {
    const keys = await db.getKeys('meeting-registrations')
    return Object.fromEntries(await Promise.all(keys.map(async key => [key.split(':').at(-1)!, await db.getItem<number>(key)])))
  },
  async clear() {
    for (const key of await db.getKeys('meeting-registrations')) await db.removeItem(key)
  },
})

describeRegistrations('the local driver', driver)
