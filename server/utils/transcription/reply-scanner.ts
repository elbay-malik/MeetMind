import { z } from 'zod'
import type { RawSegment } from './normalize'

/**
 * Reads a stored Whisper reply a window at a time (ADR-0012 §2). The reply as
 * a whole is never parsed: its size grows with the meeting, and a Worker has
 * 10 ms of CPU per request. The scanner walks the bytes to find each whole
 * object inside the top-level `segments` array, and only those objects, one at
 * a time, ever reach `JSON.parse`.
 *
 * It works on bytes because the window can end anywhere. JSON's structural
 * characters are all ASCII, and UTF-8 never uses an ASCII byte inside a
 * multi-byte character, so a character cut by a window's edge cannot be
 * mistaken for structure, and a slice ends only on an object's closing brace.
 */

/** Everything needed to carry on from where a window ended. A type, so it fits in the run's cursor. */
export type ScanState = {
  /** Inside the `segments` array, between two of its elements. Nothing below applies then. */
  inArray: boolean
  /** The reply's opening brace has been seen. */
  started: boolean
  /** Containers open in the envelope: 1 is directly inside the top-level object. */
  depth: number
  inString: boolean
  escaped: boolean
  /** How much of `segments` the top-level string being read has matched; -1 once it differs. */
  keyPos: number
  /** 1: the last top-level token was the string `segments`. 2: and a colon has followed it. */
  key: 0 | 1 | 2
}

export const INITIAL_SCAN: ScanState = {
  inArray: false, started: false, depth: 0, inString: false, escaped: false, keyPos: -1, key: 0,
}

export interface ScanResult {
  state: ScanState
  /** Bytes of this window that are finished with; the next window starts after them. */
  consumed: number
  /** Whole segment objects, as slices of the window, in order. */
  objects: Uint8Array[]
  /** The `segments` array has closed. Whatever follows it is not read. */
  finished: boolean
}

/** The reply is not what a transcription reply looks like. Asking the provider again is the only fix. */
export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyFormatError'
  }
}

const QUOTE = 0x22
const BACKSLASH = 0x5C
const OPEN_BRACE = 0x7B
const CLOSE_BRACE = 0x7D
const OPEN_BRACKET = 0x5B
const CLOSE_BRACKET = 0x5D
const COLON = 0x3A
const COMMA = 0x2C
const KEY = new TextEncoder().encode('segments')

const isSpace = (byte: number) => byte === 0x20 || byte === 0x0A || byte === 0x0D || byte === 0x09

const UNREADABLE = 'Transcription service returned a body we could not read'
const NO_SEGMENTS = 'Transcription service returned an unexpected response: it has no segments array'

/**
 * Scan one window of the reply.
 *
 * @param atEnd the window reaches the end of the reply, so anything unfinished never will be
 * @param maxObjects stop after this many objects, however many more the window holds
 * @throws ReplyFormatError when the reply can be seen not to be a transcription reply
 */
export function scanWindow(bytes: Uint8Array, from: ScanState, options: { atEnd: boolean, maxObjects: number }): ScanResult {
  const state = { ...from }
  let position = 0
  if (!state.inArray) {
    position = scanEnvelope(bytes, state)
    if (!state.inArray) {
      if (options.atEnd) throw new ReplyFormatError(state.started ? `${UNREADABLE}: it ends early` : `${UNREADABLE}: it is empty`)
      return { state, consumed: bytes.length, objects: [], finished: false }
    }
  }
  return scanArray(bytes, position, state, options)
}

/** Walk the envelope up to the opening of `segments`. Returns where it stopped. */
function scanEnvelope(bytes: Uint8Array, state: ScanState): number {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false
        state.keyPos = -1
      }
      else if (byte === BACKSLASH) {
        state.escaped = true
      }
      else if (byte === QUOTE) {
        state.inString = false
        state.key = state.keyPos === KEY.length ? 1 : 0
      }
      else if (state.keyPos >= 0) {
        state.keyPos = byte === KEY[state.keyPos] ? state.keyPos + 1 : -1
      }
      continue
    }
    if (isSpace(byte)) continue
    if (!state.started) {
      if (byte !== OPEN_BRACE) throw new ReplyFormatError(`${UNREADABLE}: it is not a JSON object`)
      state.started = true
      state.depth = 1
      continue
    }
    if (byte === QUOTE) {
      state.inString = true
      state.escaped = false
      // Only a top-level key can name the array; `segments` nested under some
      // other field is not it.
      state.keyPos = state.depth === 1 ? 0 : -1
      state.key = 0
    }
    else if (byte === COLON && state.key === 1) {
      state.key = 2
    }
    else if (byte === OPEN_BRACKET && state.key === 2) {
      state.inArray = true
      return i + 1
    }
    else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      state.depth++
      state.key = 0
    }
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      state.depth--
      state.key = 0
      if (state.depth === 0) throw new ReplyFormatError(NO_SEGMENTS)
    }
    else {
      state.key = 0
    }
  }
  return bytes.length
}

/** Collect whole objects from `start`, which is between two elements of the array. */
function scanArray(bytes: Uint8Array, start: number, state: ScanState, options: { atEnd: boolean, maxObjects: number }): ScanResult {
  const objects: Uint8Array[] = []
  let position = start
  while (position < bytes.length) {
    const byte = bytes[position]!
    if (isSpace(byte) || byte === COMMA) {
      position++
      continue
    }
    if (byte === CLOSE_BRACKET) return { state, consumed: position + 1, objects, finished: true }
    if (byte !== OPEN_BRACE) throw new ReplyFormatError('Transcription service returned an unexpected response: a segment is not an object')
    if (objects.length === options.maxObjects) return { state, consumed: position, objects, finished: false }
    const end = objectEnd(bytes, position)
    if (end === null) break
    objects.push(bytes.subarray(position, end))
    position = end
  }
  if (options.atEnd) throw new ReplyFormatError(`${UNREADABLE}: it ends early`)
  return { state, consumed: position, objects, finished: false }
}

/** The index just past the object opening at `start`, or null when the window ends first. */
function objectEnd(bytes: Uint8Array, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < bytes.length; i++) {
    const byte = bytes[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (byte === BACKSLASH) escaped = true
      else if (byte === QUOTE) inString = false
    }
    else if (byte === QUOTE) {
      inString = true
    }
    else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth++
    }
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * Groq never publishes a full verbose_json envelope, only the per-segment
 * fields, which are documented verbatim. So parse leniently: take the fields we
 * need and tolerate unknown keys.
 */
const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
})

/** Parse the scanner's slices, each one separately. */
export function parseSegments(objects: readonly Uint8Array[]): RawSegment[] {
  // `fatal`: a reply cut inside a character is not silently patched up with
  // replacement characters.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return objects.map((object) => {
    let value: unknown
    try {
      value = JSON.parse(decoder.decode(object))
    }
    catch (err) {
      throw new ReplyFormatError(`${UNREADABLE}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const parsed = segmentSchema.safeParse(value)
    if (!parsed.success) {
      throw new ReplyFormatError(`Transcription service returned an unexpected response: ${z.prettifyError(parsed.error)}`)
    }
    return parsed.data
  })
}
