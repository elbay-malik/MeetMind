/**
 * Vector size every embedder produces and every stored window holds. The
 * database column is `vector(768)`, so changing this is a migration, not a
 * config change (ADR-0007).
 */
export const EMBEDDING_DIMENSIONS = 768

/**
 * Turns text into vectors. Implemented by the real provider and by a local stub,
 * chosen the same way every other external dependency is, so CI needs no key.
 *
 * Documents and questions are separate calls because the provider embeds them
 * differently: a question is prefixed as a query, a window as a document, and
 * the two land in the same space only when each is labelled as what it is.
 */
export interface Embedder {
  readonly kind: 'gemini' | 'stub'
  /** Stored with every window, so vectors from different models never mix. */
  readonly model: string
  readonly dimensions: number
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

/** Raised when the provider refuses or fails; carries what the UI should say. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/**
 * Refuse a vector that is not what the schema holds. A request whose dimension
 * setting was silently ignored comes back at the model's 3,072-dimension
 * default; storing that is impossible, and scoring it against 768-dimension
 * vectors is meaningless, so it fails here, loudly, on the first real call.
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
