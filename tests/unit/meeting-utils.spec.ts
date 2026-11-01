import { describe, expect, it } from 'vitest'
import {
  AUDIO_MIME,
  MAX_AUDIO_BYTES,
  MAX_TITLE_LENGTH,
  audioObjectKey,
  whisperReplyKey,
  titleFromFileName,
  transcribedButEmpty,
  uploadWasRejected,
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

describe('uploadWasRejected', () => {
  it('is true only when verification rejected the upload and deleted the object', () => {
    expect(uploadWasRejected({ status: 'failed', failedStage: 'upload' })).toBe(true)
  })

  it('is false for every other failure and every non-failed status', () => {
    expect(uploadWasRejected({ status: 'failed', failedStage: 'transcription' })).toBe(false)
    expect(uploadWasRejected({ status: 'failed', failedStage: 'summarization' })).toBe(false)
    for (const status of ['pending_upload', 'uploaded', 'transcribing', 'summarizing', 'indexing', 'ready'] as const) {
      expect(uploadWasRejected({ status, failedStage: null }), status).toBe(false)
    }
  })
})

describe('whisperReplyKey', () => {
  // ADR-0012 §2 and ADR-0010: only keys under `meetings/` are expired by the
  // bucket's lifecycle rule, which is what removes a reply a crash left behind.
  it('is under the prefix the bucket lifecycle rule covers, beside the audio', () => {
    const id = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    expect(whisperReplyKey(id).startsWith('meetings/')).toBe(true)
    expect(whisperReplyKey(id).startsWith(audioObjectKey(id).replace('audio.ogg', ''))).toBe(true)
    expect(whisperReplyKey(id)).not.toBe(audioObjectKey(id))
  })
})
