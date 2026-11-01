import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('.env.example documents the demo meeting under the name the home page warns about', async () => {
  const example = await readFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  expect(example).toMatch(/^NUXT_PUBLIC_DEMO_MEETING_ID=/m)
})
