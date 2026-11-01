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
  // ADR-0012 §2: the reply is stored as it came and read a page at a time, so
  // nothing here may parse a body whose size grows with the meeting.
  it('hands back the reply\'s bytes as they came, unparsed', async () => {
    const text = JSON.stringify(verboseJson)
    stubFetch(new Response(text, { status: 200 }))
    expect(new TextDecoder().decode(await transcriber.transcribe(audio))).toBe(text)
  })

  it('does not reject a body that is not JSON: the pages decide what it means', async () => {
    stubFetch(new Response('<html>gateway timeout</html>', { status: 200 }))
    expect(new TextDecoder().decode(await transcriber.transcribe(audio))).toBe('<html>gateway timeout</html>')
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
    expect(err.retryAfterMs).toBe(120_000)
  })

  it('reads a Retry-After given as a date, and assumes a minute when there is none', async () => {
    stubFetch(new Response('rate limited', { status: 429, headers: { 'retry-after': new Date(Date.now() + 300_000).toUTCString() } }))
    const dated = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(dated.retryAfterMs).toBeGreaterThan(290_000)
    expect(dated.retryAfterMs).toBeLessThanOrEqual(300_000)

    vi.unstubAllGlobals()
    stubFetch(new Response('rate limited', { status: 429 }))
    const bare = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(bare.retryAfterMs).toBe(60_000)
  })

  it('carries no Retry-After on any other failure', async () => {
    stubFetch(new Response('boom', { status: 503, headers: { 'retry-after': '120' } }))
    const err = await transcriber.transcribe(audio).catch((e: TranscriptionError) => e)
    expect(err.retryAfterMs).toBeNull()
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

  it('treats a body it cannot finish reading as a retryable provider fault, not a 500', async () => {
    const reply = new Response('x', { status: 200 })
    vi.spyOn(reply, 'arrayBuffer').mockRejectedValue(new TypeError('connection lost'))
    stubFetch(reply)
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
