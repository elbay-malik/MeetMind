import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { DEMO_QUESTIONS_PAUSED_MESSAGE, DEMO_QUESTIONS_USED_MESSAGE } from '../../shared/utils/meeting'
import { nextUtcMidnight, utcDay, type DemoQuestionRepository } from '../../server/utils/db/demo-questions'
import { fixedSentence, publicMessage } from '../../server/utils/public-errors'
import { AnswerError, AnswerSlotBusyError, type Answerer } from '../../server/utils/qa/answerer'
import { askMeeting } from '../../server/utils/qa/ask'
import { demoQuestionAllowance, demoQuestionLimit, demoQuestionSetting, DemoQuestionRefusedError, EXTRACTION_PENDING_RETRY_MS } from '../../server/utils/qa/demo-questions'
import { MODEL } from './helpers/sweep-cases'

/**
 * ADR-0019: the order of gate, slot and take around a question, with the real `askMeeting` and
 * allowance, and everything outside them recording what was called. The order is the whole
 * point. A slot reserved before the gate stalls extraction, and a count taken before the slot
 * lets a loop that is refused its slot burn the day's questions for everyone.
 */

const QUESTION = 'What did we decide about the budget?'
const NOW = Date.parse('2026-11-04T10:30:00Z')
const DEMO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function world(options: {
  limit?: number
  extractionPending?: boolean
  taken?: number
  slotBusy?: () => boolean
  gateFails?: boolean
  takeFails?: boolean
  /** Between this question's gate and its take, everyone else uses up the day. */
  othersTakeTheRest?: boolean
} = {}) {
  const calls: string[] = []
  const state = { taken: options.taken ?? 0 }
  const limit = options.limit ?? 3
  const repo: DemoQuestionRepository = {
    kind: 'local',
    async gate({ limit, demoMeetingId }) {
      calls.push('gate')
      expect(demoMeetingId).toBe(DEMO)
      if (options.gateFails) throw new Error('Supabase demo question gate failed (PGRST202): no such function')
      return { overCount: state.taken >= limit, extractionPending: options.extractionPending ?? false }
    },
    async take(limit) {
      calls.push('take')
      if (options.takeFails) throw new Error('Supabase take demo question failed (42P01): no such table')
      if (state.taken >= limit) return false
      state.taken++
      return true
    },
  }
  const answerer: Answerer = {
    kind: 'stub',
    async reserveSlot() {
      calls.push('slot')
      if (options.othersTakeTheRest) state.taken = limit
      if (options.slotBusy?.()) throw new AnswerSlotBusyError(new Date(NOW + 45_000))
    },
    async answer({ segments }) {
      calls.push('answer')
      return { citations: [{ quote: segments[0]!.text, segmentIdx: 0 }], answer: 'They cut it.' }
    },
  }
  const text = 'We agreed to cut the budget.'
  const ask = () => askMeeting({
    meetingId: DEMO,
    question: QUESTION,
    transcripts: { listRange: async () => [{ idx: 0, startMs: 0, endMs: 1, text }] },
    embedder: {
      model: MODEL,
      embedQuery: async () => {
        calls.push('embed')
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
    allowance: demoQuestionAllowance({ repo, demoMeetingId: DEMO, limit, now: () => NOW }),
  })
  return { calls, state, ask, repo, answerer, limit }
}

/** A question past its take finds no windows here and ends in a plain not-found, which is enough for the order. */
const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error: error as AnswerError }))

/** What costs a provider or a read of the transcript. Each is after the take in `askMeeting`. */
const SPENDERS = ['embed', 'search', 'answer']

