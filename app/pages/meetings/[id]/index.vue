<script setup lang="ts">
import type { MeetingSummary, PublicMeeting, TranscriptSegment } from '#shared/types/meeting'

const route = useRoute()
const meetingId = computed(() => String(route.params.id))

const { data, error } = await useFetch<{ meeting: PublicMeeting }>(`/api/meetings/${meetingId.value}`, PAGE_READ)
if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusCode === 404 ? 'Meeting not found' : 'Could not load meeting',
    fatal: true,
  })
}
const meeting = computed(() => data.value!.meeting)

const { data: transcriptData, error: transcriptError, refresh: refreshTranscript, status: transcriptStatus } = await useFetch<{ segments: TranscriptSegment[] }>(
  `/api/meetings/${meetingId.value}/transcript`,
  PAGE_READ,
)
const segments = computed(() => transcriptData.value?.segments ?? [])
/** A failed read is not an empty transcript, which would say that nobody spoke. */
const transcriptUnread = computed(() => !!transcriptError.value && !transcriptData.value)

const { data: summaryData, error: summaryError, refresh: refreshSummary, status: summaryStatus } = await useFetch<{ summary: MeetingSummary | null }>(
  `/api/meetings/${meetingId.value}/summary`,
  PAGE_READ,
)
const summary = computed(() => summaryData.value?.summary ?? null)
const summaryUnread = computed(() => !!summaryError.value && !summaryData.value)
useReadAgain(() => transcriptUnread.value, () => refreshTranscript())
useReadAgain(() => summaryUnread.value, () => refreshSummary())

useSeoMeta({ title: () => `MeetMind — ${meeting.value.title}` })

const player = ref<HTMLAudioElement | null>(null)
const list = ref<HTMLElement | null>(null)
const currentMs = ref(0)
const followPlayback = ref(true)
const audioError = ref<string | null>(null)

const activeIndex = computed(() => findActiveSegment(segments.value, currentMs.value))
const followIndex = computed(() => findFollowSegment(segments.value, currentMs.value))

/** The element's own timeupdate fires about four times a second. */
function onTimeUpdate() {
  // A load starts the element from 0, which is not where the visitor is.
  if (resumeAt) return
  const ms = Math.round((player.value?.currentTime ?? 0) * 1000)
  if (ms !== currentMs.value) watchForStuck()
  currentMs.value = ms
}

/** Few, and not reset by metadata: a recording whose head loads and whose middle fails loads again and again. */
const AUDIO_MAX_RETRIES = 2
const LOAD_FAILED = 'The audio could not be loaded, so seeking is unavailable.'
let audioRetryTimer: ReturnType<typeof setTimeout> | undefined
let audioRetries = 0
let resumeAt: { sec: number, play: boolean } | null = null

/** From the element's events, as Chromium has already paused it by the time it reports an error. */
let wantsPlay = false
function onAudioPlay() {
  wantsPlay = true
  watchForStuck()
}
function onAudioPause() {
  if (!player.value?.error) wantsPlay = false
  watchForStuck()
}

function onAudioError() {
  audioError.value = LOAD_FAILED
  if (audioRetryTimer || audioRetries >= AUDIO_MAX_RETRIES) return
  audioRetryTimer = setTimeout(() => {
    audioRetries++
    // A load that failed has no position of its own, so what it was asked for still stands.
    const { sec, play } = resumeAt ?? { sec: player.value?.currentTime ?? 0, play: wantsPlay }
    recoverAudio(sec, play)
  }, PAGE_RETRY_MS)
}

/**
 * WebKit raises no error when a range fails after the metadata: it asks again and takes the
 * failure's body for audio, and can stand still as "playing" after the failure has ended. Long,
 * as a far seek on a slow connection is also no progress for a while, and this restarts it.
 */
