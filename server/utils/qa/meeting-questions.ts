import type { H3Event } from 'h3'
import { MEETING_QUESTIONS_USED_MESSAGE } from '#shared/utils/meeting'
import { useMeetingQuestionRepository } from '../db'
import { nextUtcMidnight } from '../db/demo-questions'
import type { MeetingQuestionRepository } from '../db/meeting-questions'
import { AnswerError } from './answerer'
import type { QuestionAllowance } from './ask'

/**
 * Questions a meeting other than the public demo answers in a UTC day (ADR-0020). A meeting's
 * link is held by whoever registered it and whoever they gave it to, and every meeting draws on
 * the same daily allowances of the answering and embedding providers. A hundred is far more than
 * someone reading one meeting asks in a day, and puts a bound on what one link can take of what
 * the other meetings and extraction share. A constant and not a setting: nothing here needs to
 * change it per deployment, and a setting is one more thing a typo can open.
 */
export const MEETING_QUESTIONS_PER_DAY = 100

/** A refusal of our own, with a time, which nothing went wrong to cause, so it is not logged. */
export class MeetingQuestionRefusedError extends AnswerError {
  constructor(retryAt: Date) {
    super(MEETING_QUESTIONS_USED_MESSAGE, 429, false, retryAt)
    this.name = 'MeetingQuestionRefusedError'
  }
}

/** The gate or the take did not work, so nothing says the meeting may spend: refuse, and leave the words for the log. */
function closed(step: string, cause: unknown): AnswerError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new AnswerError(`The meeting question ${step} failed: ${detail}`, 503, false)
}

/**
 * Every other meeting's count, in the demo's order and for the demo's reasons (ADR-0019): read
 * before the provider's slot, so a question over the count holds none, and taken only once the
 * slot is granted, so a question refused its slot uses none of the day. A question that fails at
 * a provider after its take has used one. Without a working gate and take it fails closed.
 */
export function meetingQuestionAllowance(deps: {
  repo: MeetingQuestionRepository
  meetingId: string
  limit?: number
  now?: () => number
}): QuestionAllowance {
  const now = deps.now ?? Date.now
  const limit = deps.limit ?? MEETING_QUESTIONS_PER_DAY
  const used = () => new MeetingQuestionRefusedError(nextUtcMidnight(now()))

  return {
    async check() {
      const over = await deps.repo.overCount({ limit, meetingId: deps.meetingId }).catch((err: unknown) => {
        throw closed('gate', err)
      })
      if (over) throw used()
    },

    async take() {
      const taken = await deps.repo.take({ limit, meetingId: deps.meetingId }).catch((err: unknown) => {
        throw closed('take', err)
      })
      if (!taken) throw used()
    },
  }
}

/** This meeting's allowance, for this request. Never the demo's: it has its own. */
export function useMeetingQuestionAllowance(event: H3Event, meetingId: string): QuestionAllowance {
  return meetingQuestionAllowance({ repo: useMeetingQuestionRepository(event), meetingId })
}
