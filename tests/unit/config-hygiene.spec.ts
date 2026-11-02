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
