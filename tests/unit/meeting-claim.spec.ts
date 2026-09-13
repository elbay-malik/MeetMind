import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import type { NewMeeting } from '../../server/utils/db/meetings'

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
    await repo.update('a2', { status: 'failed' })
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
