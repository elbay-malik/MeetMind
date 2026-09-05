import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroqTranscriber } from '../../server/utils/transcription/groq'
import { TranscriptionError } from '../../server/utils/transcription/transcriber'

const transcriber = createGroqTranscriber({ apiKey: 'gsk-test' })
const audio = { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'audio/ogg' }

const verboseJson = {
  task: 'transcribe',
  language: 'english',
  duration: 50.16,
  text: 'hello world',
  segments: [
    { id: 0, seek: 0, start: 0.0, end: 2.5, text: ' hello', tokens: [1], temperature: 0, avg_logprob: -0.1, compression_ratio: 1.2, no_speech_prob: 0.01 },
    { id: 1, seek: 250, start: 2.5, end: 5.0, text: ' world', tokens: [2], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.3, no_speech_prob: 0.02 },
  ],
}

function stubFetch(response: Response | (() => never)) {
  const calls: Request[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push(new Request(url, init))
    if (typeof response === 'function') return response()
    return response
  })
  return calls
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('request', () => {
  it('asks for verbose_json from the turbo model, which is what carries timestamps', async () => {
    const calls = stubFetch(json(verboseJson))
    await transcriber.transcribe(audio)

    const form = await calls[0]!.formData()
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer gsk-test')
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('sends a language hint only when given one', async () => {
    let calls = stubFetch(json(verboseJson))
    await transcriber.transcribe(audio)
    expect((await calls[0]!.formData()).get('language')).toBeNull()

    vi.unstubAllGlobals()
    calls = stubFetch(json(verboseJson))
    await transcriber.transcribe({ ...audio, language: 'de' })
    expect((await calls[0]!.formData()).get('language')).toBe('de')
  })
})

describe('response', () => {
  it('converts the provider seconds into stored milliseconds', async () => {
    stubFetch(json(verboseJson))
    const result = await transcriber.transcribe(audio)
    expect(result.segments).toEqual([
      { idx: 0, startMs: 0, endMs: 2500, text: 'hello' },
      { idx: 1, startMs: 2500, endMs: 5000, text: 'world' },
    ])
    expect(result.durationSec).toBe(50.16)
    expect(result.language).toBe('english')
  })

  it('tolerates unknown fields, since the envelope is not fully documented', async () => {
    stubFetch(json({ ...verboseJson, x_groq: { id: 'req_1' }, some_new_field: true }))
    await expect(transcriber.transcribe(audio)).resolves.toMatchObject({ durationSec: 50.16 })
  })

  it('copes with a response carrying no duration or language', async () => {
    stubFetch(json({ segments: [{ start: 0, end: 1, text: 'x' }] }))
    const result = await transcriber.transcribe(audio)
    expect(result).toMatchObject({ durationSec: null, language: null })
  })

  it('fails loudly when segments are missing rather than storing an empty transcript', async () => {
    // A silent empty transcript would look like a meeting with no speech.
    stubFetch(json({ text: 'hello world' }))
    await expect(transcriber.transcribe(audio)).rejects.toThrow(/unexpected response/)
  })

  it('accepts a genuinely empty transcript', async () => {
    stubFetch(json({ ...verboseJson, segments: [] }))
    await expect(transcriber.transcribe(audio)).resolves.toMatchObject({ segments: [] })
  })
})

describe('failures', () => {
  it('explains a quota exhaustion in the user\'s terms and marks it retryable', async () => {
    stubFetch(new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err).toBeInstanceOf(TranscriptionError)
    expect(err.message).toMatch(/quota is exhausted.*120s/s)
    expect(err.retryable).toBe(true)
    expect(err.statusCode).toBe(429)
  })

  it('does not leak our credentials problem to the user as their fault', async () => {
    stubFetch(new Response('bad key', { status: 401 }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err.message).toMatch(/rejected our credentials/)
    expect(err.retryable).toBe(false)
    expect(err.statusCode).toBe(502)
  })

  it('treats provider outages as retryable', async () => {
    stubFetch(new Response('boom', { status: 503 }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err.retryable).toBe(true)
  })

  it('treats an oversized body as terminal, since retrying cannot shrink it', async () => {
    stubFetch(new Response('too large', { status: 413 }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err.retryable).toBe(false)
    expect(err.statusCode).toBe(413)
  })

  it('treats an unreadable body as a retryable provider fault, not a 500', async () => {
    // Letting response.json() throw would escape TranscriptionError, surface as
    // a 500, and mark the meeting permanently failed for a transient fault.
    stubFetch(new Response('<html>gateway timeout</html>', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err).toBeInstanceOf(TranscriptionError)
    expect(err.retryable).toBe(true)
    expect(err.message).toMatch(/could not read/i)
  })

  it('turns a network error into a retryable failure rather than an unhandled throw', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err).toBeInstanceOf(TranscriptionError)
    expect(err.retryable).toBe(true)
    expect(err.message).toMatch(/Could not reach/)
  })
})
