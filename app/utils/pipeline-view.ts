import type { Meeting, MeetingStatus } from '#shared/types/meeting'
import { PROVIDER_BLOCKED_ERROR, transcriptionFinished } from '#shared/utils/meeting'
import { LONG_WAIT_MS, type DriverState, type TroubleCause } from './pipeline-driver'

/**
 * What the progress page says, as plain functions of the driver's state, so each sentence can
 * be tested without mounting anything. All the words are this file's: nothing here shows a
 * stored or provider error, which `/advance` and `/pipeline` do not carry in the first place
 * (ADR-0012's step 9 addendum). `etaSeconds` is always null, so nothing here estimates; the
 * only time ever shown is the wait the server said.
 */

/** What this reads of the meeting's own row, since `/pipeline` has no error stage or size. */
export interface PipelineFacts {
  status: MeetingStatus
  failedStage: Meeting['failedStage']
  /** Null until the transcript has been read for the status shown. */
  segmentCount: number | null
  audioLabel: string
}

function plural(count: number, name: string): string {
  return `${count} ${name}${count === 1 ? '' : 's'}`
}

/** A wait in the visitor's terms: `42 seconds`, `3 minutes 20 seconds`, `2 hours 5 minutes`. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return plural(seconds, 'second')
  const parts = seconds < 3600
    ? [plural(Math.floor(seconds / 60), 'minute'), seconds % 60 ? plural(seconds % 60, 'second') : '']
    : [plural(Math.floor(seconds / 3600), 'hour'), Math.floor((seconds % 3600) / 60) ? plural(Math.floor((seconds % 3600) / 60), 'minute') : '']
  return parts.filter(Boolean).join(' ')
}

/** A moment by this browser's clock and in its language. Only ever after mounting: see the page. */
export function formatClock(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === when.toDateString()
    ? time
    : `${when.toLocaleDateString([], { weekday: 'long' })} ${time}`
}

export type StageState = 'done' | 'active' | 'waiting' | 'paused' | 'failed' | 'attention' | 'pending' | 'unfinished'

/** Said in words for every state, and each has its own icon: never colour alone. */
export const STAGE_STATE_TEXT: Record<StageState, string> = {
  done: 'Done',
  active: 'In progress',
  waiting: 'Waiting',
  paused: 'Paused',
  failed: 'Failed',
  attention: 'Needs attention',
  pending: 'Not started',
  unfinished: 'Not finished',
}

export interface StageView {
  key: 'upload' | 'transcribe' | 'summarize' | 'index'
  label: string
  state: StageState
  stateText: string
  detail: string
  /** The first stage that has something going on, for `aria-current`. */
  current: boolean
}

function statusOf(state: DriverState, facts: PipelineFacts): MeetingStatus {
  return state.answer?.status ?? facts.status
}

/**
 * Which stage a failed meeting stopped at. From the answer when there is one, since a row read
 * earlier may be behind it: `progress.stage` is that stage, except that a rejected upload and a
 * row from before the column both say `upload`, and only the row tells those apart.
 */
function failedAt(state: DriverState, facts: PipelineFacts): Meeting['failedStage'] {
  if (statusOf(state, facts) !== 'failed') return null
  const stage = state.answer?.progress.stage
  if (stage === 'transcription' || stage === 'summarization') return stage
  return facts.failedStage
}

/** What a stage doing its work is called right now, depending on who is doing it. */
function workingState(state: DriverState): StageState {
  if (state.role === 'read-only') return 'unfinished'
  if (state.stop === 'trouble' || state.stop === 'stalled' || state.pause === 'spinning') return 'paused'
  if (state.pause === 'network' || state.pause === 'server' || state.pause === 'unavailable' || state.pause === 'rate-limited') return 'paused'
  if (isLongWait(state)) return 'paused'
  return state.pause === 'wait' && !state.asking ? 'waiting' : 'active'
}

