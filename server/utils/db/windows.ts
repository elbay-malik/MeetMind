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

/** What `meeting_index_state` holds: which transcript and model an index run was for, and whether it finished. */
export interface IndexMarker {
  textHash: string
  model: string
  /** 0 until the run finishes, when the plan's length is first known. */
  windowCount: number
  complete: boolean
}

/** Everything deciding "can this meeting be asked questions" takes, in one read. */
export interface IndexState {
  /** Null when no run of the current code has ever written: a meeting indexed before step 8, or never. */
  marker: IndexMarker | null
  /** The hash of the transcript as it is now. */
  transcriptHash: string
  segmentCount: number
  /** Windows stored for this meeting, under any model. */
  storedWindows: number
  /** Of those, under the model asked about. */
  storedForModel: number
}

/**
 * The windows a meeting's finished index holds for `model`, or null when it is not
 * finished: no marker or an incomplete one, another model's, another transcript's, or
 * windows that do not add up to what the marker says. A transcript with no lines and
 * nothing stored has nothing to finish, so it is ready with none.
 */
export function readyWindowCount(state: IndexState, model: string): number | null {
  if (state.segmentCount === 0 && state.storedWindows === 0) return 0
  const { marker } = state
  if (!marker?.complete || marker.model !== model || marker.textHash !== state.transcriptHash) return null
  return state.storedWindows === marker.windowCount && state.storedForModel === marker.windowCount ? marker.windowCount : null
}

/** A search hit. Cosine similarity: 1 is identical, 0 unrelated. */
export interface WindowMatch extends TranscriptWindow {
  similarity: number
}

/** Upper bound on windows one per-meeting search may return, on both drivers. */
export const MAX_MATCHES = 20

export interface TranscriptIndexRepository {
  readonly kind: 'supabase' | 'local'
  /**
   * The marker and the counts around it, in one read. The transcript is hashed where
   * it is stored, so noticing a replaced one costs no lines read here.
   */
  readState(meetingId: string, model: string): Promise<IndexState>
  /**
   * Stored windows' keys, for detecting staleness: all of them, or only those with
   * `from <= idx <= to`, which is what keeps a step's read the size of its batch.
   */
  listKeys(meetingId: string, range?: { from: number, to: number }): Promise<StoredWindowKey[]>
  /**
   * Insert or replace windows by index, unfenced and with no marker. Nothing in
   * production writes this way: a step goes through `PipelineRepository.upsertWindows`.
   * Specs and `test:services` seed an index with it.
   */
  upsertWindows(meetingId: string, windows: EmbeddedWindow[]): Promise<void>
  /** Remove every window of the meeting, leaving nothing behind. Idempotent. */
  deleteForMeeting(meetingId: string): Promise<void>
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

/** Clamp `value` into 1..`max`, treating anything non-finite (including NaN) as 1. */
function clampTo(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

/** The same clamp the SQL function applies, so both drivers agree at the edges. */
export function clampLimit(limit: number): number {
  return clampTo(limit, MAX_MATCHES)
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
