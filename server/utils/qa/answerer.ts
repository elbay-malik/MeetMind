import type { TranscriptSegment } from '#shared/types/meeting'
import type { WireAnswer } from '#shared/schemas/qa'
import { ProviderBusyError, type RequestPacer } from '../summary/groq'

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

/**
 * Raised when the provider refuses or fails; carries what the UI should say,
 * and, when the refusal is "not now", when asking again can succeed.
 */
export class AnswerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly retryAt?: Date,
  ) {
    super(message)
    this.name = 'AnswerError'
  }
}

/** No request slot starts within the question's wait. */
export class AnswerSlotBusyError extends AnswerError {
  constructor(retryAt: Date) {
    super('The answering model is busy with other requests, such as a running extraction.', 429, false, retryAt)
    this.name = 'AnswerSlotBusyError'
  }
}

/**
 * Wait for this question's turn on the shared provider slot (ADR-0012). A
 * question waits only briefly: when no slot starts within its wait, it is
 * refused with when to try again, rather than queued behind an extraction.
 */
export async function awaitAnswerSlot(pacer: RequestPacer): Promise<void> {
  try {
    await pacer.wait()
  }
  catch (err) {
    if (err instanceof ProviderBusyError) throw new AnswerSlotBusyError(err.retryAt)
    console.warn('[meetmind] could not reserve a request slot:', err)
    throw new AnswerError('Could not schedule the question. Try again shortly.', 503, true)
  }
}
