import type { Meeting, PublicMeeting } from '#shared/types/meeting'
import { AUDIO_MIME, DEMO_QUESTIONS_PAUSED_MESSAGE, DEMO_QUESTIONS_USED_MESSAGE } from '#shared/utils/meeting'
import { DAILY_LIMIT_MESSAGE } from './qa/embedder'

/**
 * What a browser may read of anything that went wrong, and the one place that decides it.
 *
 * Stored and thrown error text can hold a provider's reply, a database's codes and
 * constraint names, or an object's key. Meeting links are readable by anyone holding them,
 * so none of it leaves. Storage keeps the raw text, for an operator and for the logic that
 * matches on it (`audioIsGone`, `refusedAsTooLong`, `DAILY_LIMIT_MESSAGE`).
 *
 * An allowlist, never a scrubber, so it fails closed: a sentence this file does not know
 * becomes a fixed one. A rule is an exact sentence of our own, or a regex anchored at both
 * ends with no wildcard in it, since a prefix would let whatever a provider appended through
 * with it. A sentence nobody listed here only costs a caller its detail.
 */

export type PublicStage = 'upload' | 'transcription' | 'extraction' | 'indexing' | 'answering'

/** A sentence of our own that goes out as it is, or a shape of one that is replaced by `say`. */
export type PublicRule = string | RegExp | { match: RegExp, say: string }

/** Every status there is, and nothing else: the only words a row puts in these sentences. */
const STATUS = '(?:pending_upload|uploaded|transcribing|summarizing|indexing|ready|failed)'

const MEETING_NOT_FOUND = 'Meeting not found'
const EMBEDDER_OUT_OF_CAPACITY = 'The embedding service is out of capacity for the moment. Try again shortly.'
const EMBEDDER_CREDENTIALS = 'The embedding service rejected our credentials.'

/** What each stage says of anything it has no rule for. Chosen by status class, and nothing else. */
const FIXED_SENTENCES: Record<PublicStage, { rateLimited: string, otherwise: string }> = {
  upload: {
    rateLimited: 'Uploads are being limited for now. Try again later.',
    otherwise: 'The uploaded audio was refused.',
  },
  transcription: {
    rateLimited: 'Transcription is being rate limited for now. Try again later.',
    otherwise: 'Transcription did not finish. Try again later.',
  },
  extraction: {
    rateLimited: 'Extraction is being rate limited for now. Try again later.',
    otherwise: 'Extraction did not finish. Try again later.',
  },
  indexing: {
    rateLimited: 'Indexing is being rate limited for now. Try again later.',
    otherwise: 'Indexing did not finish. Try again later.',
  },
  answering: {
    // Goes out with a time, and the question form says when to try again itself. It can also
    // be an outage whose retry got no slot, so this names neither a wait nor a rate limit.
    rateLimited: 'Answering is not available for now.',
    otherwise: 'The question could not be answered. Try again later.',
  },
}