const AUDIO_STUCK_MS = 20_000
let stuckTimer: ReturnType<typeof setTimeout> | undefined
function watchForStuck() {
  clearTimeout(stuckTimer)
  const audio = player.value
  if (!audio || audio.paused || audio.ended || audio.error) return
  stuckTimer = setTimeout(() => {
    if (audio.paused || audio.ended || audio.error) return
    audioError.value = LOAD_FAILED
    if (audioRetries >= AUDIO_MAX_RETRIES) return
    audioRetries++
    recoverAudio(audio.currentTime, true)
  }, AUDIO_STUCK_MS)
}

/** An element that has failed stays failed until it is told to load again, which starts it from 0. */
function recoverAudio(sec: number, play: boolean) {
  clearTimeout(audioRetryTimer)
  audioRetryTimer = undefined
  resumeAt = { sec, play }
  currentMs.value = Math.round(sec * 1000)
  player.value?.load()
}

/** Without replacing a load failure: audio that has gone from storage will never be ready. */
function explainNoAudio() {
  audioError.value ??= 'The audio is not ready yet, so this line cannot be played.'
}

/** Clear a previous complaint once the element proves it can play. */
function onAudioReady() {
  audioError.value = null
}

/** The only proof that the audio itself comes through, and not only the head of the file. */
function onAudioPlaying() {
  onAudioReady()
  audioRetries = 0
  watchForStuck()
}

/** Not proof of anything: the head of a file can load when the part wanted does not. */
function onAudioMetadata() {
  const audio = player.value
  if (!audio || !resumeAt) return
  audio.currentTime = resumeAt.sec
  currentMs.value = Math.round(resumeAt.sec * 1000)
  if (resumeAt.play) {
    void audio.play().catch(() => {
      // Autoplay can be refused; the seek still happened, which is the point.
    })
  }
  resumeAt = null
}

onBeforeUnmount(() => {
  clearTimeout(audioRetryTimer)
  clearTimeout(stuckTimer)
})

function lineAt(index: number) {
  return list.value?.querySelector<HTMLElement>(`[data-idx="${index}"]`) ?? null
}

/**
 * Scroll a line into view within the transcript container only.
 *
 * scrollIntoView would also scroll the page, pushing the player off screen,
 * and its smooth animation emits scroll events for an unbounded time — which
 * the old implementation mistook for the user taking over. Setting scrollTop
 * directly keeps the effect inside the container and is instantaneous, so
 * there is no window in which our own scrolling can be misread as theirs.
 */
function centreOn(index: number) {
  const container = list.value
  const el = lineAt(index)
  if (!container || !el) return
  // getBoundingClientRect, not el.offsetTop: offsetTop is relative to
  // el.offsetParent, the nearest POSITIONED ancestor — not necessarily this
  // container. This container has no `position` of its own (just
  // overflow-y-auto), so offsetTop was relative to whatever positioned
  // ancestor was actually nearest (the page, with the summary/player content
  // above the transcript pushing everything down), computing a wildly
  // oversized scrollTop that jumped the list to its bottom instead of
  // centering the focused line. Comparing bounding rects is independent of
  // the offsetParent chain: this element's position relative to the
  // container's OWN scroll origin, regardless of what either is positioned
  // against.
  const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  const target = elTop - (container.clientHeight - el.clientHeight) / 2
  container.scrollTop = Math.max(0, target)
}

/**
 * Treat a scroll as the user's only when it moved somewhere we did not put it.
 * Comparing against the position we last set is reliable in a way that timing
 * heuristics are not.
 */
let lastProgrammaticTop = -1
function onListScroll() {
  const top = list.value?.scrollTop ?? 0
  if (Math.abs(top - lastProgrammaticTop) <= 2) return
  followPlayback.value = false
}

/**
 * centreOn, plus recording where it actually left the scroll position.
 * scrollTop assignment fires a native 'scroll' event same as a user's own
 * scroll would, just dispatched asynchronously rather than inside this same
 * call — so setting lastProgrammaticTop here, before that event is handled,
 * is what keeps onListScroll from reading our own centring as the user
 * taking over and immediately flipping followPlayback back off. This used to
 * be a second watcher paired with the one below by registration order alone
 * (both scheduled via nextTick on the same tick) — which resumeFollow, since
 * it calls centreOn directly rather than through the watch, was never part
 * of: resuming set followPlayback true, centreOn moved the scroll position,
 * and onListScroll — with lastProgrammaticTop never updated for this call —
 * read that as the user scrolling and flipped it straight back off.
 */
