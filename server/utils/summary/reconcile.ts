import { z } from 'zod'
import type { ActionItem, Decision, TranscriptSegment } from '#shared/types/meeting'
import { actionItemSchema, decisionSchema, type WireSummary } from '#shared/schemas/summary'
import { NO_SPACE_SCRIPT } from './plan'

/**
 * Compare loosely enough to survive punctuation and case, strictly enough that
 * unrelated text does not match.
 *
 * Letters and numbers in ANY script, not just ASCII. Transcription detects the
 * language, so restricting this to a-z silently destroyed every non-Latin
 * transcript: Japanese and Cyrillic collapsed to an empty string and were
 * rejected outright, and accented Latin was mangled into a different phrase.
 *
 * NFC-normalised before filtering, and `\p{M}` (combining marks) kept
 * alongside letters and numbers: an accent can be written as one precomposed
 * character ("é") or as a base letter plus a separate combining mark ("e" +
 * U+0301) — canonically the same text, but the old letters-and-numbers-only
 * filter silently dropped the second form's accent (stripping a combining
 * mark as if it were punctuation) while keeping the first form's intact,
 * making otherwise-identical text fail to match depending only on which
 * representation happened to be used. NFC first collapses most decomposed
 * sequences back to their precomposed form anyway; `\p{M}` covers what NFC
 * does not (no precomposed form exists for every combination).
 *
 * Punctuation BETWEEN DIGITS is the exception, spelled out as a word instead
 * of flattened to a space: a separator is what distinguishes a value from a
 * range, and dropping it made "3.5 percent" and "3-5 percent" identical, so a
 * quote could state a range the transcript never mentioned (or the reverse)
 * and still attest. Spelling it keeps both sides comparable — the transcript
 * and the quote get the same treatment — while leaving the two distinguishable.
 *
 * Exported so every place that needs to check "does this text support that
 * quote" — reconciliation itself, and the e2e/driver checks that verify its
 * output over the real route — uses the identical rule rather than a raw
 * substring check that would reject a validly-stored, punctuation-normalized
 * citation.
 */
const DIGIT_SEPARATOR_WORDS: Record<string, string> = {
  '.': ' point ',
  ',': ' comma ',
  '-': ' to ',
  '–': ' to ',
  '/': ' slash ',
  ':': ' colon ',
}

export function normalise(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?<=\p{Nd})[.,\-–/:](?=\p{Nd})/gu, match => DIGIT_SEPARATOR_WORDS[match] ?? ' ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
}

/**
 * Splits already-`normalise`d text into comparable tokens: real
 * whitespace-delimited words for scripts that use them, but EACH no-space-
 * script character (CJK, Thai) as its own token, so a run of them compares
 * the same way a raw substring search would.
 *
 * Deciding "which script" for the whole string (or even the whole quote)
 * cannot handle a single quote that mixes an entirely fabricated Latin
 * phrase with a real CJK one — "approved by everyone in 東京" needs its
 * Latin portion held to a real word boundary (there is no reason to accept
 * "approved" landing inside "disapproved" just because the same quote also
 * names a place in Japanese) and its CJK portion compared as characters, in
 * the SAME comparison. Tokenizing per-character for no-space scripts and
 * per-word otherwise does both at once: a run of CJK tokens concatenates
 * back to a substring check, while Latin tokens stay real words.
 */
// NO_SPACE_SCRIPT has no `g` flag (plan.ts only ever calls .test() with it);
// splitting every occurrence, not just the first, needs one that does.
const NO_SPACE_SCRIPT_GLOBAL = new RegExp(NO_SPACE_SCRIPT.source, 'gu')

