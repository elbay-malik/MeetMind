import { describe, expect, it } from 'vitest'
import type { PipelineResponse } from '../../shared/types/meeting'
import { PROVIDER_BLOCKED_ERROR } from '../../shared/utils/meeting'
import { LONG_WAIT_MS, initialDriverState, type DriverState } from '../../app/utils/pipeline-driver'
import {
  STAGE_STATE_TEXT,
  announcementOf,
  bannerOf,
  countdownOf,
  failureOf,
  formatClock,
  formatWait,
  questionsOf,
  retryOf,
  stagesOf,
  type PipelineFacts,
} from '../../app/utils/pipeline-view'

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const HOUR = 60 * 60_000

function answer(patch: Partial<PipelineResponse> = {}): PipelineResponse {
  return {
    status: 'transcribing',
    progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null },
    index: { state: 'unavailable', done: 0, total: null, retryAt: null },
    next: 'continue',
    retryAt: null,
    retryAfterMs: null,
    ...patch,
  }
}

const state = (patch: Partial<DriverState> = {}, a: PipelineResponse | null = answer()): DriverState =>
  ({ ...initialDriverState(a), role: 'driving', ...patch })
const facts = (patch: Partial<PipelineFacts> = {}): PipelineFacts =>
  ({ status: 'transcribing', failedStage: null, segmentCount: 3, audioLabel: '1.2 MB', ...patch })
const stage = (s: DriverState, key: string, f = facts()) => stagesOf(s, f).find(entry => entry.key === key)!

const READY: Partial<PipelineResponse> = { status: 'ready', progress: { stage: 'search_index', done: 8, total: 8, etaSeconds: null }, index: { state: 'complete', done: 8, total: 8, retryAt: null }, next: 'done' }
const parkedUntil = (iso: string) => answer({ status: 'ready', next: 'done', retryAt: iso, retryAfterMs: Date.parse(iso) - NOW, progress: { stage: 'search_index', done: 16, total: null, etaSeconds: null }, index: { state: 'parked', done: 16, total: null, retryAt: iso } })
const HELD = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
const STOPPED = answer({ status: 'ready', next: 'done', index: { state: 'stopped', done: 0, total: null, retryAt: null } })

/** A stored error that must never reach a page. */
const RAW = 'PGRST116 relation "pipeline_runs" does not exist, token 0123'

describe('formatWait', () => {
  it.each<[number, string]>([
    [1, '1 second'],
    [999, '1 second'],
    [1_000, '1 second'],
    [42_000, '42 seconds'],
    [60_000, '1 minute'],
    [200_000, '3 minutes 20 seconds'],
    [3_600_000, '1 hour'],
    [7_500_000, '2 hours 5 minutes'],
    [24 * HOUR, '24 hours'],
  ])('%i ms is %s', (ms, words) => {
    expect(formatWait(ms)).toBe(words)
  })

  it('never says nothing, or a negative', () => {
    expect(formatWait(0)).toBe('1 second')
    expect(formatWait(-5_000)).toBe('1 second')
  })
})

describe('formatClock', () => {
  it('says the day too, when it is not today', () => {
    expect(formatClock(NOW + 3 * HOUR, NOW)).not.toMatch(/day/i)
    expect(formatClock(NOW + 48 * HOUR, NOW)).toMatch(/day/i)
  })
})

