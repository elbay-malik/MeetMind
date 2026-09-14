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
 * words. Japanese, Chinese, Thai, Khmer, Lao, Burmese and Tibetan do not, so a
 * long utterance in one of them collapses to a single whitespace-delimited
 * "word" no matter how long it really is — silently defeating the budget this
 * function exists to enforce, for exactly the languages transcription already
 * supports (it takes an optional language hint, not an English-only
 * assumption). A ratio-based check on the whitespace split cannot tell this
 * apart from ordinary English: a script with no spaces at all still produces
 * exactly one "word" (the whole string), so its chars-per-word ratio scales
 * with text length rather than signalling anything. Detecting the script
 * directly is the reliable test, so text in one of those scripts is costed per
 * character instead: those tokenizers run close to one token per character.
 * Any OTHER text still gets a per-character floor as well — see
 * CHARS_PER_TOKEN_FLOOR, which is what stops a missing script from being
 * catastrophic rather than merely inaccurate.
 */
// Exported: reconcile.ts's citation matching needs the same "does this
// script actually use whitespace between words" test, for the same
// underlying reason (a whitespace-shaped rule silently does the wrong
// thing for these scripts). Unicode Script properties, not hand-rolled
// code point ranges: Han in particular extends into the supplementary
// planes (U+20000 and up, in real if uncommon characters), which a range
// copied from a BMP-only chart silently excludes -- collapsing right back
// to the bug this exists to fix, just for a narrower set of characters.
//
// The SET of scripts is the part that has to stay complete, and it is the part
// that was wrong: this listed only Han/Hiragana/Katakana/Thai, while Whisper
// transcribes Khmer, Lao, Burmese and Tibetan too -- all written without
// spaces between words. Measured on one hour of transcript, Thai planned to 9
// chunks and the identical volume of Khmer planned to 1, carrying the same
// 34,320 characters into a single request: the same defeat of the budget this
// exists to prevent, for a different set of languages. Adding a script here is
// what it takes to price and match that language correctly; the floor in
// estimateTokens below is what keeps an omission from being catastrophic.
export const NO_SPACE_SCRIPT
  = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Thai}|\p{Script=Khmer}|\p{Script=Lao}|\p{Script=Myanmar}|\p{Script=Tibetan}/u

/**
 * Lower bound on tokens per character for text with no detected no-space
 * script. Whitespace-delimited counting assumes whitespace exists: a single
 * run of 5,000 characters with no space in it counts as ONE word and prices at
 * 6 tokens, whatever script it is in. Four characters per token is the
 * long-standing rule of thumb for Latin text and an underestimate for
 * everything else, so taking it as a floor cannot over-chunk ordinary prose
 * (an English sentence's word-based estimate is already the larger of the two)
 * while making a run-on of any length impossible to under-price by orders of
 * magnitude. A safety net for the script list above being incomplete again,
 * not a substitute for it.
 */
const CHARS_PER_TOKEN_FLOOR = 4

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const characters = [...trimmed].length
  if (NO_SPACE_SCRIPT.test(trimmed)) return characters + 4
  const words = trimmed.split(/\s+/).filter(Boolean).length
  return Math.max(
    Math.ceil(words * 1.4),
    Math.ceil(characters / CHARS_PER_TOKEN_FLOOR),
  ) + 4
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
