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

/**
 * What the demo meeting's object holds once it has been replaced by hand (ADR-0015). WebKit lands
 * seeks in the browser's Opus-in-Ogg about 4% early, so the one recording everyone hears is
 * served as AAC in MP4. No route writes this type: only the demo's row has it.
 */
export const DEMO_PLAYBACK_MIME = 'audio/mp4'

export const MAX_TITLE_LENGTH = 200
export const MAX_FILE_NAME_LENGTH = 255
/** Upper bound on a meeting's duration (24 h) — guards against garbage metadata. */
export const MAX_DURATION_SEC = 24 * 60 * 60

/** Storage key for a meeting's compressed audio. Only meeting ids we minted are used. */
export function audioObjectKey(meetingId: string): string {
  return `meetings/${meetingId}/audio.ogg`
}

/**
 * Storage key for a meeting's raw Whisper reply, while it is being parsed
 * (ADR-0012 §2). Under `meetings/`, so the bucket's lifecycle rule expires one
 * that nothing got to remove. One per meeting and derived from the id, like the
 * audio's key, so a delete can always name it, and a later attempt replaces
 * the earlier one instead of leaving it behind.
 */
export function whisperReplyKey(meetingId: string): string {
  return `meetings/${meetingId}/whisper-reply.json`
}

/** Derive a default meeting title from the recording's file name. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  const title = base || 'Untitled meeting'
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trimEnd() : title
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
 * Extraction is going on or stopped: it has a plan worth counting, and until it is finished
 * or the meeting deleted, it can still want Groq's slots, unless it was refused as too long,
 * which no retry gets past (ADR-0019 says what that costs the demo). A deliberate mirror of the partial
 * index and `demo_question_gate` in supabase/migrations/20261104120000_demo_question_cap.sql,
 * which the same cases in tests/unit/helpers/demo-question-cases.ts hold together.
 */
export function extractionInProgress(meeting: Pick<Meeting, 'status' | 'failedStage'>): boolean {
  return meeting.status === 'summarizing'
    || meeting.status === 'indexing'
    || (meeting.status === 'failed' && meeting.failedStage === 'summarization')
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

/** Why a Whisper step is parked when the account's allowance is used up, by this meeting or another. */
export const PROVIDER_BLOCKED_ERROR = 'The transcription provider\'s quota is used up for now.'

/**
 * What the server's guard refuses to move the public demo with, which is how a page tells that
 * from a 403 by anything in front of the app: a WAF rule's says nothing about the meeting.
 */
export const DEMO_READ_ONLY_MESSAGE = 'The demo meeting is read-only: it can be read and asked questions, not changed.'

/**
 * What a refused question on the demo is told (ADR-0019). The question form follows either with
 * its own "Try again at <time>.", so neither says when. Each goes out through
 * server/utils/public-errors.ts.
 */
export const DEMO_QUESTIONS_USED_MESSAGE = 'The demo has used its questions for today.'
export const DEMO_QUESTIONS_PAUSED_MESSAGE = 'The demo pauses its questions while a meeting is being processed.'

/**
 * Whether this id is the public demo's (ADR-0015), for the guard on the server and for a page
 * deciding not to drive. Compared in lower case: `requireMeetingId` accepts a UUID in capitals,
 * which is the same row to Postgres, and the configured id may be written either way. Trimmed,
 * as the invite code is: a secret store that kept a pasted newline would otherwise turn the
 * guard off with no warning.
 */
export function isDemoMeetingId(configured: unknown, id: string): boolean {
  const demoId = String(configured ?? '').trim()
  return demoId !== '' && demoId.toLowerCase() === id.toLowerCase()
}