describe('the stepper', () => {
  it('gives every state its own words, so colour is never the only way to tell', () => {
    expect(new Set(Object.values(STAGE_STATE_TEXT)).size).toBe(Object.keys(STAGE_STATE_TEXT).length)
  })

  it('has the four stages in order, with an honest one for the index', () => {
    expect(stagesOf(state(), facts()).map(entry => entry.label)).toEqual(['Audio uploaded', 'Transcribed', 'Summarized', 'Indexed for questions'])
  })

  it.each<[Partial<PipelineResponse>, string[]]>([
    [{ status: 'uploaded' }, ['done', 'active', 'pending', 'pending']],
    [{ status: 'transcribing' }, ['done', 'active', 'pending', 'pending']],
    [{ status: 'summarizing', progress: { stage: 'summarization', done: 0, total: null, etaSeconds: null } }, ['done', 'done', 'active', 'pending']],
    [{ status: 'indexing', progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null }, index: { state: 'building', done: 16, total: null, retryAt: null } }, ['done', 'done', 'active', 'active']],
    [READY, ['done', 'done', 'done', 'done']],
    [{ status: 'pending_upload', progress: { stage: 'upload', done: 0, total: null, etaSeconds: null }, next: 'wait' }, ['waiting', 'pending', 'pending', 'pending']],
  ])('%j', (patch, expected) => {
    expect(stagesOf(state({}, answer(patch)), facts()).map(entry => entry.state)).toEqual(expected)
  })

  it('marks the first stage with something going on as the current step, and only that', () => {
    const during = stagesOf(state({}, answer({ status: 'indexing', index: { state: 'building', done: 16, total: null, retryAt: null } })), facts())
    expect(during.filter(entry => entry.current).map(entry => entry.key)).toEqual(['summarize'])
    expect(stagesOf(state({}, answer(READY)), facts()).filter(entry => entry.current)).toEqual([])
  })

  it('says how far each stage has got, from the figures it is sent and in the words for them', () => {
    expect(stage(state({}, answer({ progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null } })), 'transcribe').detail).toBe('Transcribing. This can take a moment.')
    expect(stage(state({}, answer({ progress: { stage: 'transcription', done: 256, total: 1024, etaSeconds: null } })), 'transcribe').detail).toBe('Reading the transcript: 25%.')
    expect(stage(state({}, answer({ status: 'indexing', progress: { stage: 'summarization', done: 3, total: 9, etaSeconds: null } })), 'summarize').detail).toBe('3 of 9 parts done.')
    expect(stage(state({}, answer({ status: 'summarizing', progress: { stage: 'summarization', done: 0, total: null, etaSeconds: null } })), 'summarize').detail).toBe('Planning the work.')
    expect(stage(state({}, answer({ status: 'ready', index: { state: 'building', done: 16, total: null, retryAt: null } })), 'index').detail).toBe('16 passages done so far.')
    expect(stage(state({}, answer({ status: 'ready', index: { state: 'building', done: 16, total: 40, retryAt: null } })), 'index').detail).toBe('16 of 40 passages done.')
    expect(stage(state({}, answer({ status: 'ready', index: { state: 'building', done: 50, total: 40, retryAt: null } })), 'index').detail).toBe('40 of 40 passages done.')
  })

  it('invents no estimate: the figures are the only numbers', () => {
    const sent = answer({ status: 'indexing', progress: { stage: 'summarization', done: 3, total: 9, etaSeconds: null } })
    const said = stagesOf(state({}, sent), facts()).map(entry => entry.detail).join(' ')
    expect(said).not.toMatch(/\b(remaining|left|about|estimate|eta)\b/i)
  })

  it('counts segments only once they have been read for this status', () => {
    const past = answer({ status: 'summarizing' })
    expect(stage(state({}, past), 'transcribe', facts({ segmentCount: 7 })).detail).toContain('7 segments.')
    expect(stage(state({}, past), 'transcribe', facts({ segmentCount: 1 })).detail).toContain('1 segment.')
    expect(stage(state({}, past), 'transcribe', facts({ segmentCount: null })).detail).toBe('Speech turned into timestamped segments.')
  })

  it('says a silent recording finished, with no speech, and does not say so before it knows', () => {
    const past = answer({ status: 'summarizing' })
    expect(stage(state({}, past), 'transcribe', facts({ segmentCount: 0 })).detail).toBe('Transcription ran and found no speech.')
    expect(stage(state({}, past), 'transcribe', facts({ segmentCount: null })).detail).not.toMatch(/no speech/)
  })

  it('names the audio once it has arrived, and not before', () => {
    expect(stage(state(), 'upload').detail).toContain('1.2 MB')
    expect(stage(state({}, answer({ status: 'pending_upload', next: 'wait' })), 'upload').detail).not.toContain('1.2 MB')
  })

  it.each<[string, Partial<DriverState>, string]>([
    ['a short wait', { pause: 'wait', waitMs: 40_000 }, 'waiting'],
    ['a long wait', { pause: 'wait', waitMs: LONG_WAIT_MS }, 'paused'],
    ['a long wait while it looks', { pause: 'wait', waitMs: LONG_WAIT_MS, asking: true }, 'paused'],
    ['the request after a short wait', { pause: 'wait', waitMs: 40_000, asking: true }, 'active'],
    ['a lost connection', { pause: 'network' }, 'paused'],
    ['a bad answer', { pause: 'server' }, 'paused'],
    ['the gate', { pause: 'unavailable' }, 'paused'],
    ['a 429', { pause: 'rate-limited' }, 'paused'],
    ['the spin bound', { pause: 'spinning' }, 'paused'],
    ['a stop for trouble', { stop: 'trouble' }, 'paused'],
    ['a stop for stalling', { stop: 'stalled' }, 'paused'],
    ['a read-only page', { role: 'read-only' }, 'unfinished'],
    ['nothing in the way', {}, 'active'],
  ])('calls the stage at work what it is during %s', (_name, patch, expected) => {
    expect(stage(state(patch), 'transcribe').state).toBe(expected)
  })

  it.each<[string, PipelineResponse, string, RegExp]>([
    ['parked', parkedUntil('2026-11-04T00:00:00.000Z'), 'paused', /16 passages kept/],
    ['held', HELD, 'attention', /another model/],
    ['stopped', STOPPED, 'attention', /will not be tried again by itself/],
  ])('says what a %s index is, in the stepper too', (_name, a, expected, detail) => {
    const entry = stage(state({ stop: 'finished' }, a), 'index')
    expect(entry.state).toBe(expected)
    expect(entry.detail).toMatch(detail)
  })

  it('shows a rebuild over whatever the index was', () => {
    const entry = stage(state({ rebuild: { done: 16, total: null } }, HELD), 'index')
    expect(entry).toMatchObject({ state: 'active', detail: 'Rebuilding: 16 passages done so far.' })
  })

  it('reads a failure from the answer, ahead of a row read before it', () => {
    const failed = answer({ status: 'failed', next: 'failed', progress: { stage: 'summarization', done: 2, total: 9, etaSeconds: null } })
    const staged = stagesOf(state({}, failed), facts({ failedStage: null }))
    expect(staged.map(entry => entry.state)).toEqual(['done', 'done', 'failed', 'pending'])
    expect(staged[2]!.detail).toBe('Did not finish: 2 of 9 parts done.')
  })

  it('reads a rejected upload as the upload failing, and everything after as not started', () => {
    const failed = answer({ status: 'failed', next: 'failed', progress: { stage: 'upload', done: 0, total: null, etaSeconds: null } })
    expect(stagesOf(state({}, failed), facts({ failedStage: 'upload' })).map(entry => entry.state)).toEqual(['failed', 'pending', 'pending', 'pending'])
  })

  it('reads a failed transcription as that stage failing', () => {
    const failed = answer({ status: 'failed', next: 'failed', retryAt: 'x', retryAfterMs: 10 })
    expect(stagesOf(state({}, failed), facts()).map(entry => entry.state)).toEqual(['done', 'failed', 'pending', 'pending'])
  })

  it('works from the row alone when no answer could be read', () => {
    expect(stagesOf(state({}, null), facts({ status: 'ready' })).map(entry => entry.state)).toEqual(['done', 'done', 'done', 'pending'])
    expect(stagesOf(state({}, null), facts({ status: 'failed', failedStage: 'summarization' })).map(entry => entry.state)).toEqual(['done', 'done', 'failed', 'pending'])
  })
})

