import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import type { Meeting } from '../../shared/types/meeting'
import { audioObjectKey } from '../../shared/utils/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-delete-short-'))

/** One character short of the 32 the route insists on. */
const SHORT_TOKEN = 'e2e-short-admin-token-012345678'

/**
 * Its own spec file because the admin token is process-wide, and this one is
 * misconfigured on purpose. A token that short is guessable, so the route has
 * to refuse to run at all rather than accept it -- even from a caller who
 * presents it exactly.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_ADMIN_TOKEN: SHORT_TOKEN,
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

describe('DELETE /api/meetings/:id with a too-short admin token configured', () => {
  it('answers 500 even to the exact token, and leaves the meeting', async () => {
    // Guards the fixture itself: at 32 this would test nothing.
    expect(SHORT_TOKEN).toHaveLength(31)

    // An old ready meeting, so no blocker would stop a delete: if the length
    // check were skipped, the matching token would get a 204 and the row would
    // be gone. A 401 or 404 would mean the misconfiguration was hidden behind
    // an answer that looks like ordinary refusal, and nobody would fix it.
    const id = randomUUID()
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    const meeting: Meeting = {
      id,
      createdAt: longAgo,
      updatedAt: longAgo,
      title: 'Short token test',
      status: 'ready',
      sourceFileName: 'meeting.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 60,
      audioKey: audioObjectKey(id),
      audioBytes: 100,
      audioMime: 'audio/ogg',
      uploadedAt: longAgo,
      errorMessage: null,
      failedStage: null,
    }
    await db.setItem(`meetings/${id}`, meeting)

    const res = await fetch(`/api/meetings/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SHORT_TOKEN}` },
    })
    expect(res.status).toBe(500)
    expect((await fetch(`/api/meetings/${id}`)).status).toBe(200)
  })
})
