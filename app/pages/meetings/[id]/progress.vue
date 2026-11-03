<script setup lang="ts">
import type { Meeting, MeetingStatus, PipelineResponse, TranscriptSegment } from '#shared/types/meeting'
import type { StageState } from '~/utils/pipeline-view'

const route = useRoute()
const meetingId = computed(() => String(route.params.id))

// Without the stored error, which this page has its own words for, so that it is not in the
// server's render either: it can hold a provider's or a database's own words.
const { data, error, refresh } = await useFetch<{ meeting: Meeting }>(`/api/meetings/${meetingId.value}`, {
  transform: ({ meeting }) => ({ meeting: { ...meeting, errorMessage: null } }),
})
if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusCode === 404 ? 'Meeting not found' : 'Could not load meeting',
    fatal: true,
  })
}
const meeting = computed(() => data.value!.meeting)

useSeoMeta({ title: () => `MeetMind — ${meeting.value.title}` })

const { data: transcriptData, refresh: refreshTranscript }
  = await useFetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meetingId.value}/transcript`)
const segments = computed(() => transcriptData.value?.segments ?? [])

/** Failing to read this costs only what it says: the driver asks again as soon as it starts. */
const { data: firstAnswer } = await useFetch<PipelineResponse>(`/api/meetings/${meetingId.value}/pipeline`)

/**
 * The page drives the meeting, with no click (ADR-0012 §1), and opening it is enough
 * (ADR-0013), except on the public demo, whose `/advance` can only answer 403 (ADR-0015):
 * a visitor there reads what is stored, and nothing on this page asks for a step.
 */
const readOnly = isDemoMeetingId(useRuntimeConfig().public.demoMeetingId, meetingId.value)
const { state, now, retry, rebuildIndex } = usePipelineDriver(meetingId.value, {
  initial: firstAnswer.value ?? null,
  readOnly,
})

const status = computed<MeetingStatus>(() => state.value.answer?.status ?? meeting.value.status)

/**
 * The row and the transcript are read when the status moves, not on every step: a page of a
 * reply does not change either, and reading a whole transcript per step would grow with the
 * meeting. Until that read is back the transcript's size is not known, and is not guessed at.
 */
const transcriptReadAt = ref<MeetingStatus>(meeting.value.status)
let latestRead = 0
watch(status, async (moved) => {
  // A read cancels the one before it, and that one can still be the last to come back.
  const thisRead = ++latestRead
  await Promise.all([refresh(), refreshTranscript()])
  if (thisRead === latestRead) transcriptReadAt.value = moved
})

const facts = computed(() => ({
  status: status.value,
  failedStage: meeting.value.failedStage,
  segmentCount: transcriptReadAt.value === status.value ? segments.value.length : null,
  audioLabel: formatMegabytes(meeting.value.audioBytes),
}))

const stages = computed(() => stagesOf(state.value, facts.value))
const banner = computed(() => bannerOf(state.value, now.value))
const failure = computed(() => failureOf(state.value, facts.value))
const retryAction = computed(() => retryOf(state.value, facts.value, now.value))
const questions = computed(() => questionsOf(state.value, now.value))
const countdown = computed(() => countdownOf(state.value, now.value))
const announcement = computed(() => announcementOf(state.value, facts.value, retryAction.value?.open ?? false))

const STAGE_ICON: Record<StageState, string> = {
  done: 'i-lucide-circle-check',
  active: 'i-lucide-loader-circle',
  waiting: 'i-lucide-clock',
  paused: 'i-lucide-circle-pause',
  failed: 'i-lucide-circle-x',
  attention: 'i-lucide-circle-alert',
  pending: 'i-lucide-circle-dashed',
  unfinished: 'i-lucide-circle-dashed',
}

const STAGE_TONE: Record<StageState, string> = {
  done: 'text-success',
  active: 'text-info animate-spin',
  waiting: 'text-info',
  paused: 'text-warning',
  failed: 'text-error',
  attention: 'text-warning',
  pending: 'text-dimmed',
  unfinished: 'text-dimmed',
}

const statusColor = computed(() => ({
  pending_upload: 'warning',
  uploaded: 'success',
  transcribing: 'info',
  summarizing: 'info',
  indexing: 'info',
  ready: 'success',
  failed: 'error',
} as const)[status.value])

const statusText = computed(() => status.value.replace('_', ' '))

// See shared/utils/meeting.ts for what this actually checks and why.
const showTranscribedButEmpty = computed(() =>
  facts.value.segmentCount !== null
  && transcribedButEmpty({ status: status.value, failedStage: meeting.value.failedStage }, facts.value.segmentCount))

/**
 * In the visitor's own time and language once mounted. The server knows neither, and a first
 * client render that differed from its copy was this page's hydration mismatch, so until then
 * both say the same fixed thing.
 */
const createdAt = computed(() => now.value
  ? new Date(meeting.value.createdAt).toLocaleString()
  : `${meeting.value.createdAt.slice(0, 16).replace('T', ' ')} UTC`)

const heading = ref<HTMLElement | null>(null)

/**
 * The button the visitor just pressed goes away once it has done its work. Put focus somewhere
 * that says what happened, rather than letting it fall to <body>.
 */
async function keepFocus() {
  await nextTick()
  if (document.activeElement && document.activeElement !== document.body) return
  heading.value?.focus()
}

function tryAgain() {
  retry()
  void keepFocus()
}

function rebuild() {
  rebuildIndex()
  void keepFocus()
}
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-10">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">
          {{ meeting.title }}
        </h1>
        <p class="mt-1 text-sm text-muted">
          {{ meeting.sourceFileName }} · {{ formatMegabytes(meeting.sourceBytes) }} video
          <template v-if="meeting.durationSec">
            · {{ formatDuration(meeting.durationSec) }}
          </template>
          · created {{ createdAt }}
        </p>
      </div>
      <UBadge
        :color="statusColor"
        variant="subtle"
        class="capitalize"
      >
        {{ statusText }}
      </UBadge>
    </div>

    <MeetingLinkNotice :meeting-id="meetingId" />

    <!-- Not a live region: it can hold a countdown. The announcement below says the same
         thing once, without the time. -->
    <UAlert
      v-if="banner"
      :color="banner.color"
      variant="subtle"
      :icon="banner.icon"
      :title="banner.title"
      :description="banner.description"
    />

    <UCard>
      <template #header>
        <h2
          ref="heading"
          tabindex="-1"
          class="font-semibold focus:outline-none"
        >
          Pipeline
        </h2>
      </template>
      <ol
        aria-label="Pipeline stages"
        class="space-y-4"
      >
        <li
          v-for="stage in stages"
          :key="stage.key"
          class="flex items-start gap-3"
          :aria-current="stage.current ? 'step' : undefined"
        >
          <UIcon
            :name="STAGE_ICON[stage.state]"
            class="mt-0.5 size-5 shrink-0"
            :class="STAGE_TONE[stage.state]"
          />
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-baseline justify-between gap-x-3">
              <span
                class="font-medium"
                :class="stage.state === 'pending' ? 'text-muted' : ''"
              >{{ stage.label }}</span>
              <!-- In words, for every state: the icon and its colour are never the only way to tell. -->
              <span class="text-sm text-muted">{{ stage.stateText }}</span>
            </p>
            <p class="text-sm text-muted">
              {{ stage.detail }}
            </p>
          </div>
        </li>
      </ol>

      <template #footer>
        <div class="space-y-2">
          <div class="flex flex-wrap items-center gap-3">
            <UButton
              v-if="retryAction?.open"
              icon="i-lucide-rotate-ccw"
              @click="tryAgain"
            >
              {{ retryAction.label }}
            </UButton>
            <!-- One region for the whole page, always mounted, so it is never created at the
                 moment it has something to say, which would not be announced. -->
            <span
              class="text-sm text-muted"
              role="status"
              aria-live="polite"
            >{{ announcement }}</span>
          </div>
          <p
            v-if="countdown"
            class="text-sm text-muted tabular-nums"
          >
            {{ countdown }}
          </p>
          <p
            v-if="retryAction && !retryAction.open"
            class="text-sm text-muted tabular-nums"
          >
            {{ state.stop === 'finished' ? 'Indexing can carry on' : 'You can try again' }} in {{ formatWait(retryAction.opensInMs) }}.
          </p>
          <p
            v-if="state.role === 'watching' && !state.stop"
            class="text-sm text-muted"
          >
            Another tab of this browser is doing the work. This one only watches, and takes over if that tab closes.
          </p>
          <p
            v-else-if="state.role === 'driving' && !state.stop"
            class="text-sm text-muted"
          >
            This page is doing the work, so keep it open. If you close it, nothing is lost: it carries on from the same place when you open it again.
          </p>
        </div>
      </template>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Questions
        </h2>
      </template>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          {{ questions.text }}
        </p>
        <div
          v-if="questions.link || questions.rebuildLabel"
          class="flex flex-wrap items-center gap-3"
        >
          <UButton
            v-if="questions.link === 'ask'"
            :to="`/meetings/${meetingId}`"
            variant="ghost"
            icon="i-lucide-message-circle-question"
          >
            Ask on the meeting page
          </UButton>
          <UButton
            v-else-if="questions.link === 'read'"
            :to="`/meetings/${meetingId}`"
            variant="ghost"
            icon="i-lucide-book-open"
          >
            Read the meeting
          </UButton>
          <UButton
            v-if="questions.rebuildLabel"
            icon="i-lucide-search"
            variant="soft"
            @click="rebuild"
          >
            {{ questions.rebuildLabel }}
          </UButton>
        </div>
      </div>
      <UAlert
        v-if="state.rebuildError"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mt-3"
        title="Indexing failed"
        :description="state.rebuildError"
      />
    </UCard>

    <!-- This page's own words. What is stored on the row can be a provider's or a database's,
         and the routes the driver reads carry none of it (ADR-0012's step 9 addendum). -->
    <UAlert
      v-if="failure"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="failure.title"
      :description="failure.description"
    />
    <UAlert
      v-else-if="status === 'pending_upload'"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock"
      title="Waiting for audio"
      description="The upload has not been confirmed yet. Return to the upload screen to retry."
    />

    <UAlert
      v-if="showTranscribedButEmpty"
      color="warning"
      variant="subtle"
      icon="i-lucide-message-square-off"
      title="No speech was found"
      description="Transcription ran and returned nothing. The recording may be silent."
    />

    <UCard v-if="segments.length">
      <template #header>
        <h2 class="font-semibold">
          Transcript
        </h2>
      </template>
      <ol class="space-y-3">
        <li
          v-for="segment in segments"
          :key="segment.idx"
          class="flex gap-3 text-sm"
        >
          <!-- Fixed width so the text column does not shift when timestamps
               grow an hours digit. text-muted, not text-dimmed, which measures
               below the contrast minimum at this size. -->
          <span class="w-16 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
            {{ formatDuration(segment.startMs / 1000) }}
          </span>
          <span>{{ segment.text }}</span>
        </li>
      </ol>
      <template #footer>
        <p class="text-sm text-muted">
          Clicking a line to seek the audio arrives with the player in the next phase.
        </p>
      </template>
    </UCard>

    <div class="flex gap-3">
      <UButton
        :to="`/meetings/${meetingId}`"
        variant="ghost"
        color="neutral"
        icon="i-lucide-file-text"
      >
        Transcript &amp; player
      </UButton>
      <UButton
        to="/"
        variant="soft"
        icon="i-lucide-upload-cloud"
      >
        Upload another
      </UButton>
    </div>
  </UContainer>
</template>
