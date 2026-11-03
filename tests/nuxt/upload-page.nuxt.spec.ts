import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import UploadPage from '~/pages/index.vue'
import MeetingLinkNotice from '~/components/MeetingLinkNotice.vue'

/** A finished extraction, without a real ffmpeg worker, so the upload card renders. */
mockNuxtImport('useAudioExtract', () => () => ({
  state: reactive({
    status: 'done',
    outputBlob: new Blob(['x']),
    outputBytes: 1,
    outputUrl: null,
    durationSec: 30,
    elapsedMs: 1000,
    outTimeSec: 30,
    ratio: 1,
    error: null,
  }),
  extract: () => {},
  cancel: () => {},
  reset: () => {},
}))

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

describe('what the upload copy promises about deletion', () => {
  const copy = async () => (await mountSuspended(UploadPage)).text().replace(/\s+/g, ' ')

  afterEach(() => {
    useDeploymentFacts().value = { sweeps: false, purgeDays: null }
  })

  it('promises none by default, since nothing deletes anything', async () => {
    const text = await copy()
    expect(text).toContain('you cannot delete it yourself')
    expect(text).not.toMatch(/deleted about|are deleted|days after/)
  })

  it('promises none on a Worker with the purge off, though its cron is running', async () => {
    useDeploymentFacts().value = { sweeps: true, purgeDays: null }
    expect(await copy()).not.toMatch(/deleted about|are deleted|days after/)
  })

  it.each<[number, string]>([[30, '30 days'], [7, '7 days'], [1, '1 day']])('says the true number of days with it on: %s', async (days, said) => {
    useDeploymentFacts().value = { sweeps: true, purgeDays: days }
    const text = await copy()
    expect(text).toContain(`The meeting and everything stored for it are deleted about ${said} after upload.`)
    expect(text).toContain('you cannot delete it yourself')
  })
})

describe('what the upload copy says leaves the browser', () => {
  it('names the file details next to every claim about what is uploaded', async () => {
    const text = (await mountSuspended(UploadPage)).text().replace(/\s+/g, ' ')
    expect(text).not.toContain('Only this audio is uploaded')
    expect(text).not.toContain('The compressed audio is what gets uploaded')
    // Once in the intro, once beside the title a person might retitle to hide a name.
    expect(text.match(/file's name, size and type/g)).toHaveLength(2)
    expect(text).toContain('even if you change the title')
    expect(text).toContain('including the file\'s name')
  })

  it('names who holds the audio and who receives a question', async () => {
    const text = (await mountSuspended(UploadPage)).text().replace(/\s+/g, ' ')
    expect(text).toContain('The audio is stored at Cloudflare and sent to Groq to transcribe.')
    expect(text).toContain('Questions typed about a meeting are sent to Cloudflare and Groq too.')
  })

  it('tells link holders what they can see of the file', async () => {
    const notice = await mountSuspended(MeetingLinkNotice, { props: { meetingId: ID } })
    expect(notice.text().replace(/\s+/g, ' ')).toContain('file\'s name, size and type')
  })

  it('tells people about the file details in the notice on the demo too', async () => {
    useRuntimeConfig().public.demoMeetingId = ID
    const notice = await mountSuspended(MeetingLinkNotice, { props: { meetingId: ID } })
    useRuntimeConfig().public.demoMeetingId = ''
    expect(notice.text().replace(/\s+/g, ' ')).toContain('file\'s name, size and type')
  })
})

describe('the demo link', () => {
  const setDemo = (id: string) => {
    useRuntimeConfig().public.demoMeetingId = id
  }
  const demoButton = async () =>
    (await mountSuspended(UploadPage)).findAll('a').find(a => a.text().includes('Open the demo meeting'))

  beforeEach(() => setDemo(''))
  afterEach(() => setDemo(''))

  it('is shown for a well-formed id', async () => {
    setDemo(ID)
    expect((await demoButton())?.attributes('href')).toBe(`/meetings/${ID}`)
  })

  // The server's guard ignores this whitespace too, so the two agree on which meeting it is.
  it.each([`${ID}\n`, `  ${ID} `])('is shown with a clean link for an id stored with whitespace around it (%j)', async (id) => {
    setDemo(id)
    expect((await demoButton())?.attributes('href')).toBe(`/meetings/${ID}`)
  })

  it.each(['9b1deb4d-3b7d', 'not-a-uuid', '../../api/health'])('is not shown for %s, which could only open a 404', async (id) => {
    setDemo(id)
    expect(await demoButton()).toBeUndefined()
  })

  it('tells the operator why a configured link is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setDemo('not-a-uuid')
    await demoButton()
    expect(warn.mock.calls.flat().join(' ')).toContain('NUXT_PUBLIC_DEMO_MEETING_ID')
    warn.mockRestore()
  })

  it('does not warn over a well-formed id or an empty one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setDemo(ID)
    await demoButton()
    setDemo('')
    await demoButton()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('NUXT_PUBLIC_DEMO_MEETING_ID')
    warn.mockRestore()
  })

  it('is not shown when no demo is configured', async () => {
    expect(await demoButton()).toBeUndefined()
  })
})
