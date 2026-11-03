import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ProgressPage from '~/pages/meetings/[id]/progress.vue'
import type { Meeting, PipelineResponse } from '../../shared/types/meeting'
import { DEMO_READ_ONLY_MESSAGE } from '../../shared/utils/meeting'

/** A stored error, which the routes a page reads for the driver never carry and it never shows. */
const RAW = 'PGRST116 relation "pipeline_runs" does not exist'

const meetingRow = (id: string, patch: Partial<Meeting>) => ({
  id,
  title: 'Weekly sync',
  status: 'uploaded',
  sourceFileName: 'sync.mp4',
  sourceBytes: 1_000,
  sourceMime: 'video/mp4',
  durationSec: 60,
  audioKey: `meetings/${id}/audio.ogg`,
  audioBytes: 1_000,
  failedStage: null,
  errorMessage: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...patch,
}) as unknown as Meeting

function answer(patch: Partial<PipelineResponse> = {}): PipelineResponse {
  return {
    status: 'uploaded',
    progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null },
    index: { state: 'unavailable', done: 0, total: null, retryAt: null },
    next: 'continue',
    retryAt: null,
    retryAfterMs: null,
    ...patch,
  }
}

const READY = answer({
  status: 'ready',
  progress: { stage: 'search_index', done: 12, total: 12, etaSeconds: null },
  index: { state: 'complete', done: 12, total: 12, retryAt: null },
  next: 'done',
})

interface Reply { status?: number, body: unknown }
type Handler = { node: { res: { statusCode: number, setHeader: (name: string, value: string) => void } } }

interface Scenario {
  row?: Partial<Meeting>
  /** Each request takes the next. The last one stands for ever. A function answers as of then. */
  pipeline?: Array<Reply | (() => Reply)>
  advance?: Reply[]
  searchIndex?: Reply[]
  /** Whatever the transcript route answers. */
  segments?: unknown[]
  /** Whether that read of the row, counting from 1, answers 500. */
  rowFails?: (read: number) => boolean
  /** The same for the transcript. */
  transcriptFails?: (read: number) => boolean
}

let scenarios = 0

/**
 * Stands up one meeting's routes and counts what the page sends them. Each test has its own id,
 * because the routes registered here are not undone between tests.
 */
function aMeeting(scenario: Scenario) {
  scenarios++
  const id = `9b1deb4d-3b7d-4bad-9bdd-${String(scenarios).padStart(12, '0')}`
  const sent = { pipeline: 0, advance: 0, searchIndex: 0 }
  const row = { ...scenario.row }
  const take = (kind: keyof typeof sent, replies: Array<Reply | (() => Reply)> | undefined, event: Handler) => {
    sent[kind]++
    if (!replies?.length) throw new Error(`nothing scripted for ${kind}`)
    const next = replies.length > 1 ? replies.shift()! : replies[0]!
    const reply = typeof next === 'function' ? next() : next
    event.node.res.statusCode = reply.status ?? 200
    return reply.body
  }
  const reads = { row: 0, transcript: 0 }
  const failed = (event: Handler) => {
    event.node.res.statusCode = 500
    return { statusCode: 500, statusMessage: 'Internal Server Error' }
  }
  registerEndpoint(`/api/meetings/${id}`, (event: Handler) =>
    scenario.rowFails?.(++reads.row) ? failed(event) : { meeting: meetingRow(id, row) })
  registerEndpoint(`/api/meetings/${id}/transcript`, (event: Handler) =>
    scenario.transcriptFails?.(++reads.transcript) ? failed(event) : { segments: scenario.segments ?? [] })
  registerEndpoint(`/api/meetings/${id}/pipeline`, (event: Handler) => take('pipeline', scenario.pipeline, event))
  registerEndpoint(`/api/meetings/${id}/advance`, { method: 'POST', handler: (event: Handler) => take('advance', scenario.advance, event) })
  registerEndpoint(`/api/meetings/${id}/search-index`, { method: 'POST', handler: (event: Handler) => take('searchIndex', scenario.searchIndex, event) })
  return { id, sent, row }
}

const ok = (body: unknown): Reply => ({ body })
const DEMO_REFUSAL: Reply = { status: 403, body: { statusCode: 403, statusMessage: 'Forbidden', message: DEMO_READ_ONLY_MESSAGE } }

