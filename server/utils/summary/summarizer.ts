import type { MeetingSummary, TranscriptSegment } from '#shared/types/meeting'
import type { AttestedChunk } from './reconcile'

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
  /**
   * One chunk's extraction -- at most one provider request, retries aside --
   * already attested against the chunk's own lines, so a caller cannot store
   * unchecked model output. `segments` is one chunk of a `planChunks` plan;
   * `mergeReconciled` joins the results. The unit a step-wise pipeline runs
   * per request (ADR-0012).
   */
  summarizeChunk(input: SummarizeInput): Promise<AttestedChunk>
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
