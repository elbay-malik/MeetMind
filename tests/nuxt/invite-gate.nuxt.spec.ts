import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import UploadPage from '~/pages/index.vue'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const CODE = 'a-right-code-a-right-code-a-right-code'
const REFUSED = 'Uploading needs a valid invite code.'
const CLOSED = 'Uploading is closed at the moment, whatever code is entered.'

const IDLE = {
  status: 'idle',
  outputBlob: null as Blob | null,
  outputBytes: 0,
  outputUrl: null,
  durationSec: null as number | null,
  elapsedMs: 0,
  outTimeSec: 0,
  ratio: 0,
  error: null,
}

const extraction = reactive({ ...IDLE })
const extract = vi.fn()
mockNuxtImport('useAudioExtract', () => () => ({ state: extraction, extract, cancel: () => {}, reset: () => {} }))

type Handler = { node: { res: { statusCode: number } }, headers: Headers }
type Reply = { statusCode: number, message?: string }

/** What each route answers, and the Authorization header each was sent. */
let checkReply: Reply
let registerReply: Reply
let checkHeaders: (string | null)[]
let registerHeaders: (string | null)[]

function answer(event: Handler, reply: Reply) {
  event.node.res.statusCode = reply.statusCode
  return reply.statusCode === 204 ? null : { error: true, ...reply }
}

registerEndpoint('/api/invite-check', {
  method: 'POST',
  handler: (event: Handler) => {
    checkHeaders.push(event.headers.get('authorization'))
    return answer(event, checkReply)
  },
})

registerEndpoint('/api/meetings', {
  method: 'POST',
  handler: (event: Handler) => {
    registerHeaders.push(event.headers.get('authorization'))
    return answer(event, registerReply)
  },
})

const mount = () => mountSuspended(UploadPage, { attachTo: document.body })
type Page = Awaited<ReturnType<typeof mount>>

const codeField = (page: Page) => page.find('input[type="password"]')
const fileInput = (page: Page) => page.find('input[type="file"]')
const alerts = (page: Page) => page.findAll('[role="alert"]').map(a => a.text())
const buttonNamed = (page: Page, name: string) => page.findAll('button').find(b => b.text().includes(name))

async function submitCode(page: Page, code: string) {
  await codeField(page).setValue(code)
  await page.find('form').trigger('submit')
  await flushPromises()
  await vi.waitFor(() => expect(page.text()).not.toContain('Checking the code'))
  await flushPromises()
}

beforeEach(() => {
  Object.assign(extraction, IDLE)
  extract.mockClear()
  useRuntimeConfig().public.demoMeetingId = ''
  checkReply = { statusCode: 204 }
  registerReply = { statusCode: 401, message: REFUSED }
  checkHeaders = []
  registerHeaders = []
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  useRuntimeConfig().public.demoMeetingId = ''
  document.body.innerHTML = ''
})

describe('a visitor without a code', () => {
  it('sees plainly that uploading is invite-only, and a labelled field for the code', async () => {
    const page = await mount()
    expect(page.text().replace(/\s+/g, ' ')).toContain('Uploading is invite-only')
    const field = codeField(page)
    expect(field.exists()).toBe(true)
    const label = page.find(`label[for="${field.attributes('id')}"]`)
    expect(label.text()).toContain('Invite code')
  })

  it('is offered no way to start on a recording', async () => {
    const page = await mount()
    expect(fileInput(page).exists()).toBe(false)
    expect(buttonNamed(page, 'Extract audio')).toBeUndefined()
    expect(extract).not.toHaveBeenCalled()
  })

  it('still reads who receives what, before having any code', async () => {
    const text = (await mount()).text().replace(/\s+/g, ' ')
    expect(text).toContain('The audio is stored at Cloudflare and sent to Groq to transcribe.')
    expect(text).toContain('Questions typed about a meeting are sent to Cloudflare and Groq too.')
    expect(text).toContain('you cannot delete it yourself')
  })

  it('cannot submit an empty code', async () => {
    const page = await mount()
    expect(buttonNamed(page, 'Continue')?.attributes('disabled')).toBeDefined()
    await page.find('form').trigger('submit')
    await flushPromises()
    expect(checkHeaders).toEqual([])
  })
})

