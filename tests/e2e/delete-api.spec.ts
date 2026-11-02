import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import type { Meeting } from '../../shared/types/meeting'
import { audioObjectKey, whisperReplyKey } from '../../shared/utils/meeting'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-delete-'))

const ADMIN_TOKEN = 'e2e-admin-token-0123456789-abcdefghijklmnop'
const CEILING = 10_000

/**
 * Its own spec file for two process-wide settings: the admin token (every other
 * e2e spec runs without one, which is what proves the route stays hidden by
 * default) and a 10,000-byte storage ceiling, so the budget test can fill the
 * store with one seeded meeting and show the delete giving the room back.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ADMIN_TOKEN: ADMIN_TOKEN,
    NUXT_R2_MAX_STORED_BYTES: String(CEILING),
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
const HOUR = 60 * 60_000

/** Every meeting this file seeds stays tiny, except the one the budget test
 * seeds on purpose, so that test's arithmetic holds whatever ran before it. */
const SMALL_AUDIO = 100

/**
 * Write a meeting row straight into the local driver's files. The repository's
 * own `create` stamps both timestamps with now, and every blocker the route
 * checks is a question of how old those timestamps are -- so seeding has to go
 * around it.
 */
async function seedMeeting(overrides: Partial<Meeting> = {}): Promise<Meeting> {
  const id = overrides.id ?? randomUUID()
  const longAgo = new Date(Date.now() - 3 * HOUR).toISOString()
  const meeting: Meeting = {
    id,
    createdAt: longAgo,
    updatedAt: longAgo,
    title: 'Delete test',
    status: 'ready',
    sourceFileName: 'meeting.mp4',
    sourceBytes: 1_000_000,
    sourceMime: 'video/mp4',
    durationSec: 60,
    audioKey: audioObjectKey(id),
    audioBytes: SMALL_AUDIO,
    audioMime: 'audio/ogg',
    uploadedAt: longAgo,
    errorMessage: null,
    failedStage: null,
    ...overrides,
  }
  await db.setItem(`meetings/${id}`, meeting)
  return meeting
}

/** Plant an audio object the way the local upload route stores one. */
async function plantAudio(key: string, bytes: number): Promise<string> {
  const path = join(dataDir, 'audio', ...key.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, new Uint8Array(bytes))
  await writeFile(`${path}.meta`, JSON.stringify({ contentType: 'audio/ogg', size: bytes }))
  return path
}

const exists = (path: string) => stat(path).then(() => true, () => false)

function del(id: string, authorization: string | null = `Bearer ${ADMIN_TOKEN}`): Promise<Response> {
  return fetch(`/api/meetings/${id}`, {
    method: 'DELETE',
    headers: authorization === null ? {} : { authorization },
  })
}

function register(audioBytes: number): Promise<Response> {
  return fetch('/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...inviteHeaders },
    body: JSON.stringify({
      title: 'delete',
      sourceFileName: 'a.mp4',
      sourceBytes: 1_000_000,
      sourceMime: 'video/mp4',
      durationSec: 30,
      audioBytes,
    }),
  })
}

