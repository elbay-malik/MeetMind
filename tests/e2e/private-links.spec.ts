import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting } from '../../shared/types/meeting'

/**
 * ADR-0013: a meeting's id is the capability to read it, so nothing may hand an
 * id to anyone who does not already hold it. A registered meeting exists for
 * the whole file, so "the list is empty" can never be why a check passes.
 */
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-private-links-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

let meeting: Meeting

beforeAll(async () => {
  const created = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title: 'Private sync', sourceFileName: 'private-sync.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: 4096,
    },
  })
  meeting = created.meeting
})

/** Rendered text with tags and line wrapping gone, so copy can reflow freely. */
function words(html: string): string {
  return html.replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

describe('nothing hands out meeting ids', () => {
  it.each([
    '/api/meetings',
    '/api/meetings?limit=100',
    '/api/meetings/search?q=sync',
  ])('GET %s is not a data route', async (path) => {
    const res = await fetch(path)
    expect([404, 405]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain(meeting.id)
    expect(body).not.toContain('"meetings"')
    expect(body).not.toContain('"results"')
  })

  it.each(['/', '/meetings'])('SSR of %s carries no meeting id, in the HTML or its payload', async (path) => {
    const res = await fetch(path)
    expect(res.status).toBe(200)
    // Not "no UUID at all": Nuxt's own buildId is one, on every page.
    expect(await res.text()).not.toContain(meeting.id)
  })

  it('still serves the meeting to whoever holds the link', async () => {
    const { meeting: found } = await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)
    expect(found.id).toBe(meeting.id)
    expect((await fetch(`/meetings/${meeting.id}`)).status).toBe(200)
  })
})

describe('a meeting URL does not reach a third party through Referer', () => {
  // As a browser asks: an error page is only rendered for a request that accepts
  // HTML. Nitro's JSON errors carry its own, stricter no-referrer, and render nothing
  // that could send one.
  it.each([
    ['the upload page', () => '/'],
    ['the meetings page', () => '/meetings'],
    ['a meeting page', () => `/meetings/${meeting.id}`],
    ['a progress page', () => `/meetings/${meeting.id}/progress`],
    ['a page that does not exist', () => '/meetings/not-a-uuid'],
    ['a data route', () => `/api/meetings/${meeting.id}`],
  ])('%s answers Referrer-Policy: same-origin', async (_name, path) => {
    const res = await fetch(path(), { headers: { accept: 'text/html' } })
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
  })
})

describe('what the pages tell people', () => {
  it('the meetings page says the list lives only in this browser, before any script runs', async () => {
    const text = words(await (await fetch('/meetings')).text())
    expect(text).toContain('Your meetings')
    expect(text).toContain('only in this browser')
    expect(text).toMatch(/lose the link.*lose access/i)
    expect(text).not.toContain('Search your meetings')
  })

  it('the meetings page claims nothing about this browser\'s storage until it has read it', async () => {
    // The server has no storage to read, so saying "refused" or "empty" here is a guess.
    const text = words(await (await fetch('/meetings')).text())
    expect(text).not.toContain('not letting MeetMind store anything')
    expect(text).not.toContain('No meetings uploaded from this browser')
  })

  it('the upload page is honest about who receives the recording', async () => {
    const text = words(await (await fetch('/')).text())
    expect(text).toContain('This is a demo')
    expect(text).toContain('Do not upload anything sensitive')
    expect(text).toContain('Groq')
    expect(text).toContain('Cloudflare')
    expect(text).not.toContain('Google')
    expect(text).toContain('Anyone with the link')
    // SEC-10: true of the video, but read as if nothing else left the machine.
    expect(text).not.toContain('Only a small audio file is sent for transcription')
    // No purge exists yet, so nothing may promise one.
    expect(text).not.toMatch(/30 days|deleted after|automatically deleted/i)
  })

  it.each([
    ['meeting', () => `/meetings/${meeting.id}`],
    ['progress', () => `/meetings/${meeting.id}/progress`],
  ])('the %s page tells its holder to keep the link', async (_name, path) => {
    const text = words(await (await fetch(path())).text())
    expect(text).toContain('Keep this link')
    expect(text).toContain('Anyone with this link')
    expect(text).toContain('Copy link')
  })

  it('links no demo meeting when none is configured', async () => {
    expect(words(await (await fetch('/')).text())).not.toContain('demo meeting')
  })
})
