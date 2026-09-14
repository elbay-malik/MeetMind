import type { Meeting, MeetingStatus } from '#shared/types/meeting'

/** Everything the caller decides at creation; timestamps come from the store. */
export type NewMeeting = Omit<Meeting, 'createdAt' | 'updatedAt'>

/** Columns the pipeline is allowed to change after creation. */
export type MeetingPatch = Partial<Pick<Meeting, 'status' | 'uploadedAt' | 'errorMessage' | 'failedStage' | 'title'>>

export interface MeetingRepository {
  readonly kind: 'supabase' | 'local'
  create(meeting: NewMeeting): Promise<Meeting>
  get(id: string): Promise<Meeting | null>
  list(options: { limit: number }): Promise<Meeting[]>
  /** Returns the updated row, or `null` when no row has that id. */
  update(id: string, patch: MeetingPatch): Promise<Meeting | null>
  /**
   * Move a meeting between states only if it is currently in `from`, so exactly
   * one of several concurrent callers wins. Returns the updated row, or `null`
   * when the meeting was in a different state and the caller lost the race.
   *
   * A plain read-then-update cannot do this: both callers read `uploaded`, both
   * write `transcribing`, and both go on to spend the transcription quota.
   *
   * `expectedUpdatedAt`, when given, is an extra fencing condition: the write
   * only lands if `updated_at` still matches. `from` alone is not enough once a
   * status can be reclaimed into itself — a stale-lease reclaim moves
   * `indexing` to `indexing`, so a straggler whose own claim predates the
   * reclaim would otherwise still match `from` and could write over the new
   * claimant's result. Passing the `updatedAt` this caller observed when IT
   * claimed the row closes that gap: a reclaim in between changes it, so the
   * straggler's own later write correctly fails instead of landing.
   */
  claim(id: string, from: MeetingStatus, patch: MeetingPatch, expectedUpdatedAt?: string): Promise<Meeting | null>
}

/**
 * Postgres row shape (snake_case) for the `meetings` table. A type alias, not
 * an interface: supabase-js's generics need the implicit index signature.
 */
export type MeetingRow = {
  id: string
  created_at: string
  updated_at: string
  title: string
  status: MeetingStatus
  source_file_name: string
  source_bytes: number
  source_mime: string | null
  duration_sec: number | null
  audio_key: string
  audio_bytes: number
  audio_mime: string
  uploaded_at: string | null
  error_message: string | null
  failed_stage: 'transcription' | 'summarization' | 'upload' | null
}

export function rowToMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    status: row.status,
    sourceFileName: row.source_file_name,
    sourceBytes: Number(row.source_bytes),
    sourceMime: row.source_mime,
    durationSec: row.duration_sec,
    audioKey: row.audio_key,
    audioBytes: row.audio_bytes,
    audioMime: row.audio_mime,
    uploadedAt: row.uploaded_at,
    errorMessage: row.error_message,
    failedStage: row.failed_stage,
  }
}

export function newMeetingToRow(meeting: NewMeeting): Omit<MeetingRow, 'created_at' | 'updated_at'> {
  return {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    source_file_name: meeting.sourceFileName,
    source_bytes: meeting.sourceBytes,
    source_mime: meeting.sourceMime,
    duration_sec: meeting.durationSec,
    audio_key: meeting.audioKey,
    audio_bytes: meeting.audioBytes,
    audio_mime: meeting.audioMime,
    uploaded_at: meeting.uploadedAt,
    error_message: meeting.errorMessage,
    failed_stage: meeting.failedStage,
  }
}

/**
 * `meetings_failed_stage_matches_status` (see the failed_stage migration)
 * requires `failedStage` to be set precisely when `status` is `failed`, and
 * null every other time. Supabase enforces that with a CHECK constraint; the
 * local driver has none of its own, so without this it would silently write
 * a row Supabase would refuse -- the two drivers quietly disagreeing about
 * what data is valid, discovered when a test fixture did exactly that and the
 * local driver never complained. `failedStage` is compared with `!=` so a
 * value that is merely `undefined` (a patch that never mentions it, or a
 * record built by bypassing the type) counts as "no stage" too, not as some
 * third state distinct from `null`.
 */
function assertFailedStagePairing(
  status: MeetingStatus,
  failedStage: 'transcription' | 'summarization' | 'upload' | null | undefined,
): void {
  const shouldHaveStage = status === 'failed'
  const hasStage = failedStage != null
  if (shouldHaveStage !== hasStage) {
    throw new Error(
      shouldHaveStage
        ? `Cannot set status to 'failed' without a failedStage`
        : `Cannot set failedStage to '${failedStage}' unless status is 'failed' (got status: '${status}')`,
    )
  }
}

/**
 * Validates a patch purely from what it itself sets, not the row it will be
 * merged onto: every real caller that changes `status` already sets
 * `failedStage` in the SAME patch (a stage string moving into `failed`, or
 * `null` moving out of it) precisely so a partial update never needs to
 * re-derive the pairing from whatever was there before. Enforcing that
 * convention here needs no extra read of the current row on either driver.
 *
 * A patch that leaves `status` untouched is not checked here at all: this
 * repository has no caller that sets `failedStage` without also setting
 * `status` in the same patch, and validating that combination would need the
 * current row's status, which callers of `update`/`claim` do not hand in.
 */
export function assertValidStatusPatch(patch: MeetingPatch): void {
  if (patch.status === undefined) return
  assertFailedStagePairing(patch.status, patch.failedStage)
}

/** Same pairing, enforced on a full row at creation. `NewMeeting` requires
 * both fields, so this only ever catches a value mismatch (or a cast that
 * bypasses the type, as one legacy-row test fixture deliberately does). */
export function assertValidNewMeeting(meeting: NewMeeting): void {
  assertFailedStagePairing(meeting.status, meeting.failedStage)
}

export function patchToRow(
  patch: MeetingPatch,
): Partial<Pick<MeetingRow, 'status' | 'uploaded_at' | 'error_message' | 'failed_stage' | 'title'>> {
  const row: Partial<Pick<MeetingRow, 'status' | 'uploaded_at' | 'error_message' | 'failed_stage' | 'title'>> = {}
  if (patch.status !== undefined) row.status = patch.status
  if (patch.uploadedAt !== undefined) row.uploaded_at = patch.uploadedAt
  if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage
  if (patch.failedStage !== undefined) row.failed_stage = patch.failedStage
  if (patch.title !== undefined) row.title = patch.title
  return row
}