function centreAndTrack(index: number) {
  centreOn(index)
  lastProgrammaticTop = list.value?.scrollTop ?? -1
}

watch(followIndex, (index) => {
  if (!followPlayback.value || index < 0) return
  void nextTick(() => centreAndTrack(index))
})

/** Resume following and go to where playback actually is, not where the view was. */
function resumeFollow() {
  followPlayback.value = true
  const index = followIndex.value
  if (index >= 0) void nextTick(() => centreAndTrack(index))
}

/** Clicking a line seeks; the highlight then follows from the player itself. */
function seekTo(segment: TranscriptSegment) {
  const audio = player.value
  if (!audio) return
  const sec = segment.startMs / 1000
  if (audio.error) {
    explainNoAudio()
    recoverAudio(sec, true)
  }
  // After the end, WebKit ends again at once on a seek to an MP4, and believes the new end.
  else if (audio.ended) {
    recoverAudio(sec, true)
  }
  // A load is under way, so this line replaces the one it was going to land on.
  else if (resumeAt) {
    resumeAt = { sec, play: true }
    currentMs.value = segment.startMs
  }
  else if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    explainNoAudio()
    return
  }
  else {
    audio.currentTime = sec
    currentMs.value = segment.startMs
    if (audio.paused) {
      void audio.play().catch(() => {
        // Autoplay can be refused; the seek still happened, which is the point.
      })
    }
  }
  const wasFollowing = followPlayback.value
  followPlayback.value = true
  // Re-enabling following on the line that is ALREADY the follow target does
  // not change followIndex, so its watcher never recentres — and
  // lastProgrammaticTop stays whatever the user scrolled to, which the next
  // scroll event reads as the user taking over again.
  if (!wasFollowing) {
    const index = followIndex.value
    if (index >= 0) void nextTick(() => centreAndTrack(index))
  }
}

const focusIndex = ref(0)

/** Jump to the moment a summary item cites. */
function seekToCitation(startMs: number, segmentIdx: number) {
  const segment = segments.value.find(s => s.idx === segmentIdx)
  if (segment) return onSelect(segment, segments.value.indexOf(segment))
  const audio = player.value
  if (!audio) return
  // Same guard and the same message as seekTo: this used to be a silent no-op
  // when the audio was not ready, while clicking a transcript line in that
  // same state explained itself.
  if (audio.error) {
    explainNoAudio()
    recoverAudio(startMs / 1000, true)
    return
  }
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    explainNoAudio()
    return
  }
  audio.currentTime = startMs / 1000
}

function onSelect(segment: TranscriptSegment, index: number) {
  focusIndex.value = index
  seekTo(segment)
}

/**
 * Keep the roving tab stop on whichever line actually received focus.
 *
 * Landing on the line being played when tabbing in is the activeIndex watcher
 * below, not this: every focusable descendant of the list is a line button
 * carrying data-idx, and the scroll container itself is not a tab stop, so the
 * fallback this used to have for "focus landed on something else" could never
 * run.
 */
function onListFocusIn(event: FocusEvent) {
  const entered = (event.target as HTMLElement | null)?.dataset?.idx
  if (entered !== undefined) focusIndex.value = Number(entered)
}

// Keep the tab stop on the line being played while the user is not in the list.
watch(activeIndex, (index) => {
  if (index < 0) return
  const inList = list.value?.contains(document.activeElement)
  if (!inList) focusIndex.value = index
})

// A transcript can shrink under us; never leave the tab stop past the end.
watch(segments, (next) => {
  if (focusIndex.value > next.length - 1) focusIndex.value = Math.max(0, next.length - 1)
})