const mountAt = (id: string) => mountSuspended(ProgressPage, { route: `/meetings/${id}/progress` })
type Mounted = Awaited<ReturnType<typeof mountAt>>
const mounted: Mounted[] = []

async function open(id: string): Promise<Mounted> {
  const page = await mountAt(id)
  mounted.push(page)
  await flushPromises()
  return page
}

afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount()
  useRuntimeConfig().public.demoMeetingId = ''
})

const buttons = (page: Mounted) => page.findAll('button').map(button => button.text())
const links = (page: Mounted) => page.findAll('a').map(link => link.text())
const announced = (page: Mounted) => page.findAll('[role="status"]').map(region => region.text()).join(' | ')

const SPOKEN = [{ idx: 0, startMs: 0, endMs: 1_000, text: 'We ship on Friday.' }]
const SUMMARIZING = answer({ status: 'summarizing', progress: { stage: 'summarization', done: 0, total: 1, etaSeconds: null } })

/** Long enough for a read the status set off, and the one retry `useFetch` makes of it, to be over. */
const readsSettled = () => new Promise(resolve => setTimeout(resolve, 300))

describe('a meeting deleted while the page drives it', () => {
  it('stops showing work, its status, and a way to a page that is gone', async () => {
    const { id } = aMeeting({ row: { status: 'summarizing' }, pipeline: [ok(SUMMARIZING)], advance: [{ status: 404, body: {} }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('This meeting no longer exists'))

    expect(page.text()).not.toContain('In progress')
    expect(page.findAll('.animate-spin')).toEqual([])
    expect(page.text().toLowerCase()).not.toContain('summarizing')
    expect(links(page)).not.toContain('Transcript & player')
    expect(links(page)).toContain('Upload another')
  })

  it('does not go on waiting for an upload', async () => {
    const { id } = aMeeting({ row: { status: 'pending_upload' }, pipeline: [{ status: 404, body: {} }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('This meeting no longer exists'))
    expect(page.text()).not.toContain('Waiting for audio')
  })
})

describe('a 403 from something in front of the app', () => {
  it('does not call an ordinary meeting the demo, or give up on it', async () => {
    const { id, sent } = aMeeting({ pipeline: [ok(answer())], advance: [{ status: 403, body: { message: 'Blocked by a rule' } }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('The server hit a problem'))

    expect(page.text()).not.toMatch(/demo/i)
    expect(sent.advance).toBe(1)
  })
})

describe('a read of the row or the transcript that fails', () => {
  it('keeps the transcript it has, and says nothing about speech, when the status moves', async () => {
    const { id } = aMeeting({
      row: { status: 'transcribing' },
      segments: SPOKEN,
      transcriptFails: read => read > 1,
      pipeline: [ok(answer({ status: 'transcribing' }))],
      advance: [ok(SUMMARIZING), ok(READY)],
    })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))
    await readsSettled()

    expect(page.text()).toContain('Speech turned into timestamped segments.')
    expect(page.text()).toContain('We ship on Friday.')
    expect(page.text()).not.toContain('No speech was found')
    expect(page.text()).not.toContain('found no speech')
  })

  it('says nothing about speech when the first read of the transcript failed', async () => {
    const { id } = aMeeting({ row: { status: 'ready' }, transcriptFails: () => true, pipeline: [ok(READY)] })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))

    expect(page.text()).not.toContain('No speech was found')
    expect(page.text()).not.toContain('found no speech')
  })

  it('knows the size again once a later read comes back', async () => {
    const { id } = aMeeting({
      row: { status: 'transcribing' },
      segments: SPOKEN,
      // The first read, then the failure and the retry `useFetch` makes of it.
      transcriptFails: read => read === 2 || read === 3,
      pipeline: [ok(answer({ status: 'transcribing' }))],
      advance: [ok(SUMMARIZING), ok(READY)],
    })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('1 segment.'))
  })

  it('goes on rendering what the driver says when the row cannot be read again', async () => {
    const { id } = aMeeting({
      row: { status: 'uploaded' },
      rowFails: read => read > 1,
      pipeline: [ok(answer())],
      // A wait, so that what comes next arrives after that read has failed.
      advance: [ok(answer({ status: 'transcribing', next: 'wait', retryAfterMs: 1_000 })), ok(READY)],
    })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'), { timeout: 5_000 })
    await readsSettled()

    expect(page.text()).toContain('Weekly sync')
    expect(page.text()).toContain('Ready for questions')
  })
})

describe('opening the page', () => {
  it('drives the meeting to the end with no click, in the one live region', async () => {
    const { id, sent } = aMeeting({
      pipeline: [ok(answer())],
      advance: [
        ok(answer({ status: 'transcribing', progress: { stage: 'transcription', done: 0, total: 900, etaSeconds: null } })),
        ok(answer({ status: 'summarizing', progress: { stage: 'summarization', done: 0, total: 1, etaSeconds: null } })),
        ok(answer({ status: 'indexing', progress: { stage: 'summarization', done: 1, total: 1, etaSeconds: null } })),
        ok(READY),
      ],
    })
    const page = await open(id)

    await vi.waitFor(() => expect(announced(page)).toContain('Finished. This meeting can be read and asked questions.'))
    expect(sent.advance).toBe(4)
    expect(sent.searchIndex).toBe(0)
    expect(links(page)).toContain('Ask on the meeting page')
    expect(page.text()).toContain('Ready for questions: all 12 passages indexed.')
    expect(page.find('[role="alert"]').exists()).toBe(false)
  })

  it.each(['Start transcription', 'Extract decisions', 'Index for questions', 'Resume', 'Try'])('offers no %s button', async (label) => {
    const { id } = aMeeting({ pipeline: [ok(answer())], advance: [ok(READY)] })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))
    expect(buttons(page).filter(text => text.includes(label))).toEqual([])
  })

  it('sends no step for a meeting that is finished', async () => {
    const { id, sent } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(READY)] })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))
    expect(sent.advance).toBe(0)
    expect(links(page)).toContain('Ask on the meeting page')
    expect(links(page)).toContain('Transcript & player')
  })

  it('renders with the first answer before the driver has done anything', async () => {
    const { id } = aMeeting({
      row: { status: 'indexing' },
      pipeline: [ok(answer({ status: 'indexing', next: 'wait', retryAfterMs: 60_000, retryAt: new Date(Date.now() + 60_000).toISOString(), progress: { stage: 'summarization', done: 3, total: 9, etaSeconds: null } }))],
      advance: [ok(READY)],
    })
    const page = await open(id)
    expect(page.text()).toContain('3 of 9 parts done.')
    expect(page.text()).toContain('Audio uploaded')
    expect(page.text()).toContain('Indexed for questions')
  })

  it('stops asking when the page goes away', async () => {
    const waiting = answer({ next: 'wait', retryAfterMs: 50, retryAt: new Date(Date.now() + 50).toISOString() })
    const { id, sent } = aMeeting({ pipeline: [ok(answer())], advance: [ok(waiting)] })
    const page = await open(id)
    await vi.waitFor(() => expect(sent.advance).toBe(1))
    page.unmount()
    mounted.splice(0)
    const after = sent.advance + sent.pipeline
    await new Promise(resolve => setTimeout(resolve, 3_100))
    expect(sent.advance + sent.pipeline).toBe(after)
  }, 8_000)

  it('stops asking at pagehide, and takes part again at a pageshow from the back-forward cache', async () => {
    const waiting = answer({ next: 'wait', retryAfterMs: 50, retryAt: new Date(Date.now() + 50).toISOString() })
    const { id, sent } = aMeeting({ pipeline: [ok(answer())], advance: [ok(waiting)] })
    await open(id)
    await vi.waitFor(() => expect(sent.advance).toBe(1))
    window.dispatchEvent(new Event('pagehide'))
    const after = sent.advance + sent.pipeline
    await new Promise(resolve => setTimeout(resolve, 3_100))
    expect(sent.advance + sent.pipeline).toBe(after)

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    await vi.waitFor(() => expect(sent.advance + sent.pipeline).toBeGreaterThan(after))
  }, 8_000)

  it('leaves no tick running when it goes', async () => {
    const started = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    const waiting = answer({ next: 'wait', retryAfterMs: 60_000, retryAt: new Date(Date.now() + 60_000).toISOString() })
    const { id } = aMeeting({ pipeline: [ok(answer())], advance: [ok(waiting)] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('Next request in'))
    const ticks = started.mock.results.filter((_, i) => started.mock.calls[i]![1] === 1_000).map(result => result.value)
    expect(ticks.length).toBeGreaterThan(0)

    page.unmount()
    mounted.splice(0)
    const gone = cleared.mock.calls.map(([timer]) => timer)
    expect(ticks.filter(tick => !gone.includes(tick))).toEqual([])
    vi.restoreAllMocks()
  })

  it('leaves no listener behind when it goes', async () => {
    const added = [vi.spyOn(window, 'addEventListener'), vi.spyOn(document, 'addEventListener')]
    const removed = [vi.spyOn(window, 'removeEventListener'), vi.spyOn(document, 'removeEventListener')]
    const heard = (spies: typeof added) => spies
      .flatMap(spy => spy.mock.calls)
      .filter(([name]) => ['pagehide', 'pageshow', 'online', 'visibilitychange'].includes(name))
    const { id } = aMeeting({ pipeline: [ok(READY)] })
    const page = await open(id)
    const listening = heard(added)
    expect(listening.map(([name]) => name).sort()).toEqual(['online', 'pagehide', 'pageshow', 'visibilitychange'])

    page.unmount()
    mounted.splice(0)
    const left = listening.filter(([name, handler]) => !heard(removed).some(call => call[0] === name && call[1] === handler))
    expect(left.map(([name]) => name)).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('a wait', () => {
  it('shows the countdown on the screen and keeps it out of the live region', async () => {
    const waiting = answer({ status: 'transcribing', next: 'wait', retryAfterMs: 90_000, retryAt: new Date(Date.now() + 90_000).toISOString() })
    const { id } = aMeeting({ pipeline: [ok(answer())], advance: [ok(waiting)] })
    const page = await open(id)

    await vi.waitFor(() => expect(page.text()).toMatch(/Next request in \d/))
    expect(announced(page)).toContain('Transcribing')
    expect(announced(page)).not.toMatch(/Next request|\bin \d/)
  })

  it('says a provider\'s block plainly, in hours, in a banner, and does not ask again yet', async () => {
    const ms = 3 * 60 * 60_000
    const blocked = answer({ status: 'transcribing', next: 'wait', retryAfterMs: ms, retryAt: new Date(Date.now() + ms).toISOString() })
    const { id, sent } = aMeeting({ pipeline: [ok(answer())], advance: [ok(blocked)] })
    const page = await open(id)

    await vi.waitFor(() => expect(page.text()).toContain('Paused: waiting for the provider'))
    expect(page.text()).toMatch(/It carries on by itself in (3 hours|2 hours 59 minutes)/)
    expect(page.text()).toContain('quota is used up for now')
    expect(page.text()).toContain('Paused')
    expect(announced(page)).not.toMatch(/\d/)
    expect(sent.advance).toBe(1)
  })

  it('invents no estimate for how long the work will take', async () => {
    const { id } = aMeeting({
      pipeline: [ok(answer({ status: 'indexing', progress: { stage: 'summarization', done: 3, total: 9, etaSeconds: null } }))],
      advance: [ok(answer({ status: 'indexing', progress: { stage: 'summarization', done: 4, total: 9, etaSeconds: null } })), ok(READY)],
    })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))
    expect(page.text()).not.toMatch(/remaining|estimated|\beta\b/i)
  })
})

describe('a failure', () => {
  const failedRow = (patch: Partial<Meeting>) => ({ status: 'failed', errorMessage: RAW, ...patch }) as Partial<Meeting>

  it('stops, in the page\'s own words, shows no stored error, and offers no retry before its time', async () => {
    const ms = 60_000
    const failed = answer({ status: 'failed', next: 'failed', retryAfterMs: ms, retryAt: new Date(Date.now() + ms).toISOString() })
    const { id, sent } = aMeeting({ row: failedRow({ failedStage: 'transcription' }), pipeline: [ok(failed)] })
    const page = await open(id)

    await vi.waitFor(() => expect(page.text()).toMatch(/You can try again in \d+ seconds|You can try again in 1 minute/))
    expect(page.find('[role="alert"]').text()).toContain('Transcription did not finish')
    expect(page.html()).not.toContain('PGRST')
    expect(buttons(page).filter(text => text.includes('again'))).toEqual([])
    expect(sent.advance).toBe(0)
  })

  it('offers the retry once it can do something, and only a click spends it', async () => {
    const offered = answer({ status: 'failed', next: 'continue' })
    const { id, sent } = aMeeting({ row: failedRow({ failedStage: 'transcription' }), pipeline: [ok(offered)], advance: [ok(READY)] })
    const page = await open(id)

    await vi.waitFor(() => expect(buttons(page)).toContain('Try transcription again'))
    expect(sent.advance).toBe(0)
    expect(announced(page)).toContain('You can try again now.')

    await page.findAll('button').find(button => button.text() === 'Try transcription again')!.trigger('click')
    await vi.waitFor(() => expect(sent.advance).toBe(1))
    await vi.waitFor(() => expect(announced(page)).toContain('Finished'))
    expect(buttons(page)).not.toContain('Try transcription again')
  })

  it('keeps the stored error out of what the server\'s render sends to the browser', async () => {
    const { id } = aMeeting({
      row: { status: 'failed', failedStage: 'transcription', errorMessage: RAW },
      pipeline: [ok(answer({ status: 'failed', next: 'failed' }))],
    })
    await open(id)
    expect(JSON.stringify(useNuxtApp().payload.data)).not.toContain('PGRST116')
  })

  it('names extraction when that is what a retry would do', async () => {
    const offered = answer({ status: 'failed', next: 'continue', progress: { stage: 'summarization', done: 2, total: 9, etaSeconds: null }, index: { state: 'complete', done: 3, total: 3, retryAt: null } })
    const { id } = aMeeting({ row: failedRow({ failedStage: 'summarization' }), pipeline: [ok(offered)] })
    const page = await open(id)
    await vi.waitFor(() => expect(buttons(page)).toContain('Try extraction again'))
    expect(page.find('[role="alert"]').text()).toContain('Extraction did not finish')
    expect(page.text()).toContain('2 of 9 parts done')
  })

  it.each<[string, Partial<Meeting>, PipelineResponse['progress']['stage'], RegExp]>([
    ['a rejected upload', { failedStage: 'upload' }, 'upload', /rejected and removed/],
    ['audio missing or changed', { failedStage: 'transcription' }, 'transcription', /missing or has changed/],
    ['a transcript over the limit', { failedStage: 'summarization' }, 'summarization', /too long/],
  ])('offers no retry at all for %s, which could only fail', async (_name, row, stage, words) => {
    const forGood = answer({ status: 'failed', next: 'failed', progress: { stage, done: 0, total: null, etaSeconds: null } })
    const { id, sent } = aMeeting({ row: failedRow(row), pipeline: [ok(forGood)] })
    const page = await open(id)

    await vi.waitFor(() => expect(page.find('[role="alert"]').text()).toMatch(words))
    expect(page.html()).not.toContain('PGRST')
    expect(buttons(page).filter(text => /again|retry|resume/i.test(text))).toEqual([])
    expect(page.text()).not.toMatch(/You can try again/)
    expect(sent.advance).toBe(0)
  })

  it('goes on building the index past a failed extraction, and says both', async () => {
    const building = (done: number) => answer({ status: 'failed', next: 'continue', progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null }, index: { state: 'building', done, total: null, retryAt: null } })
    const failed = answer({ status: 'failed', next: 'failed', retryAfterMs: 60_000, retryAt: new Date(Date.now() + 60_000).toISOString(), progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null }, index: { state: 'complete', done: 3, total: 3, retryAt: null } })
    const { id, sent } = aMeeting({ row: failedRow({ failedStage: 'summarization' }), pipeline: [ok(building(0))], advance: [ok(building(3)), ok(failed)] })
    const page = await open(id)
    await vi.waitFor(() => expect(sent.advance).toBe(2))
    await vi.waitFor(() => expect(page.find('[role="alert"]').text()).toContain('Extraction did not finish'))
    expect(links(page)).toContain('Ask on the meeting page')
  })
})

