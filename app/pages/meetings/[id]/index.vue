<script setup lang="ts">
import type { Meeting, MeetingSummary, TranscriptSegment } from '#shared/types/meeting'

const route = useRoute()
const meetingId = computed(() => String(route.params.id))

const { data, error } = await useFetch<{ meeting: Meeting }>(`/api/meetings/${meetingId.value}`)
if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusCode === 404 ? 'Meeting not found' : 'Could not load meeting',
    fatal: true,
  })
}
const meeting = computed(() => data.value!.meeting)

const { data: transcriptData } = await useFetch<{ segments: TranscriptSegment[] }>(
  `/api/meetings/${meetingId.value}/transcript`,
)
const segments = computed(() => transcriptData.value?.segments ?? [])

const { data: summaryData } = await useFetch<{ summary: MeetingSummary | null }>(
  `/api/meetings/${meetingId.value}/summary`,
)
const summary = computed(() => summaryData.value?.summary ?? null)

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
  currentMs.value = Math.round((player.value?.currentTime ?? 0) * 1000)
}

function onAudioError() {
  audioError.value = 'The audio could not be loaded, so seeking is unavailable.'
}

/** Clear a previous complaint once the element proves it can play. */
function onAudioReady() {
  audioError.value = null
}

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
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    audioError.value = 'The audio is not ready yet, so this line cannot be played.'
    return
  }
  audio.currentTime = segment.startMs / 1000
  currentMs.value = segment.startMs
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
  if (audio.paused) {
    void audio.play().catch(() => {
      // Autoplay can be refused; the seek still happened, which is the point.
    })
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
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    audioError.value = 'The audio is not ready yet, so this line cannot be played.'
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

/** What to say when there are no segments, which means different things by status. */
const emptyTranscript = computed(() => {
  const { status, failedStage } = meeting.value
  if (transcribedButEmpty(meeting.value, 0)) {
    return { title: 'No speech was found', description: 'Transcription ran and returned nothing. The recording may be silent.' }
  }
  if (status === 'failed' && failedStage === 'upload') {
    return { title: 'No audio to transcribe', description: 'The uploaded audio was rejected and removed. Upload the recording again.' }
  }
  if (status === 'transcribing') {
    return { title: 'Transcription is running', description: 'The transcript will appear here when it finishes.' }
  }
  if (status === 'pending_upload') {
    return { title: 'Waiting for audio', description: 'The upload has not been confirmed yet.' }
  }
  return { title: 'No transcript yet', description: 'Run transcription from the progress screen to see the meeting\'s words here.' }
})

const audioSrc = computed(() => `/api/meetings/${meetingId.value}/audio`)
const hasAudio = computed(() => meeting.value.status !== 'pending_upload')
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
        · {{ segments.length }} transcript segments
      </p>
    </div>

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
        @loadedmetadata="onAudioReady"
        @canplay="onAudioReady"
        @playing="onAudioReady"
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
        icon="i-lucide-archive"
      >
        All meetings
      </UButton>
    </div>
  </UContainer>
</template>
