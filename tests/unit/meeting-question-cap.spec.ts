import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MEETING_QUESTIONS_USED_MESSAGE } from '../../shared/utils/meeting'
import { nextUtcMidnight } from '../../server/utils/db/demo-questions'
import type { MeetingQuestionRepository } from '../../server/utils/db/meeting-questions'
import { fixedSentence, publicMessage } from '../../server/utils/public-errors'
import { AnswerError, AnswerSlotBusyError, type Answerer } from '../../server/utils/qa/answerer'
import { askMeeting } from '../../server/utils/qa/ask'
import { MEETING_QUESTIONS_PER_DAY, meetingQuestionAllowance, MeetingQuestionRefusedError } from '../../server/utils/qa/meeting-questions'
import { MODEL } from './helpers/sweep-cases'

/**
 * ADR-0020: every meeting but the demo has its own daily count, read before the provider's slot
 * and taken after it, in the demo's order (tests/unit/demo-question-cap.spec.ts) and for its
 * reasons. The real `askMeeting` and allowance, with everything outside them recording calls.
 */

const QUESTION = 'What did we decide about the budget?'
const NOW = Date.parse('2026-11-07T10:30:00Z')
const MEETING = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function world(options: {
  limit?: number
  taken?: number
  slotBusy?: () => boolean
  gateFails?: boolean
  takeFails?: boolean
  /** The first provider call after the take fails. */
  providerFails?: boolean
  /** Between this question's gate and its take, other questions on the meeting use up the day. */
  othersTakeTheRest?: boolean
} = {}) {
  const calls: string[] = []
  const state = { taken: options.taken ?? 0 }
  const limit = options.limit ?? 3
  const repo: MeetingQuestionRepository = {
    kind: 'local',
    async overCount({ limit, meetingId }) {
      calls.push('gate')
      expect(meetingId).toBe(MEETING)
      if (options.gateFails) throw new Error('Supabase meeting question gate failed (PGRST202): no such function')
      return state.taken >= limit
    },
    async take({ limit, meetingId }) {
      calls.push('take')
      expect(meetingId).toBe(MEETING)
      if (options.takeFails) throw new Error('Supabase take meeting question failed (42P01): no such table')
      if (state.taken >= limit) return false
      state.taken++
      return true
    },
  }
  const text = 'We agreed to cut the budget.'
  const answerer: Answerer = {
    kind: 'stub',
    async reserveSlot() {
      calls.push('slot')
      if (options.othersTakeTheRest) state.taken = limit
      if (options.slotBusy?.()) throw new AnswerSlotBusyError(new Date(NOW + 45_000))
    },
    async answer() {
      calls.push('answer')
      return { citations: [{ quote: text, segmentIdx: 0 }], answer: 'They cut it.' }
    },
  }
  const ask = () => askMeeting({
    meetingId: MEETING,
    question: QUESTION,
    transcripts: { listRange: async () => [{ idx: 0, startMs: 0, endMs: 1, text }] },
    embedder: {
      model: MODEL,
      embedQuery: async () => {
        calls.push('embed')
        if (options.providerFails) throw new AnswerError('Answering quota is exhausted for now.', 429, false)
        return [1]
      },
      embedDocuments: async () => [],
    } as never,
    repo: {
      readState: async () => {
        calls.push('read index')
        return { segmentCount: 1, storedWindows: 1, storedForModel: 1, transcriptHash: 'h', marker: { complete: true, model: MODEL, textHash: 'h', windowCount: 1 } } as never
      },
      search: async () => {
        calls.push('search')
        return []
      },
    },
    answerer,
    allowance: meetingQuestionAllowance({ repo, meetingId: MEETING, limit, now: () => NOW }),
  })
  return { calls, state, ask }
}

const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error: error as AnswerError }))
const SPENDERS = ['embed', 'search', 'answer']

describe('a question on any meeting but the demo', () => {
  it('has a hundred a day, as ADR-0020 says', () => {
    expect(MEETING_QUESTIONS_PER_DAY).toBe(100)
  })

  it('reads the gate, then reserves its slot, then takes the count, and only then spends', async () => {
    const { calls, ask, state } = world()
    await settle(ask())
    expect(calls.slice(0, 4)).toEqual(['gate', 'read index', 'slot', 'take'])
    expect(calls.indexOf('take')).toBeLessThan(calls.indexOf('embed'))
    expect(state.taken).toBe(1)
  })

  it('is refused at the gate over the count, with the next 00:00 UTC, and nothing else happens', async () => {
    const { calls, ask, state } = world({ taken: 3 })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(MeetingQuestionRefusedError)
    expect(error).toMatchObject({ statusCode: 429, message: MEETING_QUESTIONS_USED_MESSAGE })
    expect(error.retryAt).toEqual(new Date('2026-11-08T00:00:00Z'))
    expect(calls).toEqual(['gate'])
    expect(state.taken).toBe(3)
  })

  it('is refused by the take too, when the count ran out while it waited for its slot, and spends nothing', async () => {
    const { calls, ask } = world({ limit: 1, othersTakeTheRest: true })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(MeetingQuestionRefusedError)
    expect(calls).toEqual(['gate', 'read index', 'slot', 'take'])
  })

  it('takes no count when refused its slot, however many times', async () => {
    let free = false
    const { calls, ask, state } = world({ limit: 2, slotBusy: () => !free })
    for (let i = 0; i < 50; i++) {
      expect((await settle(ask()) as { error: AnswerError }).error).toBeInstanceOf(AnswerSlotBusyError)
    }
    expect(state.taken).toBe(0)
    expect(calls.filter(call => call === 'take' || SPENDERS.includes(call))).toEqual([])
    free = true
    expect((await settle(ask()) as { error?: unknown }).error).toBeUndefined()
    expect(state.taken).toBe(1)
  })

  it('has used its count when the provider fails after the take, as the demo\'s does', async () => {
    const { ask, state } = world({ providerFails: true })
    expect((await settle(ask()) as { error: AnswerError }).error.message).toBe('Answering quota is exhausted for now.')
    expect(state.taken).toBe(1)
  })

  it.each([
    ['gate', { gateFails: true }, ['gate']],
    ['take', { takeFails: true }, ['gate', 'read index', 'slot', 'take']],
  ])('fails closed when the %s fails, and the caller is told none of it', async (_step, options, wanted) => {
    const { calls, ask } = world(options)
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).not.toBeInstanceOf(MeetingQuestionRefusedError)
    expect(error).toMatchObject({ statusCode: 503, retryable: false })
    expect(error.retryAt).toBeUndefined()
    expect(calls).toEqual(wanted)
    expect(publicMessage('answering', error)).toBe(fixedSentence('answering', 503))
  })

  it('says its refusal in its own words, which pass the allow-list', () => {
    expect(publicMessage('answering', new MeetingQuestionRefusedError(new Date(NOW)))).toBe(MEETING_QUESTIONS_USED_MESSAGE)
  })
})

