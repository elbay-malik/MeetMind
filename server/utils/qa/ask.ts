import type { Citation, QuestionAnswer, TranscriptSegment } from '#shared/types/meeting'
import type { TranscriptIndexRepository } from '../db/windows'
import { attestQuote, normalise } from '../summary/reconcile'
import type { Answerer } from './answerer'
import type { Embedder } from './embedder'
import { indexStatus } from './indexing'
import { planWindows } from './windows'

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
  segments: TranscriptSegment[]
  embedder: Embedder
  repo: TranscriptIndexRepository
  answerer: Answerer
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
  const { meetingId, segments, embedder, repo, answerer } = input
  const question = input.question.trim()
  if (!normalise(question)) {
    // Punctuation alone embeds as the zero vector, which ranks nothing.
    throw new QuestionError('Ask a question that contains words.', 400)
  }

  const plan = await planWindows(segments)
  const status = indexStatus(plan, await repo.listKeys(meetingId), embedder.model)
  if (status.state === 'none') {
    throw new QuestionError('This meeting has not been indexed for questions yet. Index it first.', 409)
  }
  if (status.state !== 'ready') {
    throw new QuestionError(
      'This meeting\'s index is incomplete or out of date with its transcript. Index it again first.', 409,
    )
  }
  if (plan.length === 0) return NOT_FOUND

  // Before the embedding, not just before the answer. A question refused here has spent
  // nothing, so slot pacing also limits how fast this open route can spend Workers AI:
  // the other way round, a loop refused every slot still spends an embedding per request.
  await answerer.reserveSlot()

  const matches = await repo.search(meetingId, await embedder.embedQuery(question), {
    model: embedder.model,
    limit: TOP_K,
  })

  // Checked again at retrieval, not only through the status above: the
  // transcript can be replaced between the two reads, and a window whose hash
  // no longer matches holds text that is no longer in the meeting.
  const planned = new Map(plan.map(w => [w.idx, w.contentHash]))
  if (matches.some(m => planned.get(m.idx) !== m.contentHash)) {
    throw new QuestionError(
      'This meeting\'s transcript changed after it was indexed. Index it again first.', 409,
    )
  }

  const retrieved = segments
    .filter(s => matches.some(m => s.idx >= m.firstSegmentIdx && s.idx <= m.lastSegmentIdx))
    .sort((a, b) => a.idx - b.idx)
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
