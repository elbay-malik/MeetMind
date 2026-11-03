import { normalise, tokenize } from '../summary/reconcile'
import { estimateTokens } from '../summary/plan'
import { INJECTED_FAILURE_TEXT, INJECTED_RATE_LIMIT_MS, injectedFailure } from '../injected-failure'
import {
  dailyLimitReached,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  EmbeddingInputTooLongError,
  MAX_INPUT_TOKENS,
  type Embedder,
} from './embedder'

/**
 * Not v1, which was 768 dimensions: a local index built then has to read as
 * another model's, to be built again, rather than failing on its first question.
 */
export const STUB_EMBEDDING_MODEL = 'stub-hashed-tokens-v2'

/** FNV-1a, 32-bit: small, dependency-free and well spread for bucketing. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Hash each script-aware token into one of the vector's buckets, then scale to
 * unit length. Texts sharing words share buckets, so they score close together,
 * which is what makes retrieval behave meaningfully in every credential-free test
 * tier rather than ranking noise. Not a model of meaning: synonyms score as
 * unrelated, and nobody should read a quality signal into its rankings.
 *
 * Text with no tokens at all embeds as the zero vector, which scores 0 against
 * everything rather than NaN.
 */
export function hashedTokenVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  for (const token of tokenize(normalise(text))) {
    const hash = fnv1a(token)
    // One bit of the hash picks a sign, so unrelated tokens landing in the same
    // bucket tend to cancel rather than always reinforcing.
    vector[hash % dimensions]! += (hash & 0x8000_0000) ? -1 : 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return norm === 0 ? vector : vector.map(v => v / norm)
}

export interface StubEmbedderOptions {
  /**
   * Test-only: a text containing this is refused as the real provider refuses
   * once its daily allocation is spent, so tests can prove what a visitor is told
   * over the real HTTP routes.
   */
  quotaCanary?: string
  /** Test-only: a text holding this asks for a failure. See injected-failure.ts. */
  failureCanary?: string
}

/**
 * Stands in for the embedding provider when no credentials are configured — the
 * same principle as the stub transcriber and summarizer. Documents and queries
 * are embedded identically, as the real model does. It refuses an input over the
 * model's limit too, by its estimate, so that path runs without credentials.
 */
export function createStubEmbedder(options: StubEmbedderOptions = {}): Embedder {
  function embed(text: string): number[] {
    if (options.quotaCanary && text.includes(options.quotaCanary)) throw dailyLimitReached()
    const failure = injectedFailure(options.failureCanary, 'embed', text)
    if (failure === 'internal') throw new Error(INJECTED_FAILURE_TEXT)
    if (failure === 'rate-limited') throw new EmbeddingError(INJECTED_FAILURE_TEXT, 429, false, new Date(Date.now() + INJECTED_RATE_LIMIT_MS))
    if (failure) throw new EmbeddingError(INJECTED_FAILURE_TEXT, 502, failure === 'retryable')
    const tokens = estimateTokens(text)
    if (tokens > MAX_INPUT_TOKENS) throw new EmbeddingInputTooLongError(tokens)
    return hashedTokenVector(text)
  }

  return {
    kind: 'stub',
    model: STUB_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts) {
      return texts.map(embed)
    },
    async embedQuery(text) {
      return embed(text)
    },
  }
}