function percent(done: number, total: number): number {
  return Math.min(100, Math.floor((done / total) * 100))
}

function indexFigures({ done, total }: { done: number, total: number | null }): string {
  if (total !== null && total > 0) return `${Math.min(done, total)} of ${total} passages done.`
  return done > 0 ? `${done} passages done so far.` : 'Getting ready to index.'
}

export function stagesOf(state: DriverState, facts: PipelineFacts): StageView[] {
  const status = statusOf(state, facts)
  const failed = failedAt(state, facts)
  const finishedTranscript = transcriptionFinished({ status, failedStage: failed })
  const working = workingState(state)
  const { answer } = state
  const figures = answer?.progress
  const index = answer?.index

  const upload = (): Pick<StageView, 'state' | 'detail'> => {
    if (status === 'pending_upload') return { state: 'waiting', detail: 'The upload has not been confirmed yet.' }
    if (failed === 'upload') return { state: 'failed', detail: 'The uploaded audio was rejected and removed.' }
    return { state: 'done', detail: `Compressed audio stored; the video stayed on your machine. ${facts.audioLabel} of 16\u00A0kHz mono Opus.` }
  }

  const transcribe = (): Pick<StageView, 'state' | 'detail'> => {
    const base = 'Speech turned into timestamped segments.'
    if (failed === 'transcription') return { state: 'failed', detail: 'Did not finish.' }
    if (finishedTranscript) {
      if (facts.segmentCount === 0) return { state: 'done', detail: 'Transcription ran and found no speech.' }
      return { state: 'done', detail: facts.segmentCount === null ? base : `${base} ${plural(facts.segmentCount, 'segment')}.` }
    }
    if (status !== 'uploaded' && status !== 'transcribing') return { state: 'pending', detail: base }
    if (figures?.stage === 'transcription' && figures.total) return { state: working, detail: `Reading the transcript: ${percent(figures.done, figures.total)}%.` }
    return { state: working, detail: 'Transcribing. This can take a moment.' }
  }

  const summarize = (): Pick<StageView, 'state' | 'detail'> => {
    const base = 'Decisions and action items extracted.'
    const parts = figures?.stage === 'summarization' && figures.total ? `${figures.done} of ${figures.total} parts done.` : null
    if (status === 'ready') return { state: 'done', detail: base }
    if (failed === 'summarization') return { state: 'failed', detail: parts ? `Did not finish: ${parts}` : 'Did not finish.' }
    if (status === 'summarizing' || status === 'indexing') return { state: working, detail: parts ?? 'Planning the work.' }
    return { state: 'pending', detail: base }
  }

  const indexed = (): Pick<StageView, 'state' | 'detail'> => {
    if (state.rebuild) return { state: 'active', detail: `Rebuilding: ${indexFigures(state.rebuild)}` }
    switch (index?.state) {
      case 'complete':
        return { state: 'done', detail: index.total ? `All ${plural(index.total, 'passage')} indexed.` : 'Nothing to index: the transcript is empty.' }
      case 'building':
        return { state: working, detail: indexFigures(index) }
      case 'parked':
        return { state: 'paused', detail: `${index.done > 0 ? `${index.done} passages kept.` : 'Nothing indexed yet.'} It can carry on later.` }
      case 'held':
        return { state: 'attention', detail: 'Holds another model\'s or transcript\'s work, so it needs a rebuild.' }
      case 'stopped':
        return { state: 'attention', detail: 'Stopped: it was refused, and will not be tried again by itself.' }
      default:
        return { state: 'pending', detail: 'Lets the meeting be asked questions.' }
    }
  }

  const stages: Array<Pick<StageView, 'key' | 'label'> & Pick<StageView, 'state' | 'detail'>> = [
    { key: 'upload', label: 'Audio uploaded', ...upload() },
    { key: 'transcribe', label: 'Transcribed', ...transcribe() },
    { key: 'summarize', label: 'Summarized', ...summarize() },
    { key: 'index', label: 'Indexed for questions', ...indexed() },
  ]
  // Nothing is happening to a meeting that is gone, and nothing will. What it had done it did.
  if (state.stop === 'missing') {
    return stages.map((stage) => {
      const final = stage.state === 'done' ? stage : { ...stage, state: 'unfinished' as const, detail: 'This meeting no longer exists.' }
      return { ...final, stateText: STAGE_STATE_TEXT[final.state], current: false }
    })
  }
  const current = stages.find(stage => stage.state !== 'done' && stage.state !== 'pending')
  return stages.map(stage => ({ ...stage, stateText: STAGE_STATE_TEXT[stage.state], current: stage === current }))
}

