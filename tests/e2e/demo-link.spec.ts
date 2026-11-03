import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

const DEMO_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { ...LOCAL_DRIVERS, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret', NUXT_PUBLIC_DEMO_MEETING_ID: DEMO_ID },
})

describe('NUXT_PUBLIC_DEMO_MEETING_ID', () => {
  it('links the home page to the demo meeting', async () => {
    const html = await (await fetch('/')).text()
    expect(html).toContain(`href="/meetings/${DEMO_ID}"`)
  })
})
