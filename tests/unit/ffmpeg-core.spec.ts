import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FFMPEG_CORE_LICENSE, FFMPEG_CORE_SOURCE_URL, FFMPEG_CORE_VERSION, FFMPEG_CORE_WASM_KEY, FFMPEG_CORE_WASM_PATH, FFMPEG_CORE_WASM_URL } from '../../shared/utils/ffmpeg-core'
import { audioObjectKey } from '../../shared/utils/meeting'

const inRepo = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

/** ADR-0018. An upgrade must not serve the old file silently under the new script glue. */
describe('the ffmpeg core\'s version', () => {
  it('is the one installed, in the constant, the key and the URL', async () => {
    const installed = JSON.parse(await inRepo('node_modules/@ffmpeg/core/package.json')) as { version: string }
    const declared = JSON.parse(await inRepo('package.json')) as { devDependencies: Record<string, string> }
    expect(FFMPEG_CORE_VERSION).toBe(installed.version)
    expect(declared.devDependencies['@ffmpeg/core']).toBe(installed.version)
    expect(FFMPEG_CORE_WASM_KEY).toBe(`assets/ffmpeg/${installed.version}/ffmpeg-core.wasm`)
    expect(FFMPEG_CORE_WASM_URL).toBe(`/ffmpeg/ffmpeg-core.wasm?v=${installed.version}`)
  })

  it('is read as one line by the upload script, which compares it with what is installed', async () => {
    const source = await inRepo('shared/utils/ffmpeg-core.ts')
    expect(/^export const FFMPEG_CORE_VERSION = '([^']+)'$/m.exec(source)?.[1]).toBe(FFMPEG_CORE_VERSION)
    const script = await inRepo('scripts/upload-ffmpeg-wasm.mjs')
    expect(script).toContain('constant !== installed')
    expect(script).toContain('`assets/ffmpeg/${installed}/ffmpeg-core.wasm`')
  })

  it('names the licence the package declares', async () => {
    const installed = JSON.parse(await inRepo('node_modules/@ffmpeg/core/package.json')) as { license: string }
    expect(FFMPEG_CORE_LICENSE).toBe(installed.license)
    expect(FFMPEG_CORE_SOURCE_URL).toMatch(/^https:\/\/github\.com\/ffmpegwasm\/ffmpeg\.wasm\/tree\/[0-9a-f]{40}$/)
  })

  it('is what the browser asks for, and nothing in the app names the bare path', async () => {
    const worker = await inRepo('app/workers/ffmpeg.worker.ts')
    expect(worker).toContain('new URL(FFMPEG_CORE_WASM_URL, self.location.origin)')
    const dir = fileURLToPath(new URL('../../app/', import.meta.url))
    const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(file => file.isFile())
    const naming: string[] = []
    for (const file of files) {
      const text = await readFile(`${file.parentPath}/${file.name}`, 'utf8')
      if (text.includes('ffmpeg-core.wasm')) naming.push(file.name)
    }
    expect(naming).toEqual([])
  })
})

describe('the upload script', () => {
  it('puts the file with its content type, on the real bucket and no other', async () => {
    const script = await inRepo('scripts/upload-ffmpeg-wasm.mjs')
    expect(script).toContain('\'r2\', \'object\', \'put\'')
    expect(script).toContain('\'--content-type\', \'application/wasm\'')
    expect(script).toContain('\'--remote\'')
    expect(script).toContain('const BUCKET = \'meet-mind\'')
    expect((JSON.parse(await inRepo('package.json')) as { scripts: Record<string, string> }).scripts['upload:ffmpeg-wasm']).toBe('node scripts/upload-ffmpeg-wasm.mjs')
  })
})

