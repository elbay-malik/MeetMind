import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { MeetingSummary } from '#shared/types/meeting'
import type { SummaryRepository } from './summaries'

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

const summaryKey = (meetingId: string) => `summaries/${meetingId}`

/** JSON-file summaries under `<dataDir>/db/` for development and tests. */
export function createLocalSummaryRepository(options: { dataDir: string }): SummaryRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async replaceForMeeting(meetingId, summary) {
      // One file per meeting, so replacing is atomic here in a way the
      // PostgREST driver cannot be.
      await (await storageFor(base)).setItem<MeetingSummary>(summaryKey(meetingId), summary)
    },

    async getForMeeting(meetingId) {
      return (await (await storageFor(base)).getItem<MeetingSummary>(summaryKey(meetingId))) ?? null
    },
  }
}
