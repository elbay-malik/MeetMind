import { describe, expect, it } from 'vitest'
import type { Meeting } from '#shared/types/meeting'
import { audioObjectKey } from '#shared/utils/meeting'
import type { MeetingRepository } from '../../server/utils/db/meetings'
import type { PipelineRun } from '../../server/utils/db/pipeline'
import {
  CHANGED_RETRY_AFTER_SEC,
  deleteMeeting,
  DeletionIncompleteError,
  deletionBlocker,
  INDEXING_RETRY_AFTER_SEC,
  UPLOAD_GRACE_SEC,
} from '../../server/utils/meeting-deletion'
import { UPLOAD_URL_TTL_SEC } from '../../server/utils/storage-budget'

const MIN = 60_000
const createdAt = Date.parse('2026-01-01T12:00:00.000Z')
const uploadWindowEnds = createdAt + 30 * MIN

const meeting = (
  status: Meeting['status'],
  updatedAt: number = createdAt,
): Pick<Meeting, 'status' | 'createdAt' | 'updatedAt'> => ({
  status,
  createdAt: new Date(createdAt).toISOString(),
  updatedAt: new Date(updatedAt).toISOString(),
})

describe('deletionBlocker', () => {
  // The window is spelled out as 30 minutes in the tests below rather than
  // derived from the constants, so that shortening either constant (and with
  // it the protection against a late PUT landing after the delete) fails here
  // instead of quietly moving every expectation along with it.
  it('treats an upload URL as live for its TTL plus the grace period, 30 minutes', () => {
    expect((UPLOAD_URL_TTL_SEC + UPLOAD_GRACE_SEC) * 1000).toBe(30 * MIN)
  })

  describe('upload window', () => {
    // An upload URL stays usable whatever the meeting's status, so even a
    // meeting that is already 'ready' (a fast pipeline) or never got past
    // 'uploaded' must wait: a PUT replayed after the delete would store audio
    // no row tracks.
    it.each(['uploaded', 'transcribing', 'indexing', 'summarizing', 'ready', 'failed'] as const)(
      'blocks a fresh %s meeting until the window closes',
      (status) => {
        const blocker = deletionBlocker(meeting(status), createdAt + 5 * MIN)
        expect(blocker).not.toBeNull()
        expect(blocker!.retryAfterSec).toBe(25 * 60)
      },
    )

    // Retry-After is whole seconds; rounding down would invite a retry that
    // is still a millisecond early and gets a second 409.
    it('rounds the retry delay up to a whole second', () => {
      expect(deletionBlocker(meeting('ready'), uploadWindowEnds - 1)?.retryAfterSec).toBe(1)
      expect(deletionBlocker(meeting('ready'), uploadWindowEnds - 1001)?.retryAfterSec).toBe(2)
    })

    it('still blocks one millisecond before the window ends', () => {
      expect(deletionBlocker(meeting('uploaded'), uploadWindowEnds - 1)).not.toBeNull()
    })

    it('allows the delete exactly when the window ends', () => {
      expect(deletionBlocker(meeting('uploaded'), uploadWindowEnds)).toBeNull()
    })

    // Statuses with no claim to protect have nothing else holding them back
    // once the upload URL is dead.
    it.each(['uploaded', 'ready', 'failed', 'summarizing'] as const)(
      'allows a %s meeting just past the window',
      (status) => {
        expect(deletionBlocker(meeting(status), uploadWindowEnds + 1000)).toBeNull()
      },
    )
  })

  describe('live claims', () => {
    // Past the upload window, so only the claim can be what blocks.
    const now = uploadWindowEnds + 60 * MIN

    // Transcription runs in short steps under their own leases too (ADR-0012,
    // step 7). Its old 15-minute status lease kept a paused run undeletable.
    it('allows a transcribing meeting with no live step, however recently it moved', () => {
      expect(deletionBlocker(meeting('transcribing', now - 1000), now)).toBeNull()
    })

    it('blocks a transcribing meeting while a step of it is live', () => {
      const blocker = deletionBlocker(meeting('transcribing', now - 1000), now, [{ stepLeaseUntil: new Date(now + 90_000) }])
      expect(blocker).toMatchObject({ retryAfterSec: 90 })
    })

    // Extraction runs in short steps under their own leases (ADR-0012), read
    // from the run ledger below. Between steps nothing holds an `indexing`
    // meeting, so its status alone -- even a moment old -- blocks nothing. The
    // old 4 h status lease kept a paused extraction undeletable for hours.
    it('allows an indexing meeting with no live step, however recently it moved', () => {
      expect(deletionBlocker(meeting('indexing', now - 1), now)).toBeNull()
    })
  })
})

