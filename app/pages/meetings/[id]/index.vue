<script setup lang="ts">
import type { Meeting, TranscriptSegment } from '#shared/types/meeting'

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
  const target = el.offsetTop - (container.clientHeight - el.clientHeight) / 2
  container.scrollTop = Math.max(0, target)
}

watch(followIndex, (index) => {
  if (!followPlayback.value || index < 0) return
  void nextTick(() => centreOn(index))
})

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

watch(followIndex, () => {
  void nextTick(() => {
    lastProgrammaticTop = list.value?.scrollTop ?? -1
  })
})

/** Resume following and go to where playback actually is, not where the view was. */
function resumeFollow() {
  followPlayback.value = true
  const index = followIndex.value
  if (index >= 0) void nextTick(() => centreOn(index))
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
  followPlayback.value = true
  if (audio.paused) {
    void audio.play().catch(() => {
      // Autoplay can be refused; the seek still happened, which is the point.
    })
  }
}

const focusIndex = ref(0)

function onSelect(segment: TranscriptSegment, index: number) {
  focusIndex.value = index
  seekTo(segment)
}

/**
 * Tabbing in should land on the line being played, not the top of the
 * transcript, and must not be mistaken for the user scrolling away.
 */
function onListFocusIn(event: FocusEvent) {
  const entered = (event.target as HTMLElement | null)?.dataset?.idx
  if (entered !== undefined) {
    focusIndex.value = Number(entered)
    return
  }
  if (activeIndex.value >= 0) focusIndex.value = activeIndex.value
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
    void nextTick(() => lineAt(focusIndex.value)?.focus())
  }
  if (event.key === 'ArrowDown') return move(index + 1)
  if (event.key === 'ArrowUp') return move(index - 1)
  if (event.key === 'Home') return move(0)
  if (event.key === 'End') return move(last)
}

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
      v-else
      color="neutral"
      variant="subtle"
      icon="i-lucide-file-text"
      title="No transcript yet"
      description="Run transcription from the progress screen to see the meeting's words here."
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
