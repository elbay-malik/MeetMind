import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting } from '../../shared/types/meeting'

/**
 * What the route says of an upload it refuses, when the delete behind the refusal fails. The
 * e2e specs run the local store, whose driver swallows every error of a removal, so only
 * here can a store answer as R2 does, with the object's key in what it says.
 */

const KEY = 'meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio.ogg'
const DELETE_FAILED = `R2 DELETE ${KEY} failed with 500`

const row = (patch: Partial<Meeting> = {}): Meeting => ({
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  title: 'Refused',
  status: 'pending_upload',
  sourceFileName: 'a.mp4',
  sourceBytes: 1,
  sourceMime: null,
  durationSec: null,
  audioKey: KEY,
  audioBytes: 4096,
  audioMime: 'audio/ogg',
  uploadedAt: null,
  errorMessage: null,
  failedStage: null,
  ...patch,
})

const store = vi.hoisted(() => ({ head: vi.fn(), delete: vi.fn() }))
const repo = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), claim: vi.fn() }))
vi.mock('../../server/utils/storage', () => ({ useAudioStore: () => store }))
vi.mock('../../server/utils/db', () => ({ useMeetingRepository: () => repo }))
vi.mock('../../server/utils/demo-meeting', () => ({ refuseOnPublicDemo: () => {} }))

let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: typeof handler) => fn)
  vi.stubGlobal('getRouterParam', () => '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/complete.post')).default as unknown as typeof handler
})
beforeEach(() => {
  vi.clearAllMocks()
  store.delete.mockResolvedValue(undefined)
})
afterAll(() => vi.unstubAllGlobals())

describe('POST /api/meetings/:id/complete, when the upload is refused', () => {
  it('says the reason and nothing of the delete, and stores what the delete said', async () => {
    repo.get.mockResolvedValueOnce(row())
    store.head.mockResolvedValueOnce({ size: 4097, contentType: 'audio/ogg' })
    store.delete.mockRejectedValueOnce(new Error(DELETE_FAILED))

    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string }

    expect(refused).toMatchObject({ statusCode: 409, message: 'Uploaded audio was 4097 bytes, expected 4096' })
    expect(refused.message).not.toContain(KEY)
    expect(refused.message).not.toMatch(/sweeping|deleted/)
    expect(repo.update).toHaveBeenCalledWith(row().id, {
      status: 'failed',
      failedStage: 'upload',
      errorMessage: `Uploaded audio was 4097 bytes, expected 4096; object could not be deleted and needs sweeping (${DELETE_FAILED})`,
    })
  })

  it('says the same when the delete went well', async () => {
    repo.get.mockResolvedValueOnce(row())
    store.head.mockResolvedValueOnce({ size: 4097, contentType: 'audio/ogg' })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409, message: 'Uploaded audio was 4097 bytes, expected 4096' })
  })

  it('does not repeat the media type the uploader set', async () => {
    repo.get.mockResolvedValueOnce(row())
    store.head.mockResolvedValueOnce({ size: 4096, contentType: 'text/html' })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409, message: 'The uploaded object is not audio/ogg.' })
  })
})

describe('POST /api/meetings/:id/complete, of the row it answers with', () => {
  const STORED = 'PGRST116 left on the row'

  it('removes the stored error when the meeting was already uploaded', async () => {
    repo.get.mockResolvedValueOnce(row({ status: 'uploaded', errorMessage: STORED }))
    const answer = await handler({}) as { meeting: Meeting }
    expect(answer.meeting.status).toBe('uploaded')
    expect(answer.meeting).not.toHaveProperty('errorMessage')
  })

  it('removes it when this request completed the upload', async () => {
    repo.get.mockResolvedValueOnce(row())
    store.head.mockResolvedValueOnce({ size: 4096, contentType: 'audio/ogg' })
    repo.claim.mockResolvedValueOnce(row({ status: 'uploaded', errorMessage: STORED }))
    expect((await handler({}) as { meeting: Meeting }).meeting).not.toHaveProperty('errorMessage')
  })

  it('removes it when another request got there first', async () => {
    repo.get.mockResolvedValueOnce(row())
    store.head.mockResolvedValueOnce({ size: 4096, contentType: 'audio/ogg' })
    repo.claim.mockResolvedValueOnce(null)
    repo.get.mockResolvedValueOnce(row({ status: 'uploaded', errorMessage: STORED }))
    expect((await handler({}) as { meeting: Meeting }).meeting).not.toHaveProperty('errorMessage')
  })
})