describe('the object the wasm sits at', () => {
  it('is outside what the lifecycle rule expires and what any meeting owns', () => {
    expect(FFMPEG_CORE_WASM_KEY.startsWith('meetings/')).toBe(false)
    expect(audioObjectKey('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d').startsWith('meetings/')).toBe(true)
  })

  it('can be neither deleted nor counted by anything that goes through the rows', async () => {
    // No store can list a bucket, so nothing can find this key by walking it. Every delete
    // is of a key from a row or built from a meeting's id, and the budget adds up rows.
    const store = await inRepo('server/utils/storage/audio-store.ts')
    const members = store.split('export interface AudioStore')[1]!.split('\n}\n')[0]!
    expect(members).not.toMatch(/\blist\w*\(/i)
    const r2 = await inRepo('server/utils/storage/r2.ts')
    expect(r2).not.toMatch(/list-type|ListObjects/)
    const deletion = await inRepo('server/utils/meeting-deletion.ts')
    expect(deletion).not.toContain('assets/')
    expect(deletion).not.toContain('FFMPEG_CORE')
    const budget = await inRepo('server/utils/storage-budget.ts')
    expect(budget).toContain('storedAudioBytes')
    expect(budget).not.toMatch(/FFMPEG_CORE|assets\//)
    for (const path of ['server/utils/db/meetings.ts', 'server/utils/db/local.ts', 'server/utils/db/supabase.ts']) {
      expect(await inRepo(path), path).not.toMatch(/FFMPEG_CORE|assets\/ffmpeg/)
    }
  })
})

describe('the Worker build', () => {
  it('deletes the file before Nitro lists its assets, only for a Cloudflare preset', async () => {
    vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
    const config = (await import('../../nuxt.config')).default as unknown as {
      hooks: { 'nitro:build:public-assets': (nitro: unknown) => Promise<void> }
    }
    vi.unstubAllGlobals()
    const { mkdtemp, mkdir, writeFile, access } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const publicDir = await mkdtemp(join(tmpdir(), 'meetmind-public-'))
    await mkdir(join(publicDir, 'ffmpeg'))
    const wasm = join(publicDir, 'ffmpeg/ffmpeg-core.wasm')
    const glue = join(publicDir, 'ffmpeg/ffmpeg-core.js')
    await writeFile(glue, 'glue')
    await writeFile(wasm, 'wasm')
    const run = (preset: string) => config.hooks['nitro:build:public-assets']({ options: { preset, output: { publicDir } } })

    await run('node-server')
    await expect(access(wasm)).resolves.toBeUndefined()
    await run('cloudflare-module')
    await expect(access(wasm)).rejects.toThrow()
    // The glue stays an ordinary asset, and a second run has nothing to delete.
    await expect(access(glue)).resolves.toBeUndefined()
    await expect(run('cloudflare-module')).resolves.toBeUndefined()
  })
})

const store = vi.hoisted(() => ({ openRange: vi.fn() }))
vi.mock('../../server/utils/storage', () => ({ useAudioStore: () => store }))

describe('GET /ffmpeg/ffmpeg-core.wasm', () => {
  type Handler = (event: unknown) => Promise<Response>
  let handler: Handler
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
    vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
    handler = (await import('../../server/routes/ffmpeg/ffmpeg-core.wasm.get')).default as unknown as Handler
  })
  beforeEach(() => {
    store.openRange.mockReset()
    warn.mockClear()
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  /** What R2 would hand back, with an object stored as something it should not be. */
  const stored = (bytes = new Uint8Array([0, 97, 115, 109])) => ({
    body: new Blob([bytes]).stream(),
    size: bytes.byteLength,
    contentType: 'text/html',
    window: { start: 0, end: bytes.byteLength - 1 },
    etag: '"<script>"',
  })

  it('is served at the path the browser asks for', async () => {
    const files = await readdir(fileURLToPath(new URL('../../server/routes/ffmpeg/', import.meta.url)))
    expect(files).toEqual(['ffmpeg-core.wasm.get.ts'])
    expect(FFMPEG_CORE_WASM_PATH).toBe('/ffmpeg/ffmpeg-core.wasm')
  })

  it('reads the one key, the whole object, from no input of the request', async () => {
    store.openRange.mockResolvedValueOnce(stored())
    // Nothing of a request is here to read: anything the handler reached for would throw.
    const answer = await handler(new Proxy({}, {
      get() {
        throw new Error('read the request')
      },
    }))
    expect(store.openRange).toHaveBeenCalledExactlyOnceWith(FFMPEG_CORE_WASM_KEY, null)
    expect(answer.status).toBe(200)
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]))
  })

  it('pins its headers, and reflects nothing of the stored object', async () => {
    store.openRange.mockResolvedValueOnce(stored())
    const answer = await handler({})
    expect(Object.fromEntries(answer.headers)).toEqual({
      'content-type': 'application/wasm',
      'content-length': '4',
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    })
  })

  it('answers a plain 404 sentence when the file was never put there, and logs it', async () => {
    store.openRange.mockResolvedValueOnce(null)
    const answer = await handler({})
    expect(answer.status).toBe(404)
    expect(answer.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(answer.headers.get('cache-control')).toBe('no-store')
    const text = await answer.text()
    expect(text).toBe('The audio tool is not available on this server.')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('answers a plain 503 sentence with none of R2\'s words when R2 fails, and keeps them in the log', async () => {
    const failure = new Error(`R2 GET ${FFMPEG_CORE_WASM_KEY} failed with HTTP 403`)
    store.openRange.mockRejectedValueOnce(failure)
    const answer = await handler({})
    expect(answer.status).toBe(503)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    const text = await answer.text()
    expect(text).toBe('The audio tool could not be loaded. Try again later.')
    expect(text).not.toMatch(/R2|assets|403/)
    expect(warn.mock.lastCall![1]).toBe(failure)
  })

  it('says the gate\'s own sentence when the server has no settings, as a plain answer', async () => {
    const { DRIVERS_REFUSED_MESSAGE } = await import('../../server/utils/drivers')
    store.openRange.mockRejectedValueOnce(Object.assign(new Error(DRIVERS_REFUSED_MESSAGE), { statusCode: 503 }))
    const answer = await handler({})
    expect(answer.status).toBe(503)
    expect(await answer.text()).toBe(DRIVERS_REFUSED_MESSAGE)
    expect(warn).not.toHaveBeenCalled()
  })
})
