import { describe, expect, it } from 'vitest'
import {
  AUDIO_MIME,
  MAX_AUDIO_BYTES,
  MAX_TITLE_LENGTH,
  SUMMARIZE_CLAIM_LEASE_MS,
  TRANSCRIBE_CLAIM_LEASE_MS,
  audioObjectKey,
  claimLooksStale,
  titleFromFileName,
  transcribedButEmpty,
} from '../../shared/utils/meeting'

describe('meeting limits', () => {
  it('pins the Groq free-tier cap and the Opus media type', () => {
    // Decimal, not binary: Groq documents "25 MB" ambiguously, and the smaller
    // reading is the safe one. See the constant for the reasoning.
    expect(MAX_AUDIO_BYTES).toBe(25_000_000)
    expect(MAX_AUDIO_BYTES).toBeLessThan(25 * 1024 * 1024)
    expect(AUDIO_MIME).toBe('audio/ogg')
  })
})

describe('audioObjectKey', () => {
  it('namespaces audio under the meeting id', () => {
    expect(audioObjectKey('abc')).toBe('meetings/abc/audio.ogg')
  })
})

describe('titleFromFileName', () => {
  it('strips the extension and tidies separators', () => {
    expect(titleFromFileName('Q3_board-meeting.mp4')).toBe('Q3 board meeting')
    expect(titleFromFileName('standup.mov')).toBe('standup')
  })

  it('falls back when nothing is left', () => {
    expect(titleFromFileName('.mp4')).toBe('Untitled meeting')
    expect(titleFromFileName('')).toBe('Untitled meeting')
  })

  it('caps overly long names', () => {
    const long = 'a'.repeat(MAX_TITLE_LENGTH + 50) + '.mp4'
    expect(titleFromFileName(long)).toHaveLength(MAX_TITLE_LENGTH)
  })
})

describe('transcribedButEmpty', () => {
  it('is true once transcription has finished with no segments', () => {
    for (const status of ['summarizing', 'indexing', 'ready'] as const) {
      expect(transcribedButEmpty({ status, failedStage: null }, 0)).toBe(true)
    }
  })

  it('is false while transcription has not run yet, even with no segments', () => {
    for (const status of ['pending_upload', 'uploaded', 'transcribing'] as const) {
      expect(transcribedButEmpty({ status, failedStage: null }, 0)).toBe(false)
    }
  })

  it('is false once segments exist, regardless of status', () => {
    expect(transcribedButEmpty({ status: 'ready', failedStage: null }, 3)).toBe(false)
  })

  // The specific case this function exists to get right: a summarisation
  // failure is orthogonal to whether the transcript it ran against was
  // empty, so it must still surface "no speech was found" rather than only
  // the generic extraction error — this was missing before failedStage
  // existed to distinguish it from a transcription failure.
  it('is true for a failed meeting whose failure was in summarisation', () => {
    expect(transcribedButEmpty({ status: 'failed', failedStage: 'summarization' }, 0)).toBe(true)
  })

  it('is false for a failed meeting whose failure was in transcription', () => {
    expect(transcribedButEmpty({ status: 'failed', failedStage: 'transcription' }, 0)).toBe(false)
  })
})

describe('claimLooksStale', () => {
  const at = (ms: number) => new Date(ms).toISOString()

  // The reason this exists: a meeting left in transcribing/indexing by a
  // crashed or evicted worker was recoverable ONLY by calling the route again,
  // and the progress page — the only caller there is — offered no button for
  // those statuses. The spinner polled forever. The page needs the same notion
  // of "stale" the routes use to know when offering that call is recovery.
  it('is false while a claim is still within its lease', () => {
    const now = 10 * 60 * 60_000
    expect(claimLooksStale({ status: 'transcribing', updatedAt: at(now - 60_000) }, now)).toBe(false)
    expect(claimLooksStale({ status: 'indexing', updatedAt: at(now - 60 * 60_000) }, now)).toBe(false)
  })

  it('is true once nothing can still be holding the claim', () => {
    const now = 10 * 60 * 60_000
    expect(claimLooksStale(
      { status: 'transcribing', updatedAt: at(now - TRANSCRIBE_CLAIM_LEASE_MS - 1) }, now,
    )).toBe(true)
    expect(claimLooksStale(
      { status: 'indexing', updatedAt: at(now - SUMMARIZE_CLAIM_LEASE_MS - 1) }, now,
    )).toBe(true)
  })

  it('uses each route\'s own lease, not a single shared number', () => {
    // Extraction's lease is 16x transcription's, because a multi-chunk run
    // legitimately takes hours. Treating them alike would either declare a
    // live extraction dead or leave a dead transcription unrecoverable for 4h.
    const now = 10 * 60 * 60_000
    const justOverTranscribe = at(now - TRANSCRIBE_CLAIM_LEASE_MS - 1)
    expect(claimLooksStale({ status: 'transcribing', updatedAt: justOverTranscribe }, now)).toBe(true)
    expect(claimLooksStale({ status: 'indexing', updatedAt: justOverTranscribe }, now)).toBe(false)
  })

  it('is false for statuses that are not an in-flight claim at all', () => {
    const now = 10 * 60 * 60_000
    const ancient = at(0)
    for (const status of ['pending_upload', 'uploaded', 'summarizing', 'ready', 'failed'] as const) {
      expect(claimLooksStale({ status, updatedAt: ancient }, now), status).toBe(false)
    }
  })
})
