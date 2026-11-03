import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranscriptionOutcome } from '../../server/utils/transcription/steps'

/**
 * What the route adds to a step's outcome. The e2e specs drive the stub, whose
 * 429 carries no Retry-After, so the header on a failed run is checked here.
 */

const advance = vi.hoisted(() => vi.fn<() => Promise<TranscriptionOutcome>>())
vi.mock('../../server/utils/transcription/steps', () => ({ advanceTranscription: advance }))
vi.mock('../../server/utils/transcription', () => ({ useTranscriber: () => ({}) }))
vi.mock('../../server/utils/storage', () => ({ useAudioStore: () => ({}) }))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo: () => {} }))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({}),
  usePipelineRepository: () => ({}),
  useSlotRepository: () => ({}),
}))
vi.mock('../../server/utils/http', () => ({
  conflict: (message: string) => Object.assign(new Error(message), { statusCode: 409 }),
  notFound: (message: string) => Object.assign(new Error(message), { statusCode: 404 }),
  requireMeetingId: () => 'meeting',
}))

const headers = new Map<string, unknown>()
let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('setResponseStatus', () => {})
  vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/transcribe.post')).default as unknown as typeof handler
})
afterAll(() => vi.unstubAllGlobals())

describe('POST /api/meetings/:id/transcribe, when the step failed the run', () => {
  it('passes on how long the provider asked to be left alone', async () => {
    headers.clear()
    advance.mockResolvedValueOnce({ kind: 'failed', statusCode: 429, message: 'org_123 is over its tier', retryAt: new Date(Date.now() + 90_000) })
    await expect(handler({})).rejects.toMatchObject({
      statusCode: 429,
      statusMessage: 'Transcription failed',
      message: 'Transcription is being rate limited for now. Try again later.',
    })
    const seconds = headers.get('retry-after') as number
    expect(seconds).toBeGreaterThan(85)
    expect(seconds).toBeLessThanOrEqual(90)
  })

  it('never tells a caller to come back in no time, whatever the clock has done since', async () => {
    headers.clear()
    advance.mockResolvedValueOnce({ kind: 'failed', statusCode: 429, message: 'quota', retryAt: new Date(Date.now() - 5000) })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429 })
    expect(headers.get('retry-after')).toBe(1)
  })

  it('sends no header when the failure gave no time', async () => {
    headers.clear()
    advance.mockResolvedValueOnce({ kind: 'failed', statusCode: 502, message: 'bad reply', retryAt: null })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 502 })
    expect(headers.has('retry-after')).toBe(false)
  })
})
