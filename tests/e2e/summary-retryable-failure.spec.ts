import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, ExtractionStepResponse, PublicMeeting } from '../../shared/types/meeting'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

// Isolated from summary-api.spec.ts: NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE
// makes the stub throw a retryable error exactly ONCE for the whole server
// process, which would otherwise break every other test in a shared file
// that expects a normal, successful extraction.
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-summary-retryable-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    ...LOCAL_DRIVERS,
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE: 'true',
  },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function transcribedMeeting(): Promise<PublicMeeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Retryable failure test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  const done = await driveTranscription(meeting.id)
  return done.meeting
}

describe('summarization retryable failure', () => {
  it('parks the chunk with the failure recorded, and the next step extracts it, without failing the meeting', async () => {
    // Step-wise extraction (ADR-0012): a retryable failure on a chunk's first
    // attempt parks it, and the next step is its second attempt. The meeting
    // never shows `failed` for a hiccup the retry absorbs, and the chunks
    // already finished are kept. That a second failure DOES fail it, behind the
    // cooldown, is in extraction-steps.spec.ts, where failures can be scripted.
    const meeting = await transcribedMeeting()
    const step = async () => {
      const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
      return { status: res.status, body: await res.json() as ExtractionStepResponse & { summary?: unknown } }
    }

    const planned = await step()
    expect(planned.status).toBe(202)

    const failed = await step()
    expect(failed.status).toBe(202)
    // The failure is on the run, for whoever reads storage, and not in the answer.
    const ledger = await createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
      .getItem<{ runs: { summarization: { lastError: string | null } } }>(`pipeline/${meeting.id}`)
    expect(ledger!.runs.summarization.lastError).toMatch(/stub-injected/)
    expect(failed.body.progress).not.toHaveProperty('lastError')
    expect(failed.body.meeting.status).toBe('indexing')
    // Parked for a few seconds, measured on the server, so a blip that is not
    // the provider's is not retried into the chunk's last attempt at once.
    expect(failed.body.next).toBe('wait')
    expect(failed.body.retryAfterMs).toBeGreaterThan(3000)
    expect(failed.body.retryAfterMs).toBeLessThanOrEqual(5000)

    const tooSoon = await step()
    expect(tooSoon.body.next).toBe('wait')
    expect(tooSoon.body.progress.done).toBe(0)

    await new Promise(resolve => setTimeout(resolve, tooSoon.body.retryAfterMs! + 100))

    const extracted = await step()
    expect(extracted.status).toBe(202)
    expect(extracted.body.progress).toEqual({ done: 1, total: 1 })

    const done = await step()
    expect(done.status).toBe(200)
    expect(done.body.meeting.status).toBe('ready')
  })
})