describe('an index that is not complete', () => {
  const parked = (at: string) => answer({
    status: 'ready',
    next: 'done',
    retryAt: at,
    retryAfterMs: Math.max(0, Date.parse(at) - Date.now()),
    progress: { stage: 'search_index', done: 8, total: null, etaSeconds: null },
    index: { state: 'parked', done: 8, total: null, retryAt: at },
  })
  const nextMidnight = () => new Date((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000).toISOString()

  it('says a parked index plainly, still leads onward to the meeting, and sends nothing', async () => {
    const { id, sent } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(parked(nextMidnight()))] })
    const page = await open(id)

    await vi.waitFor(() => expect(announced(page)).toContain('Finished for now'))
    expect(page.text()).toContain('The free daily limit for indexing has been reached')
    expect(page.text()).toContain('questions stay off')
    expect(links(page)).toContain('Read the meeting')
    expect(links(page)).not.toContain('Ask on the meeting page')
    expect(sent.advance + sent.searchIndex).toBe(0)
  })

  it('does not offer the explicit route for a park, which would answer wait for up to 15 minutes', async () => {
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(parked(new Date(Date.now() + 15 * 60_000).toISOString()))] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toMatch(/Indexing can carry on in (15 minutes|14 minutes)/))
    expect(page.text()).toContain('kept stopping')
    expect(buttons(page).filter(text => /index/i.test(text))).toEqual([])
  })

  it('carries on through /advance once the park is over, at a click', async () => {
    const moving = answer({ status: 'ready', next: 'continue', index: { state: 'building', done: 8, total: null, retryAt: null } })
    const parkUntil = new Date(Date.now() + 400).toISOString()
    let clicked = false
    const { id, sent } = aMeeting({ row: { status: 'ready' }, pipeline: [() => ok(clicked ? moving : parked(parkUntil))], advance: [ok(READY)] })
    const page = await open(id)
    await vi.waitFor(() => expect(buttons(page)).toContain('Carry on indexing'), { timeout: 3_000 })
    expect(sent.advance).toBe(0)

    clicked = true
    await page.findAll('button').find(button => button.text() === 'Carry on indexing')!.trigger('click')
    await vi.waitFor(() => expect(sent.advance).toBe(1))
    expect(sent.searchIndex).toBe(0)
  }, 6_000)

  it('says a held index plainly, leads onward, and sends nothing by itself', async () => {
    const held = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
    const { id, sent } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(held)], searchIndex: [ok({ index: {} })] })
    const page = await open(id)

    await vi.waitFor(() => expect(announced(page)).toContain('until its index is rebuilt'))
    expect(page.text()).toContain('another embedding model or an older transcript')
    expect(links(page)).toContain('Read the meeting')
    expect(buttons(page)).toContain('Rebuild the index')
    expect(sent.searchIndex + sent.advance).toBe(0)
  })

  it('says a stopped index plainly, and offers to try', async () => {
    const stopped = answer({ status: 'ready', next: 'done', index: { state: 'stopped', done: 4, total: null, retryAt: null } })
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(stopped)] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('will not be tried again by itself'))
    expect(buttons(page)).toContain('Try indexing again')
    expect(links(page)).toContain('Read the meeting')
  })

  describe('rebuilding it', () => {
    const MESSAGE = 'The free daily limit for indexing and questions has been reached. It resets at 00:00 UTC. '
      + 'Passages indexed so far are kept; indexing again resumes from there.'
    const held = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
    const rebuild = async (page: Mounted) =>
      page.findAll('button').find(button => button.text() === 'Rebuild the index')!.trigger('click')

    // Shaped as the route answers: tests/e2e/embedding-quota.spec.ts holds it to this.
    it('says the provider\'s daily limit in plain words, and keeps the way to try again', async () => {
      const { id, sent } = aMeeting({
        row: { status: 'ready' },
        pipeline: [ok(held)],
        searchIndex: [{ status: 429, body: { error: true, statusCode: 429, statusMessage: 'Indexing failed', message: MESSAGE } }],
      })
      const page = await open(id)
      await vi.waitFor(() => expect(buttons(page)).toContain('Rebuild the index'))
      await rebuild(page)

      await vi.waitFor(() => expect(page.find('[role="alert"]').exists()).toBe(true))
      expect(page.find('[role="alert"]').text()).toContain(MESSAGE)
      await vi.waitFor(() => expect(buttons(page)).toContain('Rebuild the index'))
      expect(sent.searchIndex).toBe(1)
    })

    it('does not pass on what is not that route\'s own sentence', async () => {
      const { id } = aMeeting({
        row: { status: 'ready' },
        pipeline: [ok(held)],
        searchIndex: [{ status: 500, body: { error: true, statusCode: 500, statusMessage: 'Server Error', message: RAW } }],
      })
      const page = await open(id)
      await vi.waitFor(() => expect(buttons(page)).toContain('Rebuild the index'))
      await rebuild(page)
      await vi.waitFor(() => expect(page.find('[role="alert"]').text()).toContain('could not be rebuilt'))
      expect(page.html()).not.toContain('PGRST')
    })

    // Shaped as the route answers: tests/e2e/search-index-api.spec.ts holds it to this.
    it('asks again until the index is finished, says how far it has got, and announces the end', async () => {
      const steps = (done: number) => ({ status: 202, body: { progress: { done, total: null, lastError: null }, next: 'continue', retryAt: null, retryAfterMs: null } })
      const finished = ok({ index: { state: 'ready', windowCount: 40, indexedCount: 40, model: 'stub' } })
      const scenario = aMeeting({
        row: { status: 'ready' },
        pipeline: [() => ok(scenario.sent.searchIndex >= 3 ? READY : held)],
        searchIndex: [steps(16), steps(32), finished],
      })
      const { id, sent } = scenario
      const page = await open(id)
      await vi.waitFor(() => expect(buttons(page)).toContain('Rebuild the index'))
      await rebuild(page)

      await vi.waitFor(() => expect(announced(page)).toContain('Finished. This meeting can be read and asked questions.'))
      expect(sent.searchIndex).toBe(3)
      expect(sent.advance).toBe(0)
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(links(page)).toContain('Ask on the meeting page')
    })
  })

  it('says it could not check, rather than blame a transcription that has finished, when nothing can be read', async () => {
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [{ status: 500, body: { error: true, statusCode: 500, message: RAW } }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('The server hit a problem'))
    expect(page.text()).toContain('Could not check whether this meeting can be asked questions')
    expect(page.text()).not.toContain('Available once transcription has finished')
    expect(page.html()).not.toContain('PGRST')
  })
})

