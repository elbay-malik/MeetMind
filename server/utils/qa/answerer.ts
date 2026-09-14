import type { TranscriptSegment } from '#shared/types/meeting'
import type { WireAnswer } from '#shared/schemas/qa'

export interface AnswerInput {
  question: string
  /** Only the retrieved lines. The model must answer from these and nothing else. */
  segments: TranscriptSegment[]
}

/**
 * Answers a question from a meeting's retrieved transcript lines. Implemented by
 * the real provider and a local stub, chosen like every other dependency.
 *
 * Returns the model's raw answer and citations; checking those citations
 * against the transcript is the caller's job (see ask.ts), in one place, for
 * every answerer alike.
 */
export interface Answerer {
  readonly kind: 'groq' | 'stub'
  answer(input: AnswerInput): Promise<WireAnswer>
}

/** Raised when the provider refuses or fails; carries what the UI should say. */
export class AnswerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'AnswerError'
  }
}
