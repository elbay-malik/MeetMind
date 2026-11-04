import { z } from 'zod'
import {
  AUDIO_MIME,
  DEMO_PLAYBACK_MIME,
  MAX_AUDIO_BYTES,
  MAX_DURATION_SEC,
  MAX_FILE_NAME_LENGTH,
  MAX_TITLE_LENGTH,
} from '../utils/meeting'
import type { CreateMeetingInput, Meeting, MeetingStatus, TranscriptSegment } from '../types/meeting'

export const meetingStatusSchema = z.enum([
  'pending_upload',
  'uploaded',
  'transcribing',
  'summarizing',
  'indexing',
  'ready',
  'failed',
]) satisfies z.ZodType<MeetingStatus>

/** Request body for `POST /api/meetings`. */
export const createMeetingBodySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  sourceFileName: z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH),
  sourceBytes: z.int().nonnegative(),
  sourceMime: z.string().max(100).nullable(),
  durationSec: z.number().positive().max(MAX_DURATION_SEC).nullable(),
  audioBytes: z.int().positive().max(MAX_AUDIO_BYTES),
}).strict() satisfies z.ZodType<CreateMeetingInput>

export type CreateMeetingBody = z.output<typeof createMeetingBodySchema>

export const meetingIdSchema = z.uuid()

/** Full meeting record as returned by the API. */
export const meetingSchema = z.object({
  id: meetingIdSchema,
  // Postgres returns `+00:00` offsets, not a bare `Z`, so offsets must be allowed.
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  title: z.string(),
  status: meetingStatusSchema,
  sourceFileName: z.string(),
  sourceBytes: z.int().nonnegative(),
  sourceMime: z.string().nullable(),
  durationSec: z.number().nullable(),
  audioKey: z.string(),
  audioBytes: z.int().positive(),
  audioMime: z.enum([AUDIO_MIME, DEMO_PLAYBACK_MIME]),
  uploadedAt: z.iso.datetime({ offset: true }).nullable(),
  errorMessage: z.string().nullable(),
  failedStage: z.enum(['transcription', 'summarization', 'upload']).nullable(),
}) satisfies z.ZodType<Meeting>

/** A single transcript segment as stored and returned by the API. */
export const transcriptSegmentSchema = z.object({
  idx: z.int().nonnegative(),
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  text: z.string(),
}).refine(s => s.endMs >= s.startMs, {
  message: 'endMs must not precede startMs',
  path: ['endMs'],
}) satisfies z.ZodType<TranscriptSegment>
