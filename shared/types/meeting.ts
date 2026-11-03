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
 * A meeting as a browser may see it: the row without its stored error, which can hold a
 * provider's reply, a database's codes or an object's key, and is only ever read from
 * storage (ADR-0012's SEC-15 addendum). The only shape a route answers with, built by
 * `toPublicMeeting`.
 */
export type PublicMeeting = Omit<Meeting, 'errorMessage'>

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
  meeting: PublicMeeting
  progress: {
    /** Chunks with an attested result. */
    done: number
    /** Chunks in the plan; null until the plan is written. */
    total: number | null
  }
  /** `continue`: ask again now. `wait`: ask again at `retryAt`. */
  next: 'continue' | 'wait'
  retryAt: string | null
  /**
   * The same wait as a duration measured on the server, so a client whose
   * clock is off waits the right length rather than to the wrong instant.
   */
  retryAfterMs: number | null
}

/**
 * What `POST /api/meetings/:id/transcribe` answers while the work is not
 * finished, shaped like {@link ExtractionStepResponse}. The finished answer is
 * `{ meeting }` with a 200; the transcript is its own request, because reading
 * it back here would grow this step with the meeting.
 */
export interface TranscriptionStepResponse {
  meeting: PublicMeeting
  progress: {
    /** Bytes of the provider's reply read so far. */
    done: number
    /** Bytes in the reply; null until the provider has answered. */
    total: number | null
    /** Segments stored so far. */
    segments: number
  }
  /** `continue`: ask again now. `wait`: ask again at `retryAt`. */
  next: 'continue' | 'wait'
  retryAt: string | null
  /** The same wait as a duration measured on the server; see {@link ExtractionStepResponse}. */
  retryAfterMs: number | null
}

/**
 * What `POST /api/meetings/:id/search-index` answers while the index is not finished,
 * shaped like {@link TranscriptionStepResponse}. The finished answer is `{ index }` with
 * a 200.
 */
export interface IndexingStepResponse {
  progress: {
    /** Passages of the plan this run has dealt with: embedded, or found stored. */
    done: number
    /** Passages in the plan, once the run has reached its end; null until then. */
    total: number | null
  }
  /** `continue`: ask again now. `wait`: ask again at `retryAt`. */
  next: 'continue' | 'wait'
  retryAt: string | null
  /** The same wait as a duration measured on the server; see {@link ExtractionStepResponse}. */
  retryAfterMs: number | null
}

/**
 * What `POST /api/meetings/:id/advance` and `GET /api/meetings/:id/pipeline` answer
 * (ADR-0012): how far this one meeting has got, from what is stored, and what a driver
 * should do next. It carries nothing else on purpose: no error text, which can be a
 * provider's or a database's own words, and no model, token or cursor.
 */
export interface PipelineResponse {
  status: MeetingStatus
  progress: {
    /**
     * The stage these figures are about: the earliest one not finished. It only moves
     * forward, even while an index batch runs in one of extraction's gaps.
     */
    stage: 'upload' | 'transcription' | 'summarization' | 'search_index'
    /** Bytes of the provider's reply read, chunks with a result, or passages dealt with. */
    done: number
    /** Null until it is known, which for passages is when the plan's end has been reached. */
    total: number | null
    /** Always null for now: ADR-0012's step 9 addendum says why no figure would be honest. */
    etaSeconds: number | null
  }
  /**
   * The search index, which can be anywhere while the status moves on, and never moves it.
   * - `unavailable`: there is no finished transcript to index yet.
   * - `building`: it has work to do, now or at `retryAt`.
   * - `complete`: this meeting can be asked questions.
   * - `parked`: nothing will happen until `retryAt`, too far off for a page to sit through.
   *   The provider's daily limit, or a run that kept stopping.
   * - `held`: it holds another model's or another transcript's work, which nothing
   *   replaces except `POST .../search-index`.
   * - `stopped`: it was refused in a way only that POST can try again.
   */
  index: {
    state: 'unavailable' | 'building' | 'complete' | 'parked' | 'held' | 'stopped'
    done: number
    total: number | null
    retryAt: string | null
  }
  /**
   * - `continue`: ask again now; a step can be taken.
   * - `wait`: ask again at `retryAt`. With none, nothing this caller can do moves it, and
   *   only looking again will show if something else has: a `pending_upload`, or a public
   *   demo that is not finished, whose `POST .../advance` answers 403 (`GET .../pipeline`).
   * - `done`: nothing more to do. With a `retryAt` the index is parked until then: the
   *   meeting can be read, not asked, and opening it after that picks the index up again.
   * - `failed`: transcription or extraction failed. Stop. With a `retryAt`, asking again
   *   from then retries; without one, nothing will. Why is not said to a browser: the
   *   stored reason is an operator's to read.
   */
  next: 'continue' | 'wait' | 'done' | 'failed'
  retryAt: string | null
  /** The same wait as a duration measured on the server; see {@link ExtractionStepResponse}. */
  retryAfterMs: number | null
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
  meeting: PublicMeeting
  upload: UploadInstructions
}

/**
 * Whether a meeting can be asked questions yet (ADR-0007 decision 6). Never kept as
 * a meeting status: `indexing` in the status machine is extraction's in-flight
 * claim, not this.
 *
 * - `unavailable` — transcription has not finished, so there is nothing to index.
 * - `none` — nothing is indexed for the current embedding model.
 * - `incomplete` — no finished run says the index is whole for this transcript: an
 *   interrupted run (the embedding quota), a replaced transcript, or a meeting indexed
 *   before the marker existed, whose windows may all be there.
 * - `ready` — a run finished for this transcript and model, and its marker says so
 *   (ADR-0012). A transcript with no segments is `ready` with zero windows: there is
 *   nothing to find.
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