describe('the pause banner', () => {
  const blocked = (stageName: PipelineResponse['progress']['stage'], role: DriverState['role'] = 'driving', left = 3 * HOUR) =>
    bannerOf(state({ role, pause: 'wait', waitMs: left, nextRequestAt: NOW + left }, answer({ progress: { stage: stageName, done: 0, total: null, etaSeconds: null } })), NOW)

  it.each<[string, number, RegExp]>([
    ['hours', 3 * HOUR, /in 3 hours /],
    ['most of a day', 23 * HOUR + 30 * 60_000, /in 23 hours 30 minutes /],
    ['minutes', 20 * 60_000, /in 20 minutes /],
  ])('says plainly why a block is waiting and for how long, in %s', (_name, left, when) => {
    const banner = blocked('transcription', 'driving', left)!
    expect(banner.title).toBe('Paused: waiting for the provider')
    expect(banner.description).toContain(PROVIDER_BLOCKED_ERROR)
    expect(banner.description).toMatch(when)
    expect(banner.description).toMatch(/Nothing is wrong with this meeting/)
    expect(banner.description).toMatch(/carries on from the same place when you open it again/)
    expect(banner.description).not.toMatch(/did not finish/)
  })

  it('names the stage that is blocked', () => {
    expect(blocked('summarization')!.description).toContain('extraction provider')
    expect(blocked('search_index')!.description).toContain('indexing provider')
  })

  it('blames the index, on a failed meeting, since nothing else there can be waiting', () => {
    const failed = answer({ status: 'failed', next: 'wait', progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null } })
    const banner = bannerOf(state({ pause: 'wait', waitMs: 3 * 60_000, nextRequestAt: NOW + 3 * 60_000 }, failed), NOW)!
    expect(banner.description).toContain('indexing provider')
    expect(banner.description).not.toContain('extraction provider')
  })

  it('says who has to stay open, which from a second tab is not this one', () => {
    expect(blocked('transcription', 'driving')!.description).toContain('while this page stays open')
    expect(blocked('transcription', 'watching')!.description).toContain('while a tab of this browser stays open')
  })

  it('does not bring a banner out for the pacing of a healthy run', () => {
    expect(bannerOf(state({ pause: 'wait', waitMs: LONG_WAIT_MS - 1, nextRequestAt: NOW + 60_000 }), NOW)).toBeNull()
    expect(bannerOf(state(), NOW)).toBeNull()
    expect(bannerOf(state({ stop: 'finished' }, answer(READY)), NOW)).toBeNull()
  })

  it.each<[DriverState['pause'], RegExp]>([
    ['network', /Cannot reach MeetMind/],
    ['server', /server hit a problem/],
    ['unavailable', /not available at the moment/],
    ['rate-limited', /slow down/],
  ])('says %s is not the meeting failing, and when it tries again', (pause, title) => {
    const banner = bannerOf(state({ pause, nextRequestAt: NOW + 45_000 }), NOW)!
    expect(banner.title).toMatch(title)
    expect(banner.description).toMatch(/not a failure of the meeting/)
    expect(banner.description).toMatch(/Trying again in 45 seconds/)
  })

  it('says shortly when the time has come and gone', () => {
    expect(bannerOf(state({ pause: 'network', nextRequestAt: NOW - 1 }), NOW)!.description).toMatch(/Trying again shortly/)
  })

  it('says a stop for trouble has stopped, and needs someone', () => {
    const banner = bannerOf(state({ stop: 'trouble', troubleCause: 'unavailable', retryFrom: NOW }), NOW)!
    expect(banner.title).toMatch(/not available at the moment/)
    expect(banner.description).toMatch(/stopped asking/)
    expect(banner.description).toMatch(/not a failure of the meeting/)
  })

  it('says the spin bound for what it is', () => {
    expect(bannerOf(state({ pause: 'spinning', nextRequestAt: NOW + 30_000 }), NOW)!.description).toMatch(/Trying again in 30 seconds/)
    expect(bannerOf(state({ stop: 'stalled', retryFrom: NOW }), NOW)!.title).toBe('Paused: nothing is moving')
  })

  it('says a deleted meeting is gone', () => {
    expect(bannerOf(state({ stop: 'missing' }), NOW)!.title).toBe('This meeting no longer exists')
  })

  describe('on the public demo', () => {
    const demo = (a: PipelineResponse | null, patch: Partial<DriverState> = {}) => bannerOf(state({ role: 'read-only', ...patch }, a), NOW)

    it('says an unfinished demo is read-only and will not move from here', () => {
      const banner = demo(answer({ status: 'uploaded', next: 'wait' }))!
      expect(banner.title).toBe('This demo meeting is read-only')
      expect(banner.description).toMatch(/nothing on this page can move it on/)
    })

    it('says what is left of a ready demo with an index not finished', () => {
      expect(demo(answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } }))!.description).toMatch(/Questions stay off/)
    })

    it('says nothing over a finished one', () => {
      expect(demo(answer(READY))).toBeNull()
    })

    it('says it could not be read, with no retry to offer', () => {
      expect(demo(null, { stop: 'trouble', retryFrom: null })!.title).toBe('Could not read this demo meeting')
    })
  })
})

