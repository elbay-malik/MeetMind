import { normalise, tokenize } from '../summary/reconcile'
import { EMBEDDING_DIMENSIONS, type Embedder } from './embedder'

export const STUB_EMBEDDING_MODEL = 'stub-hashed-tokens-v1'

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

/**
 * Stands in for the embedding provider when no API key is configured — the same
 * principle as the stub transcriber and summarizer. Documents and queries are
 * embedded identically: the provider's query/document prefixes exist to align
 * two differently-shaped inputs, and a bag of tokens has no such asymmetry.
 */
export function createStubEmbedder(): Embedder {
  return {
    kind: 'stub',
    model: STUB_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts) {
      return texts.map(text => hashedTokenVector(text))
    },
    async embedQuery(text) {
      return hashedTokenVector(text)
    },
  }
}
