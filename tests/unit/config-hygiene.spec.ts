import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

describe('config hygiene', () => {
  // `nuxt dev` runs with the production keys in .env, and DevTools has had an
  // unauthenticated command-execution hole reachable from any web page.
  it('leaves DevTools off', async () => {
    const config = await readFile(`${rootDir}nuxt.config.ts`, 'utf8')
    expect(config).toMatch(/^\s*devtools: \{ enabled: false \},$/m)
  })

  // Nitro renders these into a Worker build's _headers, which is all a static asset gets
  // there. scripts/verify-worker-streams.mjs reads that file and asks workerd for an asset.
  it('asks for nosniff and a frame block on everything, beside the crawler and referrer headers', async () => {
    vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
    const { default: config } = await import('../../nuxt.config') as unknown as { default: { routeRules: Record<string, { headers?: Record<string, string> }> } }
    vi.unstubAllGlobals()
    expect(config.routeRules['/**']!.headers).toEqual({
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': 'frame-ancestors \'none\'',
    })
  })

  // The check walks its list. A count typed beside that list was wrong for a while
  // without anything noticing, and an operator would compare the two.
  it('does not state a count of the schema objects db:migrate checks', async () => {
    const script = await readFile(`${rootDir}scripts/apply-migrations.sh`, 'utf8')
    const success = script.split('\n').find(line => line.includes('RLS enabled on every public table'))
    expect(success, 'could not find the success line').toBeTruthy()
    expect(success).not.toMatch(/\d/)
  })

  // check-ignore exits non-zero for a path git would track, which throws here.
  it.each(['.dev.vars', '.dev.vars.production'])('git ignores wrangler\'s %s', (path) => {
    expect(() => execFileSync('git', ['check-ignore', '--no-index', path], { cwd: rootDir, stdio: 'pipe' })).not.toThrow()
  })
})
