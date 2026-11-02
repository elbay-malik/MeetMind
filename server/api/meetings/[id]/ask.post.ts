import type { QuestionAnswer } from '#shared/types/meeting'
import { askBodySchema } from '#shared/schemas/qa'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { badRequest, conflict, notFound, requireMeetingId, retryLater } from '../../../utils/http'
import { useAnswerer, useEmbedder } from '../../../utils/qa'
import { AnswerError } from '../../../utils/qa/answerer'
import { askMeeting, QuestionError } from '../../../utils/qa/ask'
import { EmbeddingError } from '../../../utils/qa/embedder'

/** A question body is a sentence; refuse anything far larger before reading it. */
const MAX_BODY_BYTES = 4096

/**
 * Answer a question about one meeting, with every citation checked against the
 * transcript before it is returned (ADR-0007).
 */
export default defineEventHandler(async (event): Promise<{ answer: QuestionAnswer }> => {
  const id = requireMeetingId(event)

  // h3 buffers the whole body before any schema runs, so the size limit has to
  // come from the declared length first — the same guard meeting creation uses.
  const declaredLength = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(declaredLength)) {
    throw createError({ statusCode: 411, statusMessage: 'Content-Length is required' })
  }
  if (declaredLength > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }
  const parsed = askBodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw badRequest('Invalid question', parsed.error)

  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (!transcriptionFinished(meeting)) {
    throw conflict(`Meeting is ${meeting.status}; it has no finished transcript to ask about yet`)
  }

  try {
    const answer = await askMeeting({
      meetingId: id,
      question: parsed.data.question,
      segments: await useTranscriptRepository(event).listForMeeting(id),
      embedder: useEmbedder(event),
      repo: useTranscriptIndexRepository(event),
      answerer: useAnswerer(event),
    })
    return { answer }
  }
  catch (err) {
    if (err instanceof QuestionError) {
      throw createError({ statusCode: err.statusCode, statusMessage: 'Cannot answer', message: err.message })
    }
    if ((err instanceof AnswerError || err instanceof EmbeddingError) && err.retryAt) {
      throw createError({
        statusCode: err.statusCode,
        statusMessage: 'Answering failed',
        message: err.message,
        data: retryLater(event, err.retryAt),
      })
    }
    if (err instanceof EmbeddingError || err instanceof AnswerError) {
      throw createError({ statusCode: err.statusCode, statusMessage: 'Answering failed', message: err.message })
    }
    throw err
  }
})
