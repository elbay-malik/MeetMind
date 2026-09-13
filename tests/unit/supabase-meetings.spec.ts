import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMeetingRepository } from '../../server/utils/db/supabase'
import type { MeetingRow } from '../../server/utils/db/meetings'

const repo = createSupabaseMeetingRepository({
  url: 'https://project.supabase.co',
  serviceKey: 'service-role-key',
})

const row: MeetingRow = {
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  created_at: '2026-09-05T12:00:00.000Z',
  updated_at: '2026-09-05T12:00:00.000Z',
  title: 'Weekly sync',
  status: 'pending_upload',
  source_file_name: 'weekly-sync.mp4',
  source_bytes: 1_045_800_000,
  source_mime: 'video/mp4',
  duration_sec: 3600,
  audio_key: 'meetings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/audio.ogg',
  audio_bytes: 8_500_000,
  audio_mime: 'audio/ogg',
  uploaded_at: null,
  error_message: null,
  failed_stage: null,
}

interface Call { url: URL, method: string, headers: Headers, body: unknown }

/** Capture what PostgREST would receive, and reply with `payload`. */
function stubPostgrest(payload: unknown, init: ResponseInit = { status: 200 }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string | Request, options?: RequestInit) => {
    const request = typeof input === 'string' ? new Request(input, options) : input
    const raw = await request.clone().text()
    calls.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    })
    return new Response(JSON.stringify(payload), {
      ...init,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('create', () => {
  it('posts the snake_case row and returns the stored meeting', async () => {
    const calls = stubPostgrest(row, { status: 201 })
    const meeting = await repo.create({
      id: row.id,
      title: 'Weekly sync',
      status: 'pending_upload',
      sourceFileName: 'weekly-sync.mp4',
      sourceBytes: 1_045_800_000,
      sourceMime: 'video/mp4',
      durationSec: 3600,
      audioKey: row.audio_key,
      audioBytes: 8_500_000,
      audioMime: 'audio/ogg',
      uploadedAt: null,
      errorMessage: null,
      failedStage: null,
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe('/rest/v1/meetings')
    expect(call.body).toMatchObject({ id: row.id, source_file_name: 'weekly-sync.mp4', audio_bytes: 8_500_000 })
    // The service-role key authenticates the request and bypasses RLS.
    expect(call.headers.get('apikey')).toBe('service-role-key')
    expect(call.headers.get('authorization')).toBe('Bearer service-role-key')

    expect(meeting.sourceFileName).toBe('weekly-sync.mp4')
    expect(meeting.createdAt).toBe(row.created_at)
  })

  it('surfaces a database error with its code', async () => {
    stubPostgrest(
      { code: '23505', message: 'duplicate key value violates unique constraint', details: '', hint: '' },
      { status: 409 },
    )
    await expect(repo.create({
      id: row.id, title: 't', status: 'pending_upload', sourceFileName: 'a.mp4', sourceBytes: 1,
      sourceMime: null, durationSec: null, audioKey: row.audio_key, audioBytes: 1,
      audioMime: 'audio/ogg', uploadedAt: null, errorMessage: null, failedStage: null,
    })).rejects.toThrow(/23505.*duplicate key/)
  })
})

describe('get', () => {
  it('filters by id and maps the row', async () => {
    const calls = stubPostgrest([row])
    const meeting = await repo.get(row.id)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url.searchParams.get('id')).toBe(`eq.${row.id}`)
    expect(meeting?.id).toBe(row.id)
  })

  it('returns null for an unknown id instead of throwing', async () => {
    stubPostgrest([])
    expect(await repo.get(row.id)).toBeNull()
  })
})

describe('list', () => {
  it('asks for the newest meetings first, bounded by the limit', async () => {
    const calls = stubPostgrest([row])
    const meetings = await repo.list({ limit: 25 })
    expect(calls[0]!.url.searchParams.get('order')).toBe('created_at.desc')
    expect(calls[0]!.url.searchParams.get('limit')).toBe('25')
    expect(meetings).toHaveLength(1)
  })

  it('returns an empty list, not null, when there are no meetings', async () => {
    stubPostgrest([])
    expect(await repo.list({ limit: 10 })).toEqual([])
  })
})

describe('claim', () => {
  it('filters on the current status, which is what makes it atomic', async () => {
    const calls = stubPostgrest([{ ...row, status: 'transcribing' }])
    const claimed = await repo.claim(row.id, 'uploaded', { status: 'transcribing' })

    expect(calls[0]!.method).toBe('PATCH')
    // Without this second filter the database cannot pick a winner and every
    // concurrent caller proceeds.
    expect(calls[0]!.url.searchParams.get('id')).toBe(`eq.${row.id}`)
    expect(calls[0]!.url.searchParams.get('status')).toBe('eq.uploaded')
    expect(calls[0]!.body).toEqual({ status: 'transcribing' })
    expect(claimed?.status).toBe('transcribing')
  })

  it('returns null when the row was in another state, so the caller knows it lost', async () => {
    stubPostgrest([])
    expect(await repo.claim(row.id, 'uploaded', { status: 'transcribing' })).toBeNull()
  })

  it('surfaces a database error rather than reporting a lost race', async () => {
    stubPostgrest({ code: '42501', message: 'permission denied', details: '', hint: '' }, { status: 403 })
    await expect(repo.claim(row.id, 'uploaded', { status: 'transcribing' })).rejects.toThrow(/42501/)
  })

  it('adds an updated_at fence when a caller supplies one', async () => {
    // Without this, a status match alone lets a straggler from a stale-lease
    // reclaim (same status in, same status out) still win a later write.
    const calls = stubPostgrest([{ ...row, status: 'ready' }])
    await repo.claim(row.id, 'indexing', { status: 'ready' }, row.updated_at)
    expect(calls[0]!.url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`)
  })

  it('omits the updated_at fence when no caller supplies one', async () => {
    const calls = stubPostgrest([{ ...row, status: 'transcribing' }])
    await repo.claim(row.id, 'uploaded', { status: 'transcribing' })
    expect(calls[0]!.url.searchParams.has('updated_at')).toBe(false)
  })
})

describe('update', () => {
  it('patches only the given columns for the given id', async () => {
    const calls = stubPostgrest([{ ...row, status: 'uploaded', uploaded_at: '2026-09-05T12:05:00.000Z' }])
    const meeting = await repo.update(row.id, { status: 'uploaded', uploadedAt: '2026-09-05T12:05:00.000Z' })
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url.searchParams.get('id')).toBe(`eq.${row.id}`)
    expect(calls[0]!.body).toEqual({ status: 'uploaded', uploaded_at: '2026-09-05T12:05:00.000Z' })
    expect(meeting?.status).toBe('uploaded')
  })

  it('returns null when no row matched', async () => {
    stubPostgrest([])
    expect(await repo.update(row.id, { status: 'failed', failedStage: 'transcription' })).toBeNull()
  })
})
