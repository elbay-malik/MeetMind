import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('.env.example documents the demo meeting under the name the home page warns about', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  expect(example).toMatch(/^NUXT_PUBLIC_DEMO_MEETING_ID=/m)
})

it('.env.example documents the embedding credentials under the names the driver asks for', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  const driver = await readFile(fileURLToPath(new URL('../../server/utils/qa/index.ts', import.meta.url)), 'utf8')
  for (const name of ['NUXT_WORKERS_AI_ACCOUNT_ID', 'NUXT_WORKERS_AI_API_TOKEN']) {
    expect(example).toMatch(new RegExp(`^${name}=`, 'm'))
    expect(config).toContain(name)
    expect(driver).toContain(name)
  }
})

it('.env.example documents the invite code under the name the gate warns about, and says what its absence does', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  const gate = await readFile(fileURLToPath(new URL('../../server/utils/invite.ts', import.meta.url)), 'utf8')
  expect(example).toMatch(/^NUXT_INVITE_CODE=$/m)
  expect(example).toContain('closes uploads for everyone')
  expect(config).toContain('NUXT_INVITE_CODE')
  expect(gate).toContain('NUXT_INVITE_CODE')
})

it('keeps the invite code out of the public runtime config, which every page\'s payload carries', async () => {
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  expect(config.indexOf('inviteCode:')).toBeGreaterThan(-1)
  expect(config.indexOf('inviteCode:')).toBeLessThan(config.indexOf('public: {'))
})

// Under another name it is just as public, and an e2e build has no code to bake and so nothing to find.
it('bakes the invite code into nothing public, under any name or from the build\'s environment', async () => {
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  const publicBlock = config.split('public: {')[1]!.split('\n    },')[0]!
  expect(publicBlock).toContain('demoMeetingId')
  expect(publicBlock).not.toMatch(/invite/i)
  expect(config).not.toContain('process.env.NUXT_INVITE_CODE')
})
