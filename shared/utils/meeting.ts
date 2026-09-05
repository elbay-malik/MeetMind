/**
 * Limits and naming rules for meeting audio, shared by client and server so
 * both sides enforce the same invariants.
 */

/** Groq Whisper's free-tier upload cap; the server rejects anything larger. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

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
