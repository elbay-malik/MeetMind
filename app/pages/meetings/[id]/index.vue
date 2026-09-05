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

const activeIndex = computed(() => findActiveSegment(segments.value, currentMs.value))
const followIndex = computed(() => findFollowSegment(segments.value, currentMs.value))

/**
 * The element's own timeupdate fires about four times a second, which is
 * frequent enough to highlight a line and cheap enough not to throttle.
 */
function onTimeUpdate() {
  currentMs.value = Math.round((player.value?.currentTime ?? 0) * 1000)
}

function resumeFollow() {
  followPlayback.value = true
}

function onSelect(segment: TranscriptSegment, index: number) {
  focusIndex.value = index
  seekTo(segment)
}

/** Clicking a line seeks; the highlight then follows from the player itself. */
function seekTo(segment: TranscriptSegment) {
  const audio = player.value
  if (!audio) return
  audio.currentTime = segment.startMs / 1000
  // Resume following: a deliberate jump means the user wants to be there.
  followPlayback.value = true
  currentMs.value = segment.startMs
  if (audio.paused) void audio.play().catch(() => {
    // Autoplay can be refused; seeking still worked, which is the point.
  })
}

// Auto-scroll, but stop the moment the user takes over and resume when they
// return to the active line. Scroll events fire for our own scrolling too, so
// distinguish them with a flag rather than trying to detect intent.
let scrollingSelf = false
let releaseTimer: ReturnType<typeof setTimeout> | null = null

function onUserScroll() {
  if (scrollingSelf) return
  followPlayback.value = false
  if (releaseTimer) clearTimeout(releaseTimer)
  // Long enough that a read-ahead is not interrupted, short enough that the
  // view does not stay stranded once they stop.
  releaseTimer = setTimeout(() => {
    followPlayback.value = true
  }, 8000)
}

watch(followIndex, (index) => {
  if (!followPlayback.value || index < 0) return
  const el = list.value?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
  if (!el) return
  scrollingSelf = true
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // The flag has to outlive a smooth scroll, which emits events for a while.
  setTimeout(() => {
    scrollingSelf = false
  }, 700)
})

onUnmounted(() => {
  if (releaseTimer) clearTimeout(releaseTimer)
})

/**
 * Roving tabindex: the transcript is one tab stop, not one per line, and the
 * arrow keys move within it. Thousands of tab stops would make the page
 * unusable by keyboard.
 */
const focusIndex = ref(0)
function onKeydown(event: KeyboardEvent, index: number) {
  const last = segments.value.length - 1
  const move = (to: number) => {
    event.preventDefault()
    focusIndex.value = Math.max(0, Math.min(last, to))
    list.value?.querySelector<HTMLElement>(`[data-idx="${focusIndex.value}"]`)?.focus()
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
        @scroll.passive="onUserScroll"
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
              class="flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="index === activeIndex ? 'bg-primary/10 font-medium' : ''"
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
