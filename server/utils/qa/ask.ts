import type { Citation, QuestionAnswer, TranscriptSegment } from '#shared/types/meeting'
import type { TranscriptRepository } from '../db/transcripts'
import { readyWindowCount, type TranscriptIndexRepository, type WindowMatch } from '../db/windows'
import { attestQuote, normalise } from '../summary/reconcile'
import type { Answerer } from './answerer'
import type { Embedder } from './embedder'
import { windowOver } from './windows'

/**
 * Windows retrieved per question. Each is at most WINDOW_TOKEN_BUDGET tokens,
 * so four keep the prompt well inside the answering model's per-minute
 * allowance while still covering a few minutes of conversation.
 */
export const TOP_K = 4

/** A refusal the caller can act on: the index needs building, or the question is empty. */
export class QuestionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'QuestionError'
  }
}

const NOT_FOUND: QuestionAnswer = { found: false, answer: null, citations: [] }

export interface AskInput {
  meetingId: string
  question: string
  transcripts: Pick<TranscriptRepository, 'listRange'>
  embedder: Embedder
  repo: Pick<TranscriptIndexRepository, 'readState' | 'search'>
  answerer: Answerer
}

/**
 * The lines the retrieved windows cover, in order and once each. Windows next to each
 * other overlap by a line, so each stretch is read once, in at most `TOP_K` reads.
 */
async function readRetrieved(
  transcripts: AskInput['transcripts'],
  meetingId: string,
  matches: readonly WindowMatch[],
): Promise<TranscriptSegment[]> {
  const ranges: Array<{ from: number, to: number }> = []
  for (const { firstSegmentIdx: from, lastSegmentIdx: to } of [...matches].sort((a, b) => a.firstSegmentIdx - b.firstSegmentIdx)) {
    const last = ranges.at(-1)
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }
  const read = await Promise.all(ranges.map(({ from, to }) => transcripts.listRange(meetingId, from, to)))
  return read.flat()
}

/**
 * Answer a question about one meeting, with citations checked against the
 * transcript (ADR-0007 decision 3).
 *
 * The citation check runs against ONLY the retrieved segments, not the whole
 * transcript: a quote that occurs elsewhere in the meeting but was never in
 * front of the model cannot be what it read, so it is dropped like any other
 * unsupported quote. An answer left with no citations is withheld.
 */
export async function askMeeting(input: AskInput): Promise<QuestionAnswer> {
  const { meetingId, transcripts, embedder, repo, answerer } = input
  const question = input.question.trim()
  if (!normalise(question)) {
    // Punctuation alone embeds as the zero vector, which ranks nothing.
    throw new QuestionError('Ask a question that contains words.', 400)
  }

  // The marker, not a plan of the transcript: the cost of this check does not grow with
  // the meeting, and a run in progress is refused however much of it is stored.
  const state = await repo.readState(meetingId, embedder.model)
  const windowCount = readyWindowCount(state, embedder.model)
  if (windowCount === null) {
    if (state.storedForModel === 0) {
      throw new QuestionError('This meeting has not been indexed for questions yet. Index it first.', 409)
    }
    throw new QuestionError(
      'This meeting\'s index is incomplete or out of date with its transcript. Index it again first.', 409,
    )
  }
  if (windowCount === 0) return NOT_FOUND

  // Before the embedding, not just before the answer. A question refused here has spent
  // nothing, so slot pacing also limits how fast this open route can spend Workers AI:
  // the other way round, a loop refused every slot still spends an embedding per request.
  await answerer.reserveSlot()

  const matches = await repo.search(meetingId, await embedder.embedQuery(question), {
    model: embedder.model,
    limit: TOP_K,
  })

  const retrieved = await readRetrieved(transcripts, meetingId, matches)

  // Checked again at retrieval, not only through the marker above: the transcript can
  // be replaced between the two reads, and a window whose hash no longer matches its
  // lines holds text that is no longer in the meeting. Hashed from those lines alone.
  for (const match of matches) {
    const run = retrieved.filter(s => s.idx >= match.firstSegmentIdx && s.idx <= match.lastSegmentIdx)
    if (run.length === 0 || (await windowOver(run, match.idx)).contentHash !== match.contentHash) {
      throw new QuestionError(
        'This meeting\'s transcript changed after it was indexed. Index it again first.', 409,
      )
    }
  }

  if (retrieved.length === 0) return NOT_FOUND

  const wire = await answerer.answer({ question, segments: retrieved }, { slotHeld: true })

  const seen = new Set<string>()
  const citations: Citation[] = []
  for (const cited of wire.citations) {
    const attested = attestQuote(cited.quote, cited.segmentIdx, retrieved)
    if (!attested) continue
    const key = `${attested.segmentIdx}:${normalise(attested.quote)}`
    if (seen.has(key)) continue
    seen.add(key)
    citations.push({ quote: attested.quote, segmentIdx: attested.segmentIdx, startMs: attested.startMs })
  }
  citations.sort((a, b) => a.startMs - b.startMs || a.segmentIdx - b.segmentIdx)

  const answer = wire.answer.trim()
  if (citations.length === 0 || !answer) return NOT_FOUND
  return { found: true, answer, citations }
}
