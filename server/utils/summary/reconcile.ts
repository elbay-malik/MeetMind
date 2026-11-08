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

// Exported for the stub embedder (server/utils/qa/stub.ts), which buckets the
// same script-aware tokens so retrieval in credential-free tests behaves like
// matching does here rather than like an unrelated tokenizer.
export function tokenize(text: string): string[] {
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

/**
 * How many consecutive segments one quote may run across.
 *
 * Whisper ends a segment at a pause or a length limit, not at the end of a
 * sentence, so an ordinary sentence is regularly split over two segments
 * ("...we agreed to keep the current" / "scope for customer onboarding..."). A
 * model quoting that sentence verbatim is right, and requiring the quote to sit
 * inside one segment threw it away: measured on a one-hour meeting, 57 of 73
 * correctly quoted action items and 29 of 73 decisions were dropped that way,
 * with nothing to say so. Three covers a long sentence over short segments
 * without letting a "quote" stitch together remarks from across the meeting.
 */
export const MAX_QUOTE_SEGMENTS = 3

const bounded = (key: string): string => `${TOKEN_SEP}${key}${TOKEN_SEP}`
const containsKey = (haystackKey: string, needleKey: string): boolean =>
  bounded(haystackKey).includes(bounded(needleKey))

/**
 * How many segments, starting at `position`, the quote runs across: the
 * shortest run of consecutive segments (by index, not merely adjacent in the
 * array -- a gap is a different moment) that contains it, or 0 when none does.
 *
 * Also 0 when the quote fits wholly inside the later part of that run: then it
 * starts in a later segment, and is found from there. A citation always points
 * at the segment the quoted words BEGIN in, which is where a listener has to
 * seek to hear them.
 */
function spanFrom(segments: readonly TranscriptSegment[], keys: readonly string[], position: number, needleKey: string): number {
  const join = (from: number, to: number) => keys.slice(from, to + 1).filter(Boolean).join(TOKEN_SEP)
  for (let length = 1; length <= MAX_QUOTE_SEGMENTS; length++) {
    const last = position + length - 1
    if (last >= segments.length) return 0
    if (length > 1 && segments[last]!.idx !== segments[last - 1]!.idx + 1) return 0
    if (!containsKey(join(position, last), needleKey)) continue
    // "Without the segment it would begin in", sliced BEFORE wordless segments
    // are dropped. Whisper emits those ("...", a music note) and normalisation
    // keeps them; slicing the filtered run instead removed the next segment
    // with words, so a wordless one just before a quote was cited as its start
    // and the citation sought the listener to the music, not the words.
    if (length > 1 && containsKey(join(position + 1, last), needleKey)) return 0
    return length
  }
  return 0
}

/** Each segment's normalised tokens, the form every comparison here is made in. */
const segmentKeys = (segments: readonly TranscriptSegment[]): string[] =>
  segments.map(segment => tokenKey(normalise(segment.text)))

/**
 * Whether `quote` begins in the segment with index `segmentIdx` -- the contract
 * every stored citation satisfies, allowing for a quote that runs on into the
 * next segment or two. For checks made outside reconciliation (the e2e suite,
 * and its plain-JS mirror in scripts/lib/citation-match.mjs).
 */
export function quoteStartsAt(segments: readonly TranscriptSegment[], segmentIdx: number, quote: string): boolean {
  const position = segments.findIndex(segment => segment.idx === segmentIdx)
  const needleKey = tokenKey(normalise(quote))
  if (position < 0 || !needleKey) return false
  return spanFrom(segments, segmentKeys(segments), position, needleKey) > 0
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
  segments: readonly TranscriptSegment[],
): Attested | null {
  return createQuoteAttester(segments)(quote, claimedIdx)
}

/**
 * {@link attestQuote} for many quotes against one transcript: each segment is
 * normalised and tokenized once rather than once per quote. Reconciliation
 * checks every item of a summary against every segment of the meeting, which
 * ADR-0009 lists among the routes' CPU costs on Workers.
 */
export function createQuoteAttester(
  segments: readonly TranscriptSegment[],
): (quote: string, claimedIdx: number) => Attested | null {
  const keys = segmentKeys(segments)
  return (quote, claimedIdx) => attestAgainst(quote, claimedIdx, segments, keys)
}

function attestAgainst(
  quote: string,
  claimedIdx: number,
  segments: readonly TranscriptSegment[],
  keys: readonly string[],
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

  if (!needleKey) return null

  const candidates: Candidate[] = []
  for (const [position, segment] of segments.entries()) {
    // Compared as token keys, the same as occurs(), and for the same reason:
    // a no-space script's "entire text" still has to match despite a
    // punctuation-turned-space difference (a comma the model's quote omits,
    // say) that a whitespace-sensitive script would rightly treat as real.
    const full = keys[position] === needleKey
    const length = full ? 1 : spanFrom(segments, keys, position, needleKey)
    if (length === 0) continue
    // Nearest to the claim anywhere in the span: a model may give the number
    // of any line its quote touches, not only the first.
    let distance = Infinity
    for (let i = position; i < position + length; i++) {
      distance = Math.min(distance, Math.abs(segments[i]!.idx - claimedIdx))
    }
    candidates.push({ segment, distance, full })
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
 * One chunk's extraction with every quote checked against that chunk's lines,
 * and nothing else done to it yet: not deduplicated, sorted or numbered, since
 * that needs every chunk. Plain data, so a step-wise pipeline can store it
 * between requests (ADR-0012).
 */
export interface AttestedChunk {
  summary: string
  decisions: Omit<Decision, 'idx'>[]
  actionItems: Omit<ActionItem, 'idx'>[]
  /** Items dropped because nothing in the chunk supported them. */
  droppedDecisions: number
  droppedActionItems: number
}

/**
 * An {@link AttestedChunk} as read back from storage. Stored chunks come back
 * as untyped JSON, and `mergeReconciled` trusts its input, so whatever a
 * pipeline step reads back is checked against this before it is merged.
 */
export const attestedChunkSchema = z.object({
  summary: z.string(),
  decisions: z.array(decisionSchema.omit({ idx: true })),
  actionItems: z.array(actionItemSchema.omit({ idx: true })),
  droppedDecisions: z.int().nonnegative(),
  droppedActionItems: z.int().nonnegative(),
}) satisfies z.ZodType<AttestedChunk>

/**
 * Keep only what the chunk supports, and resolve every timestamp here rather
 * than trusting one the model supplied.
 *
 * This is the single place model output becomes stored data, so it is the only
 * place a hallucinated citation can be stopped.
 *
 * Checked against the chunk alone: the model is shown exactly these lines, so
 * an honest quote can only come from them. A quote that matches only some
 * other chunk is one the model did not read there, and is dropped; one that
 * also occurs in another chunk is cited where the model read it (ADR-0006,
 * addendum on chunk-local attestation).
 */
export function attestChunk(model: WireSummary, segments: readonly TranscriptSegment[]): AttestedChunk {
  const attest = createQuoteAttester(segments)
  const decisions: AttestedChunk['decisions'] = []
  const actionItems: AttestedChunk['actionItems'] = []
  let droppedDecisions = 0
  let droppedActionItems = 0

  for (const item of model.decisions) {
    const attested = attest(item.quote, item.segmentIdx)
    const text = item.decision.trim()
    if (!attested || !text) {
      droppedDecisions++
      continue
    }
    decisions.push({ decision: text, ...attested })
  }

  for (const item of model.actionItems) {
    const attested = attest(item.quote, item.segmentIdx)
    const task = item.task.trim()
    if (!attested || !task) {
      droppedActionItems++
      continue
    }
    actionItems.push({
      task,
      // Empty strings are the model declining to answer in a field it was
      // forced to fill; store that as "nobody was named", not as a name.
      assignee: item.assignee?.trim() || null,
      dueDateText: item.dueDateText?.trim() || null,
      ...attested,
    })
  }

  return { summary: model.summary.trim(), decisions, actionItems, droppedDecisions, droppedActionItems }
}

/**
 * Join attested chunks, in chunk order, into the stored summary: duplicates
 * removed, items in time order and numbered without gaps.
 *
 * Two rules remove duplicates. The same item cited on the same line in the
 * same words is one item, wherever it came from. And an item two neighbouring
 * chunks each report from their side of the boundary between them is one item
 * (see BOUNDARY_LINES): the fuller action item is kept, or the earlier when
 * neither has more details, with a detail only the other gives filled in.
 * Works on chunk results as stored, so meetings extracted before the second
 * rule finalize the same way.
 */
export function mergeReconciled(chunks: readonly AttestedChunk[]): Reconciled & { summary: string } {
  let droppedDecisions = 0
  let droppedActionItems = 0

  // The same decision restated at the same moment is one decision. Chunked
  // transcripts make this common at boundaries.
  //
  // Counted as dropped, because it was: `kept + dropped` is meant to account
  // for everything the model sent, and skipping silently here made it
  // under-report exactly when chunk boundaries produce the duplicates the
  // comment above says are common.
  const seenDecisions = new Set<string>()
  const decisions: Decision[] = []
  const seenActions = new Set<string>()
  const actionItems: ActionItem[] = []
  // Positions, in the lists above, of what the PREVIOUS chunk kept and no
  // boundary pair has claimed yet: the only items the boundary rule may join
  // a chunk's items to (see sameAcrossBoundary).
  let previousDecisions: number[] = []
  let previousActions: number[] = []
  for (const chunk of chunks) {
    droppedDecisions += chunk.droppedDecisions
    droppedActionItems += chunk.droppedActionItems
    const currentDecisions: number[] = []
    for (const item of chunk.decisions) {
      const key = `${item.segmentIdx}:${normalise(item.decision)}`
      if (seenDecisions.has(key)) {
        droppedDecisions++
        continue
      }
      seenDecisions.add(key)
      const partner = takePartner<Omit<Decision, 'idx'>>(previousDecisions, decisions, item, d => d.decision, () => true)
      if (partner !== null) {
        // A decision has no field for either side to fill, so the earlier
        // report is kept as it stands.
        droppedDecisions++
        continue
      }
      currentDecisions.push(decisions.push({ idx: 0, ...item }) - 1)
    }
    const currentActions: number[] = []
    for (const item of chunk.actionItems) {
      const key = `${item.segmentIdx}:${normalise(item.task)}`
      if (seenActions.has(key)) {
        droppedActionItems++
        continue
      }
      seenActions.add(key)
      const partner = takePartner<Omit<ActionItem, 'idx'>>(previousActions, actionItems, item, a => a.task, sameAssignee)
      if (partner !== null) {
        actionItems[partner] = joinActions(actionItems[partner]!, item)
        droppedActionItems++
        continue
      }
      currentActions.push(actionItems.push({ idx: 0, ...item }) - 1)
    }
    previousDecisions = currentDecisions
    previousActions = currentActions
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
    summary: chunks.map(c => c.summary).filter(Boolean).join(' '),
    decisions: finalDecisions,
    actionItems: finalActionItems,
    droppedDecisions,
    droppedActionItems,
  }
}

/**
 * {@link attestChunk} and {@link mergeReconciled} over one model reply for the
 * whole of `segments`.
 */
export function reconcile(model: WireSummary, segments: TranscriptSegment[]): Reconciled {
  const { summary: _summary, ...reconciled } = mergeReconciled([attestChunk(model, segments)])
  return reconciled
}

/**
 * How far apart, in lines, two reports from neighbouring chunks may cite and
 * still be one item spoken across the boundary between them.
 *
 * Each chunk is shown only its own lines (ADR-0006, chunk-local attestation),
 * so an item proposed on a chunk's last line and settled on the next chunk's
 * first ("Let me look into that first." / "So the action is: Tom checks
 * whether...") is read in part by both, and each reports it from its side, in
 * its own words. The same-line key above cannot join those: they cite
 * different lines, and the wording differs too much for a similarity score to
 * be trusted. Two lines either side is a proposal and its confirmation, not
 * a stretch of discussion. Items cite only lines of their own chunk, so a pair
 * from neighbouring chunks this close together is necessarily at the boundary;
 * items within one chunk are never compared.
 */
export const BOUNDARY_LINES = 2

/**
 * How two boundary reports must overlap in words to be one item. Being next to
 * each other is not enough on its own: two different things are sometimes
 * agreed one line apart, and joining them loses one. Nor is one shared word:
 * reports of different items open with the same verbs ("Agreed to ship the
 * release on Friday" / "Agreed to freeze the public API until March", "Update
 * the onboarding guide" / "Update the billing service client"), and decisions
 * have no assignee to tell them apart. So the pair must share at least
 * {@link BOUNDARY_SHARED_WORDS} content words, and those must be at least
 * {@link BOUNDARY_SHARED_SHARE} of the shorter report's content words: what a
 * restatement of the same task does ("paging", "tool", "directory"), and two
 * different tasks seldom do.
 *
 * A content word is a token of {@link BOUNDARY_WORD_CHARS} characters or
 * more that is not in {@link BOUNDARY_COMMON_WORDS}. Counted in characters, so
 * a script written without spaces, whose tokens are single characters (see
 * tokenize), never has one: those meetings keep the same-line rule alone, as
 * before, rather than a guess.
 */
const BOUNDARY_WORD_CHARS = 4
const BOUNDARY_SHARED_WORDS = 2
const BOUNDARY_SHARED_SHARE = 0.5

/**
 * Words that say nothing about which item a report is: function words long
 * enough to pass {@link BOUNDARY_WORD_CHARS}, and the verbs and phrases
 * decisions and action items are usually reported with. Lowercase, as after
 * `normalise`.
 */
const BOUNDARY_COMMON_WORDS = new Set([
  // Function words.
  'about', 'above', 'after', 'again', 'also', 'been', 'before', 'being', 'both', 'could', 'does', 'doing',
  'done', 'each', 'even', 'every', 'from', 'have', 'having', 'here', 'into', 'just', 'like', 'more', 'most',
  'much', 'must', 'once', 'only', 'onto', 'other', 'over', 'same', 'shall', 'should', 'some', 'such', 'than',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'upon', 'very', 'want', 'wants', 'well', 'were', 'what', 'when', 'where', 'whether', 'which', 'while',
  'will', 'with', 'within', 'without', 'would', 'your',
  // How decisions and action items are reported.
  'agree', 'agreed', 'agrees', 'assign', 'assigned', 'back', 'check', 'checks', 'confirm', 'confirmed',
  'confirms', 'decide', 'decided', 'decides', 'decision', 'follow', 'follows', 'going', 'investigate',
  'investigates', 'look', 'looks', 'make', 'makes', 'need', 'needs', 'next', 'report', 'reports', 'review',
  'reviews', 'sure', 'take', 'takes', 'task', 'team', 'update', 'updates', 'week',
])

const contentWords = (text: string): Set<string> =>
  new Set(tokenize(normalise(text)).filter(word =>
    [...word].length >= BOUNDARY_WORD_CHARS && !BOUNDARY_COMMON_WORDS.has(word)))

/**
 * Whether `earlier`, kept from the previous chunk, and `later`, reported by
 * the next one, are the same item spoken across the boundary between them: at
 * most {@link BOUNDARY_LINES} apart, overlapping in content words as
 * {@link BOUNDARY_SHARED_WORDS} describes, and allowed by `compatible` (for
 * action items, no two different assignees).
 */
function sameAcrossBoundary<T extends { segmentIdx: number }>(
  earlier: T,
  later: T,
  text: (item: T) => string,
  compatible: (a: T, b: T) => boolean,
): boolean {
  if (Math.abs(later.segmentIdx - earlier.segmentIdx) > BOUNDARY_LINES) return false
  if (!compatible(earlier, later)) return false
  const a = contentWords(text(earlier))
  const b = contentWords(text(later))
  let shared = 0
  for (const word of b) if (a.has(word)) shared++
  return shared >= BOUNDARY_SHARED_WORDS && shared >= BOUNDARY_SHARED_SHARE * Math.min(a.size, b.size)
}

/**
 * The position in `kept` of the previous chunk's item that `item` restates
 * across the boundary, the nearest by line when several do, or null. A
 * position is taken out of `candidates` once used, so each item joins at most
 * one other.
 */
function takePartner<T extends { segmentIdx: number }>(
  candidates: number[],
  kept: readonly T[],
  item: T,
  text: (item: T) => string,
  compatible: (a: T, b: T) => boolean,
): number | null {
  const distance = (position: number) => Math.abs(kept[position]!.segmentIdx - item.segmentIdx)
  let best = -1
  for (const [i, position] of candidates.entries()) {
    if (!sameAcrossBoundary(kept[position]!, item, text, compatible)) continue
    if (best < 0 || distance(position) < distance(candidates[best]!)) best = i
  }
  if (best < 0) return null
  return candidates.splice(best, 1)[0]!
}

/** Two assignees that can be the same person: the same name, or one not given. */
const sameAssignee = (a: { assignee: string | null }, b: { assignee: string | null }): boolean =>
  a.assignee === null || b.assignee === null || normalise(a.assignee) === normalise(b.assignee)

/**
 * One action item from a boundary pair: the report with more details kept,
 * or the earlier when neither has more, with a detail only the other gives
 * (an assignee, a spoken due date) filled in from it rather than lost.
 */
function joinActions(earlier: ActionItem, later: Omit<ActionItem, 'idx'>): ActionItem {
  const [fuller, other] = filledFields(later) > filledFields(earlier) ? [later, earlier] : [earlier, later]
  return {
    ...fuller,
    idx: 0,
    assignee: fuller.assignee ?? other.assignee,
    dueDateText: fuller.dueDateText ?? other.dueDateText,
  }
}

/** How many of an action item's optional details are given; the fuller of a boundary pair is kept. */
const filledFields = (item: { assignee: string | null, dueDateText: string | null }): number =>
  Number(item.assignee !== null) + Number(item.dueDateText !== null)

const byTime = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs
const renumber = <T extends { idx: number }>(items: T[]): T[] =>
  items.map((item, idx) => ({ ...item, idx }))
