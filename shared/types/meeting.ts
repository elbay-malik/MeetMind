/**
 * Meeting domain model shared by the Nuxt app and the Nitro server.
 * Column names in Postgres are snake_case; the repository layer maps them.
 */

/**
 * Lifecycle of a meeting through the pipeline. Phase 3 only moves rows
 * between `pending_upload` and `uploaded` (or `failed`); later phases add
 * the transcription → summary → indexing transitions.
 */
export type MeetingStatus
  = | 'pending_upload'
    | 'uploaded'
    | 'transcribing'
    | 'summarizing'
    | 'indexing'
    | 'ready'
    | 'failed'

export interface Meeting {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  status: MeetingStatus
  /** Original recording's file name — metadata only; its bytes never leave the browser. */
  sourceFileName: string
  sourceBytes: number
  sourceMime: string | null
  durationSec: number | null
  /** Object key of the compressed audio in the audio store. */
  audioKey: string
  /** Size declared by the client at creation and verified against storage on completion. */
  audioBytes: number
  audioMime: string
  uploadedAt: string | null
  errorMessage: string | null
  /**
   * Which stage produced the current `errorMessage`, when status is `failed`.
   * `'failed'` used to mean one thing; once summarisation could also fail it
   * meant two, and neither the retry route nor the UI could tell them apart —
   * retrying transcription on a summarisation failure re-ran transcription and
   * overwrote a perfectly good transcript. Null outside `failed`.
   *
   * `'upload'` is the stage that has no retry at all: verification refused the
   * stored object and deleted it, so there is nothing left for any route to
   * work from. It exists precisely so the retry routes and the UI can tell
   * that apart from a transcription failure, which they could not when this
   * case was recorded as `'transcription'` — the progress page offered "Try
   * transcription again" for audio that had just been deleted, and every
   * attempt returned the same 409, forever.
   */
  failedStage: 'transcription' | 'summarization' | 'upload' | null
}

/**
 * One timestamped chunk of speech. Times are integer milliseconds from the
 * start of the audio, so they compare exactly and seek exactly.
 */
export interface TranscriptSegment {
  /** Position in the transcript, gapless from 0. */
  idx: number
  startMs: number
  endMs: number
  text: string
}

/**
 * Something the meeting settled, with the transcript line that says so.
 *
 * `quote` is the model's evidence and `segmentIdx` points at the segment it
 * came from; both are checked against the real transcript before storage, so an
 * item that survives is one the transcript actually supports.
 */
export interface Decision {
  idx: number
  decision: string
  quote: string
  segmentIdx: number
  startMs: number
}

/** Something the meeting asked someone to do. */
export interface ActionItem {
  idx: number
  task: string
  /** Null means nobody was named, which is different from not being asked. */
  assignee: string | null
  /** The due date as spoken, unresolved: "next Friday" stays "next Friday". */
  dueDateText: string | null
  quote: string
  segmentIdx: number
  startMs: number
}

export interface MeetingSummary {
  summary: string
  decisions: Decision[]
  actionItems: ActionItem[]
  /** Which provider produced this, so a stub result is never mistaken for real. */
  provider: 'groq' | 'stub'
}

/**
 * Extraction runs as a series of short steps (ADR-0012); this is what one step
 * answers while the work is not finished. The finished answer is
 * `{ meeting, summary }` with a 200.
 */
export interface ExtractionStepResponse {
  meeting: Meeting
  progress: {
    /** Chunks with an attested result. */
    done: number
    /** Chunks in the plan; null until the plan is written. */
    total: number | null
    /** Why the last step of this run ended without a result, if it did. */
    lastError: string | null
  }
  /** `continue`: ask again now. `wait`: ask again at `retryAt`. */
  next: 'continue' | 'wait'
  retryAt: string | null
}

/** Fields the client supplies when registering a meeting before uploading its audio. */
export interface CreateMeetingInput {
  title: string
  sourceFileName: string
  sourceBytes: number
  sourceMime: string | null
  durationSec: number | null
  audioBytes: number
}

/** Instructions for the browser to upload the audio blob directly to storage. */
export interface UploadInstructions {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: string
}

export interface CreateMeetingResponse {
  meeting: Meeting
  upload: UploadInstructions
}

/**
 * Whether a meeting can be asked questions yet (ADR-0007 decision 6). Derived
 * from the stored windows, never kept as a meeting status: `indexing` in the
 * status machine is extraction's in-flight claim, not this.
 *
 * - `unavailable` — transcription has not finished, so there is nothing to index.
 * - `none` — nothing is indexed for the current embedding model.
 * - `incomplete` — some windows are missing or no longer match the transcript:
 *   an interrupted run (the embedding quota), or a replaced transcript.
 * - `ready` — every window of the current transcript is indexed. A transcript
 *   with no segments is `ready` with zero windows: there is nothing to find.
 */
export interface SearchIndexStatus {
  state: 'unavailable' | 'none' | 'incomplete' | 'ready'
  /** Windows the current transcript plans into. */
  windowCount: number
  /** Of those, how many are stored, current, and from the current model. */
  indexedCount: number
  /** The embedding model the index is (or would be) built with. */
  model: string
}

/** A line of the transcript an answer rests on, checked before it is returned. */
export interface Citation {
  quote: string
  segmentIdx: number
  startMs: number
}

/**
 * The answer to a question about one meeting.
 *
 * `found: false` means no citation survived the check against the transcript,
 * and then there is no `answer` at all: an uncited claim is withheld rather than
 * shown (ADR-0007 decision 3). It does not prove the meeting never discussed the
 * subject, only that nothing retrieved supported an answer.
 */
export type QuestionAnswer
  = | { found: true, answer: string, citations: Citation[] }
    | { found: false, answer: null, citations: [] }

/**
 * One passage a cross-meeting search retrieved (ADR-0008), tagged with the
 * meeting it came from — unlike {@link Citation}, which never needs a meeting
 * id because it is always read in the context of one already-known meeting.
 */
export interface MeetingSearchMatch {
  meetingId: string
  meetingTitle: string
  quote: string
  segmentIdx: number
  startMs: number
}

/**
 * Cross-meeting search results, ordered by each meeting's own best match.
 * Only covers meetings that have been indexed for questions (ADR-0007
 * decision 6: indexing is a manual, per-meeting step) — the UI says so as a
 * standing caption rather than this reporting exactly which meetings were
 * skipped, which would need every meeting's own index status computed on
 * every search.
 */
export interface MeetingSearchResult {
  results: MeetingSearchMatch[]
}