/**
 * Roving tabindex: the transcript is one tab stop, not one per line, and the
 * arrow keys move within it. Thousands of tab stops would make the page
 * unusable by keyboard.
 */
function onKeydown(event: KeyboardEvent, index: number) {
  const last = segments.value.length - 1
  const move = (to: number) => {
    event.preventDefault()
    focusIndex.value = Math.max(0, Math.min(last, to))
    // Focusing scrolls the line into view; that is the user's own navigation,
    // so stop following rather than fighting them for the scroll position.
    followPlayback.value = false
    void nextTick(() => {
      // preventScroll, then centre within the container ourselves: the default
      // focus scroll moves the whole page, which pushes the player out of view.
      lineAt(focusIndex.value)?.focus({ preventScroll: true })
      // Tracked, like every other programmatic scroll. It happens to be safe
      // untracked here only because followPlayback was just set false, so
      // onListScroll never compares against lastProgrammaticTop — the next
      // thing that turns following back on without recentring would read a
      // stale value and switch it straight off again.
      centreAndTrack(focusIndex.value)
    })
  }
  if (event.key === 'ArrowDown') return move(index + 1)
  if (event.key === 'ArrowUp') return move(index - 1)
  if (event.key === 'Home') return move(0)
  if (event.key === 'End') return move(last)
}

/** Nothing on the pipeline page can move the public demo (ADR-0015), so nothing here sends anyone there. */
const isDemo = computed(() => isDemoMeetingId(useRuntimeConfig().public.demoMeetingId, meetingId.value))
const DEMO_STAYS_AS_IT_IS = 'This demo meeting is read-only, so it stays as it is here.'
const deployment = useDeploymentFacts()

/** What to say when there are no segments, which means different things by status. */
const emptyTranscript = computed(() => {
  const { status } = meeting.value
  if (transcribedButEmpty(meeting.value, 0)) {
    return { title: 'No speech was found', description: 'Transcription ran and returned nothing. The recording may be silent.' }
  }
  if (uploadWasRejected(meeting.value)) {
    return { title: 'No audio to transcribe', description: 'The uploaded audio was rejected and removed. Upload the recording again.' }
  }
  if (status === 'transcribing') {
    return { title: 'Transcription is not finished', description: isDemo.value ? DEMO_STAYS_AS_IT_IS : transcriptionMoves(deployment.value.sweeps, 'It') }
  }
  if (status === 'pending_upload') {
    return { title: 'Waiting for audio', description: 'The upload has not been confirmed yet.' }
  }
  // Only `uploaded`, as a tick retries nothing and that is all else that reaches here.
  return { title: 'No transcript yet', description: isDemo.value ? DEMO_STAYS_AS_IT_IS : transcriptionStarts(status === 'uploaded' && deployment.value.sweeps) }
})

/**
 * Pages of a transcript are readable as they are stored, and after an attempt
 * that failed part-way until a retry replaces them. What to say about lines that
 * are not all of it; null when they are.
 */
const incompleteTranscript = computed(() => {
  const { status, failedStage } = meeting.value
  if (status === 'transcribing') {
    return { title: 'This transcript is not finished', description: `These are the lines so far. ${isDemo.value ? DEMO_STAYS_AS_IT_IS : transcriptionMoves(deployment.value.sweeps, 'Transcription')}` }
  }
  if (status === 'failed' && failedStage === 'transcription') {
    return { title: 'This transcript is not finished', description: `Transcription failed part-way, so these lines may stop early. ${isDemo.value ? DEMO_STAYS_AS_IT_IS : 'Open Pipeline to see whether it can be tried again.'}` }
  }
  return null
})

const audioSrc = computed(() => `/api/meetings/${meetingId.value}/audio`)
// Not just `pending_upload`: a rejected upload had its object deleted, so
// mounting a player for it only ever produces "Audio unavailable" above
// this page's own correct explanation that the recording was removed.
const hasAudio = computed(() =>
  meeting.value.status !== 'pending_upload' && !uploadWasRejected(meeting.value))

