import type { Meeting, MeetingStatus } from '#shared/types/meeting'

/** Everything the caller decides at creation; timestamps come from the store. */
export type NewMeeting = Omit<Meeting, 'createdAt' | 'updatedAt'>

/** Columns the pipeline is allowed to change after creation. */
export type MeetingPatch = Partial<Pick<Meeting, 'status' | 'uploadedAt' | 'errorMessage' | 'title'>>

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
   */
  claim(id: string, from: MeetingStatus, patch: MeetingPatch): Promise<Meeting | null>
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
  }
}

export function patchToRow(patch: MeetingPatch): Partial<Pick<MeetingRow, 'status' | 'uploaded_at' | 'error_message' | 'title'>> {
  const row: Partial<Pick<MeetingRow, 'status' | 'uploaded_at' | 'error_message' | 'title'>> = {}
  if (patch.status !== undefined) row.status = patch.status
  if (patch.uploadedAt !== undefined) row.uploaded_at = patch.uploadedAt
  if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage
  if (patch.title !== undefined) row.title = patch.title
  return row
}
