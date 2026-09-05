import type { TranscriptSegment } from '#shared/types/meeting'

export interface TranscribeInput {
  bytes: Uint8Array
  /** Media type of the audio, used for the upload part's filename and type. */
  contentType: string
  /** ISO-639-1 hint. Omitting it lets the model detect the language. */
  language?: string
}

export interface TranscribeResult {
  segments: TranscriptSegment[]
  /** Audio length in seconds as the provider measured it, when it reports one. */
  durationSec: number | null
  /** Language the provider detected or was told to use. */
  language: string | null
}

/**
 * Turns compressed audio into timestamped segments. Implemented by the real
 * provider and by a local stub, chosen the same way the storage and database
 * drivers are, so development and CI need no API key.
 */
export interface Transcriber {
  readonly kind: 'groq' | 'stub'
  transcribe(input: TranscribeInput): Promise<TranscribeResult>
}

/** Raised when the provider refuses the request; carries what the UI should say. */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}