describe('DELETE /api/meetings/:id authentication', () => {
  it('refuses a request with no Authorization header, and leaves the meeting', async () => {
    const meeting = await seedMeeting()
    const res = await del(meeting.id, null)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('refuses a wrong token, and leaves the meeting', async () => {
    // An old ready meeting, so nothing but the token stands between this
    // request and a 204: a comparison that accepted anything would delete it.
    const meeting = await seedMeeting()
    const res = await del(meeting.id, `Bearer ${ADMIN_TOKEN.slice(0, -1)}x`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('refuses the right token under any scheme but Bearer', async () => {
    // The real token, so only the scheme check can be what refuses it.
    const meeting = await seedMeeting()
    const res = await del(meeting.id, `Basic ${ADMIN_TOKEN}`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('answers 401 for an id that does not exist, so a caller cannot probe for ids', async () => {
    // Were the token checked after the lookup, a 404 here against a 401 for a
    // real id would tell an unauthenticated caller which ids exist.
    const res = await del(randomUUID(), null)
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/meetings/:id not found', () => {
  it('404s for an unknown id', async () => {
    expect((await del(randomUUID())).status).toBe(404)
  })

  it('404s for a malformed id without touching the store', async () => {
    // A malformed id must be refused before it is used to build a storage key:
    // the leftover sweep deletes `meetings/<id>/audio.ogg` for whatever id it
    // is handed. An object planted under that key proves it never ran.
    const planted = await plantAudio('meetings/not-a-uuid/audio.ogg', SMALL_AUDIO)
    expect((await del('not-a-uuid')).status).toBe(404)
    expect(await exists(planted)).toBe(true)
  })

  it('removes leftover audio and child rows whose meeting row is already gone', async () => {
    // What a delete that removed the row and then failed partway leaves
    // behind. Nothing else would ever find this object -- the budget counts
    // rows -- so repeating the delete has to be what finishes it.
    const id = randomUUID()
    const planted = await plantAudio(audioObjectKey(id), SMALL_AUDIO)
    // The failure could equally have come after the audio went: the child rows
    // are removed after it, so any of them may be what is left. The local
    // driver has no foreign key, so these orphans are only gone if the
    // not-found path sweeps them too, not just the audio.
    await db.setItem(`transcripts/${id}`, [{ idx: 0, startMs: 0, endMs: 1000, text: 'hello' }])
    await db.setItem(`summaries/${id}`, { summary: 'stored', decisions: [], actionItems: [] })
    await db.setItem(`windows/${id}`, [{ idx: 0, text: 'hello' }])
    await db.setItem(`pipeline/${id}`, ledger(null))

    expect((await del(id)).status).toBe(404)
    expect(await exists(planted)).toBe(false)
    expect(await exists(`${planted}.meta`)).toBe(false)
    expect(await db.hasItem(`transcripts/${id}`)).toBe(false)
    expect(await db.hasItem(`summaries/${id}`)).toBe(false)
    expect(await db.hasItem(`windows/${id}`)).toBe(false)
    expect(await db.hasItem(`pipeline/${id}`)).toBe(false)
  })
})

/** A run ledger as the local pipeline driver stores it, with one summarization run. */
const ledger = (stepLeaseUntil: number | null) => ({
  runs: {
    summarization: {
      runId: randomUUID(), cursor: {}, stepToken: stepLeaseUntil === null ? null : randomUUID(), stepLeaseUntil,
      attempts: 1, lastError: null, retryAt: null,
    },
  },
  chunks: [],
})

/** The same, with one indexing run, paused or holding a step. */
const indexLedger = (stepLeaseUntil: number | null, retryAt: number | null = null) => ({
  runs: {
    search_index: {
      runId: randomUUID(), cursor: {}, stepToken: stepLeaseUntil === null ? null : randomUUID(), stepLeaseUntil,
      attempts: 1, lastError: null, retryAt,
    },
  },
  chunks: [],
})

/** The same, with one transcription run, paused or holding a step. */
const transcriptionLedger = (stepLeaseUntil: number | null) => ({
  runs: {
    transcription: {
      runId: randomUUID(), cursor: {}, stepToken: stepLeaseUntil === null ? null : randomUUID(), stepLeaseUntil,
      attempts: 1, lastError: null, retryAt: null,
    },
  },
  chunks: [],
})

describe('DELETE /api/meetings/:id while the meeting may still be written', () => {
  it('409s while a pipeline step holds a live lease, until that lease ends', async () => {
    // ADR-0012: a step mid provider call would write its result back after
    // the delete. A `ready` meeting holds no status claim, so only the step
    // lease can be what refuses.
    const meeting = await seedMeeting()
    await db.setItem(`pipeline/${meeting.id}`, ledger(Date.now() + 90_000))
    const refused = await del(meeting.id)
    expect(refused.status).toBe(409)
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(80)
    expect(retryAfter).toBeLessThanOrEqual(90)
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('409s inside the upload window, with a Retry-After', async () => {
    // Its upload URL is live: audio PUT after the delete would be stored with
    // no row, invisible to the budget.
    const res = await register(SMALL_AUDIO)
    expect(res.status).toBe(201)
    const { meeting } = (await res.json()) as { meeting: Meeting }

    const refused = await del(meeting.id)
    expect(refused.status).toBe(409)
    // URL lifetime (15 min) plus grace (15 min), counted from just now.
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(29 * 60)
    expect(retryAfter).toBeLessThanOrEqual(30 * 60)
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('409s while a transcription step is live, long after the upload window', async () => {
    const meeting = await seedMeeting({ status: 'transcribing', updatedAt: new Date().toISOString() })
    await db.setItem(`pipeline/${meeting.id}`, transcriptionLedger(Date.now() + 90_000))
    const refused = await del(meeting.id)
    expect(refused.status).toBe(409)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    const after = await fetch(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe(200)
    expect(((await after.json()) as { meeting: Meeting }).meeting.status).toBe('transcribing')
  })

  it('deletes a transcribing meeting paused between steps, however recently it moved, with its raw reply', async () => {
    // ADR-0012: a run parked between steps holds nothing. The old 15-minute
    // status lease kept a paused transcription undeletable.
    const meeting = await seedMeeting({ status: 'transcribing', updatedAt: new Date().toISOString() })
    await db.setItem(`pipeline/${meeting.id}`, transcriptionLedger(null))
    const reply = join(dataDir, 'audio', ...whisperReplyKey(meeting.id).split('/'))
    await mkdir(dirname(reply), { recursive: true })
    await writeFile(reply, '{"segments":[]}')

    const res = await del(meeting.id)
    expect(res.status).toBe(204)
    await expect(access(reply)).rejects.toThrow()
    expect(await db.hasItem(`pipeline/${meeting.id}`)).toBe(false)
  })

  // ADR-0012 step 8: the in-process map this replaced could not see another isolate's
  // run, and a `ready` meeting held nothing else for it to read.
  it('409s while an indexing step holds a live lease', async () => {
    const meeting = await seedMeeting()
    await db.setItem(`pipeline/${meeting.id}`, indexLedger(Date.now() + 45_000))
    const refused = await del(meeting.id)
    expect(refused.status).toBe(409)
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(45)
    expect((await refused.json()).message).toMatch(/pipeline step is running/)
    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(200)
  })

  it('deletes an indexing run parked until tomorrow, marker and all', async () => {
    const meeting = await seedMeeting()
    const parked = indexLedger(null, Date.now() + 12 * 60 * 60 * 1000)
    await db.setItem(`pipeline/${meeting.id}`, { ...parked, indexMarker: { textHash: 'a'.repeat(64), model: 'm', windowCount: 0, complete: false } })
    expect((await del(meeting.id)).status).toBe(204)
    expect(await db.hasItem(`pipeline/${meeting.id}`)).toBe(false)
  })

  it('deletes an indexing meeting whose extraction is paused between steps, however recently it moved', async () => {
    // Extraction runs in short steps under their own leases (ADR-0012). A run
    // parked between them holds nothing, so an `indexing` status a moment old
    // no longer refuses the delete -- the old 4 h status lease made a paused
    // extraction undeletable for hours.
    const meeting = await seedMeeting({ status: 'indexing', updatedAt: new Date().toISOString() })
    await db.setItem(`pipeline/${meeting.id}`, ledger(null))
    expect((await del(meeting.id)).status).toBe(204)
    expect(await db.hasItem(`pipeline/${meeting.id}`)).toBe(false)
  })

  it('409s an indexing meeting while one of its steps is live', async () => {
    const meeting = await seedMeeting({ status: 'indexing', updatedAt: new Date().toISOString() })
    await db.setItem(`pipeline/${meeting.id}`, ledger(Date.now() + 90_000))
    const refused = await del(meeting.id)
    expect(refused.status).toBe(409)
    const retryAfter = refused.headers.get('retry-after')
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThan(0)
    expect(Number(retryAfter)).toBeLessThanOrEqual(90)
    // Refused means untouched: the row and its run are both still there.
    const after = await fetch(`/api/meetings/${meeting.id}`)
    expect(after.status).toBe(200)
    expect(((await after.json()) as { meeting: Meeting }).meeting.status).toBe('indexing')
    expect(await db.hasItem(`pipeline/${meeting.id}`)).toBe(true)
  })
})

describe('DELETE /api/meetings/:id', () => {
  it('removes the row, the audio, the transcript, the summary and the windows', async () => {
    // One test because each step depends on the one before: the second delete
    // is only meaningful against a meeting the first one removed.
    const meeting = await seedMeeting()
    const audioPath = await plantAudio(meeting.audioKey, SMALL_AUDIO)
    await db.setItem(`transcripts/${meeting.id}`, [{ idx: 0, startMs: 0, endMs: 1000, text: 'hello' }])
    await db.setItem(`summaries/${meeting.id}`, { summary: 'stored', decisions: [], actionItems: [] })
    await db.setItem(`windows/${meeting.id}`, [{ idx: 0, text: 'hello' }])
    // Parked between steps: no lease, so it does not block, and goes with the meeting.
    await db.setItem(`pipeline/${meeting.id}`, ledger(null))

    const res = await del(meeting.id)
    expect(res.status).toBe(204)

    expect((await fetch(`/api/meetings/${meeting.id}`)).status).toBe(404)
    expect(await exists(audioPath)).toBe(false)
    expect(await exists(`${audioPath}.meta`)).toBe(false)
    // The local driver has no cascade: each of these is gone only because the
    // route removed it, and a forgotten one would be found by a later scan.
    expect(await db.hasItem(`transcripts/${meeting.id}`)).toBe(false)
    expect(await db.hasItem(`summaries/${meeting.id}`)).toBe(false)
    expect(await db.hasItem(`windows/${meeting.id}`)).toBe(false)
    expect(await db.hasItem(`pipeline/${meeting.id}`)).toBe(false)

    expect((await del(meeting.id)).status).toBe(404)
  })

  it('gives the meeting\'s bytes back to the storage budget', async () => {
    // This is what makes the budget reversible: without a delete, a full store
    // stays full until the bucket's lifecycle rule gets round to it. 8000 of
    // the 10,000 bytes, so 2000 more cannot fit now and must fit afterwards --
    // every other meeting in this file holds 100, too few to tip either side.
    const big = await seedMeeting({ audioBytes: 8000 })
    await plantAudio(big.audioKey, 8000)

    const full = await register(2000)
    expect(full.status).toBe(507)

    expect((await del(big.id)).status).toBe(204)

    expect((await register(2000)).status).toBe(201)
  })
})
