import type { H3Event } from 'h3'
import type { Meeting } from '#shared/types/meeting'
import { audioObjectKey, whisperReplyKey } from '#shared/utils/meeting'
import { usePipelineRepository, useSummaryRepository, useTranscriptIndexRepository, useTranscriptRepository } from './db'
import type { MeetingRepository } from './db/meetings'
import { liveStepLease, type PipelineRepository, type PipelineRun } from './db/pipeline'
import { useAudioStore } from './storage'
import { UPLOAD_RESERVATION_SEC } from './storage-budget'

/** Retry-After for the one refusal with no deadline to count down to: a row that changed between the check and the delete. */
export const CHANGED_RETRY_AFTER_SEC = 1

/** Why a meeting cannot be deleted right now, and when to try again. */
export interface DeletionBlocker {
  reason: string
  retryAfterSec: number
}

/**
 * Whether something else may still write this meeting's data, so that deleting
 * it now would leave bytes or rows behind that nothing tracks.
 *
 * - **A live upload URL.** It stays usable for its whole lifetime whatever the
 *   meeting's status -- an R2 object is overwritable for as long as its presigned
 *   PUT lives, which is why every read re-checks the size. A PUT landing after
 *   the delete creates an object with no row, which the storage budget cannot
 *   see and only the bucket's lifecycle rule would ever remove. Measured from
 *   `createdAt`, which is written just AFTER the URL is minted, so it can only
 *   overestimate the URL's life.
 * - **A live pipeline step** (ADR-0012). A step writes its result back when it
 *   finishes, fenced on its token; the cascade would make that write match
 *   nothing on Supabase, but a step part-way through a provider call has
 *   already spent the quota for a result that would be thrown away. A run
 *   parked between steps holds no lease and does not block: a `transcribing` or
 *   `indexing` meeting that is paused is deletable.
 */
export function deletionBlocker(
  meeting: Pick<Meeting, 'createdAt'>,
  now: number = Date.now(),
  runs: readonly Pick<PipelineRun, 'stepLeaseUntil'>[] = [],
): DeletionBlocker | null {
  const uploadWindowEnds = Date.parse(meeting.createdAt) + UPLOAD_RESERVATION_SEC * 1000
  if (now < uploadWindowEnds) {
    return {
      reason: 'Its upload URL may still be in use, and audio uploaded after the delete would be stored untracked',
      retryAfterSec: Math.ceil((uploadWindowEnds - now) / 1000),
    }
  }

  const stepLease = liveStepLease(runs, now)
  if (stepLease) {
    return {
      reason: 'A pipeline step is running, and it would write its result back after the delete',
      retryAfterSec: Math.ceil((stepLease.getTime() - now) / 1000),
    }
  }

  return null
}

/**
 * Remove everything stored for a meeting other than its row: the audio object,
 * the raw Whisper reply if one is still there, and the transcript, summary and
 * search windows.
 *
 * Every step is idempotent, so this is also how a delete that failed partway is
 * finished: the route runs it again even when the row is already gone, using
 * the key the object would have had.
 *
 * Audio first. It is the only part that costs money for as long as it exists,
 * and once the row is gone the storage budget no longer counts it.
 */
export async function removeMeetingData(event: H3Event, meetingId: string, audioKey: string): Promise<void> {
  const store = useAudioStore(event)
  const rows = {
    pipeline: usePipelineRepository(event),
    index: useTranscriptIndexRepository(event),
    summaries: useSummaryRepository(event),
    transcripts: useTranscriptRepository(event),
  }
  await removeObjectsWith(store, meetingId, audioKey)
  await removeRowsWith(rows, meetingId)
}

/** The bucket's half of {@link removeMeetingData}. A key already gone is not a failure, so it can be repeated. */
export async function removeObjectsWith(
  store: { delete: (key: string) => Promise<void> },
  meetingId: string,
  audioKey: string,
): Promise<void> {
  await store.delete(audioKey)
  await store.delete(whisperReplyKey(meetingId))
}

