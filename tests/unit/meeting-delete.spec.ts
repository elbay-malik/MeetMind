import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import type { NewMeeting } from '../../server/utils/db/meetings'

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-delete-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const newMeeting = (id: string): NewMeeting => ({
  id,
  title: 'delete test',
  status: 'ready',
  sourceFileName: 'a.mp4',
  sourceBytes: 1,
  sourceMime: null,
  durationSec: null,
  audioKey: `meetings/${id}/audio.ogg`,
  audioBytes: 10,
  audioMime: 'audio/ogg',
  uploadedAt: null,
  errorMessage: null,
  failedStage: null,
})

describe('delete (local driver)', () => {
  // The same fence the Supabase driver puts in its WHERE clause. The route
  // decides a meeting is safe to delete from a read; these tests pin that the
  // local driver, too, refuses when the row is no longer the one that was read.

  it('removes the row when status and updatedAt both still match', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    const created = await repo.create(newMeeting('d1'))
    const deleted = await repo.delete('d1', { status: created.status, updatedAt: created.updatedAt })
    expect(deleted).toMatchObject({ id: 'd1', status: 'ready' })
    expect(await repo.get('d1')).toBeNull()
    expect((await repo.list({ limit: 100 })).map(m => m.id)).not.toContain('d1')
  })

  it('refuses and keeps the row when the status has moved on', async () => {
    // A retry claimed the meeting between the route's read and its delete.
    const repo = createLocalMeetingRepository({ dataDir })
    const created = await repo.create({ ...newMeeting('d2'), status: 'uploaded' })
    await repo.claim('d2', 'uploaded', { status: 'transcribing' })
    expect(await repo.delete('d2', { status: 'uploaded', updatedAt: created.updatedAt })).toBeNull()
    expect(await repo.get('d2')).toMatchObject({ status: 'transcribing' })
  })

  it('refuses and keeps the row when only updatedAt has moved on', async () => {
    // A stale-lease reclaim leaves status exactly where it was and moves only
    // updatedAt; a status-only check would let this delete through.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const repo = createLocalMeetingRepository({ dataDir })
      const created = await repo.create(newMeeting('d3'))
      vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'))
      const touched = await repo.update('d3', { title: 'renamed' })
      expect(touched!.status).toBe(created.status)
      expect(touched!.updatedAt).not.toBe(created.updatedAt)

      expect(await repo.delete('d3', { status: created.status, updatedAt: created.updatedAt })).toBeNull()
      expect(await repo.get('d3')).toMatchObject({ title: 'renamed' })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('returns null for a meeting that does not exist', async () => {
    const repo = createLocalMeetingRepository({ dataDir })
    expect(await repo.delete('missing', { status: 'ready', updatedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })
})