describe('a question on the demo', () => {
  it('reads the gate, then reserves its slot, then takes the count, and only then spends', async () => {
    const { calls, ask, state } = world()
    await settle(ask())
    expect(calls.slice(0, 4)).toEqual(['gate', 'read index', 'slot', 'take'])
    expect(calls.slice(4)).toContain('embed')
    expect(calls.indexOf('take')).toBeLessThan(calls.indexOf('embed'))
    expect(state.taken).toBe(1)
  })

  it('is refused at the gate over the count, with the next 00:00 UTC, and nothing else happens', async () => {
    const { calls, ask, state } = world({ taken: 3 })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(DemoQuestionRefusedError)
    expect(error).toMatchObject({ statusCode: 429, message: DEMO_QUESTIONS_USED_MESSAGE })
    expect(error.retryAt).toEqual(new Date('2026-11-05T00:00:00Z'))
    expect(calls).toEqual(['gate'])
    expect(state.taken).toBe(3)
  })

  it('is refused at the gate while an extraction is pending, for about a minute, with no slot reserved and nothing counted', async () => {
    const { calls, ask, state } = world({ extractionPending: true })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toMatchObject({ statusCode: 429, message: DEMO_QUESTIONS_PAUSED_MESSAGE })
    expect(error.retryAt).toEqual(new Date(NOW + EXTRACTION_PENDING_RETRY_MS))
    expect(EXTRACTION_PENDING_RETRY_MS).toBe(60_000)
    expect(calls).toEqual(['gate'])
    expect(state.taken).toBe(0)
  })

  it('says over the count first when both hold, as that is the longer wait', async () => {
    const { ask } = world({ taken: 3, extractionPending: true })
    expect((await settle(ask()) as { error: AnswerError }).error.message).toBe(DEMO_QUESTIONS_USED_MESSAGE)
  })

  it('is refused by the take too, when the count ran out while it waited for its slot, and spends nothing', async () => {
    const { calls, ask, state } = world({ limit: 1, othersTakeTheRest: true })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(DemoQuestionRefusedError)
    expect(error).toMatchObject({ statusCode: 429, message: DEMO_QUESTIONS_USED_MESSAGE })
    expect(error.retryAt).toEqual(new Date('2026-11-05T00:00:00Z'))
    expect(calls).toEqual(['gate', 'read index', 'slot', 'take'])
    expect(state.taken).toBe(1)
  })

  it('takes no count when refused its slot', async () => {
    const { calls, ask, state } = world({ slotBusy: () => true })
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(AnswerSlotBusyError)
    expect(calls).toEqual(['gate', 'read index', 'slot'])
    expect(state.taken).toBe(0)
  })

  it('leaves the day\'s questions to everyone else, however hard a loop hammers past its slot', async () => {
    let free = false
    const { calls, ask, state } = world({ limit: 2, slotBusy: () => !free })
    for (let i = 0; i < 200; i++) {
      expect((await settle(ask()) as { error: AnswerError }).error).toBeInstanceOf(AnswerSlotBusyError)
    }
    expect(state.taken).toBe(0)
    expect(calls.filter(call => call === 'take')).toEqual([])
    expect(calls.filter(call => SPENDERS.includes(call))).toEqual([])
    free = true
    expect((await settle(ask()) as { error?: unknown }).error).toBeUndefined()
    expect(state.taken).toBe(1)
  })

  it('never spends a provider call on a refusal, whatever the refusal', async () => {
    for (const options of [{ taken: 3 }, { extractionPending: true }, { gateFails: true }, { takeFails: true }, { limit: 0 }, { slotBusy: () => true }]) {
      const { calls, ask } = world(options)
      expect((await settle(ask()) as { error: unknown }).error).toBeInstanceOf(AnswerError)
      expect(calls.filter(call => SPENDERS.includes(call))).toEqual([])
    }
  })

  it('refuses every question at a limit of zero, and calls nothing to do it', async () => {
    const { calls, ask } = world({ limit: 0 })
    expect((await settle(ask()) as { error: AnswerError }).error.message).toBe(DEMO_QUESTIONS_USED_MESSAGE)
    expect(calls).toEqual([])
  })

  it.each([
    ['gate', { gateFails: true }, ['gate']],
    ['take', { takeFails: true }, ['gate', 'read index', 'slot', 'take']],
  ])('fails closed when the %s fails, and the visitor is told none of it', async (_step, options, wanted) => {
    const { calls, ask } = world(options)
    const { error } = await settle(ask()) as { error: AnswerError }
    expect(error).toBeInstanceOf(AnswerError)
    expect(error).not.toBeInstanceOf(DemoQuestionRefusedError)
    expect(error).toMatchObject({ statusCode: 503, retryable: false })
    expect(error.retryAt).toBeUndefined()
    expect(calls).toEqual(wanted)
    expect(error.message).toMatch(/PGRST202|42P01/)
    expect(publicMessage('answering', error)).toBe(fixedSentence('answering', 503))
  })
})

describe('a question on the demo that is empty, and so was never going to be asked', () => {
  it('reads nothing of the cap', async () => {
    const { calls, repo, answerer } = world()
    const refused = await settle(askMeeting({
      meetingId: DEMO,
      question: '?!',
      transcripts: { listRange: async () => [] },
      embedder: { model: MODEL } as never,
      repo: { readState: async () => ({}) as never, search: async () => [] },
      answerer,
      allowance: demoQuestionAllowance({ repo, demoMeetingId: DEMO, limit: 3 }),
    })) as { error: { statusCode: number } }
    expect(refused.error.statusCode).toBe(400)
    expect(calls).toEqual([])
  })
})