const TROUBLE_TITLE: Record<TroubleCause, string> = {
  'network': 'Cannot reach MeetMind',
  'server': 'The server hit a problem',
  'unavailable': 'MeetMind is not available at the moment',
  'rate-limited': 'The server asked this page to slow down',
}

const TROUBLE_WHY = 'This is not a failure of the meeting, and nothing stored is lost.'

export interface BannerView {
  title: string
  description: string
  icon: string
  color: 'info' | 'warning' | 'error' | 'neutral'
}

const PROVIDER_OF: Record<string, string> = {
  summarization: 'The extraction provider\'s quota is used up for now.',
  search_index: 'The indexing provider\'s quota is used up for now.',
}

/** A wait past what a healthy run ever does. Up to a day, and it must be said plainly (step 9 addendum). */
function isLongWait(state: DriverState): boolean {
  return state.pause === 'wait' && (state.waitMs ?? 0) >= LONG_WAIT_MS
}

function isFinishedMeeting(state: DriverState): boolean {
  return state.answer?.status === 'ready' && state.answer.index.state === 'complete'
}

/**
 * The banner for anything that has paused or stopped the work and is not the meeting failing.
 * Not a live region: it holds a countdown, and {@link announcementOf} is what gets announced.
 */
export function bannerOf(state: DriverState, now: number): BannerView | null {
  const left = state.nextRequestAt === null ? null : state.nextRequestAt - now
  const when = left !== null && left > 0 ? `in ${formatWait(left)}` : 'shortly'

  if (state.stop === 'missing') {
    return { title: 'This meeting no longer exists', description: 'It may have been deleted. Nothing more will happen on this page.', icon: 'i-lucide-file-x', color: 'error' }
  }
  if (state.role === 'read-only') {
    if (state.stop === 'trouble') {
      return { title: 'Could not read this demo meeting', description: 'Reload the page to try again.', icon: 'i-lucide-triangle-alert', color: 'warning' }
    }
    if (isFinishedMeeting(state)) return null
    return {
      title: 'This demo meeting is read-only',
      description: state.answer?.status === 'ready'
        ? 'It can be read and played. Questions stay off until its index is finished, and nothing on this page can do that.'
        : 'It is not finished, and nothing on this page can move it on. What is stored so far can still be read.',
      icon: 'i-lucide-eye',
      color: 'neutral',
    }
  }
  if (state.stop === 'trouble') {
    return {
      title: TROUBLE_TITLE[state.troubleCause ?? 'server'],
      description: `${TROUBLE_WHY} This page has stopped asking for now. Try again when you are ready; the work carries on from where it stopped.`,
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
    }
  }
  if (state.stop === 'stalled') {
    return {
      title: 'Paused: nothing is moving',
      description: 'The server kept saying there was more to do, and nothing changed, so this page stopped asking. What is stored is kept. Try again when you are ready.',
      icon: 'i-lucide-pause',
      color: 'warning',
    }
  }
  if (state.pause === 'network' || state.pause === 'server' || state.pause === 'unavailable' || state.pause === 'rate-limited') {
    return {
      title: TROUBLE_TITLE[state.pause],
      description: `${TROUBLE_WHY} Trying again ${when}.`,
      icon: state.pause === 'network' ? 'i-lucide-wifi-off' : 'i-lucide-triangle-alert',
      color: 'warning',
    }
  }
  if (state.pause === 'spinning') {
    return {
      title: 'Paused: nothing is moving',
      description: `The server keeps saying there is more to do, and nothing changes, so this page is holding off. Trying again ${when}.`,
      icon: 'i-lucide-pause',
      color: 'warning',
    }
  }
  if (isLongWait(state)) {
    // On a failed meeting, only the index has anything left to wait for.
    const stage = state.answer?.status === 'failed' ? 'search_index' : state.answer?.progress.stage ?? 'transcription'
    const clock = left !== null && left > 0 ? ` (${formatClock(now + left, now)})` : ''
    const who = state.role === 'watching' ? 'a tab of this browser stays' : 'this page stays'
    return {
      title: 'Paused: waiting for the provider',
      description: `${PROVIDER_OF[stage] ?? PROVIDER_BLOCKED_ERROR} Nothing is wrong with this meeting, and nothing is lost. It carries on by itself ${when}${clock} while ${who} open. If you close it, it carries on from the same place when you open it again.`,
      icon: 'i-lucide-pause',
      color: 'info',
    }
  }
  return null
}

