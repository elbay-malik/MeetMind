import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting } from '../../shared/types/meeting'

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
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE: 'true',
  },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function transcribedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title: 'Retryable failure test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
  return done.meeting
}

/** Simulate the retry cooldown having elapsed, without a real 60s wait. */
async function backdateUpdatedAt(id: string, msAgo: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, updatedAt: new Date(Date.now() - msAgo).toISOString() })
}

describe('summarization retryable failure', () => {
  it('lands a retryable failure on a cooldown-gated failed state, not the ungated summarizing one', async () => {
    const meeting = await transcribedMeeting()
    const res = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(502)

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    // The bug this guards: a retryable failure used to reset straight to
    // `summarizing` — the meeting's own pre-first-attempt state, which
    // claim() reclaims with no cooldown gate at all.
    expect(after.status).toBe('failed')
    expect(after.failedStage).toBe('summarization')

    // An instant retry must still be refused.
    const tooSoon = await fetch(`/api/meetings/${meeting.id}/summarize`, { method: 'POST' })
    expect(tooSoon.status).toBe(409)
    const body = await tooSoon.json()
    expect(body.message).toMatch(/wait \d+s/)

    // Past the cooldown, and past the stub's single-shot failure, a retry
    // succeeds normally.
    await backdateUpdatedAt(meeting.id, 61_000)
    const { meeting: recovered } = await $fetch<{ meeting: Meeting }>(
      `/api/meetings/${meeting.id}/summarize`, { method: 'POST' },
    )
    expect(recovered.status).toBe('ready')
  })
})
