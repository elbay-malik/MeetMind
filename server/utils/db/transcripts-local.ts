import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { TranscriptSegment } from '#shared/types/meeting'
import { serialize } from './local'
import type { TranscriptRepository } from './transcripts'

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

const transcriptKey = (meetingId: string) => `transcripts/${meetingId}`

/** JSON-file transcripts under `<dataDir>/db/` for development and tests. */
export function createLocalTranscriptRepository(options: { dataDir: string }): TranscriptRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async replaceForMeeting(meetingId, segments) {
      // One file per meeting, so replacing is atomic here in a way the
      // PostgREST driver cannot be. Still queued behind the shared per-id
      // chain (see local.ts's own docstring on `serialize`): summarize.post.ts
      // reads a meeting's transcript before it has claimed the meeting, so a
      // concurrent replaceForMeeting (a re-transcription attempt racing an
      // extraction request for the same meeting) is a real, not hypothetical,
      // way for a read here to land mid-write without this queue.
      await serialize(meetingId, async () => {
        await (await storageFor(base)).setItem<TranscriptSegment[]>(transcriptKey(meetingId), segments)
      })
    },

    async deleteForMeeting(meetingId) {
      await serialize(meetingId, async () => {
        await (await storageFor(base)).removeItem(transcriptKey(meetingId))
      })
    },

    async listForMeeting(meetingId) {
      return serialize(meetingId, async () => {
        const stored = await (await storageFor(base)).getItem<TranscriptSegment[]>(transcriptKey(meetingId))
        return stored ?? []
      })
    },
  }
}
