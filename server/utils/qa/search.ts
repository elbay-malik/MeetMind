import type { MeetingSearchMatch, MeetingSearchResult } from '#shared/types/meeting'
import type { MeetingRepository } from '../db/meetings'
import { MAX_MATCHES_PER_MEETING, MAX_MEETINGS, type TranscriptIndexRepository } from '../db/windows'
import { normalise } from '../summary/reconcile'
import type { Embedder } from './embedder'

/** A refusal the caller can act on: the query has no words to embed. */
export class SearchError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'SearchError'
  }
}

export interface SearchMeetingsInput {
  query: string
  embedder: Embedder
  repo: TranscriptIndexRepository
  meetings: MeetingRepository
}

/**
 * Below this, a match is not evidence of relevance — it is whatever ranked
 * least-bad among windows that share no real direction with the query. There
 * is no answering model here to make that call the way `askMeeting` lets the
 * citation check do it (ADR-0007 decision 3); a plain floor on the vector's
 * own similarity is the equivalent guard search has available. 0, not some
 * higher bar: this only excludes what is actively unrelated or worse
 * (orthogonal or negative cosine similarity), not an attempt to tune a
 * "relevant enough" threshold with no labelled data to tune it against.
 */
const MIN_SIMILARITY = 0

/**
 * Search every indexed meeting's transcript for passages relevant to `query`
 * (ADR-0008), grouped by meeting and ordered by each meeting's own best
 * match — search, not a synthesized cross-meeting answer; see ADR-0008 for
 * why that line is where Phase 8 stops.
 *
 * A window's own start is the seek target, not some more specific "best
 * line" within it: there is no answering model here to point at one, and
 * guessing would be exactly the kind of unearned specificity the citation
 * design elsewhere in this app exists to avoid.
 */
export async function searchMeetings(input: SearchMeetingsInput): Promise<MeetingSearchResult> {
  const { embedder, repo, meetings } = input
  const query = input.query.trim()
  if (!normalise(query)) {
    // Punctuation alone embeds as the zero vector, which ranks nothing.
    throw new SearchError('Search for something that contains words.', 400)
  }

  const ranked = await repo.searchAcrossMeetings(await embedder.embedQuery(query), {
    model: embedder.model,
    meetingLimit: MAX_MEETINGS,
    perMeetingLimit: MAX_MATCHES_PER_MEETING,
  })
  // Retrieval ranks everything it is given, top-K regardless of whether the
  // "nearest" thing is actually close — with no query anywhere near any
  // indexed window (nothing indexed shares its topic), the top-ranked result
  // is still whatever ranked highest, and NaN (a zero-norm window) sorts
  // last rather than being excluded. Filtered here, not in the repository:
  // ranking and "is this a real match at all" are different questions, the
  // same separation `askMeeting` keeps between retrieval and the citation
  // check.
  const matches = ranked.filter(m => m.similarity > MIN_SIMILARITY)
  if (matches.length === 0) return { results: [] }

  const meetingIds = [...new Set(matches.map(m => m.meetingId))]
  const found = await Promise.all(meetingIds.map(id => meetings.get(id)))
  const titles = new Map(found.filter(m => m !== null).map(m => [m.id, m.title]))

  const results: MeetingSearchMatch[] = []
  for (const match of matches) {
    const title = titles.get(match.meetingId)
    // A meeting deleted after being indexed (nothing does this yet, but the
    // repository contract does not rule it out) has no title to show; drop
    // its match rather than render a result pointing nowhere.
    if (title === undefined) continue
    results.push({
      meetingId: match.meetingId,
      meetingTitle: title,
      quote: match.text,
      segmentIdx: match.firstSegmentIdx,
      startMs: match.startMs,
    })
  }
  return { results }
}
