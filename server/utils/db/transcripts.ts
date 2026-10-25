import type { TranscriptSegment } from '#shared/types/meeting'

export interface TranscriptRepository {
  readonly kind: 'supabase' | 'local'
  /** Replace a meeting's whole transcript. Re-running transcription is idempotent. */
  replaceForMeeting(meetingId: string, segments: TranscriptSegment[]): Promise<void>
  listForMeeting(meetingId: string): Promise<TranscriptSegment[]>
  /** Remove the whole transcript. Idempotent: nothing stored is not an error. */
  deleteForMeeting(meetingId: string): Promise<void>
}

/** Postgres row shape for `transcript_segments`. */
export type TranscriptSegmentRow = {
  meeting_id: string
  idx: number
  start_ms: number
  end_ms: number
  text: string
  created_at: string
}

export function rowToSegment(row: TranscriptSegmentRow): TranscriptSegment {
  return { idx: row.idx, startMs: row.start_ms, endMs: row.end_ms, text: row.text }
}

export function segmentToRow(
  meetingId: string,
  segment: TranscriptSegment,
): Omit<TranscriptSegmentRow, 'created_at'> {
  return {
    meeting_id: meetingId,
    idx: segment.idx,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.text,
  }
}
