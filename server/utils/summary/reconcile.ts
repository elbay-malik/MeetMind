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
 * Exported so every place that needs to check "does this text support that
 * quote" — reconciliation itself, and the e2e/driver checks that verify its
 * output over the real route — uses the identical rule rather than a raw
 * substring check that would reject a validly-stored, punctuation-normalized
 * citation.
 */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * For a no-space script, strips ALL whitespace rather than leaving
 * `normalise`'s single spaces in place. Those spaces stand in for whatever
 * punctuation used to be there (a comma the model's quote omits, say), and
 * scripts with no whitespace between words have no reliable word boundary
 * for that residual space to preserve — so a real citation differing from
 * the transcript only by a comma would otherwise fail to match by exactly
 * that one space. Left alone for scripts that actually use whitespace to
 * separate words, where the space is load-bearing.
 */
function compactIfNoSpaceScript(text: string): string {
  return NO_SPACE_SCRIPT.test(text) ? text.replace(/\s+/gu, '') : text
}

/**
 * Whether `needle` occurs in `haystack` on token boundaries, for scripts that
 * actually separate words with whitespace. A raw substring check accepts a
 * quote that starts or ends mid-word: "approved by everyone" is a literal
 * substring of "disapproved by everyone", the opposite of what it claims to
 * quote, and at 20+ characters it clears the fragment floor below outright.
 * Scripts with no whitespace between words (CJK, Thai) have no such boundary
 * to require — a real substring there is a legitimate sub-phrase, not a
 * mid-word accident, so those keep plain substring matching, on whitespace
 * fully stripped rather than merely normalised (see compactIfNoSpaceScript).
 *
 * The choice is made from the QUOTE alone, not the segment: a segment can
 * legitimately mix scripts (an English sentence naming a place in Japanese),
 * and checking the whole haystack would fall back to substring matching for
 * an ENTIRELY LATIN quote just because the segment it is being checked
 * against happens to also contain an unrelated CJK character elsewhere —
 * reintroducing the exact mid-word fabrication this function exists to catch.
 */
function occurs(haystack: string, needle: string): boolean {
  if (NO_SPACE_SCRIPT.test(needle)) {
    return compactIfNoSpaceScript(haystack).includes(compactIfNoSpaceScript(needle))
  }
  return ` ${haystack} `.includes(` ${needle} `)
}

/**
 * Shortest FRAGMENT worth attesting; below this a match is likely accidental
 * and, more to the point, proves too little to back a specific claim — a short
 * generic phrase ("the vendor", "next week") occurs constantly and can be
 * paired with a decision it has nothing to do with. Counted in characters, so
 * for scripts written without spaces this is a longer phrase than it looks.
 *
 * A quote that is the cited segment's ENTIRE text is exempted down to
 * {@link MIN_FULL_SEGMENT_QUOTE_CHARS}: there is no larger context it could be
 * cherry-picked from, so a short whole utterance ("Agreed.") is exactly as
 * trustworthy as a long one.
 */
const MIN_QUOTE_CHARS = 20
const MIN_FULL_SEGMENT_QUOTE_CHARS = 2

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

  const candidates: Candidate[] = []
  for (const segment of segments) {
    const segmentText = normalise(segment.text)
    // Same compaction as occurs() below, and for the same reason: a no-space
    // script's "entire text" still has to match despite a punctuation-turned-
    // space difference (a comma the model's quote omits, say) that a
    // whitespace-sensitive script would rightly treat as a real distinction.
    const full = NO_SPACE_SCRIPT.test(needle)
      ? compactIfNoSpaceScript(segmentText) === compactIfNoSpaceScript(needle)
      : segmentText === needle
    if (!full && !occurs(segmentText, needle)) continue
    candidates.push({ segment, distance: Math.abs(segment.idx - claimedIdx), full })
  }

  const usable = candidates.filter(c =>
    needle.length >= (c.full ? MIN_FULL_SEGMENT_QUOTE_CHARS : MIN_QUOTE_CHARS))
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
    if (seenDecisions.has(key)) continue
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
    if (seenActions.has(key)) continue
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