describe('the public demo', () => {
  const asDemo = (id: string) => {
    useRuntimeConfig().public.demoMeetingId = id
  }

  it('never asks for a step, and shows an unfinished demo as read-only', async () => {
    const unfinished = answer({ status: 'uploaded', next: 'wait' })
    const { id, sent } = aMeeting({ pipeline: [ok(unfinished)], advance: [DEMO_REFUSAL], searchIndex: [DEMO_REFUSAL] })
    asDemo(id)
    const page = await open(id)

    await new Promise(resolve => setTimeout(resolve, 300))
    await flushPromises()
    expect(sent.advance + sent.searchIndex).toBe(0)
    expect(page.text()).toContain('This demo meeting is read-only')
    expect(announced(page)).toContain('public demo')
    expect(buttons(page).filter(text => /again|retry|resume|index|start/i.test(text))).toEqual([])
    expect(page.text()).not.toContain('This page is doing the work')
    expect(page.text()).not.toContain('Next request')
  })

  it('finds its id however it is written, as the server does', async () => {
    const { id, sent } = aMeeting({ pipeline: [ok(READY)] })
    useRuntimeConfig().public.demoMeetingId = ` ${id.toUpperCase()}\n`
    const page = await open(id)
    await flushPromises()
    expect(announced(page)).toContain('public demo')
    expect(sent.advance).toBe(0)
  })

  it('shows a finished demo with nothing over it, and leads onward to asking', async () => {
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(READY)] })
    asDemo(id)
    const page = await open(id)
    await flushPromises()
    expect(page.text()).not.toContain('This demo meeting is read-only')
    expect(links(page)).toContain('Ask on the meeting page')
  })

  it('offers no retry and repeats no stored error on a failed one', async () => {
    const failed = answer({ status: 'failed', next: 'failed', progress: { stage: 'summarization', done: 0, total: null, etaSeconds: null } })
    const { id } = aMeeting({ row: { status: 'failed', failedStage: 'summarization', errorMessage: RAW }, pipeline: [ok(failed)] })
    asDemo(id)
    const page = await open(id)
    await flushPromises()
    expect(page.html()).not.toContain('PGRST')
    expect(page.text()).toContain('This demo meeting is read-only')
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(buttons(page).filter(text => /again/i.test(text))).toEqual([])
  })

  it('offers no rebuild of a held index', async () => {
    const held = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(held)] })
    asDemo(id)
    const page = await open(id)
    await flushPromises()
    expect(buttons(page)).not.toContain('Rebuild the index')
  })

  it('goes read-only when the server says so before the page knew', async () => {
    const { id, sent } = aMeeting({ pipeline: [ok(answer()), ok(answer()), ok(answer({ next: 'wait' }))], advance: [DEMO_REFUSAL] })
    const page = await open(id)
    await vi.waitFor(() => expect(sent.advance).toBe(1))
    await vi.waitFor(() => expect(page.text()).toContain('This demo meeting is read-only'))
    expect(sent.advance).toBe(1)
  })
})