describe('with a demo meeting configured', () => {
  it('makes the demo the first and primary action', async () => {
    useRuntimeConfig().public.demoMeetingId = ID
    const page = await mount()
    const demo = page.findAll('a').find(a => a.text().includes('Open the demo meeting'))!
    expect(demo.attributes('href')).toBe(`/meetings/${ID}`)
    // Solid, where the actions in the cards below stay smaller.
    expect(demo.classes()).toContain('bg-primary')
    const order = demo.element.compareDocumentPosition(codeField(page).element)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(page.text().replace(/\s+/g, ' ')).toContain('The demo meeting above needs no code.')
  })
})

describe('with no demo meeting configured', () => {
  it('still makes sense: no demo link, and no mention of one', async () => {
    const page = await mount()
    expect(page.findAll('a').some(a => a.text().includes('Open the demo meeting'))).toBe(false)
    const text = page.text().replace(/\s+/g, ' ')
    expect(text).not.toContain('demo meeting')
    expect(text).toContain('Uploading is invite-only')
    expect(codeField(page).exists()).toBe(true)
  })
})

describe('a wrong code', () => {
  it('fails at once, in an alert, with no way on to a recording', async () => {
    checkReply = { statusCode: 401, message: REFUSED }
    const page = await mount()
    await submitCode(page, 'not-the-code')
    expect(alerts(page).join(' ')).toContain(REFUSED)
    expect(fileInput(page).exists()).toBe(false)
    expect(extract).not.toHaveBeenCalled()
  })

  it('leaves focus on the field, to try again', async () => {
    checkReply = { statusCode: 401, message: REFUSED }
    const page = await mount()
    await submitCode(page, 'not-the-code')
    expect(document.activeElement).toBe(codeField(page).element)
  })

  it('clears its alert when the next try is accepted', async () => {
    checkReply = { statusCode: 401, message: REFUSED }
    const page = await mount()
    await submitCode(page, 'not-the-code')
    checkReply = { statusCode: 204 }
    await submitCode(page, CODE)
    expect(alerts(page)).toEqual([])
  })

  // Fetch throws on such a header, so this must never reach it, and must read as any wrong code.
  it.each(['pässwörd-with-umlauts', 'emoji-🔑-code'])('refuses %s without asking the server', async (code) => {
    const page = await mount()
    await submitCode(page, code)
    expect(checkHeaders).toEqual([])
    expect(alerts(page).join(' ')).toContain(REFUSED)
  })
})

describe('when uploads are closed', () => {
  it('says so, in an alert, whatever code was entered', async () => {
    checkReply = { statusCode: 503, message: CLOSED }
    const page = await mount()
    await submitCode(page, CODE)
    expect(alerts(page).join(' ')).toContain(CLOSED)
    expect(fileInput(page).exists()).toBe(false)
  })
})

describe('when the code cannot be checked', () => {
  it('says that, not that the code is wrong', async () => {
    checkReply = { statusCode: 502 }
    const page = await mount()
    await submitCode(page, CODE)
    const said = alerts(page).join(' ')
    expect(said).toContain('Could not check the code')
    expect(said).not.toContain(REFUSED)
    expect(fileInput(page).exists()).toBe(false)
  })
})