/** The database's half of {@link removeMeetingData}, with what it needs already chosen. */
export async function removeRowsWith(
  deps: {
    pipeline: Pick<PipelineRepository, 'deleteForMeeting'>
    index: { deleteForMeeting: (meetingId: string) => Promise<void> }
    summaries: { deleteForMeeting: (meetingId: string) => Promise<void> }
    transcripts: { deleteForMeeting: (meetingId: string) => Promise<void> }
  },
  meetingId: string,
): Promise<void> {
  await deps.pipeline.deleteForMeeting(meetingId)
  await deps.index.deleteForMeeting(meetingId)
  await deps.summaries.deleteForMeeting(meetingId)
  await deps.transcripts.deleteForMeeting(meetingId)
}

export type DeletionOutcome
  = | { kind: 'deleted' }
    | { kind: 'not-found' }
    | { kind: 'blocked', reason: string, retryAfterSec: number }

export interface DeletionDeps {
  meetings: MeetingRepository
  /** The run ledger, for the step leases {@link deletionBlocker} reads. */
  pipeline: Pick<PipelineRepository, 'listRuns'>
  /** {@link removeMeetingData}, bound to the request. */
  removeData: (meetingId: string, audioKey: string) => Promise<void>
  /**
   * For a caller that nobody can repeat: the objects, once nothing blocks the delete and before
   * the row goes, so that a failure leaves the row to choose the meeting by next time. This gives
   * up the fence's promise for the objects, so it is only for a meeting past keeping (ADR-0017).
   * A failure here is the failure itself, with nothing yet deleted that cannot be found again.
   */
  removeObjectsFirst?: (meetingId: string, audioKey: string) => Promise<void>
  now?: () => number
}

/**
 * Removing a meeting's stored data failed, with its row already gone (or never
 * found). Repeating the delete finishes it, which is what the route tells the
 * caller.
 */
export class DeletionIncompleteError extends Error {
  constructor(override readonly cause: unknown) {
    super('The meeting row was deleted but some of its stored data could not be removed')
    this.name = 'DeletionIncompleteError'
  }
}

/**
 * Delete a meeting and everything stored for it, or say why not (ADR-0011).
 * Separate from the route so every branch can be driven with fakes; the route
 * only maps the outcome to HTTP.
 *
 * Throws {@link DeletionIncompleteError} when the row went but the cleanup
 * after it did not finish.
 */
export async function deleteMeeting(id: string, deps: DeletionDeps): Promise<DeletionOutcome> {
  const now = deps.now ?? Date.now
  const meeting = await deps.meetings.get(id)
  if (!meeting) {
    // Possibly an earlier delete that removed the row and then failed partway
    // through the rest. Finish it: every step is idempotent and the audio key
    // follows from the id.
    await removeOrExplain(deps, id, audioObjectKey(id))
    return { kind: 'not-found' }
  }

  // Read after the meeting: a step claimed in between moves its updatedAt,
  // so the fenced delete below refuses it even though this read missed it.
  const blocker = deletionBlocker(meeting, now(), await deps.pipeline.listRuns(id))
  if (blocker) return { kind: 'blocked', ...blocker }

  await deps.removeObjectsFirst?.(id, meeting.audioKey)

  // The row before the data. Fenced on the row as read above, so a claim that
  // landed since then leaves nothing to delete -- and nothing of a meeting that
  // is still in use gets removed.
  const deleted = await deps.meetings.delete(id, meeting)
  if (!deleted) {
    return { kind: 'blocked', reason: 'It changed while it was being deleted', retryAfterSec: CHANGED_RETRY_AFTER_SEC }
  }

  await removeOrExplain(deps, id, deleted.audioKey)
  return { kind: 'deleted' }
}

async function removeOrExplain(deps: DeletionDeps, id: string, audioKey: string): Promise<void> {
  try {
    await deps.removeData(id, audioKey)
  }
  catch (err) {
    throw new DeletionIncompleteError(err)
  }
}