/**
 * A link to one moment: `?t=<startMs>&seg=<segmentIdx>`. Both must be present and
 * numeric, or this is some other visit to the page, not a followed link — a
 * half-formed query string should render the page normally, not half-seek it.
 */
onMounted(() => {
  // A failure before hydration fired its event with nobody listening.
  if (player.value?.error) onAudioError()
  const startMs = Number(route.query.t)
  const segmentIdx = Number(route.query.seg)
  if (!Number.isFinite(startMs) || !Number.isFinite(segmentIdx)) return
  const trySeek = () => seekToCitation(startMs, segmentIdx)
  const audio = player.value
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) trySeek()
  // Metadata (and so a real duration) loads asynchronously; seeking before
  // then is what audioError's "not ready yet" guard exists for, but a
  // followed link should just work rather than surface that as a failure.
  else audio?.addEventListener('loadedmetadata', trySeek, { once: true })
})
</script>

<template>
  <UContainer class="max-w-3xl space-y-6 py-10">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">
        {{ meeting.title }}
      </h1>
      <p class="mt-1 text-sm text-muted">
        {{ meeting.sourceFileName }}
        <template v-if="meeting.durationSec">
          · {{ formatDuration(meeting.durationSec) }}
        </template>
        <template v-if="!transcriptUnread">
          · {{ segments.length }} transcript segments{{ incompleteTranscript ? ' so far' : '' }}
        </template>
      </p>
    </div>

    <MeetingLinkNotice :meeting-id="meetingId" />

    <UCard v-if="hasAudio">
      <audio
        ref="player"
        :src="audioSrc"
        controls
        preload="metadata"
        class="w-full"
        @timeupdate="onTimeUpdate"
        @seeked="onTimeUpdate"
        @error="onAudioError"
        @play="onAudioPlay"
        @pause="onAudioPause"
        @loadedmetadata="onAudioMetadata"
        @canplay="onAudioReady"
        @playing="onAudioPlaying"
      />
      <UAlert
        v-if="audioError"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mt-3"
        title="Audio unavailable"
        :description="audioError"
      />
      <p class="mt-2 text-xs text-muted">
        Select any line to jump there. The transcript follows playback until you scroll away.
      </p>
    </UCard>

    <UCard v-if="summary">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-semibold">
            Summary
          </h2>
          <UBadge
            v-if="summary.provider === 'stub'"
            color="warning"
            variant="subtle"
            size="sm"
          >
            placeholder
          </UBadge>
        </div>
      </template>

      <div class="space-y-5">
        <p class="text-sm">
          {{ summary.summary }}
        </p>

        <div v-if="summary.decisions.length">
          <h3 class="mb-2 text-sm font-semibold">
            Decisions
          </h3>
          <ul class="space-y-1">
            <li
              v-for="decision in summary.decisions"
              :key="decision.idx"
            >
              <button
                type="button"
                class="flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-elevated/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
                @click="seekToCitation(decision.startMs, decision.segmentIdx)"
              >
                <span class="w-16 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
                  {{ formatDuration(decision.startMs / 1000) }}
                </span>
                <span class="min-w-0">
                  {{ decision.decision }}
                  <!-- The evidence, shown. It is checked against the transcript
                       before storage, but it only proves the WORDS were said,
                       not that they support the claim above them (see
                       ADR-0006) — a model can pair a real "Yeah." with any
                       decision. Showing it is what lets a reader catch that;
                       it used to be stored and never rendered. -->
                  <q class="mt-0.5 block text-xs text-muted italic">{{ decision.quote }}</q>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div v-if="summary.actionItems.length">
          <h3 class="mb-2 text-sm font-semibold">
            Action items
          </h3>
          <ul class="space-y-1">
            <li
              v-for="item in summary.actionItems"
              :key="item.idx"
            >
              <button
                type="button"
                class="flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-elevated/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
                @click="seekToCitation(item.startMs, item.segmentIdx)"
              >
                <span class="w-16 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
                  {{ formatDuration(item.startMs / 1000) }}
                </span>
                <span class="min-w-0">
                  {{ item.task }}
                  <!-- Absent, not unknown: the meeting simply did not say. -->
                  <span class="text-muted">
                    · {{ item.assignee ?? 'nobody named' }}
                    <template v-if="item.dueDateText">· due {{ item.dueDateText }}</template>
                  </span>
                  <!-- The evidence, shown. It is checked against the transcript
                       before storage, but it only proves the WORDS were said,
                       not that they support the claim above them (see
                       ADR-0006) — a model can pair a real "Yeah." with any
                       decision. Showing it is what lets a reader catch that;
                       it used to be stored and never rendered. -->
                  <q class="mt-0.5 block text-xs text-muted italic">{{ item.quote }}</q>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <p
          v-if="!summary.decisions.length && !summary.actionItems.length"
          class="text-sm text-muted"
        >
          No decisions or action items are recorded for this meeting.
        </p>
      </div>
    </UCard>

    <UAlert
      v-else-if="summaryUnread"
      role="alert"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="The summary could not be loaded"
      :actions="[{ label: 'Try again', color: 'neutral', variant: 'subtle', loading: summaryStatus === 'pending', onClick: () => refreshSummary() }]"
    />

    <MeetingQuestions
      :meeting-id="meetingId"
      @seek="seekToCitation"
    />

    <UAlert
      v-if="segments.length && incompleteTranscript"
      color="warning"
      variant="subtle"
      icon="i-lucide-hourglass"
      :title="incompleteTranscript.title"
      :description="incompleteTranscript.description"
    />

    <UCard v-if="segments.length">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-semibold">
            Transcript
          </h2>
          <UButton
            v-if="!followPlayback"
            size="xs"
            variant="soft"
            icon="i-lucide-crosshair"
            @click="resumeFollow"
          >
            Follow playback
          </UButton>
        </div>
      </template>

      <div
        ref="list"
        class="max-h-[60vh] overflow-y-auto"
        @scroll.passive="onListScroll"
        @focusin="onListFocusIn"
      >
        <ol class="space-y-1">
          <li
            v-for="(segment, index) in segments"
            :key="segment.idx"
          >
            <button
              type="button"
              :data-idx="index"
              :tabindex="index === focusIndex ? 0 : -1"
              :aria-current="index === activeIndex ? 'true' : undefined"
              class="flex w-full gap-3 rounded border-l-2 px-2 py-1 text-left text-sm hover:bg-elevated/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
              :class="index === activeIndex
                ? 'border-primary bg-primary/20 font-medium text-highlighted'
                : 'border-transparent'"
              @click="onSelect(segment, index)"
              @keydown="onKeydown($event, index)"
            >
              <span class="w-16 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
                {{ formatDuration(segment.startMs / 1000) }}
              </span>
              <span>{{ segment.text }}</span>
            </button>
          </li>
        </ol>
      </div>
    </UCard>

    <UAlert
      v-else-if="transcriptUnread"
      role="alert"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="The transcript could not be loaded"
      :actions="[{ label: 'Try again', color: 'neutral', variant: 'subtle', loading: transcriptStatus === 'pending', onClick: () => refreshTranscript() }]"
    />

    <!-- Driven by status, not by the segment count alone: a silent recording
         is `ready` with no segments, and telling that reader to "run
         transcription from the progress screen" sent them to a page offering
         no such action. -->
    <UAlert
      v-else
      color="neutral"
      variant="subtle"
      icon="i-lucide-file-text"
      :title="emptyTranscript.title"
      :description="emptyTranscript.description"
    />

    <div class="flex gap-3">
      <UButton
        :to="`/meetings/${meetingId}/progress`"
        variant="ghost"
        color="neutral"
        icon="i-lucide-arrow-left"
      >
        Pipeline
      </UButton>
      <UButton
        to="/meetings"
        variant="soft"
        icon="i-lucide-list"
      >
        Your meetings
      </UButton>
    </div>
  </UContainer>
</template>
