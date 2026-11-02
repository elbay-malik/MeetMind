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
