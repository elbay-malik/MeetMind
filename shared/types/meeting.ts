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