const route = vi.hoisted(() => ({
  overCount: vi.fn(),
  take: vi.fn(),
  demoGate: vi.fn(),
  demoId: '',
}))
vi.mock('../../server/utils/demo-meeting', async () => {
  const { isDemoMeetingId } = await import('../../shared/utils/meeting')
  return { isPublicDemo: (_event: unknown, id: string) => isDemoMeetingId(route.demoId, id) }
})
vi.mock('../../server/utils/qa/demo-questions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/utils/qa/demo-questions')>()
  return {
    ...original,
    useDemoQuestionAllowance: (_event: unknown, demoMeetingId: string) => original.demoQuestionAllowance({
      repo: { kind: 'local', gate: route.demoGate, take: vi.fn() },
      demoMeetingId,
      limit: 25,
    }),
  }
})
vi.mock('../../server/utils/qa', () => ({
  useAnswerer: () => ({ kind: 'stub', reserveSlot: async () => {}, answer: async () => ({ citations: [], answer: '' }) }),
  useEmbedder: () => ({ model: 'model-a', embedQuery: async () => [1] }),
}))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({ get: async () => ({ status: 'ready' }) }),
  useTranscriptIndexRepository: () => ({ readState: async () => ({ storedForModel: 0 }), search: async () => [] }),
  useTranscriptRepository: () => ({ listRange: async () => [] }),
  useMeetingQuestionRepository: () => ({ kind: 'local', overCount: route.overCount, take: route.take }),
}))

describe('POST /api/meetings/:id/ask, on a meeting that is not the demo', () => {
  const headers = new Map<string, unknown>()
  type Handler = (event: unknown) => Promise<unknown>
  let handler: Handler
  let warn: MockInstance<typeof console.warn>

  beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
    vi.stubGlobal('getRouterParam', () => MEETING)
    vi.stubGlobal('getRequestHeader', (_event: unknown, name: string) => ({ 'content-length': '30', 'content-type': 'application/json' })[name])
    vi.stubGlobal('readBody', async () => ({ question: QUESTION }))
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
    handler = (await import('../../server/api/meetings/[id]/ask.post')).default as unknown as Handler
  })
  beforeEach(() => {
    headers.clear()
    warn.mockClear()
    route.overCount.mockReset()
    route.take.mockReset()
    route.demoGate.mockReset()
    route.demoId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  it('answers over the count with 429 and the next 00:00 UTC, as the demo\'s does, and logs nothing', async () => {
    route.overCount.mockResolvedValue(true)
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, statusMessage: string, message: string, data: { retryAt: string, retryAfterSec: number } }
    expect(refused).toMatchObject({ statusCode: 429, statusMessage: 'Answering failed', message: MEETING_QUESTIONS_USED_MESSAGE })
    expect(refused.data.retryAt).toBe(nextUtcMidnight(Date.now()).toISOString())
    expect(headers.get('retry-after')).toBe(refused.data.retryAfterSec)
    expect(route.overCount).toHaveBeenCalledWith({ limit: MEETING_QUESTIONS_PER_DAY, meetingId: MEETING })
    expect(route.demoGate).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails closed with the fixed sentence when the gate fails, as with no migration, and keeps the words in the log', async () => {
    route.overCount.mockRejectedValue(new Error('Supabase meeting question gate failed (PGRST202): Could not find the function'))
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string }
    expect(refused).toMatchObject({ statusCode: 503, message: fixedSentence('answering', 503) })
    expect(warn).toHaveBeenCalledOnce()
    expect(String((warn.mock.lastCall![1] as Error).message)).toContain('PGRST202')
  })

  it('leaves the demo to its own count, and never reads this one for it', async () => {
    route.demoId = MEETING
    route.demoGate.mockResolvedValue({ overCount: true, extractionPending: false })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429 })
    expect(route.demoGate).toHaveBeenCalledOnce()
    expect(route.overCount).not.toHaveBeenCalled()
  })
})
