import type { TranscriptSegment } from '#shared/types/meeting'

/**
 * Rough token count for transcript text.
 *
 * Deliberately an estimate, not a tokenizer: pulling one in to decide how to
 * split a transcript would cost more than being slightly conservative. English
 * runs about 1.35 tokens per word; this rounds up so a chunk that fits the
 * estimate fits the real budget too.
 *
 * Splitting on whitespace assumes the script actually uses spaces between
 * words. Japanese, Chinese and Thai do not, so a long utterance in one of them
 * collapses to a single whitespace-delimited "word" no matter how long it
 * really is — silently defeating the budget this function exists to enforce,
 * for exactly the languages transcription already supports (it takes an
 * optional language hint, not an English-only assumption). A ratio-based
 * check on the whitespace split cannot tell this apart from ordinary English:
 * a script with no spaces at all still produces exactly one "word" (the whole
 * string), so its chars-per-word ratio scales with text length rather than
 * signalling anything. Detecting the script directly is the only reliable
 * test, so any text containing Hiragana, Katakana, CJK ideographs or Thai
 * characters is costed per character instead: those tokenizers run close to
 * one token per character.
 */
// Exported: reconcile.ts's citation matching needs the same "does this
// script actually use whitespace between words" test, for the same
// underlying reason (a whitespace-shaped rule silently does the wrong
// thing for these scripts).
export const NO_SPACE_SCRIPT = /[฀-๿぀-ヿ㐀-䶿一-鿿豈-﫿]/

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  if (NO_SPACE_SCRIPT.test(trimmed)) return [...trimmed].length + 4
  const words = trimmed.split(/\s+/).filter(Boolean).length
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
 * exceeds it in a single request — a local one-hour recording reaches that
 * (see ADR-0002; the fixture itself is gitignored, not committed), so it is
 * not a hypothetical.
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
