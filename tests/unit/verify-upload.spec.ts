import { describe, expect, it, vi } from 'vitest'
import { failMeetingUpload, inspectStoredAudio } from '../../server/utils/verify-upload'
import { MAX_AUDIO_BYTES } from '../../shared/utils/meeting'

const meeting = { id: 'm1', audioKey: 'meetings/m1/audio.ogg', audioBytes: 8_500_000 }

describe('inspectStoredAudio', () => {
  it('accepts an object matching the declaration', () => {
    expect(inspectStoredAudio(meeting, { size: 8_500_000, contentType: 'audio/ogg' })).toBeNull()
  })

  it('accepts a media type carrying codec parameters', () => {
    expect(inspectStoredAudio(meeting, { size: 8_500_000, contentType: 'audio/ogg; codecs=opus' })).toBeNull()
  })

  it('accepts an object whose type the store does not report', () => {
    // Unknown is not the same as wrong; refusing here would break any store
    // that omits the header.
    expect(inspectStoredAudio(meeting, { size: 8_500_000, contentType: null })).toBeNull()
  })

  it('refuses a size that differs from the declaration', () => {
    expect(inspectStoredAudio(meeting, { size: 8_500_001, contentType: 'audio/ogg' }))
      .toMatch(/8500001 bytes, expected 8500000/)
  })

  it('refuses anything over the hard cap even if it matches the declaration', () => {
    const huge = { ...meeting, audioBytes: MAX_AUDIO_BYTES + 1 }
    expect(inspectStoredAudio(huge, { size: MAX_AUDIO_BYTES + 1, contentType: 'audio/ogg' })).not.toBeNull()
  })

  it('refuses a non-audio object of exactly the right length', () => {
    expect(inspectStoredAudio(meeting, { size: 8_500_000, contentType: 'video/mp4' }))
      .toMatch(/video\/mp4, expected audio\/ogg/)
  })
})

describe('failMeetingUpload', () => {
  it('deletes the object and records why', async () => {
    const store = { delete: vi.fn().mockResolvedValue(undefined) }
    const repo = { update: vi.fn().mockResolvedValue(null) }

    const message = await failMeetingUpload(store, repo, meeting, 'size mismatch')

    expect(store.delete).toHaveBeenCalledWith(meeting.audioKey)
    expect(message).toBe('size mismatch; object deleted')
    expect(repo.update).toHaveBeenCalledWith('m1', {
      status: 'failed', errorMessage: message, failedStage: 'transcription',
    })
  })

  it('still marks the meeting failed when deletion throws', async () => {
    // A row stuck at pending_upload would keep claiming the upload is in
    // flight; a stranded object is only wasted bytes a sweep can collect.
    const store = { delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')) }
    const repo = { update: vi.fn().mockResolvedValue(null) }

    const message = await failMeetingUpload(store, repo, meeting, 'size mismatch')

    expect(repo.update).toHaveBeenCalledWith('m1', {
      status: 'failed', errorMessage: message, failedStage: 'transcription',
    })
    expect(message).toMatch(/could not be deleted and needs sweeping \(R2 unavailable\)/)
    expect(message).not.toMatch(/object deleted/)
  })
})
