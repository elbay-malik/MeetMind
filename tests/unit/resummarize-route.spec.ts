import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'
import { MIN_ADMIN_TOKEN_LENGTH } from '../../server/utils/admin'
import { fixedSentence } from '../../server/utils/public-errors'
import { RESTART_REFUSALS, type ExtractionOutcome } from '../../server/utils/summary/steps'

/**
 * What `POST /api/meetings/:id/resummarize` adds to `restartExtraction`: the admin token before
 * anything else, as for the admin delete (ADR-0011), and how each outcome is answered. Which
 * meetings it moves is tests/unit/resummarize.spec.ts, and the whole route over a built server is
 * tests/e2e/resummarize-api.spec.ts.
 */

const restart = vi.hoisted(() => vi.fn<(id: string, deps: unknown) => Promise<ExtractionOutcome>>())
vi.mock('../../server/utils/summary/steps', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/summary/steps')>(),
  restartExtraction: restart,
}))
vi.mock('../../server/utils/pipeline/deps', () => ({ useExtractionStepDeps: () => ({ built: true }) }))
vi.mock('../../server/utils/db', () => ({ useTranscriptIndexRepository: () => ({ index: true }) }))
vi.mock('../../server/utils/qa', () => ({ useStepEmbedder: () => ({ model: 'model-a' }) }))
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig: () => ({ adminToken: configured }) }))
vi.mock('../../server/utils/http', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/http')>(),
  requireMeetingId: () => 'meeting',
}))

const TOKEN = 'a'.repeat(MIN_ADMIN_TOKEN_LENGTH)
let configured = TOKEN
let authorization: string | undefined
const headers = new Map<string, unknown>()
let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('getRequestHeader', (_event: unknown, name: string) => name === 'authorization' ? authorization : undefined)
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  // Resolved from h3 itself in this tier, so the status codes are held in tests/e2e.
  vi.stubGlobal('setResponseStatus', () => {})
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/resummarize.post')).default as unknown as typeof handler
})
beforeEach(() => {
  configured = TOKEN
  authorization = `Bearer ${TOKEN}`
  headers.clear()
  restart.mockReset()
})
afterAll(() => vi.unstubAllGlobals())

const meeting: Meeting = {
  id: 'meeting', createdAt: 'x', updatedAt: '2026-11-08T00:00:00.000Z', title: 't', status: 'indexing', sourceFileName: 'f', sourceBytes: 1, sourceMime: null,
  durationSec: null, audioKey: 'k', audioBytes: 1, audioMime: 'audio/ogg', uploadedAt: null, errorMessage: null, failedStage: null,
}

describe('POST /api/meetings/:id/resummarize, before the meeting is looked at', () => {
  it('does not exist with no token configured', async () => {
    for (const unset of ['', '   \n']) {
      configured = unset
      await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(restart).not.toHaveBeenCalled()
  })

  it('refuses a missing or wrong token with 401, and asks for a bearer', async () => {
    for (const sent of [undefined, '', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN]) {
      authorization = sent
      await expect(handler({})).rejects.toMatchObject({ statusCode: 401 })
    }
    expect(headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(restart).not.toHaveBeenCalled()
  })

  it('refuses to use a token shorter than the minimum', async () => {
    configured = TOKEN.slice(1)
    authorization = `Bearer ${configured}`
    await expect(handler({})).rejects.toThrow(/at least/)
    expect(restart).not.toHaveBeenCalled()
  })

  it('is not refused on the public demo, which the token admits like any meeting', async () => {
    restart.mockResolvedValueOnce({ kind: 'progress', meeting, progress: { done: 0, total: 2, lastError: null }, next: 'continue', retryAt: null })
    await handler({})
    expect(restart).toHaveBeenCalledWith('meeting', { built: true, index: { index: true }, model: 'model-a' })
  })
})

describe('POST /api/meetings/:id/resummarize, its answers', () => {
  it('answers the plan when extraction has started again', async () => {
    restart.mockResolvedValueOnce({ kind: 'progress', meeting, progress: { done: 0, total: 2, lastError: 'raw' }, next: 'continue', retryAt: null })
    const answer = await handler({}) as { meeting: { status: string }, progress: object, next: string }
    expect(answer).toMatchObject({ meeting: { status: 'indexing' }, progress: { done: 0, total: 2 }, next: 'continue', retryAt: null, retryAfterMs: null })
    expect(answer.progress).not.toHaveProperty('lastError')
  })

  it('answers the summary when there was nothing to extract', async () => {
    const summary = { summary: '', decisions: [], actionItems: [], provider: 'stub' as const }
    restart.mockResolvedValueOnce({ kind: 'done', meeting: { ...meeting, status: 'ready' }, summary })
    expect(await handler({})).toMatchObject({ meeting: { status: 'ready' }, summary })
  })

  it.each([
    [404, 'Meeting not found'],
    [409, RESTART_REFUSALS.notFinished('summarizing')],
    [409, RESTART_REFUSALS.tooLong],
    [409, RESTART_REFUSALS.noIndex],
    [409, RESTART_REFUSALS.moved],
  ] as const)('answers a refusal with %i and its own sentence: %s', async (statusCode, message) => {
    restart.mockResolvedValueOnce({ kind: 'refused', statusCode, message })
    await expect(handler({})).rejects.toMatchObject({ statusCode, message })
  })

  it('says nothing of a refusal in words it does not know', async () => {
    restart.mockResolvedValueOnce({ kind: 'refused', statusCode: 409, message: 'Supabase read failed (PGRST116)' })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409, message: fixedSentence('extraction', 409) })
  })
})