function tokenize(text: string): string[] {
  return text
    .replace(NO_SPACE_SCRIPT_GLOBAL, match => ` ${match} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * A separator that cannot appear in a token (tokens are split ON whitespace,
 * so none contains one), used to compare/search token SEQUENCES as strings
 * without writing a manual subsequence scan.
 *
 * A plain space, deliberately — this was briefly a literal NUL byte, on the
 * theory that a more exotic character was a safer separator. It was not: a
 * space is already unambiguous for the reason above, while the NUL made git
 * classify this whole file as BINARY, so every diff of it read "Binary files
 * differ" and the citation guard became invisible to code review for five
 * rounds of it. It was also fragile in a fail-OPEN direction: any tool that
 * strips control characters from source would silently turn this into `''`,
 * and joining tokens with an empty string makes `occurs()` accept a quote
 * that lands mid-word — "approved by everyone" would attest against
 * "disapproved by everyone", the exact fabrication this file exists to
 * reject. Keep this printable; tests/unit/source-hygiene.spec.ts enforces it.
 */
const TOKEN_SEP = ' '
const tokenKey = (text: string): string => tokenize(text).join(TOKEN_SEP)

/**
 * Whether `needle` occurs in `haystack` on token boundaries — see
 * {@link tokenize} for what a "token" is per script. A raw substring check
 * accepts a quote that starts or ends mid-word: "approved by everyone" is a
 * literal substring of "disapproved by everyone", the opposite of what it
 * claims to quote, and at 20+ characters it clears the fragment floor below
 * outright.
 *
 * Exported for the same reason `normalise` is: the e2e citation assertions
 * need the identical contract, not an approximation of it. A plain
 * `normalise().includes()` (what those checks used before) both accepts a
 * mid-word fabrication and rejects a legitimate no-space-script citation
 * that differs from the transcript only by punctuation — the exact two bugs
 * this function exists to avoid, reintroduced one layer up in whatever
 * verifies its output.
 */
export function occurs(haystack: string, needle: string): boolean {
  const needleKey = tokenKey(needle)
  if (!needleKey) return false
  return `${TOKEN_SEP}${tokenKey(haystack)}${TOKEN_SEP}`.includes(`${TOKEN_SEP}${needleKey}${TOKEN_SEP}`)
}

/**
 * Shortest FRAGMENT worth attesting; below this a match is likely accidental
 * and, more to the point, proves too little to back a specific claim — a short
 * generic phrase ("the vendor", "next week") occurs constantly and can be
 * paired with a decision it has nothing to do with.
 *
 * A quote that is the cited segment's ENTIRE text is exempted down to
 * {@link MIN_FULL_SEGMENT_QUOTE_CHARS}: there is no larger context it could be
 * cherry-picked from, so a short whole utterance ("Agreed.") is exactly as
 * trustworthy as a long one.
 */
const MIN_QUOTE_CHARS = 20
const MIN_FULL_SEGMENT_QUOTE_CHARS = 2

/**
 * What one character of a no-space script is worth against the floor above.
 *
 * A raw character count is not a comparable measure of "how specific is this
 * quote" across scripts, and treating it as one made the floor a far stricter
 * rule for Japanese, Chinese, Thai, Khmer, Lao, Burmese and Tibetan than for
 * Latin rather than the "longer phrase than it looks" the old comment here
 * claimed. Twenty characters of English is three or four words; twenty
 * characters of Japanese is a whole sentence. Measured against the real
 * implementation, 来週までに新しい見積もりを提出すること — nineteen characters, a
 * complete and entirely specific clause — was rejected, so a CJK meeting
 * produced citations only when the model happened to quote a segment in full.
 *
 * 2.5 is a judgement, not a measurement: one such character is roughly a
 * morpheme, so equal SPECIFICITY would argue for a weight near 5 (four
 * characters ≈ four English words). This deliberately stops well short of
 * that, buying back the clearly-specific clauses without lowering the bar to
 * the two- or three-character phrases that really are generic.
 */
const NO_SPACE_CHAR_WEIGHT = 2.5

/**
 * Length of a quote in units comparable across scripts — see
 * {@link NO_SPACE_CHAR_WEIGHT}.
 *
 * Code points, not `.length`: a supplementary-plane character (a real if
 * uncommon Han ideograph) is ONE character but TWO UTF-16 units, so counting
 * units would let it clear a floor it should not — plan.ts counts the same way
 * for the same reason.
 */
function weightedLength(text: string): number {
  let total = 0
  for (const character of text) {
    total += NO_SPACE_SCRIPT.test(character) ? NO_SPACE_CHAR_WEIGHT : 1
  }
  return total
}

export interface Attested {
  segmentIdx: number
  startMs: number
  quote: string
}

interface Candidate {
  segment: TranscriptSegment
  distance: number
  /** Whether the quote is this segment's entire text, not merely a fragment of it. */ full: boolean
}

/**
 * Find where a quote actually occurs in the transcript.
 *
 * Returns null when it occurs nowhere, which is the case that matters: a model
 * asked to cite its evidence will sometimes produce a fluent quote that nobody
 * said. Checking is cheap and the alternative is a summary that reads as
 * authoritative while pointing at nothing.
 *
 * Among everywhere it occurs, prefers a full-segment match over a fragment
 * match, then the occurrence nearest the model's claimed index — a model that
 * gets the words right and the index slightly wrong is far more common than
 * one that invents both, and repeated short phrases ("sounds good", "let's
 * move on") occur throughout an ordinary meeting, so picking the first
 * occurrence in transcript order (rather than the nearest) would routinely
 * attribute a citation to the wrong moment.
 *
 * This proves the quoted words were said; it does not prove the model's claim
 * about them is accurate. A short but real quote can still be paired with an
 * unrelated decision — closing that needs a semantic check against a judge
 * model, which would spend the same scarce quota this design protects, and is
 * deferred (see ADR-0006).
 */
export function attestQuote(
  quote: string,
  claimedIdx: number,
  segments: TranscriptSegment[],
): Attested | null {
  const needle = normalise(quote)
  if (!needle) return null
  const needleKey = tokenKey(needle)
  // Two different questions, so two different measures.
  //
  // The FRAGMENT floor asks "is this specific enough to pin a claim to", which
  // is not comparable across scripts by raw character count — see
  // weightedLength and NO_SPACE_CHAR_WEIGHT.
  const needleWeighted = weightedLength(needle)
  // The FULL-SEGMENT floor asks only "is this a real utterance at all", since
  // a whole segment cannot have been cherry-packed out of a larger context.
  // Raw characters are the right measure there, in Unicode CODE POINTS rather
  // than `.length`: one supplementary-plane character is a single character but
  // TWO UTF-16 units, and would otherwise clear a floor of 2 on its own.
  const needleCodePoints = [...needle].length

  const candidates: Candidate[] = []
  for (const segment of segments) {
    const segmentText = normalise(segment.text)
    // Same tokenizing as occurs() below, and for the same reason: a
    // no-space script's "entire text" still has to match despite a
    // punctuation-turned-space difference (a comma the model's quote omits,
    // say) that a whitespace-sensitive script would rightly treat as real.
    const full = tokenKey(segmentText) === needleKey
    if (!full && !occurs(segmentText, needle)) continue
    candidates.push({ segment, distance: Math.abs(segment.idx - claimedIdx), full })
  }

  const usable = candidates.filter(c => c.full
    ? needleCodePoints >= MIN_FULL_SEGMENT_QUOTE_CHARS
    : needleWeighted >= MIN_QUOTE_CHARS)
  if (usable.length === 0) return null

  usable.sort((a, b) => (a.full === b.full ? a.distance - b.distance : Number(b.full) - Number(a.full)))
  const best = usable[0]!.segment
  return { segmentIdx: best.idx, startMs: best.startMs, quote: quote.trim() }
}

export interface Reconciled {
  decisions: Decision[]
  actionItems: ActionItem[]
  /** Items dropped because nothing in the transcript supported them. */
  droppedDecisions: number
  droppedActionItems: number
}

/**
 * Keep only what the transcript supports, and resolve every timestamp here
 * rather than trusting one the model supplied.
 *
 * This is the single place model output becomes stored data, so it is the only
 * place a hallucinated citation can be stopped.
 */
export function reconcile(model: WireSummary, segments: TranscriptSegment[]): Reconciled {
  const decisions: Decision[] = []
  const actionItems: ActionItem[] = []
  let droppedDecisions = 0
  let droppedActionItems = 0

  const seenDecisions = new Set<string>()
  for (const item of model.decisions) {
    const attested = attestQuote(item.quote, item.segmentIdx, segments)
    const text = item.decision.trim()
    if (!attested || !text) {
      droppedDecisions++
      continue
    }
    // The same decision restated at the same moment is one decision. Chunked
    // transcripts make this common at boundaries.
    const key = `${attested.segmentIdx}:${normalise(text)}`
    // Counted as dropped, because it was: `kept + dropped` is meant to account
    // for everything the model sent, and skipping silently here made it
    // under-report exactly when chunk boundaries produce the duplicates the
    // comment above says are common.
    if (seenDecisions.has(key)) {
      droppedDecisions++
      continue
    }
    seenDecisions.add(key)
    decisions.push({ idx: 0, decision: text, ...attested })
  }

  const seenActions = new Set<string>()
  for (const item of model.actionItems) {
    const attested = attestQuote(item.quote, item.segmentIdx, segments)
    const task = item.task.trim()
    if (!attested || !task) {
      droppedActionItems++
      continue
    }
    const key = `${attested.segmentIdx}:${normalise(task)}`
    if (seenActions.has(key)) {
      droppedActionItems++
      continue
    }
    seenActions.add(key)
    actionItems.push({
      idx: 0,
      task,
      // Empty strings are the model declining to answer in a field it was
      // forced to fill; store that as "nobody was named", not as a name.
      assignee: item.assignee?.trim() || null,
      dueDateText: item.dueDateText?.trim() || null,
      ...attested,
    })
  }

  const finalDecisions = renumber(decisions.sort(byTime))
  const finalActionItems = renumber(actionItems.sort(byTime))

  // decisionSchema/actionItemSchema are not asked of the model (see the wire
  // schema's docstring) — they describe what THIS function is supposed to
  // produce. Asserting the shape here turns a future bug in this function into
  // a loud failure instead of a malformed row silently reaching storage.
  z.array(decisionSchema).parse(finalDecisions)
  z.array(actionItemSchema).parse(finalActionItems)

  return {
    decisions: finalDecisions,
    actionItems: finalActionItems,
    droppedDecisions,
    droppedActionItems,
  }
}

const byTime = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs
const renumber = <T extends { idx: number }>(items: T[]): T[] =>
  items.map((item, idx) => ({ ...item, idx }))