describe('the failure alert', () => {
  const failed = (progressStage: PipelineResponse['progress']['stage'], retryAt: string | null) =>
    answer({ status: 'failed', next: 'failed', retryAt, retryAfterMs: retryAt ? 60_000 : null, progress: { stage: progressStage, done: 0, total: null, etaSeconds: null } })

  it('says nothing unless the meeting failed', () => {
    expect(failureOf(state(), facts())).toBeNull()
  })

  it.each<[string, PipelineResponse, Partial<PipelineFacts>, RegExp]>([
    ['a retryable transcription', failed('transcription', 'x'), {}, /Transcription did not finish/],
    ['a retryable extraction', failed('summarization', 'x'), {}, /Extraction did not finish/],
    ['audio missing or changed', failed('transcription', null), {}, /missing or has changed/],
    ['a transcript over the limit', failed('summarization', null), {}, /too long/],
    ['a rejected upload', failed('upload', null), { failedStage: 'upload' }, /rejected and removed/],
    ['a row from before the column', failed('upload', null), { failedStage: null }, /Something went wrong/],
  ])('has its own words for %s', (_name, a, patch, title) => {
    expect(failureOf(state({ stop: 'failed' }, a), facts({ status: 'failed', ...patch }))!.title).toMatch(title)
  })

  it('says of the never-retried failures that trying again would not help, not that it can', () => {
    expect(failureOf(state({ stop: 'failed' }, failed('transcription', null)), facts())!.description).toMatch(/trying again would not help/)
    expect(failureOf(state({ stop: 'failed' }, failed('summarization', null)), facts())!.description).not.toMatch(/retry/i)
    expect(failureOf(state({ stop: 'failed' }, failed('upload', null)), facts({ failedStage: 'upload' }))!.description).toMatch(/Upload the recording again/)
  })

  it('does not call a failure final while the index is still being built past it', () => {
    const stillGoing = answer({ status: 'failed', next: 'continue', progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null }, index: { state: 'building', done: 16, total: null, retryAt: null } })
    expect(failureOf(state({}, stillGoing), facts())!.title).toBe('Extraction did not finish')
  })

  it('stays out of the way on the public demo, whose banner says all there is', () => {
    expect(failureOf(state({ role: 'read-only' }, failed('summarization', null)), facts())).toBeNull()
  })

  it('works from the row alone when no answer could be read', () => {
    expect(failureOf(state({}, null), facts({ status: 'failed', failedStage: 'transcription' }))!.title).toBe('Transcription did not finish')
  })

  it('has no way to repeat a stored error: nothing it reads holds one', () => {
    const said = JSON.stringify(failureOf(state({ stop: 'failed' }, failed('transcription', 'x')), { ...facts(), errorMessage: RAW } as PipelineFacts))
    expect(said).not.toContain('PGRST')
  })
})

