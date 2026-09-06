import type { TranscriptSegment } from '#shared/types/meeting'

/**
 * Rough token count for transcript text.
 *
 * Deliberately an estimate, not a tokenizer: pulling one in to decide how to
 * split a transcript would cost more than being slightly conservative. English
 * runs about 1.35 tokens per word; this rounds up so a chunk that fits the
 * estimate fits the real budget too.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.ceil(words * 1.4) + 4
}

/** A contiguous run of segments small enough to summarise in one request. */
export interface Chunk {
  segments: TranscriptSegment[]
  startMs: number
  endMs: number
  estimatedTokens: number
}

/**
 * Split a transcript into request-sized chunks.
 *
 * Splits on segment boundaries, never inside one: segments are the unit the
 * rest of the system speaks in, they carry the index and offset every citation
 * needs, and they do not cut sentences in half.
 *
 * Chunking is not optional at the sizes this app accepts. The provider's
 * per-minute token allowance is the binding limit, and a one-hour meeting
 * exceeds it in a single request — the repository's own one-hour fixture
 * reaches that, so it is not a hypothetical.
 */
export function planChunks(segments: TranscriptSegment[], budgetTokens: number): Chunk[] {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new Error(`budgetTokens must be a positive number, got ${budgetTokens}`)
  }
  if (segments.length === 0) return []

  const chunks: Chunk[] = []
  let current: TranscriptSegment[] = []
  let tokens = 0

  for (const segment of segments) {
    const cost = estimateTokens(segment.text)
    // A single segment over budget still has to go somewhere; give it its own
    // chunk rather than dropping transcript on the floor.
    if (current.length > 0 && tokens + cost > budgetTokens) {
      chunks.push(toChunk(current, tokens))
      current = []
      tokens = 0
    }
    current.push(segment)
    tokens += cost
  }
  if (current.length > 0) chunks.push(toChunk(current, tokens))
  return chunks
}

function toChunk(segments: TranscriptSegment[], estimatedTokens: number): Chunk {
  return {
    segments,
    startMs: segments[0]!.startMs,
    endMs: segments.at(-1)!.endMs,
    estimatedTokens,
  }
}