/** Exported for the test that holds every one of them to the shape above. */
export const PUBLIC_RULES: Record<PublicStage, readonly PublicRule[]> = {
  upload: [
    /^Uploaded audio was \d+ bytes, expected \d+$/,
    // The type is what the uploader's PUT set, so it does not go back out, even to them.
    { match: /^Uploaded object is [\w.+-]+\/[\w.+-]+, expected [\w.+-]+\/[\w.+-]+$/, say: `The uploaded object is not ${AUDIO_MIME}.` },
  ],
  transcription: [
    MEETING_NOT_FOUND,
    'The meeting audio is missing from storage',
    /^Stored audio is \d+ bytes, expected \d+$/,
    'The audio is larger than the transcription service accepts.',
    /^Transcription stopped without an answer \d+ times\.$/,
    'Reading the transcription kept stopping without finishing; try again later.',
    'Saving the transcript kept stopping without finishing; try again later.',
    'The stored transcription reply changed. Try transcription again.',
    'The stored transcription reply is gone. Try transcription again.',
    /^The last transcription attempt failed recently; wait \d+s before retrying$/,
    new RegExp(`^Meeting is ${STATUS}; it has no audio ready to transcribe$`),
    'This meeting\'s transcript is already there; the failure was in extraction — retry summarisation, not transcription',
    'The uploaded audio was rejected and removed, so there is nothing to transcribe; upload the recording again',
  ],
  extraction: [
    MEETING_NOT_FOUND,
    /^This transcript would need \d+ sequential requests, over the \d+ limit\.$/,
    /^Extraction of chunk \d+ of \d+ stopped without an answer \d+ times\.$/,
    'Planning the extraction kept stopping without finishing; try again later.',
    'Saving the summary kept stopping without finishing; try again later.',
    /^The last extraction failed recently; wait \d+s before retrying$/,
    'This meeting has no transcript to summarise yet',
    new RegExp(`^Meeting is ${STATUS}; it has no transcript ready to summarise$`),
  ],
  indexing: [
    MEETING_NOT_FOUND,
    DAILY_LIMIT_MESSAGE,
    EMBEDDER_OUT_OF_CAPACITY,
    EMBEDDER_CREDENTIALS,
    /^A passage in this transcript is too long to index for questions \((?:[\d,]+ tokens; )?the limit is [\d,]+ tokens\)\. Questions cannot be asked about this meeting\. Its transcript and summary are not affected\.$/,
    /^A passage in this transcript runs past \d+ lines, too long to index for questions\. Its transcript and summary are not affected\.$/,
    'The stored passages do not add up to this transcript; indexing will try again later.',
    /^Indexing stopped without an answer \d+ times; it will try again later\.$/,
    'Indexing hit a problem on the server.',
    new RegExp(`^Meeting is ${STATUS}; it has no finished transcript to index yet$`),
    'This meeting\'s index belongs to another model or transcript. Only an explicit request replaces it.',
  ],
  answering: [
    'Ask a question that contains words.',
    'This meeting has not been indexed for questions yet. Index it first.',
    'This meeting\'s index is incomplete or out of date with its transcript. Index it again first.',
    'This meeting\'s transcript changed after it was indexed. Index it again first.',
    DAILY_LIMIT_MESSAGE,
    EMBEDDER_OUT_OF_CAPACITY,
    EMBEDDER_CREDENTIALS,
    'The answering model is busy with other requests, such as a running extraction.',
    'Could not schedule the question. Try again shortly.',
    'Answering quota is exhausted for now.',
    'The answering service rejected our credentials.',
    DEMO_QUESTIONS_USED_MESSAGE,
    DEMO_QUESTIONS_PAUSED_MESSAGE,
  ],
}

function wordsFor(rule: PublicRule, text: string): string | null {
  if (typeof rule === 'string') return rule === text ? rule : null
  if (rule instanceof RegExp) return rule.test(text) ? text : null
  return rule.match.test(text) ? rule.say : null
}

/** The fixed sentence for anything a stage has no rule for. */
export function fixedSentence(stage: PublicStage, statusCode: number): string {
  const sentences = FIXED_SENTENCES[stage]
  return statusCode === 429 ? sentences.rateLimited : sentences.otherwise
}

/**
 * What a caller may be told of a failure or a refusal: our own sentence if it is one, or
 * else the fixed one for its stage and status. The status stays the route's to answer with.
 */
export function publicMessage(stage: PublicStage, failure: { message: string, statusCode: number }): string {
  for (const rule of PUBLIC_RULES[stage]) {
    const words = wordsFor(rule, failure.message)
    if (words !== null) return words
  }
  return fixedSentence(stage, failure.statusCode)
}

/**
 * A meeting as a route answers with it. The field is removed, not set to null, so nothing
 * on the wire suggests there is a value to read. A `Meeting` is assignable to `PublicMeeting`
 * as far as TypeScript is concerned, which is why this has to be called, and why
 * tests/unit/public-errors.spec.ts reads the routes to see that it is.
 */
export function toPublicMeeting(meeting: Meeting): PublicMeeting {
  const { errorMessage: _stored, ...visible } = meeting
  return visible
}

/**
 * A step's progress as a route answers with it. `next` and `retryAt` say what a caller needs,
 * and the last error is the same text as the stored one.
 */
export function withoutLastError<Progress extends { lastError: string | null }>(progress: Progress): Omit<Progress, 'lastError'> {
  const { lastError: _stored, ...visible } = progress
  return visible
}
