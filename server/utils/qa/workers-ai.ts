import {
  assertEmbedding,
  dailyLimitReached,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  EmbeddingInputTooLongError,
  planEmbeddingBatches,
  type Embedder,
} from './embedder'

/** Cloudflare's multilingual embedding model (ADR-0014). */
export const WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-m3'

/**
 * The exhausted daily allocation. Cloudflare's error page lists 3036, and 4006 is
 * remembered from older replies. Neither has been seen here, because seeing one
 * means spending the whole allocation, so the wording is checked as well.
 */
const DAILY_LIMIT_CODES = [3036, 4006]
const DAILY_LIMIT_WORDING = /daily free allocation/i

/** Also a 429, documented as "Capacity temporarily exceeded, please try again". */
const OUT_OF_CAPACITY_CODE = 3040

/** A request over the model's context window, by its guess from the body's length. */
const CONTEXT_WINDOW_CODE = 5021
/** The same limit by its real count. Shares code 8007 with other refusals. */
const OVER_CONTEXT_WORDING = /max context reached/i
/** One input over MAX_INPUT_TOKENS, with its real count. Also code 8007. */
const SEQUENCE_TOO_LONG = /sequence too long:\s*(\d+)/i

export interface WorkersAiEmbedderOptions {
  accountId: string
  apiToken: string
  endpoint?: string
  timeoutMs?: number
  /** Attempts per batch when the failure is transient. */
  maxAttempts?: number
}

interface WorkersAiReply {
  success?: unknown
  result?: { data?: unknown, shape?: unknown } | null
}

export function createWorkersAiEmbedder(options: WorkersAiEmbedderOptions): Embedder {
  const endpoint = options.endpoint
    ?? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${WORKERS_AI_EMBEDDING_MODEL}`
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxAttempts = options.maxAttempts ?? 2

  // These messages reach visitors, and the URL holds the account id. Whatever a
  // failure echoes, neither credential goes out with it.
  const secrets = [options.apiToken, options.accountId].filter(Boolean)
  const scrub = (text: string) => secrets.reduce((clean, secret) => clean.replaceAll(secret, '[redacted]'), text)

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${options.apiToken}`,
        'content-type': 'application/json',
      },
      // `text` and nothing else: this model's `query` and `contexts` ask for
      // reranking, not embeddings. No prefix either way (ADR-0014).
      body: JSON.stringify({ text: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new EmbeddingError(`Could not reach the embedding service: ${scrub(detail)}`, 502, true)
    })

    const body = await response.json().catch(() => null) as WorkersAiReply | null
    if (!response.ok) throw describeRefusal(response.status, body, texts.length, scrub)
    if (body === null) throw new EmbeddingError('The embedding service returned an unreadable body', 502, true)
    if (body.success !== true) throw describeRefusal(response.status, body, texts.length, scrub)
    return readVectors(body, texts.length)
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
    kind: 'workers-ai',
    model: WORKERS_AI_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,

    async embedDocuments(texts) {
      const vectors: number[][] = []
      // Sequential, so the first refusal stops the spending.
      for (const batch of planEmbeddingBatches(texts, text => text)) {
        vectors.push(...await withRetries(() => embedBatch(batch)))
      }
      return vectors
    },

    async embedQuery(text) {
      const [vector] = await withRetries(() => embedBatch([text]))
      return vector!
    },
  }
}

function readVectors(reply: WorkersAiReply, count: number): number[][] {
  const data = reply.result?.data
  if (!Array.isArray(data) || data.length !== count) {
    // Pairing vectors with texts by position is only safe when every text got
    // exactly one; a short reply would shift every later window's vector onto
    // the wrong text.
    const got = Array.isArray(data) ? data.length : 'no'
    throw new EmbeddingError(`Expected ${count} embeddings, got ${got}`, 502, false)
  }
  const shape = reply.result?.shape
  if (shape !== undefined && (!Array.isArray(shape) || shape[0] !== count || shape[1] !== EMBEDDING_DIMENSIONS)) {
    const got = JSON.stringify(shape)?.slice(0, 40)
    throw new EmbeddingError(`Expected a result shaped ${count} by ${EMBEDDING_DIMENSIONS}, got ${got}`, 502, false)
  }
  return data.map(values => assertEmbedding(values, EMBEDDING_DIMENSIONS))
}

function describeRefusal(
  status: number,
  body: unknown,
  batchSize: number,
  scrub: (text: string) => string,
): EmbeddingError {
  const listed = (body as { errors?: unknown } | null)?.errors
  const errors = (Array.isArray(listed) ? listed : []) as { code?: unknown, message?: unknown }[]
  const codes = errors.map(e => e?.code)
  const said = errors.map(e => (typeof e?.message === 'string' ? e.message : '')).join(' ').trim()

  // Before the 429 below: it shares the status, and the daily limit's message
  // would be false, sending people away until midnight over a short shortage.
  if (codes.includes(OUT_OF_CAPACITY_CODE)) {
    return new EmbeddingError('The embedding service is out of capacity for the moment. Try again shortly.', 503, false)
  }
  // Never retried in place: the allocation does not come back within a request.
  if (status === 429 || DAILY_LIMIT_CODES.some(code => codes.includes(code)) || DAILY_LIMIT_WORDING.test(said)) {
    return dailyLimitReached()
  }

  const tooLong = SEQUENCE_TOO_LONG.exec(said)
  if (tooLong) return new EmbeddingInputTooLongError(Number(tooLong[1]))
  // Alone in its request, the text is what is over the limit. In a larger request
  // the batching was wrong instead, and the generic refusal below says so.
  if (batchSize === 1 && (status === 413 || codes.includes(CONTEXT_WINDOW_CODE) || OVER_CONTEXT_WORDING.test(said))) {
    return new EmbeddingInputTooLongError()
  }

  if (status === 401 || status === 403) {
    return new EmbeddingError('The embedding service rejected our credentials.', 502, false)
  }
  if (status >= 500) {
    return new EmbeddingError(`Embedding service is unavailable (HTTP ${status}).`, 502, true)
  }
  const code = codes.find(c => typeof c === 'number')
  return new EmbeddingError(
    `Embedding service refused the request (HTTP ${status}${code === undefined ? '' : `, code ${code}`})`
    + `${said ? `: ${scrub(said).slice(0, 200)}` : '.'}`,
    502,
    false,
  )
}
