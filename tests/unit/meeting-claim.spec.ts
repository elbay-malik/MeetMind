import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import type { NewMeeting } from '../../server/utils/db/meetings'

/**
 * Writes a row straight to the JSON store, bypassing repo.create() (and the
 * validation it now runs) entirely -- what a genuine legacy row looks like:
 * written by a version of this repository that predates both the
 * failedStage field and today's status/failedStage pairing check.
 */
async function writeLegacyRow(id: string, row: Record<string, unknown>): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`meetings/${id}`, row)
}

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-claim-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

// Deliberately missing `failedStage`, even though `NewMeeting` declares it:
// this stands in for a row written before that column/field existed, which
// is exactly what the "legacy row" test below needs.
const newMeeting = (id: string): NewMeeting => ({
  id,
  title: 'claim test',
  status: 'uploaded',
  sourceFileName: 'a.mp4',
  sourceBytes: 1,
  sourceMime: null,
  durationSec: null,
  audioKey: `meetings/${id}/audio.ogg`,
  audioBytes: 10,
  audioMime: 'audio/ogg',
  uploadedAt: null,
  errorMessage: null,
} as NewMeeting)

describe('claim', () => {
  it('moves the meeting when it is in the expected state', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('a1'))
    const claimed = await repo.claim('a1', 'uploaded', { status: 'transcribing' })
    expect(claimed?.status).toBe('transcribing')
  })

  it('refuses when the meeting is in a different state', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('a2'))
    await repo.update('a2', { status: 'failed', failedStage: 'transcription' })
    expect(await repo.claim('a2', 'uploaded', { status: 'transcribing' })).toBeNull()
  })

  it('refuses for a meeting that does not exist', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    expect(await repo.claim('missing', 'uploaded', { status: 'transcribing' })).toBeNull()
  })

  it('lets exactly one of many concurrent callers win', async () => {
    // The whole point: a read-then-write would let all ten through, and each
    // would go on to spend the transcription quota.
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('a3'))
    const results = await Promise.all(
      Array.from({ length: 10 }, () => repo.claim('a3', 'uploaded', { status: 'transcribing' })),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await repo.get('a3'))?.status).toBe('transcribing')
  })

  it('serializes claims across separate repository instances on the same directory', async () => {
    const a = createLocalMeetingRepository({ dataDir })
    const b = createLocalMeetingRepository({ dataDir })
    await a.create(newMeeting('a4'))
    const [first, second] = await Promise.all([
      a.claim('a4', 'uploaded', { status: 'transcribing' }),
      b.claim('a4', 'uploaded', { status: 'transcribing' }),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('treats a legacy row with no failedStage field as null, not undefined', async () => {
    // A row written before failedStage existed has no such property at all.
    // Both retry routes compare it against a specific stage string, which
    // undefined would never match — a stuck-forever meeting if this leaked.
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('a5'))
    expect(await repo.get('a5')).toMatchObject({ failedStage: null })
    expect((await repo.list({ limit: 10 })).find(m => m.id === 'a5')).toMatchObject({ failedStage: null })
    expect(await repo.update('a5', { title: 'renamed' })).toMatchObject({ failedStage: null })
    expect(await repo.claim('a5', 'uploaded', { status: 'transcribing' })).toMatchObject({ failedStage: null })
  })

  it('defaults a legacy FAILED row with no failedStage field to transcription, not null', async () => {
    // null would still leave it stuck: both retry routes compare failedStage
    // against a specific stage string ('transcription'/'summarization'), and
    // null matches neither — coercing missing-to-null only fixes the type,
    // not the actual "can this ever be retried" question. Summarisation did
    // not exist when the oldest such rows could have been written, matching
    // the Supabase migration's own backfill for this same shape.
    const repo = createLocalMeetingRepository({ dataDir })
    const now = new Date().toISOString()
    await writeLegacyRow('a7', {
      ...newMeeting('a7'), status: 'failed', errorMessage: 'boom', createdAt: now, updatedAt: now,
    })
    expect(await repo.get('a7')).toMatchObject({ failedStage: 'transcription' })
  })

  it('refuses a write whose fencing token no longer matches the row, even though status still does', async () => {
    // The exact shape a stale-lease reclaim produces: status goes back to the
    // same value it already had, but updatedAt moves. A caller whose own
    // claim predates that reclaim must not still be able to write, or two
    // workers can each believe they alone hold the meeting.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const repo = createLocalMeetingRepository({ dataDir })
      await repo.create(newMeeting('a6'))
      const first = await repo.claim('a6', 'uploaded', { status: 'transcribing' })
      expect(first).not.toBeNull()

      vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'))
      const reclaimed = await repo.claim('a6', 'transcribing', { status: 'transcribing' })
      expect(reclaimed?.updatedAt).not.toBe(first!.updatedAt)

      vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'))
      const stale = await repo.claim('a6', 'transcribing', { status: 'summarizing' }, first!.updatedAt)
      expect(stale).toBeNull()
      expect((await repo.get('a6'))?.status).toBe('transcribing')

      const legitimate = await repo.claim('a6', 'transcribing', { status: 'summarizing' }, reclaimed!.updatedAt)
      expect(legitimate?.status).toBe('summarizing')
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('status/failedStage pairing', () => {
  // meetings_failed_stage_matches_status (the failed_stage migration) rejects
  // exactly these combinations in Supabase. Before assertValidStatusPatch /
  // assertValidNewMeeting existed, the local driver had no such check and
  // silently wrote the invalid row instead -- these two existing test
  // fixtures did precisely that (see git history on this file) until they
  // were fixed alongside the validation itself.

  it('refuses to update a meeting to failed without a failedStage', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b1'))
    await expect(repo.update('b1', { status: 'failed' })).rejects.toThrow(/failedStage/)
  })

  it('refuses to claim a meeting into failed without a failedStage', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b2'))
    await expect(repo.claim('b2', 'uploaded', { status: 'failed' })).rejects.toThrow(/failedStage/)
  })

  it('refuses to pair a non-failed status with a failedStage', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b3'))
    await expect(
      repo.update('b3', { status: 'transcribing', failedStage: 'transcription' }),
    ).rejects.toThrow(/failedStage/)
  })

  it('refuses to create a meeting whose status and failedStage disagree', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await expect(
      repo.create({ ...newMeeting('b4'), status: 'failed', errorMessage: 'boom', failedStage: null }),
    ).rejects.toThrow(/failedStage/)
  })

  it('accepts a patch that pairs failed with a failedStage', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b5'))
    const updated = await repo.update('b5', { status: 'failed', failedStage: 'transcription', errorMessage: 'boom' })
    expect(updated).toMatchObject({ status: 'failed', failedStage: 'transcription' })
  })

  it('refuses a patch that moves status out of failed without clearing the stage', async () => {
    // The gap the patch-level check structurally cannot see: this patch is
    // internally consistent — no `failed`, no stage — but a partial update
    // leaves failed_stage alone, so the ROW it produces is the pairing
    // meetings_failed_stage_matches_status forbids. Postgres judges the merged
    // row; the local driver used to judge only the patch, and so accepted a
    // row Supabase would have rejected. complete.post.ts is a real caller that
    // writes exactly this shape.
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b7'))
    await repo.update('b7', { status: 'failed', failedStage: 'transcription', errorMessage: 'boom' })
    await expect(repo.update('b7', { status: 'uploaded' })).rejects.toThrow(/failedStage/)
    // And the same through claim(), which has its own merge.
    await expect(repo.claim('b7', 'failed', { status: 'uploaded' })).rejects.toThrow(/failedStage/)
    // The row is untouched by the refusal, not half-written.
    expect(await repo.get('b7')).toMatchObject({ status: 'failed', failedStage: 'transcription' })
  })

  it('accepts the same move when the stage is cleared alongside it', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b8'))
    await repo.update('b8', { status: 'failed', failedStage: 'transcription', errorMessage: 'boom' })
    expect(await repo.update('b8', { status: 'uploaded', failedStage: null }))
      .toMatchObject({ status: 'uploaded', failedStage: null })
  })

  it('does not validate a patch that never touches status', async () => {
    // Nothing in this repository sets failedStage without also setting
    // status in the same patch, so a patch that only touches unrelated
    // fields is left unchecked rather than guessed at against a current row
    // neither driver's update()/claim() is handed here.
    const repo = createLocalMeetingRepository({ dataDir })
    await repo.create(newMeeting('b6'))
    await expect(repo.update('b6', { title: 'renamed' })).resolves.toMatchObject({ title: 'renamed' })
  })
})
