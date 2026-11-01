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
