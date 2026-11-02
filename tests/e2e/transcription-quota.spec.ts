import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, PipelineResponse } from '../../shared/types/meeting'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

// Isolated from transcription-api.spec.ts: NUXT_TRANSCRIBE_STUB_QUOTA_FAIL
// makes the stub throw a 429 exactly ONCE for the whole server process, which
// would otherwise break every other test in a shared file that expects a
// normal, successful transcription.
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-transcribe-quota-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_TRANSCRIBE_STUB_QUOTA_FAIL: 'true',
  },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function uploadedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Quota test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  const done = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return done.meeting
}

/** Simulate the retry cooldown having elapsed, without a real 60s wait. */
async function backdateUpdatedAt(id: string, msAgo: number): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  const meeting = await storage.getItem<Meeting>(`meetings/${id}`)
  if (!meeting) throw new Error(`no local meeting row for ${id}`)
  await storage.setItem(`meetings/${id}`, { ...meeting, updatedAt: new Date(Date.now() - msAgo).toISOString() })
}

describe('transcription quota exhaustion', () => {
  it('lands a 429 on a cooldown-gated failed state, not the ungated uploaded reset', async () => {
    const meeting = await uploadedMeeting()
    // The route reports the failure's own status code (429, matching what the
    // provider actually said) for this first, real attempt.
    const res = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(429)

    const { meeting: after } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    // The bug this guards: a retryable 429 used to reset straight to
    // `uploaded`, which has no cooldown gate at all — a client could
    // immediately hammer the same exhausted quota again.
    expect(after.status).toBe('failed')
    expect(after.failedStage).toBe('transcription')
    expect(after.errorMessage).toMatch(/quota is exhausted/)

    // An instant retry must still be refused, with an accurate reason.
    const tooSoon = await fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    expect(tooSoon.status).toBe(409)
    const body = await tooSoon.json()
    expect(body.message).toMatch(/wait \d+s/)

    // The driver's route says the same thing its way, with no provider's words in it, and
    // takes no step: a retry is only for after the cooldown, which is when it says.
    const driver = await fetch(`/api/meetings/${meeting.id}/advance`, { method: 'POST' })
    expect(driver.status).toBe(200)
    const answer = await driver.json() as PipelineResponse
    expect(answer).toMatchObject({ status: 'failed', next: 'failed', progress: { stage: 'transcription' } })
    expect(Date.parse(answer.retryAt!)).toBeGreaterThan(Date.now())
    expect(JSON.stringify(answer)).not.toMatch(/quota/)

    // Past the cooldown, and past the stub's single-shot failure, a retry
    // succeeds normally.
    await backdateUpdatedAt(meeting.id, 61_000)
    const { meeting: recovered } = await driveTranscription(meeting.id)
    expect(recovered.status).toBe('summarizing')
    expect(recovered.failedStage).toBeNull()
  })
})
