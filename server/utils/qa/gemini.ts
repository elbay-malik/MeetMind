import { assertEmbedding, EMBEDDING_DIMENSIONS, EmbeddingError, type Embedder } from './embedder'

/** Current Google embedding model (ADR-0007 decision 1). */
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2'

const ENDPOINT
  = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`

/**
 * Texts per batchEmbedContents call. The API reference states no limit; 100 is
 * a conservative cap rather than a documented one. Whether a batch counts as
 * one request against the free tier's daily quota or one per text is also not
 * documented, which is why indexing is resumable (ADR-0007 decision 5).
 */
export const MAX_BATCH = 100

/**
 * gemini-embedding-2 takes its task as a text prefix rather than a taskType
 * field. These are the formats Google documents for question answering.
 */
export const documentText = (text: string) => `title: none | text: ${text}`
export const queryText = (text: string) => `task: question answering | query: ${text}`

export interface GeminiEmbedderOptions {
  apiKey: string
  endpoint?: string
  timeoutMs?: number
  /** Attempts per batch when the failure is transient. */
  maxAttempts?: number
}

export function createGeminiEmbedder(options: GeminiEmbedderOptions): Embedder {
  const endpoint = options.endpoint ?? ENDPOINT
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxAttempts = options.maxAttempts ?? 2

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': options.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${GEMINI_EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          // Not the top-level outputDimensionality, which the API reference
          // marks deprecated. If this is ignored, assertEmbedding catches the
          // 3,072-dimension default on the very first reply.
          embedContentConfig: { outputDimensionality: EMBEDDING_DIMENSIONS },
        })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new EmbeddingError(`Could not reach the embedding service: ${detail}`, 502, true)
    })

    if (!response.ok) throw await describeFailure(response)

    const body = await response.json().catch(() => {
      throw new EmbeddingError('The embedding service returned an unreadable body', 502, true)
    }) as { embeddings?: { values?: unknown }[] }

    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      // Pairing vectors with texts by position is only safe when every text
      // got exactly one; a short reply would shift every later window's vector
      // onto the wrong text.
      const got = Array.isArray(body.embeddings) ? body.embeddings.length : 'no'
      throw new EmbeddingError(`Expected ${texts.length} embeddings, got ${got}`, 502, false)
    }
    return body.embeddings.map(e => assertEmbedding(e?.values, EMBEDDING_DIMENSIONS))
  }

  async function withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work()
      }
      catch (err) {
        if (!(err instanceof EmbeddingError && err.retryable) || attempt >= maxAttempts) throw err
      }
    }
  }

  return {
    kind: 'gemini',
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,

    async embedDocuments(texts) {
      const vectors: number[][] = []
      // Sequential: the per-minute request limit is the one that binds.
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH).map(documentText)
        vectors.push(...await withRetries(() => embedBatch(batch)))
      }
      return vectors
    },

    async embedQuery(text) {
      const [vector] = await withRetries(() => embedBatch([queryText(text)]))
      return vector!
    },
  }
}

async function describeFailure(response: Response): Promise<EmbeddingError> {
  const detail = (await response.text().catch(() => '')).slice(0, 300)

  if (response.status === 429) {
    // Not retried in place: an immediate retry hits the same quota again. The
    // daily cap in particular does not recover within a request's lifetime.
    const retryAfter = response.headers.get('retry-after')
    return new EmbeddingError(
      `Embedding quota is exhausted for now.${retryAfter ? ` Try again in ${retryAfter}s.` : ''}`,
      429,
      false,
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new EmbeddingError('The embedding service rejected our credentials.', 502, false)
  }
  if (response.status >= 500) {
    return new EmbeddingError(`Embedding service is unavailable (HTTP ${response.status}).`, 502, true)
  }
  return new EmbeddingError(
    `Embedding service refused the request (HTTP ${response.status}): ${detail}`,
    502,
    false,
  )
}
