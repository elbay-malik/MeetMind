import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

describe('config hygiene', () => {
  // `nuxt dev` runs with the production keys in .env, and DevTools has had an
  // unauthenticated command-execution hole reachable from any web page.
  it('leaves DevTools off', async () => {
    const config = await readFile(`${rootDir}nuxt.config.ts`, 'utf8')
    expect(config).toMatch(/^\s*devtools: \{ enabled: false \},$/m)
  })

  // check-ignore exits non-zero for a path git would track, which throws here.
  it.each(['.dev.vars', '.dev.vars.production'])('git ignores wrangler\'s %s', (path) => {
    expect(() => execFileSync('git', ['check-ignore', '--no-index', path], { cwd: rootDir, stdio: 'pipe' })).not.toThrow()
  })
})
