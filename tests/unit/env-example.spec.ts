import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { REQUIRED_SETTINGS } from '../../server/utils/drivers'

it('.env.example documents the demo meeting under the name the home page warns about', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  expect(example).toMatch(/^NUXT_PUBLIC_DEMO_MEETING_ID=/m)
})

it('.env.example documents the embedding credentials under the names the driver asks for', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  const driver = await readFile(fileURLToPath(new URL('../../server/utils/drivers.ts', import.meta.url)), 'utf8')
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

// A commented line, so copying this file never sets it, under the name the gate reads.
it('.env.example documents the opt-in for local drivers, and leaves it off', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  expect(example).toMatch(/^# NUXT_ALLOW_LOCAL_DRIVERS=true/m)
  expect(example).not.toMatch(/^NUXT_ALLOW_LOCAL_DRIVERS=/m)
  expect(config).toContain('NUXT_ALLOW_LOCAL_DRIVERS')
})

it('.env.example documents every setting the gate requires, under the name it logs', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const names = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group))
  expect(names).toHaveLength(9)
  for (const name of names) expect(example).toMatch(new RegExp(`^${name}=`, 'm'))
})

// Irreversible, so it is off in everything this repo hands anyone.
it('.env.example documents the retention purge under the name it reads, and leaves it off', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
  const wrangler = await readFile(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), 'utf8')
  expect(example).toMatch(/^NUXT_RETENTION_PURGE_DAYS=$/m)
  expect(config).toMatch(/^ {4}retentionPurgeDays: '', \/\/ NUXT_RETENTION_PURGE_DAYS$/m)
  expect(wrangler).not.toMatch(/RETENTION_PURGE|retentionPurge/)
})
