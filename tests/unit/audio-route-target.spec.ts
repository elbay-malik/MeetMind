import { createServer, request, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which way the route answers. A mock response without a socket is what Nitro hands every
 * request on a Worker, and it has `writeHead` as well, so that alone says nothing: taking the
 * Node path there buffers the whole object. scripts/verify-worker-streams.mjs holds the same
 * thing under workerd, with a real build. A real socket here is a real Node server.
 */

const MEETING = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const CHUNK = new Uint8Array(64 * 1024).fill(7)
const CHUNKS = 200

const source = vi.hoisted(() => ({ pulled: 0, cancelled: false }))

function opened(chunks: number) {
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        source.pulled++
        if (source.pulled > chunks) controller.close()
        else controller.enqueue(CHUNK)
      },
      cancel() {
        source.cancelled = true
      },
    }, { highWaterMark: 0 }),
    size: chunks * CHUNK.byteLength,
    contentType: 'application/octet-stream',
    window: { start: 0, end: chunks * CHUNK.byteLength - 1 },
    etag: '"e"',
  }
}

vi.mock('../../server/utils/storage', () => ({
  useAudioStore: () => ({ openRange: async () => opened(CHUNKS) }),
}))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({
    get: async () => ({ id: MEETING, status: 'ready', audioBytes: CHUNKS * CHUNK.byteLength, audioKey: `meetings/${MEETING}/audio.ogg` }),
  }),
}))

type Handler = (event: unknown) => Promise<unknown>
let handler: Handler

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('getRouterParam', () => MEETING)
  vi.stubGlobal('getRequestHeader', (event: { node?: { req?: { headers?: Record<string, string> } } }, name: string) => event.node?.req?.headers?.[name])
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  handler = (await import('../../server/api/meetings/[id]/audio.get')).default as unknown as Handler
})
beforeEach(() => {
  source.pulled = 0
  source.cancelled = false
})
afterAll(() => vi.unstubAllGlobals())

describe('the audio route, on a response with no socket', () => {
  it('returns a plain Response and never touches the mock\'s writeHead', async () => {
    const writeHead = vi.fn()
    const event = { node: { req: { headers: {} }, res: { socket: null, writeHead } } }
    const answer = await handler(event) as Response
    expect(answer).toBeInstanceOf(Response)
    expect(writeHead).not.toHaveBeenCalled()
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('audio/ogg')
    expect(answer.headers.get('content-length')).toBe(String(CHUNKS * CHUNK.byteLength))
  })

  it('reads nothing of the object until the runtime does', async () => {
    const event = { node: { req: { headers: {} }, res: { socket: null, writeHead: vi.fn() } } }
    const answer = await handler(event) as Response
    expect(source.pulled).toBe(0)
    const reader = answer.body!.getReader()
    await reader.read()
    expect(source.pulled).toBe(1)
    await reader.cancel()
    expect(source.cancelled).toBe(true)
  })

  it('answers a range with a 206 the same way', async () => {
    const event = { node: { req: { headers: { range: 'bytes=0-99' } }, res: { socket: null, writeHead: vi.fn() } } }
    const answer = await handler(event) as Response
    expect(answer.status).toBe(206)
    expect(answer.headers.get('content-range')).toMatch(/^bytes 0-/)
    await answer.body!.cancel()
  })
})

describe('the audio route, on a real Node server', () => {
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handler({ node: { req, res } })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  it('drives the response itself, and the whole object arrives', async () => {
    const answer = await fetch(`http://127.0.0.1:${port}/`)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('accept-ranges')).toBe('bytes')
    expect((await answer.arrayBuffer()).byteLength).toBe(CHUNKS * CHUNK.byteLength)
  })

  it('stops reading the object when the client goes away, as a seek does', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', reject)
      req.end()
    })
    await vi.waitFor(() => expect(source.cancelled).toBe(true))
    expect(source.pulled).toBeLessThan(CHUNKS)
  })
})