describe('the right code', () => {
  it('goes in the Authorization header, trimmed as pasted', async () => {
    const page = await mount()
    await submitCode(page, `  ${CODE}\n`)
    expect(checkHeaders).toEqual([`Bearer ${CODE}`])
  })

  it('opens the recording step, says so, and moves focus there', async () => {
    const page = await mount()
    await submitCode(page, CODE)
    expect(fileInput(page).exists()).toBe(true)
    expect(codeField(page).exists()).toBe(false)
    expect(page.find('[role="status"]').text()).toContain('Invite code accepted.')
    expect(document.activeElement).toBe(fileInput(page).element)
  })

  it('still does not extract anything until asked', async () => {
    const page = await mount()
    await submitCode(page, CODE)
    expect(extract).not.toHaveBeenCalled()
  })

  it('announces from a region that was already on the page', async () => {
    const page = await mount()
    const region = page.find('[role="status"][aria-live="polite"]')
    expect(region.exists()).toBe(true)
    await submitCode(page, CODE)
    expect(region.text()).toContain('Invite code accepted.')
  })
})

describe('where the code is kept', () => {
  const everywhere = () => JSON.stringify([
    window.location.href,
    useRoute().fullPath,
    { ...localStorage },
    { ...sessionStorage },
    document.cookie,
  ])

  it('never in the URL, storage or a cookie, accepted or refused', async () => {
    const page = await mount()
    await submitCode(page, CODE)
    expect(everywhere()).not.toContain(CODE)
    checkReply = { statusCode: 401, message: REFUSED }
    const again = await mount()
    await submitCode(again, 'a-wrong-code-a-wrong-code-a-wrong-code')
    expect(everywhere()).not.toContain('a-wrong-code')
  })

  it('never in a log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const page = await mount()
    await submitCode(page, CODE)
    const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls))
    spies.forEach(spy => spy.mockRestore())
    expect(logged).not.toContain(CODE)
  })

  // A form submitted before the page is interactive sends its named fields in the URL.
  it('not in a named field, which a native form submission would put in the URL', async () => {
    const page = await mount()
    expect(codeField(page).attributes('name')).toBeUndefined()
  })

  it('in a field that hides it and that the browser is told not to remember', async () => {
    const page = await mount()
    expect(codeField(page).attributes('type')).toBe('password')
    expect(codeField(page).attributes('autocomplete')).toBe('off')
  })
})

describe('uploading', () => {
  const READY = { ...IDLE, status: 'done', outputBlob: new Blob(['x']), outputBytes: 1, durationSec: 30, elapsedMs: 1000, outTimeSec: 30, ratio: 1 }
  const uploadButton = (page: Page) => buttonNamed(page, 'Upload audio')!

  async function readyToUpload() {
    Object.assign(extraction, READY)
    const page = await mount()
    await submitCode(page, CODE)
    Object.defineProperty(fileInput(page).element, 'files', { value: [new File(['x'], 'a-meeting.mp4')] })
    await fileInput(page).trigger('change')
    return page
  }

  it('sends the code with the registration', async () => {
    const page = await readyToUpload()
    await uploadButton(page).trigger('click')
    await vi.waitFor(() => expect(registerHeaders).toEqual([`Bearer ${CODE}`]))
  })

  it('offers no upload without an accepted code', async () => {
    Object.assign(extraction, READY)
    const page = await mount()
    expect(uploadButton(page).attributes('disabled')).toBeDefined()
  })

  // The code was rotated after this page checked it: minutes of extraction are not thrown away.
  it('asks for the code again when the server stops accepting it, and keeps the audio', async () => {
    const page = await readyToUpload()
    await uploadButton(page).trigger('click')
    await vi.waitFor(() => expect(codeField(page).exists()).toBe(true))
    await flushPromises()
    expect(alerts(page).join(' ')).toContain(REFUSED)
    expect(page.text()).toContain('Audio ready to upload')
    expect((codeField(page).element as HTMLInputElement).value).toBe('')
    expect(uploadButton(page).attributes('disabled')).toBeDefined()
  })

  it('does not ask for the code again over a failure that is not about the code', async () => {
    registerReply = { statusCode: 507, message: 'The audio archive is full.' }
    const page = await readyToUpload()
    await uploadButton(page).trigger('click')
    await vi.waitFor(() => expect(alerts(page).join(' ')).toContain('The audio archive is full.'))
    expect(codeField(page).exists()).toBe(false)
  })
})
