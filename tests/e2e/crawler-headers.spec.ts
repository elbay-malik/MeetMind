import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { ...LOCAL_DRIVERS, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

describe('nothing is sniffed or framed', () => {
  it.each(['/', '/meetings', '/api/health', '/robots.txt', '/ffmpeg/ffmpeg-core.js', '/ffmpeg/ffmpeg-core.wasm?v=any'])('%s says so, once each', async (path) => {
    const response = await fetch(path)
    expect(response.status).not.toBe(404)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toBe('frame-ancestors \'none\'')
  })

  // The Node build keeps today's file, and a query on it is what the browser now sends.
  it('serves the wasm from the public file on a Node server, with its type, and a query changes nothing', async () => {
    const response = await fetch('/ffmpeg/ffmpeg-core.wasm?v=any')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/wasm')
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(25 * 1024 * 1024)
    await response.body?.cancel()
  })
})

describe('crawlers are kept out', () => {
  it.each(['/', '/meetings', '/api/health'])('%s answers noindex', async (path) => {
    const response = await fetch(path)
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('robots.txt disallows everything, but LinkedIn\'s preview of the home page, which holds no meeting', async () => {
    const response = await fetch('/robots.txt')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('User-Agent: LinkedInBot\nAllow: /$\nAllow: /og.png\nDisallow: /\n\nUser-Agent: *\nDisallow: /\n')
  })
})
