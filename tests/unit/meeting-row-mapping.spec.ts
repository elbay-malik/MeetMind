import { describe, expect, it } from 'vitest'
import {
  newMeetingToRow,
  patchToRow,
  rowToMeeting,
  type MeetingRow,
  type NewMeeting,
} from '../../server/utils/db/meetings'

const row: MeetingRow = {
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  created_at: '2026-09-05T12:00:00.000Z',
  updated_at: '2026-09-05T12:05:00.000Z',
  title: 'Weekly sync',
  status: 'uploaded',
  source_file_name: 'weekly-sync.mp4',
  source_bytes: 1_045_800_000,
  source_mime: 'video/mp4',
  duration_sec: 3600,
  audio_key: 'meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio.ogg',
  audio_bytes: 8_500_000,
  audio_mime: 'audio/ogg',
  uploaded_at: '2026-09-05T12:05:00.000Z',
  error_message: null,
  failed_stage: null,
}

describe('rowToMeeting', () => {
  it('maps every column to its camelCase field', () => {
    expect(rowToMeeting(row)).toEqual({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: 'Weekly sync',
      status: 'uploaded',
      sourceFileName: 'weekly-sync.mp4',
      sourceBytes: 1_045_800_000,
      sourceMime: 'video/mp4',
      durationSec: 3600,
      audioKey: row.audio_key,
      audioBytes: 8_500_000,
      audioMime: 'audio/ogg',
      uploadedAt: row.uploaded_at,
      errorMessage: null,
      failedStage: null,
    })
  })

  it('coerces bigint columns arriving as strings', () => {
    // Defensive: source_bytes is a Postgres bigint, and drivers may hand back
    // large integers as strings. Realistic file sizes are far below 2^53, so
    // this guards the column type rather than a size we actually expect.
    const asString = { ...row, source_bytes: '1045800000' as unknown as number }
    expect(rowToMeeting(asString).sourceBytes).toBe(1_045_800_000)
  })

  it('preserves nulls rather than inventing defaults', () => {
    const sparse = { ...row, source_mime: null, duration_sec: null, uploaded_at: null, error_message: 'boom' }
    const meeting = rowToMeeting(sparse)
    expect(meeting.sourceMime).toBeNull()
    expect(meeting.durationSec).toBeNull()
    expect(meeting.uploadedAt).toBeNull()
    expect(meeting.errorMessage).toBe('boom')
  })
})

describe('newMeetingToRow', () => {
  const input: NewMeeting = {
    id: row.id,
    title: 'Weekly sync',
    status: 'pending_upload',
    sourceFileName: 'weekly-sync.mp4',
    sourceBytes: 1_045_800_000,
    sourceMime: 'video/mp4',
    durationSec: 3600,
    audioKey: row.audio_key,
    audioBytes: 8_500_000,
    audioMime: 'audio/ogg',
    uploadedAt: null,
    errorMessage: null,
    failedStage: null,
  }

  it('produces the insert row without touching the timestamp columns', () => {
    const inserted = newMeetingToRow(input)
    expect(inserted).toEqual({
      id: row.id,
      title: 'Weekly sync',
      status: 'pending_upload',
      source_file_name: 'weekly-sync.mp4',
      source_bytes: 1_045_800_000,
      source_mime: 'video/mp4',
      duration_sec: 3600,
      audio_key: row.audio_key,
      audio_bytes: 8_500_000,
      audio_mime: 'audio/ogg',
      uploaded_at: null,
      error_message: null,
      failed_stage: null,
    })
    // created_at/updated_at are the database's to set.
    expect(inserted).not.toHaveProperty('created_at')
    expect(inserted).not.toHaveProperty('updated_at')
  })

  it('round-trips through rowToMeeting', () => {
    const stored = { ...newMeetingToRow(input), created_at: row.created_at, updated_at: row.updated_at }
    expect(rowToMeeting(stored as MeetingRow)).toEqual({
      ...input, createdAt: row.created_at, updatedAt: row.updated_at,
    })
  })
})

describe('patchToRow', () => {
  it('emits only the fields the caller set', () => {
    expect(patchToRow({ status: 'uploaded' })).toEqual({ status: 'uploaded' })
    expect(patchToRow({})).toEqual({})
  })

  it('passes explicit nulls through so a value can be cleared', () => {
    expect(patchToRow({ errorMessage: null })).toEqual({ error_message: null })
    expect(patchToRow({ uploadedAt: null })).toEqual({ uploaded_at: null })
    expect(patchToRow({ failedStage: null })).toEqual({ failed_stage: null })
  })

  it('maps a full patch', () => {
    expect(patchToRow({
      status: 'failed', uploadedAt: '2026-09-05T12:05:00.000Z', errorMessage: 'size mismatch',
      failedStage: 'summarization', title: 'x',
    })).toEqual({
      status: 'failed', uploaded_at: '2026-09-05T12:05:00.000Z', error_message: 'size mismatch',
      failed_stage: 'summarization', title: 'x',
    })
  })
})