describe('a meeting with no audio yet', () => {
  it('sends no step, which could only answer 409, and says what it is waiting for', async () => {
    const pending = answer({ status: 'pending_upload', next: 'wait', progress: { stage: 'upload', done: 0, total: null, etaSeconds: null } })
    const { id, sent } = aMeeting({ row: { status: 'pending_upload' }, pipeline: [ok(pending)], advance: [{ status: 409, body: {} }] })
    const page = await open(id)
    await vi.waitFor(() => expect(announced(page)).toContain('Waiting for the upload to be confirmed.'))
    expect(page.text()).toContain('Waiting for audio')
    expect(sent.advance).toBe(0)
  })

  it('does not say this page is doing work that no page can do', async () => {
    const pending = answer({ status: 'pending_upload', next: 'wait', progress: { stage: 'upload', done: 0, total: null, etaSeconds: null } })
    const { id, sent } = aMeeting({ row: { status: 'pending_upload' }, pipeline: [ok(pending)] })
    const page = await open(id)
    // The driver's own read, after the page's: it is only then that it is driving.
    await vi.waitFor(() => expect(sent.pipeline).toBe(2))
    await readsSettled()
    expect(announced(page)).toContain('Waiting for the upload to be confirmed.')
    expect(page.text()).not.toContain('is doing the work')
  })
})

