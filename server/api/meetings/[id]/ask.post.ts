import type { QuestionAnswer } from '#shared/types/meeting'
import { askBodySchema } from '#shared/schemas/qa'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { isPublicDemo } from '../../../utils/demo-meeting'
import { badRequest, conflict, notFound, requireMeetingId, retryLater } from '../../../utils/http'
import { publicMessage } from '../../../utils/public-errors'
import { useAnswerer, useEmbedder } from '../../../utils/qa'
import { AnswerError, AnswerSlotBusyError } from '../../../utils/qa/answerer'
import { askMeeting, QuestionError } from '../../../utils/qa/ask'
import { DemoQuestionRefusedError, useDemoQuestionAllowance } from '../../../utils/qa/demo-questions'
import { EmbeddingError } from '../../../utils/qa/embedder'

/** A question body is a sentence; refuse anything far larger before reading it. */
const MAX_BODY_BYTES = 4096

/**
 * Answer a question about one meeting, with every citation checked against the
 * transcript before it is returned (ADR-0007).
 *
 * A provider's failure here is stored nowhere, so the log is the only copy of what it
 * said. A turn refused by our own pacing has nothing to say, and asking is open to anyone,
 * so that one is not logged, and nor is a refusal by the demo's cap (ADR-0019). Only the public
 * demo has a cap: no other meeting's question calls anything of it.
 *
 * The body is JSON, and only JSON: any other declared type is a 415. A browser on another
 * origin can send a form or plain text without asking first, but JSON only after a CORS
 * preflight, which this app never grants, so a page elsewhere cannot make a visitor's browser
 * ask. A request the browser itself marks as started by another site (`Sec-Fetch-Site:
 * cross-site`) is a 403. A client that sends no such header, such as curl or an older browser,
 * is judged by its type alone. Both are read from the headers before the body, so a refused
 * request reaches no meeting, no slot and no demo count.
 */
export default defineEventHandler(async (event): Promise<{ answer: QuestionAnswer }> => {
  const id = requireMeetingId(event)

  if (getRequestHeader(event, 'sec-fetch-site')?.trim().toLowerCase() === 'cross-site') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: 'Questions are asked from this site only' })
  }
  const mediaType = getRequestHeader(event, 'content-type')?.split(';')[0]!.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported Media Type', message: 'A question is sent as application/json' })
  }

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
      transcripts: useTranscriptRepository(event),
      embedder: useEmbedder(event),
      repo: useTranscriptIndexRepository(event),
      answerer: useAnswerer(event),
      allowance: isPublicDemo(event, id) ? useDemoQuestionAllowance(event, id) : undefined,
    })
    return { answer }
  }
  catch (err) {
    if (err instanceof QuestionError) {
      throw createError({ statusCode: err.statusCode, statusMessage: 'Cannot answer', message: publicMessage('answering', err) })
    }
    if (!(err instanceof EmbeddingError || err instanceof AnswerError)) throw err
    if (!(err instanceof AnswerSlotBusyError || err instanceof DemoQuestionRefusedError)) console.warn(`[meetmind] a question on meeting ${id} failed:`, err)
    throw createError({
      statusCode: err.statusCode,
      statusMessage: 'Answering failed',
      message: publicMessage('answering', err),
      data: err.retryAt ? retryLater(event, err.retryAt) : undefined,
    })
  }
})
