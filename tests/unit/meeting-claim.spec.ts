import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import type { NewMeeting } from '../../server/utils/db/meetings'

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-claim-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

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
})

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
})