describe('the setting', () => {
  let warn: MockInstance<typeof console.warn>
  beforeAll(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterAll(() => warn.mockRestore())

  it.each([1, 25, 2_147_483_647])('takes %s as it is', (value) => {
    expect(demoQuestionLimit(value)).toBe(value)
  })

  it.each<[string, unknown]>([
    ['zero', 0],
    ['nothing', undefined],
    ['null', null],
    ['blank', ''],
    ['a word', 'lots'],
    ['a fraction', 2.5],
    ['less than nothing', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['past what the column holds', 2_147_483_648],
    ['quoted', '25'],
  ])('reads %s as a limit of zero, never as no limit', (_name, value) => {
    expect(demoQuestionLimit(value)).toBe(0)
  })

  it.each(['null', 'NULL', ' null ', 'undefined', 'Undefined', '\tundefined\n'])('reads the text %j as a bad value, whatever default Nitro kept in its place', (written) => {
    expect(demoQuestionLimit(demoQuestionSetting(25, written))).toBe(0)
  })

  it.each<[string | undefined, unknown]>([
    [undefined, 25],
    ['7', 7],
    ['abc', 'abc'],
    ['', ''],
    ['nullish', 'nullish'],
  ])('leaves the text %j to what the runtime config made of it', (written, configured) => {
    expect(demoQuestionSetting(configured, written)).toBe(configured)
  })

  it('warns by name and never with the value', () => {
    const lines = warn.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('NUXT_DEMO_QUESTIONS_PER_DAY'))).toBe(true)
    expect(lines.join()).not.toContain('lots')
  })

  it('counts by UTC day, and comes back at its next midnight, on either side of one', () => {
    expect(utcDay(Date.parse('2026-11-04T23:59:59.999Z'))).toBe('2026-11-04')
    expect(utcDay(Date.parse('2026-11-05T00:00:00.000Z'))).toBe('2026-11-05')
    expect(nextUtcMidnight(Date.parse('2026-11-04T23:59:59.999Z'))).toEqual(new Date('2026-11-05T00:00:00.000Z'))
    expect(nextUtcMidnight(Date.parse('2026-11-05T00:00:00.000Z'))).toEqual(new Date('2026-11-06T00:00:00.000Z'))
    expect(nextUtcMidnight(Date.parse('2026-12-31T12:00:00.000Z'))).toEqual(new Date('2027-01-01T00:00:00.000Z'))
  })
})

const route = vi.hoisted(() => ({
  gate: vi.fn(),
  take: vi.fn(),
  demoId: '',
  warned: [] as unknown[][],
}))
// Both read the runtime config, which only a built server has: tests/e2e/demo-questions.spec.ts has that.
vi.mock('../../server/utils/demo-meeting', async () => {
  const { isDemoMeetingId } = await import('../../shared/utils/meeting')
  return { isPublicDemo: (_event: unknown, id: string) => isDemoMeetingId(route.demoId, id) }
})
vi.mock('../../server/utils/qa/demo-questions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/utils/qa/demo-questions')>()
  return {
    ...original,
    useDemoQuestionAllowance: (_event: unknown, demoMeetingId: string) => original.demoQuestionAllowance({
      repo: { kind: 'local', gate: route.gate, take: route.take },
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
  useTranscriptIndexRepository: () => ({
    readState: async () => ({ storedForModel: 0 }),
    search: async () => [],
  }),
  useTranscriptRepository: () => ({ listRange: async () => [] }),
  // Every other meeting's count (ADR-0020), never the demo's: tests/unit/meeting-question-cap.spec.ts has it.
  useMeetingQuestionRepository: () => ({ kind: 'local', overCount: async () => false, take: async () => true }),
}))