export interface FailureView {
  title: string
  description: string
}

/**
 * Why a failed meeting stopped, in this page's own words: `failed` with no time to come back
 * means nothing will retry it, and `progress.stage` says which of the three that is. Nothing
 * here comes from the stored error.
 */
export function failureOf(state: DriverState, facts: PipelineFacts): FailureView | null {
  if (statusOf(state, facts) !== 'failed' || state.role === 'read-only' || state.stop === 'missing') return null
  const stage = failedAt(state, facts)
  const forGood = state.answer?.next === 'failed' && state.answer.retryAt === null
  if (stage === 'upload') {
    return { title: 'The audio was rejected and removed', description: 'This meeting cannot be transcribed. Upload the recording again.' }
  }
  if (stage === 'transcription') {
    return forGood
      ? { title: 'The stored audio is missing or has changed', description: 'This meeting cannot be transcribed, and trying again would not help. Upload the recording again.' }
      : { title: 'Transcription did not finish', description: 'What was stored so far is kept, and a retry carries on from there.' }
  }
  if (stage === 'summarization') {
    return forGood
      ? { title: 'This transcript is too long to extract from', description: 'It would take more requests than one meeting is allowed, so decisions and action items cannot be extracted. The transcript is kept and can still be read.' }
      : {
          title: 'Extraction did not finish',
          // While the index builds the answer cannot tell a cooldown from a transcript over the
          // limit, which no retry helps. It can once `failed` says so, or the driver has stopped.
          description: `The transcript is kept, and so is every part already extracted.${state.answer?.next === 'failed' || state.stop ? ' A retry carries on from there.' : ''}`,
        }
  }
  return { title: 'Something went wrong', description: 'This meeting stopped, and nothing here can move it on.' }
}

export interface RetryView {
  label: string
  /** Offered now. Until then, only said to be coming. */
  open: boolean
  opensInMs: number
}

/** Only after something stopped, and only when asking again can do anything: else nothing. */
export function retryOf(state: DriverState, facts: PipelineFacts, now: number): RetryView | null {
  if (state.role === 'read-only' || !state.stop || state.retryFrom === null) return null
  const labels: Partial<Record<NonNullable<Meeting['failedStage']>, string>> = {
    transcription: 'Try transcription again',
    summarization: 'Try extraction again',
  }
  const stage = failedAt(state, facts)
  const label = state.stop === 'finished'
    ? 'Carry on indexing'
    : state.stop === 'failed' && stage ? labels[stage] ?? 'Try again' : 'Try again'
  const opensInMs = Math.max(0, state.retryFrom - now)
  return { label, open: opensInMs === 0, opensInMs }
}