describe('the retry', () => {
  const now = NOW

  it.each<[string, Partial<DriverState>]>([
    ['still working', {}],
    ['a failure no retry can help', { stop: 'failed', retryFrom: null }],
    ['a finished meeting', { stop: 'finished', retryFrom: null }],
    ['a meeting gone', { stop: 'missing', retryFrom: null }],
    ['the public demo, whatever it says', { role: 'read-only', stop: 'failed', retryFrom: now }],
  ])('is not offered for %s', (_name, patch) => {
    expect(retryOf(state(patch), facts(), now)).toBeNull()
  })

  it('is coming, not offered, until the time', () => {
    expect(retryOf(state({ stop: 'failed', retryFrom: now + 42_000 }), facts(), now)).toMatchObject({ open: false, opensInMs: 42_000 })
  })

  it('is offered at the time and after it', () => {
    expect(retryOf(state({ stop: 'failed', retryFrom: now }), facts(), now)).toMatchObject({ open: true, opensInMs: 0 })
    expect(retryOf(state({ stop: 'failed', retryFrom: now - 1 }), facts(), now)).toMatchObject({ open: true, opensInMs: 0 })
  })

  it.each<[string, Partial<DriverState>, PipelineResponse, string]>([
    ['transcription', { stop: 'failed', retryFrom: now }, answer({ status: 'failed', next: 'failed' }), 'Try transcription again'],
    ['extraction', { stop: 'failed', retryFrom: now }, answer({ status: 'failed', next: 'failed', progress: { stage: 'summarization', done: 0, total: 3, etaSeconds: null } }), 'Try extraction again'],
    ['a parked index', { stop: 'finished', retryFrom: now }, parkedUntil('2026-11-03T12:00:00.000Z'), 'Carry on indexing'],
    ['a stop for trouble', { stop: 'trouble', retryFrom: now }, answer(), 'Try again'],
    ['the spin bound', { stop: 'stalled', retryFrom: now }, answer(), 'Try again'],
  ])('says what it does for %s', (_name, patch, a, label) => {
    expect(retryOf(state(patch, a), facts(), now)!.label).toBe(label)
  })
})

