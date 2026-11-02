import { estimateTokens } from '../summary/plan'

/**
 * Vector size every embedder produces and every stored window holds. The
 * database column is `vector(1024)`, so changing this is a migration, not a
 * config change (ADR-0014).
 */
export const EMBEDDING_DIMENSIONS = 1024

/**
 * Longest single input the model takes, in its own tokens. Over it the provider
 * refuses rather than truncating (measured, ADR-0014). Only a single transcript
 * segment over the window budget can get there: see WINDOW_TOKEN_BUDGET.
 */
export const MAX_INPUT_TOKENS = 8_192

/**
 * Texts per embedding request. Batches of 200 short texts have been accepted, so
 * 100 is not the provider's limit. ADR-0012 step 8 lowers it for the Workers CPU
 * limit, which is not measured yet; ADR-0014 has the local numbers.
 */
export const MAX_BATCH = 100

/**
 * Estimated tokens per embedding request. The provider refuses a request over
 * 60,000 tokens, both by its own guess from the body's length and by its real
 * count, and a request of 40 windows at the full budget was already refused
 * (ADR-0014). The worst real-to-estimated ratio measured is 3.94, on text with
 * about one token per character, since the estimate never drops below a quarter
 * token per character. So 12,000 keeps even that under about 48,000 real tokens.
 */
export const MAX_BATCH_TOKENS = 12_000

/**
 * Split items into requests the provider will take, in order. Used by indexing
 * and by the driver alike, so a batch indexing stores at once is one request. An
 * item over the token cap on its own still goes, alone: refusing it is the
 * provider's call, and it says why.
 */
export function planEmbeddingBatches<T>(items: T[], textOf: (item: T) => string): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let tokens = 0
  for (const item of items) {
    const cost = estimateTokens(textOf(item))
    if (batch.length > 0 && (batch.length >= MAX_BATCH || tokens + cost > MAX_BATCH_TOKENS)) {
      batches.push(batch)
      batch = []
      tokens = 0
    }
    batch.push(item)
    tokens += cost
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * Turns text into vectors. Implemented by the real provider and by a local stub,
 * chosen the same way every other external dependency is, so CI needs no key.
 *
 * Documents and questions are separate calls because not every model treats them
 * alike. The current one does, and is sent both as they are (ADR-0014).
 */
export interface Embedder {
  readonly kind: 'workers-ai' | 'stub'
  /** Stored with every window, so vectors from different models never mix. */
  readonly model: string
  readonly dimensions: number
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

/**
 * Raised when the provider refuses or fails; carries what the UI should say,
 * and, when the refusal is "not now", when asking again can succeed.
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly retryAt?: Date,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/**
 * One input is over the model's limit. Indexing again cannot help: the same text
 * is refused the same way, so the meeting stays without questions. It is said
 * plainly rather than cutting the text, which would lose it silently (ADR-0014).
 */
export class EmbeddingInputTooLongError extends EmbeddingError {
  constructor(tokens?: number) {
    const size = tokens === undefined ? '' : `${tokens.toLocaleString('en-US')} tokens; `
    super(
      `A passage in this transcript is too long to index for questions (${size}the limit is ${MAX_INPUT_TOKENS.toLocaleString('en-US')} tokens). `
      + 'Questions cannot be asked about this meeting. Its transcript and summary are not affected.',
      422,
      false,
    )
    this.name = 'EmbeddingInputTooLongError'
  }
}

/**
 * The provider's free daily allocation is spent. It comes back at 00:00 UTC, so
 * that is when asking again can succeed, and nothing sooner will (ADR-0014).
 */
export function dailyLimitReached(now = new Date()): EmbeddingError {
  return new EmbeddingError(
    'The free daily limit for indexing and questions has been reached. It resets at 00:00 UTC.',
    429,
    false,
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
  )
}

/**
 * Refuse a vector that is not what the schema holds. A model changed under its
 * name, or a reply cut short, comes back at another size. Storing that is
 * impossible, and scoring it against 1024-dimension vectors is meaningless, so
 * it fails here, loudly, on the first real call.
 */
export function assertEmbedding(values: unknown, dimensions: number): number[] {
  if (!Array.isArray(values) || values.length !== dimensions) {
    const got = Array.isArray(values) ? `${values.length} values` : typeof values
    throw new EmbeddingError(`Expected a ${dimensions}-dimension embedding, got ${got}`, 502, false)
  }
  if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new EmbeddingError('The embedding contained a non-numeric or non-finite value', 502, false)
  }
  return values as number[]
}
