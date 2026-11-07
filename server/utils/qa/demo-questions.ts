import type { H3Event } from 'h3'
import { DEMO_QUESTIONS_PAUSED_MESSAGE, DEMO_QUESTIONS_USED_MESSAGE } from '#shared/utils/meeting'
import { useDemoQuestionRepository } from '../db'
import { nextUtcMidnight, type DemoQuestionRepository } from '../db/demo-questions'
import { AnswerError } from './answerer'
import type { QuestionAllowance } from './ask'

/** Roughly how long an extraction holds questions off before it is worth asking again. */
export const EXTRACTION_PENDING_RETRY_MS = 60_000

/** The largest a Postgres integer holds. A larger setting would fail each call anyway. */
const MAX_LIMIT = 2_147_483_647

/** A refusal of our own, with a time, which nothing went wrong to cause, so it is not logged. */
export class DemoQuestionRefusedError extends AnswerError {
  constructor(message: string, retryAt: Date) {
    super(message, 429, false, retryAt)
    this.name = 'DemoQuestionRefusedError'
  }
}

let warnedOfSetting = false

/**
 * The setting as a limit. Zero, and whatever is not a positive whole number, is a limit of zero
 * and so refuses every question: a typo must never read as no cap. Logged once per isolate, by
 * name, as whoever set it believes it is on. Zero says what it means, and is not logged.
 */
export function demoQuestionLimit(setting: unknown): number {
  if (setting === 0) return 0
  if (typeof setting === 'number' && Number.isInteger(setting) && setting > 0 && setting <= MAX_LIMIT) return setting
  if (!warnedOfSetting) {
    warnedOfSetting = true
    console.warn('[meetmind] NUXT_DEMO_QUESTIONS_PER_DAY is not a positive whole number, so every question on the demo is refused')
  }
  return 0
}

/**
 * The setting as written, for what Nitro's runtime config cannot show. Its env layer reads
 * `null` and `undefined`, in any case and with spaces around, as nothing at all, and then keeps
 * the default, so a limit nobody set would run with nothing logged. Those two read here as the
 * bad value they are. Anything else, set or not, is the runtime config's to say.
 */
export function demoQuestionSetting(configured: unknown, written: string | undefined): unknown {
  return written !== undefined && /^(?:null|undefined)$/i.test(written.trim()) ? null : configured
}

/** The gate or the take did not work, so nothing says the demo may spend: refuse, and leave the words for the log. */
function closed(step: string, cause: unknown): AnswerError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new AnswerError(`The demo question ${step} failed: ${detail}`, 503, false)
}

/**
 * The public demo's cap (ADR-0019): over the count, or while another meeting's extraction is
 * pending, a question is refused before it reserves a slot, and the count is taken only once it
 * has its slot. Without a working gate and take it fails closed, as every other meeting's count
 * does (ADR-0020).
 */
export function demoQuestionAllowance(deps: {
  repo: DemoQuestionRepository
  demoMeetingId: string
  limit: number
  now?: () => number
}): QuestionAllowance {
  const now = deps.now ?? Date.now
  const used = () => new DemoQuestionRefusedError(DEMO_QUESTIONS_USED_MESSAGE, nextUtcMidnight(now()))

  return {
    async check() {
      if (deps.limit <= 0) throw used()
      const gate = await deps.repo.gate({ limit: deps.limit, demoMeetingId: deps.demoMeetingId }).catch((err: unknown) => {
        throw closed('gate', err)
      })
      if (gate.overCount) throw used()
      if (gate.extractionPending) throw new DemoQuestionRefusedError(DEMO_QUESTIONS_PAUSED_MESSAGE, new Date(now() + EXTRACTION_PENDING_RETRY_MS))
    },

    async take() {
      const taken = await deps.repo.take(deps.limit).catch((err: unknown) => {
        throw closed('take', err)
      })
      if (!taken) throw used()
    },
  }
}

/** The demo's allowance, for this request. */
export function useDemoQuestionAllowance(event: H3Event, demoMeetingId: string): QuestionAllowance {
  return demoQuestionAllowance({
    repo: useDemoQuestionRepository(event),
    demoMeetingId,
    limit: demoQuestionLimit(demoQuestionSetting(useRuntimeConfig(event).demoQuestionsPerDay, process.env.NUXT_DEMO_QUESTIONS_PER_DAY)),
  })
}
