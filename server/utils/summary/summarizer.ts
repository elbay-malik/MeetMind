import type { MeetingSummary, TranscriptSegment } from '#shared/types/meeting'

export interface SummarizeInput {
  segments: TranscriptSegment[]
}

/**
 * Turns a transcript into a summary with decisions and action items.
 * Implemented by the real provider and by a local stub, chosen the same way the
 * storage, database and transcription drivers are, so CI needs no API key.
 */
export interface Summarizer {
  readonly kind: 'groq' | 'stub'
  summarize(input: SummarizeInput): Promise<MeetingSummary>
}

/** Raised when the provider refuses or fails; carries what the UI should say. */
export class SummarizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SummarizationError'
  }
}
