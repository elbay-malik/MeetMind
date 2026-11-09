import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingPage from '~/pages/meetings/[id]/index.vue'
import MeetingQuestions from '~/components/MeetingQuestions.vue'
import { DEMO_GUIDE_HEAD_SCRIPT, DEMO_GUIDE_HIDDEN_CLASS, DEMO_GUIDE_KEY, DEMO_QUESTION_PLACEHOLDER, DEMO_SAMPLE_QUESTIONS, guideDismissed, rememberGuideDismissed } from '~/utils/demo-guide'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

mockNuxtImport('useRoute', () => () => ({ params: { id: ID }, query: {}, path: `/meetings/${ID}`, fullPath: `/meetings/${ID}` }))

registerEndpoint(`/api/meetings/${ID}`, () => ({
  meeting: {
    id: ID,
    title: 'Booking outage review',
    status: 'ready',
    failedStage: null,
    sourceFileName: 'review.m4a',
    sourceBytes: 1,
    sourceMime: 'audio/mp4',
    audioBytes: 1,
    durationSec: 10,
    createdAt: '2026-11-01T00:00:00.000Z',
  },
}))
registerEndpoint(`/api/meetings/${ID}/transcript`, () => ({ segments: [{ idx: 0, startMs: 0, endMs: 1000, text: 'The flag changed.' }] }))
registerEndpoint(`/api/meetings/${ID}/summary`, () => ({ summary: null }))
registerEndpoint(`/api/meetings/${ID}/search-index`, () => ({
  index: { state: 'ready', windowCount: 1, indexedCount: 1, model: 'stub' },
}))
const asked = vi.fn()
registerEndpoint(`/api/meetings/${ID}/ask`, {
  method: 'POST',
  handler: () => {
    asked()
    return {}
  },
})

let lastPage: Awaited<ReturnType<typeof mountSuspended>> | null = null

async function open({ demo = true } = {}) {
  useRuntimeConfig().public.demoMeetingId = demo ? ID : ''
  lastPage?.unmount()
  clearNuxtData()
  const page = await mountSuspended(MeetingPage, { attachTo: document.body })
  lastPage = page
  await flushPromises()
  return page
}

const card = () => document.querySelector('[data-testid="demo-guide"]')
const buttonIn = (root: ParentNode | null, text: string) =>
  [...(root?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === text) as HTMLButtonElement | undefined

/** A reload: nothing kept from the last page but what storage holds. */
function newVisit() {
  useState('demo-guide-open').value = true
  useState('demo-guide-closed').value = false
}

beforeEach(() => {
  localStorage.clear()
  newVisit()
  asked.mockClear()
})
afterEach(() => {
  lastPage?.unmount()
  lastPage = null
  useRuntimeConfig().public.demoMeetingId = ''
})

describe('the demo guide', () => {
  it('shows on a first visit to the demo, without taking focus', async () => {
    const before = document.activeElement
    await open()
    expect(card()?.textContent).toContain('Try this')
    expect(card()?.textContent).toContain('needs an invite code')
    expect(card()?.getAttribute('aria-labelledby')).toBe('demo-guide-title')
    expect(card()?.getAttribute('role')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it('is not on any other meeting, and neither is its button', async () => {
    const page = await open({ demo: false })
    expect(card()).toBeNull()
    expect(page.text()).not.toContain('Guide')
  })

  it('closes for this visit, and stores nothing', async () => {
    await open()
    buttonIn(card(), 'Close')!.click()
    await flushPromises()
    expect(card()).toBeNull()
    expect(localStorage.getItem(DEMO_GUIDE_KEY)).toBeNull()

    await open()
    expect(card()).toBeNull()

    newVisit()
    await open()
    expect(card()).not.toBeNull()
  })

  it('closes on Esc', async () => {
    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(card()).toBeNull()
  })

  it('stays away on later visits once told not to show again', async () => {
    await open()
    buttonIn(card(), 'Don\'t show again')!.click()
    await flushPromises()
    expect(card()).toBeNull()
    expect(localStorage.getItem(DEMO_GUIDE_KEY)).toBe('dismissed')

    newVisit()
    await open()
    expect(card()).toBeNull()
  })

  it('reopens from the Guide button, which says whether it is open', async () => {
    localStorage.setItem(DEMO_GUIDE_KEY, 'dismissed')
    const page = await open()
    const guide = buttonIn(page.element, 'Guide')!
    expect(guide.getAttribute('aria-expanded')).toBe('false')
    guide.click()
    await flushPromises()
    expect(card()).not.toBeNull()
    expect(guide.getAttribute('aria-expanded')).toBe('true')
    expect(guide.getAttribute('aria-controls')).toBe(card()!.id)
    // Asked for, so focus goes to it, and the head script's hiding is undone.
    expect(document.activeElement).toBe(document.getElementById('demo-guide-title'))
    expect(document.documentElement.classList.contains(DEMO_GUIDE_HIDDEN_CLASS)).toBe(false)
  })

  it('has a head script that hides it before the first paint once dismissed, and never throws', () => {
    const run = new Function(DEMO_GUIDE_HEAD_SCRIPT)
    run()
    expect(document.documentElement.classList.contains(DEMO_GUIDE_HIDDEN_CLASS)).toBe(false)
    localStorage.setItem(DEMO_GUIDE_KEY, 'dismissed')
    run()
    expect(document.documentElement.classList.contains(DEMO_GUIDE_HIDDEN_CLASS)).toBe(true)
    document.documentElement.classList.remove(DEMO_GUIDE_HIDDEN_CLASS)
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(run).not.toThrow()
    vi.restoreAllMocks()
  })

  it('gives focus back to the Guide button when closed from inside', async () => {
    const page = await open()
    const close = buttonIn(card(), 'Close')!
    close.focus()
    close.click()
    await flushPromises()
    expect(document.activeElement).toBe(buttonIn(page.element, 'Guide'))
  })
})

describe('the guide\'s storage', () => {
  it('reads blocked storage as not dismissed and does not throw writing to it', () => {
    const refuse = () => {
      throw new Error('blocked')
    }
    const blocked = { getItem: refuse, setItem: refuse }
    expect(guideDismissed(blocked)).toBe(false)
    expect(() => rememberGuideDismissed(blocked)).not.toThrow()
    expect(guideDismissed(null)).toBe(false)
  })
})

describe('sample questions on the demo', () => {
  it('fill the field and send nothing', async () => {
    useRuntimeConfig().public.demoMeetingId = ID
    const wrapper = await mountSuspended(MeetingQuestions, { props: { meetingId: ID } })
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe(DEMO_QUESTION_PLACEHOLDER)
    const sample = wrapper.findAll('button').find(button => button.text() === DEMO_SAMPLE_QUESTIONS[0])!
    await sample.trigger('click')
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe(DEMO_SAMPLE_QUESTIONS[0])
    expect(asked).not.toHaveBeenCalled()
  })

  it('are not offered on other meetings', async () => {
    const wrapper = await mountSuspended(MeetingQuestions, { props: { meetingId: ID } })
    expect(wrapper.text()).not.toContain(DEMO_SAMPLE_QUESTIONS[0])
    expect(wrapper.find('input').attributes('placeholder')).not.toBe(DEMO_QUESTION_PLACEHOLDER)
  })
})