/** The route, with `askMeeting` real. Only a demo reaches the demo's two functions. */
describe('POST /api/meetings/:id/ask', () => {
  const headers = new Map<string, unknown>()
  const JSON_REQUEST = { 'content-length': '30', 'content-type': 'application/json' }
  let request: Record<string, string> = JSON_REQUEST
  type Handler = (event: unknown) => Promise<unknown>
  let handler: Handler
  let warn: MockInstance<typeof console.warn>

  beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
    vi.stubGlobal('getRouterParam', () => DEMO)
    vi.stubGlobal('getRequestHeader', (_event: unknown, name: string) => request[name])
    vi.stubGlobal('readBody', async () => ({ question: QUESTION }))
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
    handler = (await import('../../server/api/meetings/[id]/ask.post')).default as unknown as Handler
  })
  beforeEach(() => {
    headers.clear()
    warn.mockClear()
    route.gate.mockReset()
    route.take.mockReset()
    route.demoId = DEMO
    request = JSON_REQUEST
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  it('calls neither function for any other meeting, migration or no migration', async () => {
    route.demoId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    route.gate.mockRejectedValue(new Error('no such function'))
    route.take.mockRejectedValue(new Error('no such function'))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409 })
    expect(route.gate).not.toHaveBeenCalled()
    expect(route.take).not.toHaveBeenCalled()
  })

  it('calls neither with no demo set at all', async () => {
    route.demoId = ''
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409 })
    expect(route.gate).not.toHaveBeenCalled()
  })

  it('takes the demo by its id in capitals, as Postgres would', async () => {
    route.demoId = DEMO.toUpperCase()
    route.gate.mockResolvedValue({ overCount: true, extractionPending: false })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429, message: DEMO_QUESTIONS_USED_MESSAGE })
  })

  it('answers over the count in the shape the route already sends, says when, and logs nothing', async () => {
    route.gate.mockResolvedValue({ overCount: true, extractionPending: false })
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, statusMessage: string, message: string, data: { retryAt: string, retryAfterSec: number } }
    expect(refused).toMatchObject({ statusCode: 429, statusMessage: 'Answering failed', message: DEMO_QUESTIONS_USED_MESSAGE })
    expect(refused.data.retryAt).toBe(nextUtcMidnight(Date.now()).toISOString())
    expect(refused.data.retryAfterSec).toBeGreaterThan(0)
    expect(refused.data.retryAfterSec).toBeLessThanOrEqual(86_400)
    expect(headers.get('retry-after')).toBe(refused.data.retryAfterSec)
    expect(warn).not.toHaveBeenCalled()
  })

  it('answers while an extraction is pending with about a minute', async () => {
    route.gate.mockResolvedValue({ overCount: false, extractionPending: true })
    const refused = await handler({}).catch((err: unknown) => err) as { message: string, data: { retryAfterSec: number } }
    expect(refused.message).toBe(DEMO_QUESTIONS_PAUSED_MESSAGE)
    expect(refused.data.retryAfterSec).toBeGreaterThanOrEqual(59)
    expect(refused.data.retryAfterSec).toBeLessThanOrEqual(60)
    expect(headers.get('retry-after')).toBe(refused.data.retryAfterSec)
  })

  it('fails closed with the fixed sentence when the gate fails, as with no migration, and keeps the words in the log', async () => {
    const failure = new Error('Supabase demo question gate failed (PGRST202): Could not find the function public.demo_question_gate')
    route.gate.mockRejectedValue(failure)
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string, data?: unknown }
    expect(refused).toMatchObject({ statusCode: 503, message: fixedSentence('answering', 503) })
    expect(refused.message).not.toMatch(/Supabase|PGRST|demo_question_gate/)
    expect(refused.data).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(String((warn.mock.lastCall![1] as Error).message)).toContain('PGRST202')
  })
  it.each([
    ['a form', 'application/x-www-form-urlencoded', 415],
    ['a multipart form', 'multipart/form-data; boundary=x', 415],
    ['plain text', 'text/plain', 415],
    ['plain text that names JSON in a parameter', 'text/plain; type=application/json', 415],
    ['no type at all', undefined, 415],
  ])('refuses %s before reading it, and calls neither function', async (_name, type, statusCode) => {
    request = { 'content-length': '30', ...(type === undefined ? {} : { 'content-type': type }) }
    const readBody = vi.fn(async () => ({ question: QUESTION }))
    vi.stubGlobal('readBody', readBody)
    try {
      await expect(handler({})).rejects.toMatchObject({ statusCode })
    }
    finally {
      vi.stubGlobal('readBody', async () => ({ question: QUESTION }))
    }
    expect(readBody).not.toHaveBeenCalled()
    expect(route.gate).not.toHaveBeenCalled()
    expect(route.take).not.toHaveBeenCalled()
  })

  it('refuses a request its browser says another site started, before anything else', async () => {
    request = { ...JSON_REQUEST, 'sec-fetch-site': 'cross-site' }
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403 })
    expect(route.gate).not.toHaveBeenCalled()
    expect(route.take).not.toHaveBeenCalled()
  })

  it.each([
    ['its own page', 'same-origin'],
    ['a sibling subdomain', 'same-site'],
    ['an address typed in', 'none'],
    ['no such header, as from curl', undefined],
  ])('goes on from %s, with JSON in any spelling', async (_name, site) => {
    request = { 'content-length': '30', 'content-type': 'Application/JSON; charset=utf-8', ...(site === undefined ? {} : { 'sec-fetch-site': site }) }
    route.gate.mockResolvedValue({ overCount: true, extractionPending: false })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429, message: DEMO_QUESTIONS_USED_MESSAGE })
    expect(route.gate).toHaveBeenCalledOnce()
  })
})