describe('trouble that is not the meeting', () => {
  const GATE = 'MeetMind is not available at the moment. Try again later.'

  it('answers the gate\'s 503 with a plain banner, backs off and shows no failure', async () => {
    const { id, sent } = aMeeting({ pipeline: [ok(answer())], advance: [{ status: 503, body: { statusCode: 503, message: GATE } }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('MeetMind is not available at the moment'))
    expect(page.text()).toMatch(/not a failure of the meeting/)
    expect(page.text()).toMatch(/Trying again in \d+ seconds/)
    expect(page.find('[role="alert"]').exists()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sent.advance).toBe(1)
  })

  it('answers a 500 the same way, with none of its words', async () => {
    const { id } = aMeeting({ pipeline: [ok(answer())], advance: [{ status: 500, body: { statusCode: 500, message: RAW } }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('The server hit a problem'))
    expect(page.html()).not.toContain('PGRST')
  })

  it('says a meeting deleted while it was open is gone', async () => {
    const { id } = aMeeting({ pipeline: [ok(answer())], advance: [{ status: 404, body: {} }] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('This meeting no longer exists'))
    expect(buttons(page).filter(text => /again/i.test(text))).toEqual([])
  })
})

describe('the transcript on the page', () => {
  it('comes with the status moving past transcription, and says nothing of silence before it is read', async () => {
    const segments = [{ idx: 0, startMs: 0, endMs: 1_000, text: 'Hello there' }]
    const { id } = aMeeting({
      pipeline: [ok(answer())],
      segments,
      advance: [ok(answer({ status: 'summarizing' })), ok(READY)],
    })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('Hello there'))
    await vi.waitFor(() => expect(page.text()).toContain('1 segment.'))
    expect(page.text()).not.toContain('No speech was found')
  })

  it('says a silent recording has no speech, once it has read that', async () => {
    const { id } = aMeeting({ pipeline: [ok(answer())], segments: [], advance: [ok(answer({ status: 'summarizing' })), ok(answer({ ...READY, index: { state: 'complete', done: 0, total: 0, retryAt: null } }))] })
    const page = await open(id)
    await vi.waitFor(() => expect(page.text()).toContain('No speech was found'))
    expect(page.text()).toContain('Nothing to index: the transcript is empty.')
  })
})

describe('the created date', () => {
  it('is in the visitor\'s own terms once mounted, having said a fixed thing until then', async () => {
    const { id } = aMeeting({ row: { status: 'ready' }, pipeline: [ok(READY)] })
    const page = await open(id)
    expect(page.text()).toContain(new Date('2026-11-01T10:00:00.000Z').toLocaleString())
    expect(page.text()).not.toContain('2026-11-01 10:00 UTC')
  })
})