describe('deletionBlocker and pipeline step leases (ADR-0012)', () => {
  const later = uploadWindowEnds + 60 * MIN
  const lease = (until: number | null) => ({ stepLeaseUntil: until === null ? null : new Date(until) })

  it('refuses while any stage holds a live step lease, until that lease ends', () => {
    const blocker = deletionBlocker(meeting('ready'), later, [lease(null), lease(later + 90_500)])
    expect(blocker?.reason).toMatch(/pipeline step is running/)
    expect(blocker?.retryAfterSec).toBe(91)
  })

  it('waits for the latest of several live leases', () => {
    expect(deletionBlocker(meeting('ready'), later, [lease(later + 10_000), lease(later + 70_000)])?.retryAfterSec).toBe(70)
  })

  // Parked between steps: a run waiting for its next slot holds no lease, and
  // must not make a meeting undeletable for as long as the wait lasts.
  it('lets a run parked between steps be deleted', () => {
    expect(deletionBlocker(meeting('ready'), later, [lease(null)])).toBeNull()
  })

  it('treats a lease that has run out as abandoned', () => {
    expect(deletionBlocker(meeting('ready'), later, [lease(later)])).toBeNull()
  })
})

describe('deleteMeeting', () => {
  const id = 'm-1'
  // Past the upload window and with no claim, so deletionBlocker lets it
  // through and only the branch under test decides the outcome.
  const later = uploadWindowEnds + 60 * MIN
  // Deliberately not audioObjectKey(id): the found path must use the key the
  // row records, and only the not-found path may fall back to the derived one.
  const rowAudioKey = 'custom/m-1/recording.ogg'

  const row = (overrides: Partial<Meeting> = {}): Meeting => ({
    id,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt + 10 * MIN).toISOString(),
    title: 'Standup',
    status: 'ready',
    sourceFileName: 'standup.m4a',
    sourceBytes: 1000,
    sourceMime: 'audio/mp4',
    durationSec: 60,
    audioKey: rowAudioKey,
    audioBytes: 500,
    audioMime: 'audio/ogg',
    uploadedAt: new Date(createdAt + MIN).toISOString(),
    errorMessage: null,
    failedStage: null,
    ...overrides,
  })

  interface Harness {
    meetings: MeetingRepository
    deleteCalls: Array<{ id: string, expected: Pick<Meeting, 'status' | 'updatedAt'> }>
    removeCalls: Array<{ meetingId: string, audioKey: string }>
    indexingRuns: Map<string, Promise<unknown>>
    deps: Parameters<typeof deleteMeeting>[1]
  }

  // Only get and delete matter to deleteMeeting; everything else throws, so a
  // future change that starts depending on another method fails loudly here
  // instead of passing against a stub that silently returns undefined.
  function harness(options: {
    stored?: Meeting | null
    deleteResult?: 'row' | 'null'
    onDelete?: (h: Harness) => void
    removeData?: (meetingId: string, audioKey: string) => Promise<void>
    runs?: PipelineRun[]
    now?: number
  } = {}): Harness {
    const stored = options.stored === undefined ? row() : options.stored
    const unused = () => {
      throw new Error('not used by deleteMeeting')
    }
    const h = {
      deleteCalls: [],
      removeCalls: [],
      indexingRuns: new Map(),
    } as unknown as Harness
    h.meetings = {
      kind: 'local',
      create: unused,
      list: unused,
      update: unused,
      claim: unused,
      storedAudioBytes: unused,
      // A copy, so a test can tell whether delete was handed exactly what get
      // returned rather than an object the code under test rebuilt.
      get: async () => (stored ? { ...stored } : null),
      delete: async (deleteId, expected) => {
        h.deleteCalls.push({ id: deleteId, expected: { status: expected.status, updatedAt: expected.updatedAt } })
        options.onDelete?.(h)
        return options.deleteResult === 'null' || !stored ? null : { ...stored }
      },
    }
    h.deps = {
      meetings: h.meetings,
      pipeline: { listRuns: async () => options.runs ?? [] },
      removeData: async (meetingId, audioKey) => {
        h.removeCalls.push({ meetingId, audioKey })
        await options.removeData?.(meetingId, audioKey)
      },
      indexingRuns: h.indexingRuns,
      now: () => options.now ?? later,
    }
    return h
  }

  function deferred() {
    let resolve!: () => void
    let reject!: (err: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  // Lets every already-queued continuation run, so "not called yet" is
  // asserted after deleteMeeting has had every chance to get there.
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  it('deletes the row, then removes its data under the key the row records', async () => {
    const h = harness()
    await expect(deleteMeeting(id, h.deps)).resolves.toEqual({ kind: 'deleted' })
    expect(h.deleteCalls).toHaveLength(1)
    expect(h.removeCalls).toEqual([{ meetingId: id, audioKey: rowAudioKey }])
  })

  // A delete that removed the row and then failed partway leaves data with no
  // row pointing at it. Repeating the request is how it is finished, so a
  // missing row must still sweep, under the key the object would have had.
  it('still sweeps leftovers under the derived audio key when the row is gone', async () => {
    const h = harness({ stored: null })
    await expect(deleteMeeting(id, h.deps)).resolves.toEqual({ kind: 'not-found' })
    expect(h.removeCalls).toEqual([{ meetingId: id, audioKey: audioObjectKey(id) }])
    expect(h.deleteCalls).toHaveLength(0)
  })

  // A live upload URL can still land bytes; deleting now would store audio no
  // row tracks. The refusal must happen before anything is removed.
  it('refuses while deletionBlocker objects, deleting nothing', async () => {
    const now = createdAt + 5 * MIN
    const h = harness({ now })
    const outcome = await deleteMeeting(id, h.deps)
    expect(outcome).toMatchObject({ kind: 'blocked', retryAfterSec: 25 * 60 })
    expect(outcome).toMatchObject({ retryAfterSec: deletionBlocker(row(), now)!.retryAfterSec })
    expect(h.deleteCalls).toHaveLength(0)
    expect(h.removeCalls).toHaveLength(0)
  })

  it('refuses while a pipeline step holds a live lease, deleting nothing', async () => {
    const runs: PipelineRun[] = [{
      stage: 'summarization', runId: 'r', cursor: {}, attempts: 1, lastError: null, retryAt: null,
      stepLeaseUntil: new Date(later + 30_000),
    }]
    const h = harness({ runs })
    const outcome = await deleteMeeting(id, h.deps)
    expect(outcome).toMatchObject({ kind: 'blocked', retryAfterSec: 30 })
    expect(h.deleteCalls).toHaveLength(0)
    expect(h.removeCalls).toHaveLength(0)
  })

  // The ledger is read AFTER the meeting. A step claimed between the two reads
  // is then seen by the ledger read; one claimed after both moves updatedAt,
  // which the fenced delete catches. Read the other way round, a claim landing
  // between them would be seen by neither.
  it('reads the step leases after the meeting row, so a claim between the two reads is seen', async () => {
    const h = harness()
    const order: string[] = []
    const get = h.meetings.get
    h.deps.meetings = { ...h.meetings, get: async (mid) => {
      order.push('meeting')
      return get(mid)
    } }
    h.deps.pipeline = { listRuns: async () => {
      order.push('runs')
      return [{ stage: 'summarization', runId: 'r', cursor: {}, attempts: 1, lastError: null, retryAt: null, stepLeaseUntil: new Date(later + 60_000) }]
    } }
    expect(await deleteMeeting(id, h.deps)).toMatchObject({ kind: 'blocked' })
    expect(order).toEqual(['meeting', 'runs'])
  })

  // Indexing holds no claim deletionBlocker can see on a 'ready' row, so the
  // in-process registry is the only thing standing between a running embed
  // and windows written back after the delete.
  it('refuses while an indexing run is already in flight, deleting nothing', async () => {
    const h = harness()
    // Already settled, so that if the check were dropped the late-run wait
    // would not hang the test: it fails on the assertions instead.
    h.indexingRuns.set(id, Promise.resolve())
    const outcome = await deleteMeeting(id, h.deps)
    expect(outcome).toMatchObject({ kind: 'blocked', retryAfterSec: INDEXING_RETRY_AFTER_SEC })
    expect(h.deleteCalls).toHaveLength(0)
    expect(h.removeCalls).toHaveLength(0)
  })

  // The fenced delete lost: the row changed after it was read (e.g. a claim
  // landed). Its data now belongs to work in progress and must be left alone.
  it('refuses when the fenced delete finds the row changed, leaving the data alone', async () => {
    const stored = row({ status: 'failed', updatedAt: new Date(createdAt + 20 * MIN).toISOString() })
    const h = harness({ stored, deleteResult: 'null' })
    const outcome = await deleteMeeting(id, h.deps)
    expect(outcome).toMatchObject({ kind: 'blocked', retryAfterSec: CHANGED_RETRY_AFTER_SEC })
    // The fence is only as good as what it is fenced on: exactly the row as read.
    expect(h.deleteCalls).toEqual([{ id, expected: { status: 'failed', updatedAt: stored.updatedAt } }])
    expect(h.removeCalls).toHaveLength(0)
  })

  describe('an indexing run registered after the in-flight check', () => {
    // The race the late-run wait exists for: a run registered between the
    // check and the row's removal would write its windows after removeData
    // cleared them. Registering it from inside the fake delete puts it in
    // exactly that gap.
    it('is awaited before the data is removed', async () => {
      const run = deferred()
      const h = harness({ onDelete: hh => hh.indexingRuns.set(id, run.promise) })
      const pending = deleteMeeting(id, h.deps)
      await settle()
      expect(h.deleteCalls).toHaveLength(1)
      expect(h.removeCalls).toHaveLength(0)

      run.resolve()
      await expect(pending).resolves.toEqual({ kind: 'deleted' })
      expect(h.removeCalls).toEqual([{ meetingId: id, audioKey: rowAudioKey }])
    })

    // On Supabase the late run fails on the foreign key once the row is gone;
    // that failure is expected and must not abort the cleanup.
    it('is awaited even when it rejects, and the cleanup still runs', async () => {
      const run = deferred()
      const h = harness({ onDelete: hh => hh.indexingRuns.set(id, run.promise) })
      const pending = deleteMeeting(id, h.deps)
      await settle()
      expect(h.removeCalls).toHaveLength(0)

      run.reject(new Error('foreign key violation'))
      await expect(pending).resolves.toEqual({ kind: 'deleted' })
      expect(h.removeCalls).toEqual([{ meetingId: id, audioKey: rowAudioKey }])
    })

    // The sweep after a failed delete removes windows too, so a run that read
    // the row before it went would write them straight back after the sweep.
    it('is awaited before sweeping leftovers of a row that is already gone', async () => {
      const run = deferred()
      const h = harness({ stored: null })
      h.indexingRuns.set(id, run.promise)
      const pending = deleteMeeting(id, h.deps)
      await settle()
      expect(h.removeCalls).toHaveLength(0)

      run.resolve()
      await expect(pending).resolves.toEqual({ kind: 'not-found' })
      expect(h.removeCalls).toEqual([{ meetingId: id, audioKey: audioObjectKey(id) }])
    })
  })

  // The route turns DeletionIncompleteError into "repeat the request"; any
  // other error would be a bare 500 with no hint that a retry finishes it.
  describe('when removing the data fails', () => {
    const failure = new Error('R2 unavailable')
    const failing = async () => {
      throw failure
    }

    it('throws DeletionIncompleteError carrying the cause after the row is deleted', async () => {
      const h = harness({ removeData: failing })
      const err = await deleteMeeting(id, h.deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeletionIncompleteError)
      expect((err as DeletionIncompleteError).cause).toBe(failure)
      expect(h.deleteCalls).toHaveLength(1)
    })

    it('throws DeletionIncompleteError carrying the cause when sweeping a missing row', async () => {
      const h = harness({ stored: null, removeData: failing })
      const err = await deleteMeeting(id, h.deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeletionIncompleteError)
      expect((err as DeletionIncompleteError).cause).toBe(failure)
    })
  })
})
