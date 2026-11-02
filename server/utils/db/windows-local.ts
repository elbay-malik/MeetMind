import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import { serialize } from './local'
import {
  clampLimit,
  cosineSimilarity,
  type EmbeddedWindow,
  type TranscriptIndexRepository,
} from './windows'

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

const windowsKey = (meetingId: string) => `windows/${meetingId}`

/** A similarity as an ordering key: NaN sorts as the worst possible value, matching pgvector. */
const rank = (similarity: number): number => (Number.isNaN(similarity) ? Number.NEGATIVE_INFINITY : similarity)

/**
 * JSON-file index under `<dataDir>/db/` for development and tests. One file per
 * meeting, searched by exact cosine similarity in memory — the same result the
 * SQL function returns, at a size where a scan is trivially cheap.
 *
 * Unlike the Supabase table, nothing here cascades when a meeting is deleted;
 * the delete route calls `deleteForMeeting` itself.
 */
export function createLocalTranscriptIndexRepository(options: { dataDir: string }): TranscriptIndexRepository {
  const base = join(options.dataDir, 'db')

  async function read(meetingId: string): Promise<EmbeddedWindow[]> {
    return (await (await storageFor(base)).getItem<EmbeddedWindow[]>(windowsKey(meetingId))) ?? []
  }
  async function write(meetingId: string, windows: EmbeddedWindow[]): Promise<void> {
    await (await storageFor(base)).setItem(windowsKey(meetingId), windows)
  }

  return {
    kind: 'local',

    async listKeys(meetingId) {
      return serialize(meetingId, async () =>
        (await read(meetingId)).map(w => ({ idx: w.idx, contentHash: w.contentHash, model: w.model })))
    },

    async upsertWindows(meetingId, windows) {
      if (windows.length === 0) return
      // Queued behind the shared per-meeting chain: read-modify-write, and a
      // meeting's worth of 1024-dimension vectors is exactly the payload size at
      // which a concurrent truncating write becomes observable.
      await serialize(meetingId, async () => {
        const byIdx = new Map((await read(meetingId)).map(w => [w.idx, w]))
        for (const window of windows) byIdx.set(window.idx, window)
        await write(meetingId, [...byIdx.values()].sort((a, b) => a.idx - b.idx))
      })
    },

    async deleteExcept(meetingId, keep) {
      await serialize(meetingId, async () => {
        const kept = new Set(keep)
        const current = await read(meetingId)
        const remaining = current.filter(w => kept.has(w.idx))
        if (remaining.length !== current.length) await write(meetingId, remaining)
      })
    },

    async deleteForMeeting(meetingId) {
      await serialize(meetingId, async () => {
        await (await storageFor(base)).removeItem(windowsKey(meetingId))
      })
    },

    async search(meetingId, query, { model, limit }) {
      const windows = await serialize(meetingId, () => read(meetingId))
      return windows
        .filter(w => w.model === model)
        .map(({ embedding, model: _model, ...window }) => ({
          ...window,
          similarity: cosineSimilarity(query, embedding),
        }))
        // NaN (a zero-norm window, see cosineSimilarity) must rank last, worse
        // than any real similarity including a genuinely negative one — the
        // same place pgvector puts it. Plain `b.similarity - a.similarity` does
        // not do this: once either side is NaN the subtraction is NaN too,
        // which `||` reads as falsy and falls through to the index tiebreak
        // instead, letting a zero-norm window rank ahead of a worse-but-real
        // one depending only on index order.
        .sort((a, b) => rank(b.similarity) - rank(a.similarity) || a.idx - b.idx)
        .slice(0, clampLimit(limit))
    },
  }
}
