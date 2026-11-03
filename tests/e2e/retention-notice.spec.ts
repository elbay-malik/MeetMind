import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse } from '../../shared/types/meeting'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

/**
 * A Node server with the retention purge's setting on. It has no cron, so nothing deletes
 * anything, and it must not say otherwise (ADR-0017). A Worker build says the true number of
 * days, which scripts/verify-worker-sweep.mjs reads off the page.
 */

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-retention-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    ...LOCAL_DRIVERS,
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_RETENTION_PURGE_DAYS: '1',
    NUXT_PUBLIC_DEMO_MEETING_ID: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

describe('a server with no cron, with the purge\'s setting on', () => {
  it('promises no deletion on the upload page', async () => {
    const html = await (await fetch('/', { headers: { accept: 'text/html' } })).text()
    expect(html).toContain('you cannot delete it yourself')
    expect(html).not.toContain('deleted about')
  })

  it('tells the page nothing of the setting, or of its value', async () => {
    const html = await (await fetch('/', { headers: { accept: 'text/html' } })).text()
    expect(html).not.toContain('retentionPurgeDays')
    expect(html).not.toContain('NUXT_RETENTION')
  })

  it('deletes nothing, past its days or not', async () => {
    const { meeting } = await $fetch<CreateMeetingResponse>('/api/meetings', {
      method: 'POST',
      headers: inviteHeaders,
      body: { title: 'Old', sourceFileName: 'a.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 60, audioBytes: 4096 },
    })
    const row = await db.getItem<Record<string, unknown>>(`meetings/${meeting.id}`)
    await db.setItem(`meetings/${meeting.id}`, { ...row, createdAt: '2020-01-01T00:00:00.000Z' })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await db.getItem(`meetings/${meeting.id}`)).not.toBeNull()
  })
})