describe('the Questions card', () => {
  it('leads onward to asking once the index is complete', () => {
    expect(questionsOf(state({ stop: 'finished' }, answer(READY)), NOW)).toEqual({ text: 'Ready for questions: all 8 passages indexed.', link: 'ask', rebuildLabel: null })
  })

  it('leads onward to reading when there was nothing to index', () => {
    const empty = answer({ status: 'ready', next: 'done', index: { state: 'complete', done: 0, total: 0, retryAt: null } })
    expect(questionsOf(state({ stop: 'finished' }, empty), NOW)).toEqual({ text: 'Nothing to index: the transcript is empty.', link: 'read', rebuildLabel: null })
  })

  it('says what it knows while it is being built, and offers no way forward yet', () => {
    const building = answer({ status: 'indexing', index: { state: 'building', done: 16, total: null, retryAt: null } })
    expect(questionsOf(state({}, building), NOW)).toEqual({ text: 'Indexing the transcript for questions. 16 passages done so far.', link: null, rebuildLabel: null })
  })

  it('says it cannot be asked before there is a transcript', () => {
    expect(questionsOf(state(), NOW).text).toBe('Available once transcription has finished.')
  })

  it('says it could not check, rather than blame a transcript, when nothing could be read', () => {
    const said = questionsOf(state({}, null), NOW)
    expect(said.text).toContain('Could not check whether this meeting can be asked questions')
    expect(said.text).not.toContain('Available once')
  })

  describe('with the index parked', () => {
    const midnight = parkedUntil('2026-11-04T00:00:00.000Z')
    const other = parkedUntil('2026-11-03T12:15:00.000Z')

    it('says the daily limit when that is what its time means, with the time here', () => {
      const said = questionsOf(state({ stop: 'finished' }, midnight), NOW)
      expect(said.text).toMatch(/free daily limit for indexing has been reached/)
      expect(said.text).toMatch(/00:00 UTC \(.+ here\)/)
      expect(said.text).toMatch(/kept/)
      expect(said.text).toMatch(/can be read now/)
      expect(said.link).toBe('read')
      expect(said.rebuildLabel).toBeNull()
    })

    it('says a run that kept stopping when it was not the limit, and blames no limit', () => {
      const said = questionsOf(state({ stop: 'finished' }, other), NOW)
      expect(said.text).toMatch(/kept stopping, so it is resting until /)
      expect(said.text).not.toMatch(/daily limit/)
      expect(said.link).toBe('read')
    })

    it('says no time before mounting, since the server knows neither the clock nor the language', () => {
      const first = questionsOf(state({}, midnight), 0)
      expect(first.text).toMatch(/resets at 00:00 UTC\./)
      expect(first.text).not.toMatch(/here\)/)
      expect(first.text).not.toMatch(/carry on now/)
      expect(questionsOf(state({}, other), 0).text).toMatch(/resting for now\./)
    })

    it('says so once it can carry on', () => {
      expect(questionsOf(state({ stop: 'finished' }, other), Date.parse('2026-11-03T12:15:00.000Z')).text).toMatch(/It can carry on now/)
    })

    it('does not offer the explicit route: it would honour the park and sit there for up to 15 minutes', () => {
      expect(questionsOf(state({ stop: 'finished' }, other), NOW).rebuildLabel).toBeNull()
    })
  })

  it('says a held index is the work of something else, and offers the one thing that replaces it', () => {
    const said = questionsOf(state({ stop: 'finished' }, HELD), NOW)
    expect(said.text).toMatch(/another embedding model or an older transcript/)
    expect(said.text).toMatch(/spends quota/)
    expect(said.text).toMatch(/can be read now/)
    expect(said).toMatchObject({ link: 'read', rebuildLabel: 'Rebuild the index' })
  })

  it('says a stopped index will not try by itself, and offers to', () => {
    expect(questionsOf(state({ stop: 'finished' }, STOPPED), NOW)).toMatchObject({ link: 'read', rebuildLabel: 'Try indexing again' })
  })

  it('shows a rebuild for what it is', () => {
    expect(questionsOf(state({ rebuild: { done: 16, total: 40 } }, HELD), NOW)).toEqual({ text: 'Rebuilding the index for questions: 16 of 40 passages done.', link: null, rebuildLabel: null })
  })

  describe('on the public demo', () => {
    it.each<[string, PipelineResponse]>([['held', HELD], ['stopped', STOPPED]])('offers no way to touch a %s index', (_name, a) => {
      expect(questionsOf(state({ role: 'read-only' }, a), NOW).rebuildLabel).toBeNull()
    })

    it('does not say anything is under way', () => {
      const building = answer({ status: 'ready', next: 'wait', index: { state: 'building', done: 0, total: null, retryAt: null } })
      expect(questionsOf(state({ role: 'read-only' }, building), NOW).text).toBe('Not available: this meeting\'s index is not finished.')
    })
  })
})

