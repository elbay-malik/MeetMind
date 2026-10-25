import type { Meeting } from '#shared/types/meeting'

/**
 * Limits and naming rules for meeting audio, shared by client and server so
 * both sides enforce the same invariants.
 */

/**
 * Groq Whisper's free-tier upload cap; the server rejects anything larger.
 *
 * Groq documents "25 MB" without saying whether it means decimal or binary, so
 * this takes the smaller reading. Guessing wrong the other way costs 1.2 MB of
 * headroom but fails at the worst possible moment — after the user has waited
 * through a full extraction and upload — for roughly ten minutes of extra
 * recording at 16 kbps. Not a trade worth making.
 */
export const MAX_AUDIO_BYTES = 25_000_000

/** How the cap is written in user-facing copy, matching Groq's own wording. */
export const MAX_AUDIO_LABEL = '25 MB'

/** The only media type the upload path accepts — the browser-encoded Opus-in-Ogg. */
export const AUDIO_MIME = 'audio/ogg'

export const MAX_TITLE_LENGTH = 200
export const MAX_FILE_NAME_LENGTH = 255
/** Upper bound on a meeting's duration (24 h) — guards against garbage metadata. */
export const MAX_DURATION_SEC = 24 * 60 * 60

/** Storage key for a meeting's compressed audio. Only meeting ids we minted are used. */
export function audioObjectKey(meetingId: string): string {
  return `meetings/${meetingId}/audio.ogg`
}

/** Derive a default meeting title from the recording's file name. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  const title = base || 'Untitled meeting'
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trimEnd() : title
}

/**
 * How long each route honours a claim before another caller may take it over.
 *
 * Shared rather than route-private because the CLIENT needs the same numbers:
 * a meeting left in `transcribing`/`indexing` by a crashed, redeployed or
 * evicted worker is recoverable only by calling the route again, and the retry
 * routes are the only thing that ever calls them. Without a way to tell "a
 * worker is running" from "a worker died holding this", the progress page
 * showed a spinner and no action at all — forever, for up to four hours of
 * lease and then indefinitely, because nothing was left to issue the request
 * that would reclaim it.
 *
 * The server stays the authority: it re-checks staleness under a
 * compare-and-swap and refuses with an accurate 409 if a worker really is
 * still alive. These only decide whether the button is worth offering.
 */
export const TRANSCRIBE_CLAIM_LEASE_MS = 15 * 60_000

/**
 * Statuses that mean a route is holding a claim on this meeting right now.
 *
 * Not `indexing`: extraction runs in short steps, each under its own lease in
 * the run ledger (ADR-0012), and between steps nothing holds it at all. An
 * `indexing` meeting is always safe to ask to carry on -- the server answers
 * "wait" while a step is live -- and safe to delete between steps.
 */
const IN_FLIGHT_LEASE: Partial<Record<Meeting['status'], number>> = {
  transcribing: TRANSCRIBE_CLAIM_LEASE_MS,
}

/**
 * Whether an in-flight claim is old enough that nothing can still be holding
 * it, so asking the route again is a recovery rather than a duplicate request.
 */
export function claimLooksStale(
  meeting: Pick<Meeting, 'status' | 'updatedAt'>,
  now: number = Date.now(),
): boolean {
  const lease = IN_FLIGHT_LEASE[meeting.status]
  if (lease === undefined) return false
  return now - new Date(meeting.updatedAt).getTime() >= lease
}

/**
 * Transcription has run and found nothing, as opposed to not having run yet.
 * Extracted out of the progress page (rather than left as an inline
 * computed) so this — the one thing that decides whether "no speech was
 * found" gets shown instead of leaving the page stuck with only a generic
 * extraction error — has a fast unit test independent of mounting the page.
 *
 * Includes a `failed`+`summarization` meeting too: that failure is orthogonal
 * to whether the transcript it ran against was empty, and hiding this warning
 * there would leave only a generic extraction error, silently dropping the
 * (still true, still useful) "the recording may be silent" explanation.
 */
export function transcribedButEmpty(
  meeting: Pick<Meeting, 'status' | 'failedStage'>,
  segmentCount: number,
): boolean {
  return transcriptionFinished(meeting) && segmentCount === 0
}

/**
 * Whether transcription has completed for this meeting, whatever happened after.
 *
 * `failed` + 'summarization' counts: extraction only ever runs against a
 * transcript that already exists, so its failure says nothing about the
 * transcript. The one place this is decided, rather than each caller keeping
 * its own copy of the status list — extraction, the progress page and indexing
 * all need exactly this answer.
 */
export function transcriptionFinished(meeting: Pick<Meeting, 'status' | 'failedStage'>): boolean {
  return ['summarizing', 'indexing', 'ready'].includes(meeting.status)
    || (meeting.status === 'failed' && meeting.failedStage === 'summarization')
}

/**
 * Whether verification rejected this meeting's upload and DELETED the stored
 * object (see verify-upload.ts). The audio is gone, so anything that would
 * fetch or play it has nothing to fetch.
 *
 * Shared rather than repeated inline, which is how the two pages drifted:
 * `'upload'` arrived with Phase 6, the progress page and the meeting page's
 * empty-transcript message both learned about it, and the meeting page's
 * `hasAudio` — written in Phase 5, when the only audio-less state was
 * `pending_upload` — did not. It went on mounting a player pointing at a
 * deleted object, so the page showed "Audio unavailable" directly above its
 * own correct explanation that the recording had been removed.
 */
export function uploadWasRejected(meeting: Pick<Meeting, 'status' | 'failedStage'>): boolean {
  return meeting.status === 'failed' && meeting.failedStage === 'upload'
}
