import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { TranscriptSegment } from '#shared/types/meeting'
import { serialize } from './local'
import {
  clampLimit,
  cosineSimilarity,
  type EmbeddedWindow,
  type IndexMarker,
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
// The ledger holds the marker, as one write with the cursor beside it, and the
// transcript repository holds the lines. Under the same base, read in this meeting's
// one queue.
const ledgerKey = (meetingId: string) => `pipeline/${meetingId}`
const transcriptKey = (meetingId: string) => `transcripts/${meetingId}`

/**
 * A transcript's fingerprint: not the same bytes `public.transcript_hash` hashes, since
 * each driver only ever compares its own, but the same thing noticed, and the hash of
 * nothing for a transcript with no lines.
 */
export async function hashTranscript(segments: readonly TranscriptSegment[]): Promise<string> {
  const lines = [...segments].sort((a, b) => a.idx - b.idx).map(s => JSON.stringify([s.idx, s.startMs, s.endMs, s.text]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n')))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

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

    async readState(meetingId, model) {
      return serialize(meetingId, async () => {
        const s = await storageFor(base)
        const windows = await read(meetingId)
        const segments = (await s.getItem<TranscriptSegment[]>(transcriptKey(meetingId))) ?? []
        const ledger = await s.getItem<{ indexMarker?: IndexMarker }>(ledgerKey(meetingId))
        return {
          marker: ledger?.indexMarker ?? null,
          transcriptHash: await hashTranscript(segments),
          segmentCount: segments.length,
          storedWindows: windows.length,
          storedForModel: windows.filter(w => w.model === model).length,
        }
      })
    },

    async listKeys(meetingId, range) {
      return serialize(meetingId, async () =>
        (await read(meetingId))
          .filter(w => !range || (w.idx >= range.from && w.idx <= range.to))
          .map(w => ({ idx: w.idx, contentHash: w.contentHash, model: w.model })))
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
