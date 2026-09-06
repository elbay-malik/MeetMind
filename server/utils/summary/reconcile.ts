import type { ActionItem, Decision, TranscriptSegment } from '#shared/types/meeting'
import type { WireSummary } from '#shared/schemas/summary'

/**
 * Compare loosely enough to survive punctuation and case, strictly enough that
 * unrelated text does not match.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** How far either side of the claimed segment to look before searching wider. */
const NEARBY_SEGMENTS = 2

/** Shortest quote worth attesting; below this, matches are accidental. */
const MIN_QUOTE_CHARS = 8

export interface Attested {
  segmentIdx: number
  startMs: number
  quote: string
}

/**
 * Find where a quote actually occurs in the transcript.
 *
 * Returns null when it occurs nowhere, which is the case that matters: a model
 * asked to cite its evidence will sometimes produce a fluent quote that nobody
 * said. Checking is cheap and the alternative is a summary that reads as
 * authoritative while pointing at nothing.
 *
 * Searches the claimed segment first, then its neighbours, then the whole
 * transcript — a model that gets the words right and the index slightly wrong
 * is far more common than one that invents both.
 */
export function attestQuote(
  quote: string,
  claimedIdx: number,
  segments: TranscriptSegment[],
): Attested | null {
  const needle = normalise(quote)
  if (needle.length < MIN_QUOTE_CHARS) return null

  const at = (idx: number) => segments.find(s => s.idx === idx)
  const matches = (segment: TranscriptSegment | undefined) =>
    segment !== undefined && normalise(segment.text).includes(needle)

  const claimed = at(claimedIdx)
  if (matches(claimed)) {
    return { segmentIdx: claimed!.idx, startMs: claimed!.startMs, quote: quote.trim() }
  }

  for (let offset = 1; offset <= NEARBY_SEGMENTS; offset++) {
    for (const candidate of [at(claimedIdx - offset), at(claimedIdx + offset)]) {
      if (matches(candidate)) {
        return { segmentIdx: candidate!.idx, startMs: candidate!.startMs, quote: quote.trim() }
      }
    }
  }

  const anywhere = segments.find(s => normalise(s.text).includes(needle))
  return anywhere
    ? { segmentIdx: anywhere.idx, startMs: anywhere.startMs, quote: quote.trim() }
    : null
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

  return {
    decisions: renumber(decisions.sort(byTime)),
    actionItems: renumber(actionItems.sort(byTime)),
    droppedDecisions,
    droppedActionItems,
  }
}

const byTime = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs
const renumber = <T extends { idx: number }>(items: T[]): T[] =>
  items.map((item, idx) => ({ ...item, idx }))
