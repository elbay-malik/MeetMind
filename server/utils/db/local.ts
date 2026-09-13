import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { Meeting } from '#shared/types/meeting'
import type { MeetingPatch, MeetingRepository, NewMeeting } from './meetings'

const storages = new Map<string, Promise<Storage>>()

/**
 * One promise chain per meeting, covering reads as well as writes.
 *
 * Writes replace a whole JSON file with a truncating write, so in principle a
 * read can land mid-write and see a partial file. Measured, that window only
 * opens for values large enough to need several write syscalls — at 1 KB and
 * 100 KB no concurrent read ever observed a partial file, and meeting rows are
 * far smaller than that. Reads are queued anyway because this driver's own
 * contract says it is not safe for concurrent writers and the cost is nil, but
 * it is a consistency guarantee rather than a fix for an observed failure.
 */
const chains = new Map<string, Promise<unknown>>()

/**
 * Exported so every local JSON-file driver keyed by meeting id can share the
 * one queue per id — summaries-local.ts stores exactly the payload this
 * comment warns about (potentially dozens of decisions and action items, each
 * carrying a full verbatim quote) and needs the same protection.
 */
export function serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).then(work, work)
  chains.set(id, next.catch(() => undefined))
  return next
}

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
 * A row written before `failedStage` existed has no such property at all, so
 * `unstorage` hands it back `undefined` rather than `null`. The type declares
 * the field always present, and both retry routes compare it against a
 * specific stage string — `undefined` matches neither, so an old `failed`
 * meeting would satisfy no retry condition and get stuck forever. Coercing on
 * read treats "never had the field" the same as "explicitly null", which is
 * what it actually means.
 */
function normalize(meeting: Meeting): Meeting {
  return { ...meeting, failedStage: meeting.failedStage ?? null }
}

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
      return serialize(input.id, async () => {
        const now = new Date().toISOString()
        const meeting: Meeting = { ...input, createdAt: now, updatedAt: now }
        await (await storage()).setItem<Meeting>(meetingKey(meeting.id), meeting)
        return meeting
      })
    },

    async get(id) {
      return serialize(id, async () => {
        const found = await (await storage()).getItem<Meeting>(meetingKey(id))
        return found ? normalize(found) : null
      })
    },

    async list({ limit }) {
      const s = await storage()
      const keys = await s.getKeys('meetings')
      const items = await s.getItems<Meeting>(keys)
      return items
        .map(i => i.value)
        .filter((m): m is Meeting => !!m)
        .map(normalize)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
    },

    async update(id, patch: MeetingPatch) {
      return serialize(id, async () => {
        const s = await storage()
        const found = await s.getItem<Meeting>(meetingKey(id))
        if (!found) return null
        const next: Meeting = { ...normalize(found), ...patch, updatedAt: new Date().toISOString() }
        await s.setItem<Meeting>(meetingKey(id), next)
        return next
      })
    },

    async claim(id, from, patch: MeetingPatch, expectedUpdatedAt) {
      return serialize(id, async () => {
        const s = await storage()
        const found = await s.getItem<Meeting>(meetingKey(id))
        if (!found || found.status !== from) return null
        if (expectedUpdatedAt !== undefined && found.updatedAt !== expectedUpdatedAt) return null
        const next: Meeting = { ...normalize(found), ...patch, updatedAt: new Date().toISOString() }
        await s.setItem<Meeting>(meetingKey(id), next)
        return next
      })
    },
  }
}
