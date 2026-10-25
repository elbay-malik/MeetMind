import type { TranscriptWindow } from '../qa/windows'

/** A window as stored: its embedding, and the model that produced it. */
export interface EmbeddedWindow extends TranscriptWindow {
  model: string
  embedding: number[]
}

/** What indexing needs to know about a stored window without its vector. */
export interface StoredWindowKey {
  idx: number
  contentHash: string
  model: string
}

/** A search hit. Cosine similarity: 1 is identical, 0 unrelated. */
export interface WindowMatch extends TranscriptWindow {
  similarity: number
}

/**
 * A search hit from across every meeting: everything {@link WindowMatch}
 * carries, plus which meeting it came from. Needed because a window's `idx`
 * and segment range are only unique WITHIN a meeting — pooling matches from
 * several meetings without tagging them would let one meeting's window
 * collide with another's by coincidence of index.
 */
export interface CrossMeetingMatch extends WindowMatch {
  meetingId: string
}

/** Upper bound on windows one per-meeting search may return, on both drivers. */
export const MAX_MATCHES = 20

/** Upper bound on distinct meetings one cross-meeting search may return. */
export const MAX_MEETINGS = 20

/** Upper bound on windows any one meeting may contribute to a cross-meeting search. */
export const MAX_MATCHES_PER_MEETING = 5

export interface TranscriptIndexRepository {
  readonly kind: 'supabase' | 'local'
  /** Every stored window's key, for resuming indexing and detecting staleness. */
  listKeys(meetingId: string): Promise<StoredWindowKey[]>
  /** Insert or replace windows by index. */
  upsertWindows(meetingId: string, windows: EmbeddedWindow[]): Promise<void>
  /** Remove every stored window whose index is not in `keep`. */
  deleteExcept(meetingId: string, keep: number[]): Promise<void>
  /**
   * Remove every window of the meeting, leaving nothing behind for a
   * cross-meeting scan to find. Idempotent. Not `deleteExcept(id, [])`: on the
   * local driver that leaves an empty file, which is still a key.
   */
  deleteForMeeting(meetingId: string): Promise<void>
  /**
   * The nearest windows to `query` within one meeting and one model, nearest
   * first, ties broken by index. `limit` is clamped to 1..MAX_MATCHES.
   */
  search(meetingId: string, query: number[], options: { model: string, limit: number }): Promise<WindowMatch[]>
  /**
   * The nearest windows to `query` across every meeting with a matching
   * model, grouped by meeting: at most `meetingLimit` meetings — the ones
   * whose own single best match is nearest — each contributing at most
   * `perMeetingLimit` windows, nearest first within a meeting and meetings
   * ordered by their own best match. A separate method from {@link search},
   * not a widened version of it: `search`'s "within one meeting" contract is
   * exactly what its existing callers and tests already rely on (ADR-0008).
   */
  searchAcrossMeetings(
    query: number[],
    options: { model: string, meetingLimit: number, perMeetingLimit: number },
  ): Promise<CrossMeetingMatch[]>
}

export type TranscriptWindowRow = {
  meeting_id: string
  idx: number
  first_segment_idx: number
  last_segment_idx: number
  start_ms: number
  end_ms: number
  content: string
  content_hash: string
  model: string
  /** Sent as a JSON array of numbers; pgvector parses it on insert. */
  embedding: number[] | string
  created_at: string
  updated_at: string
}

export type WindowMatchRow = {
  idx: number
  first_segment_idx: number
  last_segment_idx: number
  start_ms: number
  end_ms: number
  content: string
  content_hash: string
  similarity: number
}

export type CrossMeetingMatchRow = WindowMatchRow & { meeting_id: string }

export function windowToRow(
  meetingId: string,
  window: EmbeddedWindow,
): Omit<TranscriptWindowRow, 'created_at' | 'updated_at'> {
  return {
    meeting_id: meetingId,
    idx: window.idx,
    first_segment_idx: window.firstSegmentIdx,
    last_segment_idx: window.lastSegmentIdx,
    start_ms: window.startMs,
    end_ms: window.endMs,
    content: window.text,
    content_hash: window.contentHash,
    model: window.model,
    embedding: window.embedding,
  }
}

export function rowToMatch(row: WindowMatchRow): WindowMatch {
  return {
    idx: row.idx,
    firstSegmentIdx: row.first_segment_idx,
    lastSegmentIdx: row.last_segment_idx,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.content,
    contentHash: row.content_hash,
    similarity: Number(row.similarity),
  }
}

export function rowToCrossMeetingMatch(row: CrossMeetingMatchRow): CrossMeetingMatch {
  return { ...rowToMatch(row), meetingId: row.meeting_id }
}

/** Clamp `value` into 1..`max`, treating anything non-finite (including NaN) as 1. */
function clampTo(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

/** The same clamp the SQL function applies, so both drivers agree at the edges. */
export function clampLimit(limit: number): number {
  return clampTo(limit, MAX_MATCHES)
}

/** The same clamp the cross-meeting SQL function applies to its meeting count. */
export function clampMeetingLimit(limit: number): number {
  return clampTo(limit, MAX_MEETINGS)
}

/** The same clamp the cross-meeting SQL function applies to its per-meeting count. */
export function clampPerMeetingLimit(limit: number): number {
  return clampTo(limit, MAX_MATCHES_PER_MEETING)
}

/**
 * Cosine similarity, matching pgvector's `1 - (a <=> b)` exactly, NaN
 * included: a zero vector has no direction, and pgvector's `<=>` genuinely
 * returns NaN for it rather than a number (verified against a real
 * pgvector/pgvector:pg17 instance) — earlier this returned 0 instead, which
 * reads as "unrelated" but actually outranks any window with genuine negative
 * similarity, the opposite of pgvector's real ordering. Callers that rank by
 * this value need to sort NaN as worst explicitly (see windows-local.ts's
 * search) rather than relying on arithmetic comparison, which never singles
 * NaN out on its own.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Cannot compare vectors of ${a.length} and ${b.length} dimensions`)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return Number.NaN
  return dot / Math.sqrt(normA * normB)
}