describe('what is announced', () => {
  const said = (s: DriverState, f = facts(), retryOpen = false) => announcementOf(s, f, retryOpen)

  it('never holds a figure that ticks: it cannot depend on the time', () => {
    const before = state({ pause: 'wait', waitMs: 3 * HOUR, nextRequestAt: NOW + 3 * HOUR })
    const later = { ...before, nextRequestAt: NOW + 2 * HOUR, waitMs: 2 * HOUR }
    expect(said(before)).toBe(said(later))
    expect(said(before)).not.toMatch(/\d/)
    expect(announcementOf.length).toBe(3)
  })

  it('does not change between a wait and the request after it', () => {
    const running = answer({ status: 'indexing', progress: { stage: 'summarization', done: 3, total: 9, etaSeconds: null } })
    const waiting = said(state({ pause: 'wait', waitMs: 60_000, nextRequestAt: NOW + 60_000 }, running))
    const asking = said(state({ asking: true }, running))
    expect(waiting).toBe('Extracting decisions and action items: 3 of 9 parts done.')
    expect(asking).toBe(waiting)
  })

  it('does not change with each page of a reply or each batch of an index', () => {
    const page = (done: number) => answer({ progress: { stage: 'transcription', done, total: 1_000, etaSeconds: null } })
    expect(said(state({}, page(10)))).toBe(said(state({}, page(900))))
    const batch = (done: number) => answer({ status: 'ready', next: 'continue', index: { state: 'building', done, total: null, retryAt: null } })
    expect(said(state({}, batch(16)))).toBe(said(state({}, batch(32))))
    expect(said(state({}, batch(16)))).toBe('Indexing the transcript for questions.')
  })

  it.each<[string, Partial<DriverState>, PipelineResponse, RegExp]>([
    ['transcribing', {}, answer(), /^Transcribing/],
    ['a long block', { pause: 'wait', waitMs: 3 * HOUR }, answer(), /^Paused: waiting for the provider/],
    ['a lost connection', { pause: 'network' }, answer(), /Cannot reach MeetMind.*by itself/],
    ['a 503', { pause: 'unavailable' }, answer(), /not available/],
    ['a stop for trouble', { stop: 'trouble', troubleCause: 'server' }, answer(), /stopped asking/],
    ['the spin bound', { pause: 'spinning' }, answer(), /nothing is moving/],
    ['the end of the bound', { stop: 'stalled' }, answer(), /nothing is moving/],
    ['a gone meeting', { stop: 'missing' }, answer(), /no longer exists/],
    ['a rebuild', { rebuild: { done: 1, total: null } }, HELD, /Rebuilding/],
    ['the end', { stop: 'finished' }, answer(READY), /^Finished\. This meeting can be read and asked questions/],
    ['an empty end', { stop: 'finished' }, answer({ status: 'ready', next: 'done', index: { state: 'complete', done: 0, total: 0, retryAt: null } }), /nothing to index/],
    ['a parked end', { stop: 'finished' }, parkedUntil('2026-11-04T00:00:00.000Z'), /^Finished for now\. This meeting can be read/],
    ['a held end', { stop: 'finished' }, HELD, /until its index is rebuilt/],
    ['a stopped end', { stop: 'finished' }, STOPPED, /until its index is finished/],
    ['the demo, unfinished', { role: 'read-only' }, answer({ status: 'uploaded', next: 'wait' }), /public demo.*read-only/],
    ['the demo, finished', { role: 'read-only' }, answer(READY), /public demo.*finished/],
  ])('says %s', (_name, patch, a, expected) => {
    expect(said(state(patch, a))).toMatch(expected)
  })

  it('says the failure, by its own name, and that a retry is open only when it is', () => {
    const failed = state({ stop: 'failed', retryFrom: NOW + 1 }, answer({ status: 'failed', next: 'failed', retryAt: 'x', retryAfterMs: 1 }))
    expect(said(failed)).toBe('Transcription did not finish.')
    expect(said(failed, facts(), true)).toBe('Transcription did not finish. You can try again now.')
  })

  it('says a parked index can carry on, once it can', () => {
    expect(said(state({ stop: 'finished' }, parkedUntil('2026-11-04T00:00:00.000Z')), facts(), true)).toMatch(/You can carry on now/)
  })

  it('says which tab is working, from the one that is not', () => {
    expect(said(state({ role: 'watching' }))).toBe('Watching another tab. Transcribing. This can take a moment.')
    expect(said(state({ role: 'watching', pause: 'wait', waitMs: 3 * HOUR }))).toMatch(/^Watching another tab\. Paused/)
  })

  it('says it is waiting for the upload', () => {
    expect(said(state({ pause: 'look' }, answer({ status: 'pending_upload', next: 'wait' })))).toBe('Waiting for the upload to be confirmed.')
  })

  it('says the same on the server and in the first client render: it has nothing else to go on', () => {
    const first = initialDriverState(answer({ status: 'uploaded' }))
    expect(announcementOf(first, facts(), false)).toBe('Transcribing. This can take a moment.')
  })
})

