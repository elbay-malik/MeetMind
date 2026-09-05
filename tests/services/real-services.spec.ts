import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { AwsClient } from 'aws4fetch'
import { createGroqTranscriber } from '../../server/utils/transcription/groq'
import { meetingSchema, transcriptSegmentSchema } from '../../shared/schemas/meeting'
import { MAX_AUDIO_BYTES } from '../../shared/utils/meeting'

/**
 * Exercises the real services, which nothing else can: the drivers are covered
 * by unit tests with a stubbed fetch, and that proves the request shape but not
 * the contract. ADR-0003 and ADR-0004 both list this as the open follow-up.
 *
 * Run with `pnpm test:services` once credentials exist. Each service is skipped
 * when its variables are absent. Objects and rows are prefixed `verify-` and
 * cleaned up; nothing pre-existing is touched.
 */
const env: Record<string, string | undefined> = { ...process.env }

beforeAll(async () => {
  try {
    const file = await readFile(new URL('../../.env', import.meta.url), 'utf8')
    for (const line of file.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (match?.[1] && !env[match[1]]) env[match[1]] = match[2]!.trim().replace(/^["']|["']$/g, '')
    }
  }
  catch { /* no .env; ambient environment only */ }
})

const has = (...keys: string[]) => keys.every(k => (process.env[k] ?? '').length > 0)

// ---------------------------------------------------------------- Cloudflare R2
describe.skipIf(!has('NUXT_R2_ACCOUNT_ID', 'NUXT_R2_ACCESS_KEY_ID', 'NUXT_R2_SECRET_ACCESS_KEY', 'NUXT_R2_BUCKET'))(
  'Cloudflare R2',
  () => {
    // Built lazily: describe.skipIf still runs this callback, so constructing
    // the client here would throw before any test is skipped.
    const client = () => new AwsClient({
      accessKeyId: process.env.NUXT_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.NUXT_R2_SECRET_ACCESS_KEY!,
      service: 's3',
      region: 'auto',
      retries: 1,
    })
    const objectKey = `verify-${Date.now()}/audio.ogg`
    const objectUrl = () => {
      const url = new URL(`https://${process.env.NUXT_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
      url.pathname = `/${process.env.NUXT_R2_BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
      return url
    }
    const body = new Uint8Array(2048).map((_, i) => i % 251)

    it('accepts a browser PUT to the presigned URL we mint', async () => {
      const url = objectUrl()
      url.searchParams.set('X-Amz-Expires', '900')
      const signed = await client().sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } })
      const put = await fetch(signed.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body })
      expect(put.ok, `HTTP ${put.status}: ${await put.text()}`).toBe(true)
    })

    it('reports the exact byte count on HEAD, which the completion check depends on', async () => {
      const head = await client().fetch(objectUrl().href, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(String(body.byteLength))
    })

    it('returns the same bytes on GET, which transcription depends on', async () => {
      const get = await client().fetch(objectUrl().href, { method: 'GET' })
      expect(get.ok).toBe(true)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)
    })

    it('answers 404 for a missing object rather than an error', async () => {
      const missing = await client().fetch(`${objectUrl().href}-absent`, { method: 'HEAD' })
      expect(missing.status).toBe(404)
    })

    it('allows the browser origin to PUT, without which uploads fail only in a browser', async () => {
      const preflight = await fetch(objectUrl().href, {
        method: 'OPTIONS',
        headers: {
          'origin': process.env.VERIFY_ORIGIN ?? 'http://localhost:3000',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(
        preflight.headers.get('access-control-allow-origin'),
        'no CORS rule matched — see README → Storage setup',
      ).toBeTruthy()
    })

    it('deletes the object', async () => {
      const del = await client().fetch(objectUrl().href, { method: 'DELETE' })
      expect([200, 204, 404]).toContain(del.status)
    })
  },
)

// ------------------------------------------------------------------- Supabase
describe.skipIf(!has('NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY'))('Supabase Postgres', () => {
  const id = crypto.randomUUID()
  const newRow = () => ({
    id,
    title: 'verify-services probe',
    status: 'uploaded' as const,
    source_file_name: 'verify.mp4',
    source_bytes: 1,
    source_mime: null,
    duration_sec: null,
    audio_key: `verify-${id}/audio.ogg`,
    audio_bytes: 1024,
    audio_mime: 'audio/ogg',
    uploaded_at: null,
    error_message: null,
  })

  async function db() {
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(process.env.NUXT_SUPABASE_URL!, process.env.NUXT_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }

  it('stores a meeting row whose shape satisfies meetingSchema', async () => {
    const client = await db()
    const { data, error } = await client.from('meetings').insert(newRow()).select().single()
    expect(error, `${error?.code}: ${error?.message} — is the migration applied?`).toBeNull()

    // The real question: do Postgres timestamps parse the way the schema assumes?
    const parsed = meetingSchema.safeParse({
      id: data!.id,
      createdAt: data!.created_at,
      updatedAt: data!.updated_at,
      title: data!.title,
      status: data!.status,
      sourceFileName: data!.source_file_name,
      sourceBytes: Number(data!.source_bytes),
      sourceMime: data!.source_mime,
      durationSec: data!.duration_sec,
      audioKey: data!.audio_key,
      audioBytes: data!.audio_bytes,
      audioMime: data!.audio_mime,
      uploadedAt: data!.uploaded_at,
      errorMessage: data!.error_message,
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true)
  })

  it('advances updated_at through the trigger', async () => {
    const client = await db()
    const before = await client.from('meetings').select().eq('id', id).single()
    const after = await client.from('meetings').update({ status: 'transcribing' }).eq('id', id).select().single()
    expect(after.error).toBeNull()
    expect(
      new Date(after.data!.updated_at).getTime(),
      'updated_at did not advance — is the trigger installed?',
    ).toBeGreaterThan(new Date(before.data!.updated_at).getTime())
  })

  it('enforces the audio cap in the database, not just in code', async () => {
    const client = await db()
    const { error } = await client.from('meetings').insert({
      ...newRow(), id: crypto.randomUUID(), audio_key: `verify-over-${id}`, audio_bytes: MAX_AUDIO_BYTES + 1,
    })
    expect(error, 'an over-cap row was accepted — the tightening migration is not applied').not.toBeNull()
  })

  it('stores transcript segments and reads them back in order', async () => {
    const client = await db()
    const segments = [0, 1, 2].map(idx => ({
      meeting_id: id, idx, start_ms: idx * 1000, end_ms: (idx + 1) * 1000, text: `segment ${idx}`,
    }))
    const inserted = await client.from('transcript_segments').insert(segments)
    expect(inserted.error, `${inserted.error?.code}: ${inserted.error?.message}`).toBeNull()

    const listed = await client.from('transcript_segments').select().eq('meeting_id', id).order('idx', { ascending: true })
    expect(listed.data).toHaveLength(3)
    for (const [i, row] of listed.data!.entries()) {
      const parsed = transcriptSegmentSchema.safeParse({
        idx: row.idx, startMs: row.start_ms, endMs: row.end_ms, text: row.text,
      })
      expect(parsed.success).toBe(true)
      expect(row.idx).toBe(i)
    }
  })

  it('cascades the transcript away when the meeting is deleted', async () => {
    const client = await db()
    await client.from('meetings').delete().eq('id', id)
    await client.from('meetings').delete().eq('audio_key', `verify-over-${id}`)
    const orphans = await client.from('transcript_segments').select().eq('meeting_id', id)
    expect(orphans.data).toHaveLength(0)
  })
})

// ----------------------------------------------------------------------- Groq
describe.skipIf(!has('NUXT_GROQ_API_KEY'))('Groq Whisper', () => {
  let audio: Uint8Array

  beforeAll(() => {
    // Real speech-shaped audio in exactly the format the browser produces.
    const source = fileURLToPath(new URL('../../fixtures/fixture-30s-720p.mp4', import.meta.url))
    const out = execFileSync('ffmpeg', [
      '-v', 'error', '-i', source, '-t', '5', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '16k', '-f', 'ogg', 'pipe:1',
    ], { maxBuffer: 32 * 1024 * 1024 })
    audio = new Uint8Array(out)
    expect(audio.byteLength).toBeGreaterThan(0)
  })

  it('accepts Ogg/Opus at 16 kHz mono and returns the envelope we parse', async () => {
    const form = new FormData()
    form.append('file', new Blob([audio as BlobPart], { type: 'audio/ogg' }), 'audio.ogg')
    form.append('model', 'whisper-large-v3-turbo')
    form.append('response_format', 'verbose_json')

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.NUXT_GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    expect(response.ok, `HTTP ${response.status}: ${(await response.clone().text()).slice(0, 300)}`).toBe(true)

    const body = await response.json() as { segments?: unknown[] }
    // The envelope was inferred from OpenAI compatibility, never published by
    // Groq. This is the assertion that closes ADR-0004's main open question.
    console.info('[verify] Groq envelope keys:', Object.keys(body).join(', '))
    expect(Array.isArray(body.segments), 'no segments array — groq.ts expects one').toBe(true)
    if (body.segments?.length) {
      console.info('[verify] segment keys:', Object.keys(body.segments[0] as object).join(', '))
      const first = body.segments[0] as { start: unknown, end: unknown, text: unknown }
      expect(typeof first.start).toBe('number')
      expect(typeof first.end).toBe('number')
      expect(typeof first.text).toBe('string')
    }
  })

  it('is parsed by the production transcriber into valid segments', async () => {
    const result = await createGroqTranscriber({ apiKey: process.env.NUXT_GROQ_API_KEY! })
      .transcribe({ bytes: audio, contentType: 'audio/ogg' })

    for (const [i, segment] of result.segments.entries()) {
      expect(transcriptSegmentSchema.safeParse(segment).success).toBe(true)
      expect(segment.idx).toBe(i)
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs)
    }
    console.info(`[verify] transcribed into ${result.segments.length} segments, duration ${result.durationSec}s`)
  })
})
