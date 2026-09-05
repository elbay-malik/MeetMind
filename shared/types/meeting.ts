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