const DAY_MS = 86_400_000
/**
 * Only the meeting whose request hit the limit stores midnight itself. Any other parks on the
 * account's block, which the database works out from a duration, so it lands a request's round
 * trip and any clock skew away from it, on either side.
 */
const DAILY_RESET_WITHIN_MS = 60_000

/** About the moment a daily limit resets. Anything else parked is a run that kept stopping. */
function isDailyReset(iso: string | null | undefined): boolean {
  if (!iso) return false
  const intoDay = Date.parse(iso) % DAY_MS
  return intoDay <= DAILY_RESET_WITHIN_MS || DAY_MS - intoDay <= DAILY_RESET_WITHIN_MS
}

export interface QuestionsView {
  text: string
  /** Where this leads on to: asking, or reading only. */
  link: 'ask' | 'read' | null
  /** An explicit `POST .../search-index`, the only thing that moves these two states. */
  rebuildLabel: string | null
}

/** What the Questions card says, which comes down to what `index.state` says. */
export function questionsOf(state: DriverState, now: number): QuestionsView {
  if (state.stop === 'missing') return { text: 'This meeting no longer exists, so it cannot be asked questions.', link: null, rebuildLabel: null }
  const readOnly = state.role === 'read-only'
  // A tab that only watches has no lock to rebuild under, and the tab that has one can do it.
  const elsewhere = state.role === 'watching' && !state.stop
  const fromThere = elsewhere ? ' It can be rebuilt from the tab doing the work.' : ''
  if (state.rebuild) return { text: `Rebuilding the index for questions: ${indexFigures(state.rebuild)}`, link: null, rebuildLabel: null }
  const { answer } = state
  // With no status to read, every reason below would be a guess.
  if (!answer) return { text: 'Could not check whether this meeting can be asked questions. Reload the page to try again.', link: null, rebuildLabel: null }
  const { index } = answer
  switch (index.state) {
    case 'unavailable':
      return { text: 'Available once transcription has finished.', link: null, rebuildLabel: null }
    case 'building':
      return {
        text: readOnly
          ? 'Not available: this meeting\'s index is not finished.'
          : `Indexing the transcript for questions. ${indexFigures(index)}`,
        link: null,
        rebuildLabel: null,
      }
    case 'complete':
      return index.total
        ? { text: `Ready for questions: all ${plural(index.total, 'passage')} indexed.`, link: 'ask', rebuildLabel: null }
        : { text: 'Nothing to index: the transcript is empty.', link: 'read', rebuildLabel: null }
    case 'parked': {
      const at = index.retryAt ? Date.parse(index.retryAt) : Number.NaN
      // Not before mounting, when `now` is 0: the server's clock and language are not this visitor's.
      const clock = Number.isNaN(at) || !now ? null : formatClock(at, now)
      const passed = !Number.isNaN(at) && !!now && now >= at
      const why = isDailyReset(index.retryAt)
        ? `The free daily limit for indexing has been reached. It resets at 00:00 UTC${clock ? ` (${clock} here)` : ''}.`
        : `Indexing kept stopping, so it is resting${clock ? ` until ${clock}` : ' for now'}.`
      const next = passed && !readOnly ? ' It can carry on now.' : ''
      return {
        text: `${why}${next} What is indexed so far is kept. The meeting can be read now, and questions stay off until the index is finished.`,
        link: 'read',
        rebuildLabel: null,
      }
    }
    case 'held':
      return {
        text: `This meeting's index holds the work of another embedding model or an older transcript. That is not replaced by itself, because rebuilding spends quota and overwrites what is stored. The meeting can be read now, and questions stay off until the index is rebuilt.${fromThere}`,
        link: 'read',
        rebuildLabel: readOnly || elsewhere ? null : 'Rebuild the index',
      }
    case 'stopped':
      return {
        text: `Indexing was refused and will not be tried again by itself. What is indexed so far is kept. The meeting can be read now, and questions stay off until the index is finished.${fromThere}`,
        link: 'read',
        rebuildLabel: readOnly || elsewhere ? null : 'Try indexing again',
      }
  }
}

