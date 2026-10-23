import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-budget-'))

/**
 * A 5,000-byte ceiling, so the budget can be crossed with a handful of
 * registrations. Its own spec file because the ceiling is process-wide: every
 * other e2e spec runs on the 8 GiB default, which is what proves the check does
 * not interfere with normal operation.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_R2_MAX_STORED_BYTES: '5000',
  },
})

function register(audioBytes: number): Promise<Response> {
  return fetch('/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'budget',
      sourceFileName: 'a.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 30,
      audioBytes,
    }),
  })
}

/**
 * R2 has no spending cap, so this is the only thing that stops storage cost
 * growing: past the free allowance Cloudflare bills rather than refusing.
 * `POST /api/meetings` is anonymous and nothing in the API can delete a
 * recording, so without this an upload loop grows a standing monthly bill with
 * no in-app way to reverse it.
 *
 * These run in order and share one store: each registration adds to the total
 * the next one is measured against, which is the behaviour under test.
 */
describe('POST /api/meetings storage budget', () => {
  it('registers a meeting while there is room under the ceiling', async () => {
    const res = await register(1000)
    expect(res.status).toBe(201)
  })

  it('refuses one that would take the store past the ceiling', async () => {
    // 1000 already reserved + 9000 asked for, against a 5000 ceiling. Refused
    // BEFORE the upload URL is minted: that URL is the capability that spends
    // the storage, so handing it out and checking later would not be a limit.
    const res = await register(9000)

    expect(res.status).toBe(507)
    const body = await res.json()
    expect(body.data).toMatchObject({ storedBytes: 1000, ceilingBytes: 5000, requestedBytes: 9000 })
  })

  it('counts a registration that has not uploaded yet, so a burst cannot all pass', async () => {
    // The reservation is the whole point. Counting only confirmed uploads would
    // let any number of concurrent registrations each see an empty store, pass
    // the check, and then all upload.
    expect((await register(3000)).status).toBe(201)

    const second = await register(3000)
    expect(second.status).toBe(507)
    expect((await second.json()).data).toMatchObject({ storedBytes: 4000 })
  })

  it('still refuses after a failed upload leaves its reservation standing', async () => {
    // Nothing has been uploaded at all in this file — every byte counted so far
    // is a reservation. The ceiling holds on reservations alone, which is what
    // keeps the window between registering and uploading from being a hole.
    expect((await register(2000)).status).toBe(507)
  })
})
