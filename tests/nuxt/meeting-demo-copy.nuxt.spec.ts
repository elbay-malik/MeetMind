import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingPage from '~/pages/meetings/[id]/index.vue'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

mockNuxtImport('useRoute', () => () => ({ params: { id: ID }, query: {}, path: `/meetings/${ID}`, fullPath: `/meetings/${ID}` }))

const row = { current: {} as Record<string, unknown> }
const transcript = { segments: [] as unknown[] }

registerEndpoint(`/api/meetings/${ID}`, () => ({
  meeting: {
    id: ID,
    title: 'A meeting',
    status: 'uploaded',
    failedStage: null,
    sourceFileName: 'a.mp4',
    sourceBytes: 1,
    sourceMime: 'video/mp4',
    audioBytes: 1,
    durationSec: 10,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...row.current,
  },
}))
registerEndpoint(`/api/meetings/${ID}/transcript`, () => transcript)
registerEndpoint(`/api/meetings/${ID}/summary`, () => ({ summary: null }))
registerEndpoint(`/api/meetings/${ID}/search-index`, () => ({ index: null }))
registerEndpoint(`/api/meetings/${ID}/pipeline`, () => ({
  status: row.current.status ?? 'uploaded',
  progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null },
  index: { state: 'unavailable', done: 0, total: null, retryAt: null },
  next: 'wait',
  retryAt: null,
  retryAfterMs: null,
}))

async function open(status: Record<string, unknown>, segments: unknown[] = []) {
  row.current = status
  transcript.segments = segments
  const page = await mountSuspended(MeetingPage)
  await flushPromises()
  return page
}

const LINE = { idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship on Friday.' }

afterEach(() => {
  useRuntimeConfig().public.demoMeetingId = ''
})

describe.each<[string, Record<string, unknown>, unknown[]]>([
  ['no transcript yet', { status: 'uploaded' }, []],
  ['transcribing, with no lines', { status: 'transcribing' }, []],
  ['transcribing, with lines', { status: 'transcribing' }, [LINE]],
  ['failed part-way', { status: 'failed', failedStage: 'transcription' }, [LINE]],
])('a meeting that is not finished: %s', (_name, status, segments) => {
  it('sends a visitor to the pipeline page to move it on', async () => {
    const page = await open(status, segments)
    expect(page.text()).toMatch(/Open Pipeline/)
  })

  it('on the public demo, does not, since nothing on that page can', async () => {
    useRuntimeConfig().public.demoMeetingId = ID
    const page = await open(status, segments)
    expect(page.text()).not.toMatch(/Open Pipeline/)
    expect(page.text()).not.toMatch(/by itself/)
  })
})