/**
 * The one sentence for the live region. No figure that ticks and no time, because a screen
 * reader announces every change here: a countdown would talk over everything, and a page
 * spending a day waiting would say so eighty thousand times. Bytes and batches stay on the
 * screen and out of this for the same reason, so the only count is parts of extraction,
 * which each take a provider request.
 */
export function announcementOf(state: DriverState, facts: PipelineFacts, retryOpen: boolean): string {
  const status = statusOf(state, facts)
  const failure = failureOf(state, facts)
  const retry = retryOpen ? ' You can try again now.' : ''

  if (state.stop === 'missing') return 'This meeting no longer exists.'
  if (state.role === 'read-only') {
    return isFinishedMeeting(state)
      ? 'This is the public demo meeting. It is finished, and can be read and asked questions.'
      : 'This is the public demo meeting. It is read-only here, and not finished.'
  }
  if (state.rebuild) return 'Rebuilding the index for questions.'
  if (state.stop === 'trouble') return `${TROUBLE_TITLE[state.troubleCause ?? 'server']}. This page has stopped asking.${retry}`
  if (state.stop === 'stalled') return `Paused: nothing is moving.${retry}`
  if (state.pause === 'network' || state.pause === 'server' || state.pause === 'unavailable' || state.pause === 'rate-limited') {
    return `${TROUBLE_TITLE[state.pause]}. Trying again by itself.`
  }
  if (state.pause === 'spinning') return 'Paused: nothing is moving. Trying again by itself.'
  if (status === 'pending_upload') return 'Waiting for the upload to be confirmed.'
  if (state.stop === 'failed') return `${failure?.title ?? 'This meeting stopped'}.${retry}`
  if (status === 'failed' && failure && state.answer?.index.state !== 'building') return `${failure.title}.`

  if (state.stop === 'finished') {
    switch (state.answer?.index.state) {
      case 'complete':
        return state.answer.index.total
          ? 'Finished. This meeting can be read and asked questions.'
          : 'Finished. There was nothing to index, so there is nothing to ask.'
      case 'parked':
        return `Finished for now. This meeting can be read, and questions stay off until indexing can carry on.${retryOpen ? ' You can carry on now.' : ''}`
      case 'held':
        return 'Finished. This meeting can be read, and questions stay off until its index is rebuilt.'
      default:
        return 'Finished. This meeting can be read, and questions stay off until its index is finished.'
    }
  }

  const prefix = state.role === 'watching' ? 'Watching another tab. ' : ''
  if (isLongWait(state)) return `${prefix}Paused: waiting for the provider. It carries on by itself.`
  const parts = state.answer?.progress.stage === 'summarization' ? state.answer.progress : null
  const extracting = parts?.total
    ? `Extracting decisions and action items: ${parts.done} of ${parts.total} parts done.`
    : 'Extracting decisions and action items.'
  switch (status) {
    case 'uploaded':
    case 'transcribing':
      return `${prefix}Transcribing. This can take a moment.`
    case 'summarizing':
    case 'indexing':
      return `${prefix}${extracting}`
    default:
      return state.answer?.index.state === 'building' ? `${prefix}Indexing the transcript for questions.` : prefix.trim()
  }
}

/**
 * The next-request countdown, on the screen and out of the live region. Only for the plain
 * case: a banner says its own time, and a stopped tab has no next request.
 */
export function countdownOf(state: DriverState, now: number): string | null {
  if (state.stop || state.pause !== 'wait' || isLongWait(state) || state.nextRequestAt === null) return null
  const left = state.nextRequestAt - now
  return left > 0 ? `Next request in ${formatWait(left)}.` : null
}
