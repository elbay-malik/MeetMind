import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { Meeting } from '#shared/types/meeting'
import type { MeetingPatch, MeetingRepository, NewMeeting } from './meetings'

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

const meetingKey = (id: string) => `meetings/${id}`

/**
 * JSON-file repository under `<dataDir>/db/` for development and tests.
 * Not safe for concurrent writers — that is what Postgres is for.
 */
export function createLocalMeetingRepository(options: { dataDir: string }): MeetingRepository {
  const base = join(options.dataDir, 'db')
  const storage = () => storageFor(base)

  return {
    kind: 'local',

    async create(input: NewMeeting) {
      const now = new Date().toISOString()
      const meeting: Meeting = { ...input, createdAt: now, updatedAt: now }
      await (await storage()).setItem<Meeting>(meetingKey(meeting.id), meeting)
      return meeting
    },

    async get(id) {
      return (await (await storage()).getItem<Meeting>(meetingKey(id))) ?? null
    },

    async list({ limit }) {
      const s = await storage()
      const keys = await s.getKeys('meetings')
      const items = await s.getItems<Meeting>(keys)
      return items
        .map(i => i.value)
        .filter((m): m is Meeting => !!m)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
    },

    async update(id, patch: MeetingPatch) {
      const s = await storage()
      const current = await s.getItem<Meeting>(meetingKey(id))
      if (!current) return null
      const next: Meeting = { ...current, ...patch, updatedAt: new Date().toISOString() }
      await s.setItem<Meeting>(meetingKey(id), next)
      return next
    },
  }
}
