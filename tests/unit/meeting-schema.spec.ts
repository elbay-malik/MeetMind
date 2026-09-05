import { describe, expect, it } from 'vitest'
import { createMeetingBodySchema, meetingSchema } from '../../shared/schemas/meeting'
import { MAX_AUDIO_BYTES } from '../../shared/utils/meeting'

const validBody = {
  title: 'Weekly sync',
  sourceFileName: 'weekly-sync.mp4',
  sourceBytes: 1_045_800_000,
  sourceMime: 'video/mp4',
  durationSec: 3600,
  audioBytes: 8_500_000,
}

describe('createMeetingBodySchema', () => {
  it('accepts a well-formed body', () => {
    expect(createMeetingBodySchema.parse(validBody)).toEqual(validBody)
  })

  it('accepts unknown duration and mime', () => {
    const r = createMeetingBodySchema.safeParse({ ...validBody, durationSec: null, sourceMime: null })
    expect(r.success).toBe(true)
  })

  it('rejects audio above the 25 MB cap', () => {
    const r = createMeetingBodySchema.safeParse({ ...validBody, audioBytes: MAX_AUDIO_BYTES + 1 })
    expect(r.success).toBe(false)
  })

  it('rejects empty audio, blank titles and unknown keys', () => {
    expect(createMeetingBodySchema.safeParse({ ...validBody, audioBytes: 0 }).success).toBe(false)
    expect(createMeetingBodySchema.safeParse({ ...validBody, title: '   ' }).success).toBe(false)
    expect(createMeetingBodySchema.safeParse({ ...validBody, video: 'nope' }).success).toBe(false)
  })

  it('rejects non-integer byte counts', () => {
    expect(createMeetingBodySchema.safeParse({ ...validBody, audioBytes: 1.5 }).success).toBe(false)
  })
})

describe('meetingSchema', () => {
  it('validates a stored meeting record', () => {
    const r = meetingSchema.safeParse({
      id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      createdAt: '2026-09-05T12:00:00.000Z',
      updatedAt: '2026-09-05T12:00:00.000Z',
      title: 'Weekly sync',
      status: 'uploaded',
      sourceFileName: 'weekly-sync.mp4',
      sourceBytes: 1,
      sourceMime: null,
      durationSec: null,
      audioKey: 'meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio.ogg',
      audioBytes: 10,
      audioMime: 'audio/ogg',
      uploadedAt: null,
      errorMessage: null,
    })
    expect(r.success).toBe(true)
  })
})
