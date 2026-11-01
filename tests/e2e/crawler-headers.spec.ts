import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

describe('crawlers are kept out', () => {
  it.each(['/', '/meetings', '/api/health'])('%s answers noindex', async (path) => {
    const response = await fetch(path)
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('robots.txt disallows everything', async () => {
    const response = await fetch('/robots.txt')
    expect(response.status).toBe(200)
    expect(await response.text()).toMatch(/^User-Agent: \*\nDisallow: \/\n?$/)
  })
})
