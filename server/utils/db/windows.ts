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

/** Upper bound on windows one search may return, on both drivers. */
export const MAX_MATCHES = 20

export interface TranscriptIndexRepository {
  readonly kind: 'supabase' | 'local'
  /** Every stored window's key, for resuming indexing and detecting staleness. */
  listKeys(meetingId: string): Promise<StoredWindowKey[]>
  /** Insert or replace windows by index. */
  upsertWindows(meetingId: string, windows: EmbeddedWindow[]): Promise<void>
  /** Remove every stored window whose index is not in `keep`. */
  deleteExcept(meetingId: string, keep: number[]): Promise<void>
  /**
   * The nearest windows to `query` within one meeting and one model, nearest
   * first, ties broken by index. `limit` is clamped to 1..MAX_MATCHES.
   */
  search(meetingId: string, query: number[], options: { model: string, limit: number }): Promise<WindowMatch[]>
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

/** The same clamp the SQL function applies, so both drivers agree at the edges. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MATCHES)
}

/**
 * Cosine similarity, matching pgvector's `1 - (a <=> b)`. A zero vector has no
 * direction; it scores 0 here rather than NaN, so it sorts last instead of
 * corrupting the order.
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
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}
