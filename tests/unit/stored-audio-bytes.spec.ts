import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { audioIsStored } from '../../server/utils/db/meetings'

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-stored-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const DAY = 86_400_000
const WINDOW = { retentionDays: 30, reservationSeconds: 900 }

function row(over: Partial<Meeting> & Pick<Meeting, 'audioKey' | 'audioBytes'>): Meeting {
  return {
    id: crypto.randomUUID(),
    createdAt: ago(DAY),
    updatedAt: ago(DAY),
    title: 'stored bytes',
    status: 'uploaded',
    sourceFileName: 'a.mp4',
    sourceBytes: 1,
    sourceMime: null,
    durationSec: null,
    audioMime: 'audio/ogg',
    uploadedAt: ago(DAY),
    errorMessage: null,
    failedStage: null,
    ...over,
  }
}

/**
 * The six cases below are the SAME six asserted against the SQL in
 * scripts/verify-migrations.sh. `audioIsStored` and
 * `public.stored_audio_bytes` are hand-written mirrors of each other -- the
 * local tier uses one, Supabase the other -- so a change to either that is not
 * made to both silently gives the two tiers different budgets. Keep the lists in
 * step; the last test in this file fails if the link between the files is lost.
 */
describe('audioIsStored', () => {
  it('counts a confirmed upload inside the retention window', () => {
    expect(audioIsStored(row({ audioKey: 'fresh', audioBytes: 1000 }), WINDOW, NOW)).toBe(true)
  })

  it('counts a failure that is not an upload failure, whose object is still there', () => {
    const m = row({ audioKey: 'later', audioBytes: 2000, status: 'failed', failedStage: 'transcription' })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(true)
  })

  it('excludes a rejected upload, whose object failMeetingUpload deleted', () => {
    // Exactly `uploadWasRejected` in shared/utils/meeting.ts.
    const m = row({ audioKey: 'rejected', audioBytes: 4000, status: 'failed', failedStage: 'upload' })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(false)
  })

  it('excludes an upload the bucket lifecycle rule has expired', () => {
    const m = row({ audioKey: 'expired', audioBytes: 8000, uploadedAt: ago(90 * DAY) })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(false)
    // ...and counts it again when there is no lifecycle rule at all.
    expect(audioIsStored(m, { ...WINDOW, retentionDays: 0 }, NOW)).toBe(true)
  })

  it('reserves a registration whose presigned PUT is still live', () => {
    // The point of reserving: without it, a burst of registrations all pass the
    // check and then all upload, each believing the store was empty.
    const m = row({ audioKey: 'reserved', audioBytes: 16_000, status: 'pending_upload', createdAt: ago(60_000), uploadedAt: null })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(true)
  })

  it('stops reserving a registration whose upload URL has expired', () => {
    const m = row({ audioKey: 'abandoned', audioBytes: 32_000, status: 'pending_upload', createdAt: ago(DAY), uploadedAt: null })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(false)
    // An abandoned registration must not inflate the total for ever, or the
    // budget closes permanently and no upload ever succeeds again.
    expect(audioIsStored(m, { ...WINDOW, reservationSeconds: 2 * 86_400 }, NOW)).toBe(true)
  })

  it('excludes a row that never recorded an upload time', () => {
    const m = row({ audioKey: 'no-time', audioBytes: 64_000, uploadedAt: null })
    expect(audioIsStored(m, WINDOW, NOW)).toBe(false)
  })
})

describe('local repository storedAudioBytes', () => {
  it('sums only the rows whose audio should still be in the store', async () => {
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    const rows = [
      row({ audioKey: 'fresh', audioBytes: 1000 }),
      row({ audioKey: 'later', audioBytes: 2000, status: 'failed', failedStage: 'transcription' }),
      row({ audioKey: 'rejected', audioBytes: 4000, status: 'failed', failedStage: 'upload' }),
      row({ audioKey: 'expired', audioBytes: 8000, uploadedAt: ago(90 * DAY) }),
      row({ audioKey: 'abandoned', audioBytes: 32_000, status: 'pending_upload', createdAt: ago(DAY), uploadedAt: null }),
    ]
    for (const r of rows) await storage.setItem(`meetings/${r.id}`, r)

    const repo = createLocalMeetingRepository({ dataDir })

    expect(await repo.storedAudioBytes(WINDOW)).toBe(3000)
  })

  it('returns 0 rather than NaN when nothing is stored', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'meetmind-stored-empty-'))
    try {
      const repo = createLocalMeetingRepository({ dataDir: empty })
      expect(await repo.storedAudioBytes(WINDOW)).toBe(0)
    }
    finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('the two implementations stay findable from each other', () => {
  it('cross-references the SQL and the TypeScript predicate by name', async () => {
    // Not a proof of equivalence -- nothing here can run the SQL. It only keeps
    // the two reachable from one another, so whoever edits one is told the other
    // exists. Equivalence is asserted case-by-case: this file for the
    // TypeScript, scripts/verify-migrations.sh for the SQL.
    const sqlPath = fileURLToPath(new URL(
      '../../supabase/migrations/20261023120000_stored_audio_bytes.sql', import.meta.url))
    const tsPath = fileURLToPath(new URL('../../server/utils/db/meetings.ts', import.meta.url))
    const [sql, ts] = await Promise.all([readFile(sqlPath, 'utf8'), readFile(tsPath, 'utf8')])

    expect(sql.length, 'could not read the migration').toBeGreaterThan(500)
    expect(ts).toContain('stored_audio_bytes')
    expect(sql).toContain('uploadWasRejected')
    expect(ts).toContain('uploadWasRejected')
  })
})
