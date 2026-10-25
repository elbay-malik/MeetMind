import type { H3Event } from 'h3'
import type { Meeting } from '#shared/types/meeting'
import { audioObjectKey, claimLooksStale, SUMMARIZE_CLAIM_LEASE_MS, TRANSCRIBE_CLAIM_LEASE_MS } from '#shared/utils/meeting'
import { usePipelineRepository, useSummaryRepository, useTranscriptIndexRepository, useTranscriptRepository } from './db'
import type { MeetingRepository } from './db/meetings'
import { liveStepLease, type PipelineRepository, type PipelineRun } from './db/pipeline'
import { useAudioStore } from './storage'
import { UPLOAD_URL_TTL_SEC } from './storage-budget'

/**
 * How long past its expiry an upload URL is still treated as live.
 *
 * R2 checks a presigned URL's expiry when the PUT starts, not when it finishes,
 * so an upload begun a second before expiry can still be landing well after it.
 * A 25 MB cap on a slow connection takes minutes; this is comfortably more.
 */
export const UPLOAD_GRACE_SEC = 15 * 60

/**
 * Retry-After for the two refusals that have no deadline to count down to: an
 * indexing run, which embeds in batches for as long as the quota allows, and a
 * row that changed between the check and the delete.
 */
export const INDEXING_RETRY_AFTER_SEC = 60
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
 * - **A live claim.** Transcription and summarisation write their results after
 *   holding the claim for minutes or hours. The fenced delete would stop the
 *   route's own status write, but not the child rows it writes first -- and on
 *   the local driver nothing would refuse those. A claim past its lease is
 *   treated the way the routes themselves treat it: as abandoned.
 * - **A live pipeline step** (ADR-0012). A step writes its result back when it
 *   finishes, fenced on its token; the cascade would make that write match
 *   nothing on Supabase, but a step part-way through a provider call has
 *   already spent the quota for a result that would be thrown away. A run
 *   parked between steps holds no lease and does not block.
 */
export function deletionBlocker(
  meeting: Pick<Meeting, 'status' | 'createdAt' | 'updatedAt'>,
  now: number = Date.now(),
  runs: readonly Pick<PipelineRun, 'stepLeaseUntil'>[] = [],
): DeletionBlocker | null {
  const uploadWindowEnds = Date.parse(meeting.createdAt) + (UPLOAD_URL_TTL_SEC + UPLOAD_GRACE_SEC) * 1000
  if (now < uploadWindowEnds) {
    return {
      reason: 'Its upload URL may still be in use, and audio uploaded after the delete would be stored untracked',
      retryAfterSec: Math.ceil((uploadWindowEnds - now) / 1000),
    }
  }

  const lease = meeting.status === 'transcribing'
    ? TRANSCRIBE_CLAIM_LEASE_MS
    : meeting.status === 'indexing' ? SUMMARIZE_CLAIM_LEASE_MS : undefined
  if (lease !== undefined && !claimLooksStale(meeting, now)) {
    return {
      reason: `It is ${meeting.status}, and that work would write its results back after the delete`,
      retryAfterSec: Math.ceil((Date.parse(meeting.updatedAt) + lease - now) / 1000),
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
 * and the transcript, summary and search windows.
 *
 * Every step is idempotent, so this is also how a delete that failed partway is
 * finished: the route runs it again even when the row is already gone, using
 * the key the object would have had.
 *
 * Audio first. It is the only part that costs money for as long as it exists,
 * and once the row is gone the storage budget no longer counts it.
 */
export async function removeMeetingData(event: H3Event, meetingId: string, audioKey: string): Promise<void> {
  await useAudioStore(event).delete(audioKey)
  await usePipelineRepository(event).deleteForMeeting(meetingId)
  await useTranscriptIndexRepository(event).deleteForMeeting(meetingId)
  await useSummaryRepository(event).deleteForMeeting(meetingId)
  await useTranscriptRepository(event).deleteForMeeting(meetingId)
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
  /** Indexing runs in flight in this process (server/utils/qa/in-flight.ts). */
  indexingRuns: ReadonlyMap<string, Promise<unknown>>
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
    // follows from the id. After any indexing run, for the reason below.
    await settled(deps.indexingRuns.get(id))
    await removeOrExplain(deps, id, audioObjectKey(id))
    return { kind: 'not-found' }
  }

  // Read after the meeting: a step claimed in between moves its updatedAt,
  // so the fenced delete below refuses it even though this read missed it.
  const blocker = deletionBlocker(meeting, now(), await deps.pipeline.listRuns(id))
  if (blocker) return { kind: 'blocked', ...blocker }
  if (deps.indexingRuns.has(id)) {
    return {
      kind: 'blocked',
      reason: 'It is being indexed for search, and that would write its windows back',
      retryAfterSec: INDEXING_RETRY_AFTER_SEC,
    }
  }

  // The row before the data. Fenced on the row as read above, so a claim that
  // landed since then leaves nothing to delete -- and nothing of a meeting that
  // is still in use gets removed.
  const deleted = await deps.meetings.delete(id, meeting)
  if (!deleted) {
    return { kind: 'blocked', reason: 'It changed while it was being deleted', retryAfterSec: CHANGED_RETRY_AFTER_SEC }
  }

  // The in-flight check above is a read, and indexing has no claim on the row
  // to fence against. An indexing request can start after that check and still
  // read the row before it goes, then write its windows after they have been
  // removed -- on the local driver nothing would refuse them. The indexing
  // route registers its run BEFORE reading the row, so any run that could have
  // seen the row is registered by now, and waiting for it is enough. Its own
  // outcome does not matter: on Supabase it fails on the foreign key.
  await settled(deps.indexingRuns.get(id))

  await removeOrExplain(deps, id, deleted.audioKey)
  return { kind: 'deleted' }
}

async function settled(run: Promise<unknown> | undefined): Promise<void> {
  if (run) await run.catch(() => undefined)
}

async function removeOrExplain(deps: DeletionDeps, id: string, audioKey: string): Promise<void> {
  try {
    await deps.removeData(id, audioKey)
  }
  catch (err) {
    throw new DeletionIncompleteError(err)
  }
}
