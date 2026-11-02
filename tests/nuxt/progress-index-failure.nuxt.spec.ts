import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ProgressPage from '~/pages/meetings/[id]/progress.vue'
import type { Meeting, SearchIndexStatus } from '../../shared/types/meeting'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const MESSAGE = 'The free daily limit for indexing and questions has been reached. It resets at 00:00 UTC. '
  + 'Passages indexed so far are kept; indexing again resumes from there.'

const meeting = {
  id: ID,
  title: 'Weekly sync',
  status: 'ready',
  sourceFileName: 'sync.mp4',
  sourceBytes: 1_000,
  sourceMime: 'video/mp4',
  durationSec: 60,
  audioKey: `meetings/${ID}/audio.ogg`,
  audioBytes: 1_000,
  failedStage: null,
  errorMessage: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
} as unknown as Meeting

// What the status route reads before indexing, then after a run the limit stopped.
let index: SearchIndexStatus = { state: 'none', windowCount: 12, indexedCount: 0, model: 'stub' }

registerEndpoint(`/api/meetings/${ID}`, () => ({ meeting }))
registerEndpoint(`/api/meetings/${ID}/transcript`, () => ({ segments: [] }))
registerEndpoint(`/api/meetings/${ID}/search-index`, {
  method: 'GET',
  handler: () => ({ index }),
})
// Shaped as the route answers: tests/e2e/embedding-quota.spec.ts holds it to this.
registerEndpoint(`/api/meetings/${ID}/search-index`, {
  method: 'POST',
  handler: (event: { node: { res: { statusCode: number } } }) => {
    index = { ...index, state: 'incomplete', indexedCount: 8 }
    event.node.res.statusCode = 429
    return { error: true, statusCode: 429, statusMessage: 'Indexing failed', message: MESSAGE }
  },
})

describe('the progress page when the provider\'s daily limit stops indexing', () => {
  it('says so in plain words, shows how far it got, and offers to carry on', async () => {
    const page = await mountSuspended(ProgressPage, { route: `/meetings/${ID}/progress` })
    await flushPromises()
    const button = page.findAll('button').find(b => b.text().includes('Index for questions'))
    expect(button, 'no button to index with').toBeTruthy()
    await button!.trigger('click')

    await vi.waitFor(() => expect(page.find('[role="alert"]').exists()).toBe(true))
    await flushPromises()
    expect(page.find('[role="alert"]').text()).toContain(MESSAGE)
    expect(page.text()).toContain('8 of 12 passages indexed')
    expect(page.findAll('button').some(b => b.text().includes('Update the index'))).toBe(true)
  })
})

describe('the progress page driving indexing', () => {
  const STEPPING = '6fa459ea-ee8a-4ca4-894e-db77e160355e'
  let status: SearchIndexStatus = { state: 'none', windowCount: 40, indexedCount: 0, model: 'stub' }
  let requests = 0
  registerEndpoint(`/api/meetings/${STEPPING}`, () => ({ meeting: { ...meeting, id: STEPPING } }))
  registerEndpoint(`/api/meetings/${STEPPING}/transcript`, () => ({ segments: [] }))
  registerEndpoint(`/api/meetings/${STEPPING}/search-index`, { method: 'GET', handler: () => ({ index: status }) })
  // Shaped as the route answers: tests/e2e/search-index-api.spec.ts holds it to this.
  registerEndpoint(`/api/meetings/${STEPPING}/search-index`, {
    method: 'POST',
    handler: (event: { node: { res: { statusCode: number } } }) => {
      requests++
      if (requests <= 2) {
        event.node.res.statusCode = 202
        return {
          progress: { done: requests * 16, total: null, lastError: null },
          next: 'continue',
          retryAt: null,
          retryAfterMs: null,
        }
      }
      status = { ...status, state: 'ready', indexedCount: 40 }
      return { index: status }
    },
  })

  it('asks again until the index is finished, says how far it has got, and announces the end', async () => {
    const page = await mountSuspended(ProgressPage, { route: `/meetings/${STEPPING}/progress` })
    await flushPromises()
    await page.findAll('button').find(b => b.text().includes('Index for questions'))!.trigger('click')

    await vi.waitFor(() => expect(page.text()).toContain('Indexing finished. This meeting can be asked questions.'))
    expect(requests).toBe(3)
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(page.findAll('a').some(a => a.text().includes('Ask on the meeting page'))).toBe(true)
  })
})

describe('the progress page when the index status cannot be read', () => {
  const BROKEN = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'
  registerEndpoint(`/api/meetings/${BROKEN}`, () => ({ meeting: { ...meeting, id: BROKEN } }))
  registerEndpoint(`/api/meetings/${BROKEN}/transcript`, () => ({ segments: [] }))
  registerEndpoint(`/api/meetings/${BROKEN}/search-index`, (event: { node: { res: { statusCode: number } } }) => {
    event.node.res.statusCode = 500
    return { error: true, statusCode: 500, statusMessage: 'Server Error' }
  })

  it('says that, rather than blaming transcription that has finished', async () => {
    const page = await mountSuspended(ProgressPage, { route: `/meetings/${BROKEN}/progress` })
    await flushPromises()
    expect(page.text()).toContain('Could not check whether this meeting can be asked questions')
    expect(page.text()).not.toContain('Available once transcription has finished')
  })
})
