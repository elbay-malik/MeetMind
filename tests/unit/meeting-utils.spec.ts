import { describe, expect, it } from 'vitest'
import {
  AUDIO_MIME,
  MAX_AUDIO_BYTES,
  MAX_TITLE_LENGTH,
  audioObjectKey,
  titleFromFileName,
} from '../../shared/utils/meeting'

describe('meeting limits', () => {
  it('pins the Groq free-tier cap and the Opus media type', () => {
    expect(MAX_AUDIO_BYTES).toBe(26214400)
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