describe('the next-request countdown', () => {
  it('says when the next request is', () => {
    expect(countdownOf(state({ pause: 'wait', waitMs: 42_000, nextRequestAt: NOW + 42_000 }), NOW)).toBe('Next request in 42 seconds.')
  })

  it('moves with the clock', () => {
    const waiting = state({ pause: 'wait', waitMs: 42_000, nextRequestAt: NOW + 42_000 })
    expect(countdownOf(waiting, NOW + 12_000)).toBe('Next request in 30 seconds.')
  })

  it('says nothing when the time is up, the request being on its way', () => {
    expect(countdownOf(state({ pause: 'wait', waitMs: 42_000, nextRequestAt: NOW }), NOW)).toBeNull()
  })

  it.each<[string, Partial<DriverState>]>([
    ['nothing being waited for', {}],
    ['a banner saying the time itself', { pause: 'wait', waitMs: 3 * HOUR, nextRequestAt: NOW + 3 * HOUR }],
    ['trouble, whose banner does the same', { pause: 'network', nextRequestAt: NOW + 5_000 }],
    ['a stop', { stop: 'failed', pause: 'wait', waitMs: 1_000, nextRequestAt: NOW + 1_000 }],
  ])('stays away for %s', (_name, patch) => {
    expect(countdownOf(state(patch), NOW)).toBeNull()
  })
})
