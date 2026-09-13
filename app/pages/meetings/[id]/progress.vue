<script setup lang="ts">
import type { Meeting, MeetingStatus, TranscriptSegment } from '#shared/types/meeting'

const route = useRoute()
const meetingId = computed(() => String(route.params.id))

const { data, error, refresh } = await useFetch<{ meeting: Meeting }>(`/api/meetings/${meetingId.value}`)
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

const transcribing = ref(false)
const stepError = ref<{ step: string, message: string } | null>(null)
const justFinished = ref(false)

async function reloadAll() {
  await Promise.all([refresh(), refreshTranscript()])
}

const summarizing = ref(false)

async function startSummary() {
  summarizing.value = true
  stepError.value = null
  try {
    await $fetch(`/api/meetings/${meetingId.value}/summarize`, { method: 'POST' })
  }
  catch (err) {
    stepError.value = { step: 'Extraction failed', message: describeError(err) }
  }
  finally {
    summarizing.value = false
    await reloadAll()
  }
}

async function startTranscription() {
  transcribing.value = true
  stepError.value = null
  justFinished.value = false
  try {
    await $fetch(`/api/meetings/${meetingId.value}/transcribe`, { method: 'POST' })
    justFinished.value = true
  }
  catch (err) {
    stepError.value = { step: 'Transcription failed', message: describeError(err) }
  }
  finally {
    transcribing.value = false
    await reloadAll()
  }
}

// A meeting can be left mid-transcription by another tab, or by a request that
// outlived its page. Poll so this screen converges instead of showing a state
// that never changes.
const POLL_MS = 5000
let poller: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  poller = setInterval(() => {
    if (meeting.value.status === 'transcribing' && !transcribing.value) void reloadAll()
    if (meeting.value.status === 'indexing' && !summarizing.value) void reloadAll()
  }, POLL_MS)
})
onUnmounted(() => {
  if (poller) clearInterval(poller)
})

/** The server's message when it gave one, rather than a generic failure. */
function describeError(err: unknown): string {
  const data = (err as { data?: { message?: string } }).data
  return data?.message ?? (err instanceof Error ? err.message : String(err))
}

interface Stage {
  key: string
  label: string
  detail: string
  reached: (status: MeetingStatus) => boolean
}

// Order of the pipeline. Later phases stream real per-stage progress here.
const STAGES: Stage[] = [
  {
    key: 'upload',
    label: 'Audio uploaded',
    detail: 'Compressed audio stored; the video stayed on your machine.',
    // Only `pending_upload` means the audio never arrived. A later failure does
    // not undo an upload that did happen.
    reached: s => s !== 'pending_upload',
  },
  {
    key: 'transcribe',
    label: 'Transcribed',
    detail: 'Speech turned into timestamped segments.',
    // Requires actual segments: a status alone would show a green tick for a
    // transcription that produced nothing. A `failed` meeting still counts
    // when the failure is summarize.post.ts's: that route only ever runs
    // against a transcript that already exists, so the transcript stage is
    // done regardless of how extraction went.
    reached: s => (['summarizing', 'indexing', 'ready'].includes(s)
      || (s === 'failed' && meeting.value.failedStage === 'summarization')) && segments.value.length > 0,
  },
  {
    key: 'summarize',
    label: 'Summarized',
    detail: 'Decisions and action items extracted.',
    // `ready` only: `indexing` is the in-flight claim summarize.post.ts sets
    // the instant it starts, exactly as `transcribing` means "not done yet"
    // for the stage above. Including it here showed a green tick for an
    // extraction that had not actually produced anything.
    reached: s => s === 'ready',
  },
  // No "Indexing" stage: nothing in this codebase indexes anything yet — that
  // is Phase 9 (see docs/adr/0006-structured-summaries.md). `indexing` is only
  // ever an in-flight marker set by summarize.post.ts's own claim(), not a
  // real pipeline step, and showing a stage for it would claim semantic search
  // ran the moment extraction finished.
]

const statusColor = computed(() => ({
  pending_upload: 'warning',
  uploaded: 'success',
  transcribing: 'info',
  summarizing: 'info',
  indexing: 'info',
  ready: 'success',
  failed: 'error',
} as const)[meeting.value.status])

const statusText = computed(() => meeting.value.status.replace('_', ' '))

/** Transcription has run and found nothing, as opposed to not having run. */
const transcribedButEmpty = computed(() =>
  ['summarizing', 'indexing', 'ready'].includes(meeting.value.status) && segments.value.length === 0)
const createdAt = computed(() => new Date(meeting.value.createdAt).toLocaleString())
const canTranscribe = computed(() =>
  meeting.value.status === 'uploaded'
  || (meeting.value.status === 'failed' && meeting.value.failedStage === 'transcription'))
const canSummarize = computed(() =>
  (meeting.value.status === 'summarizing' && segments.value.length > 0)
  || (meeting.value.status === 'failed' && meeting.value.failedStage === 'summarization'))

/**
 * What the card is doing, as one string in one live region. Screen readers only
 * announce a region that stays mounted, so the completion message has to appear
 * in the same element the in-progress message did.
 */
const activityLabel = computed(() => {
  if (summarizing.value) return 'Extracting decisions and action items.'
  if (transcribing.value) return 'Transcribing. This can take a moment.'
  if (meeting.value.status === 'transcribing') return 'Transcription is running.'
  // Another tab, or a request that outlived its page, can leave a meeting
  // claimed here with nothing visibly running on THIS page.
  if (meeting.value.status === 'indexing') return 'Extraction is running.'
  if (justFinished.value) return `Transcription finished with ${segments.value.length} segments.`
  if (canTranscribe.value) return 'Transcription runs on demand until the pipeline is automated.'
  return ''
})
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

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Pipeline
        </h2>
      </template>
      <ol class="space-y-4">
        <li
          v-for="stage in STAGES"
          :key="stage.key"
          class="flex items-start gap-3"
        >
          <UIcon
            :name="stage.reached(meeting.status) ? 'i-lucide-check-circle' : 'i-lucide-circle-dashed'"
            class="mt-0.5 size-5 shrink-0"
            :class="stage.reached(meeting.status) ? 'text-success' : 'text-dimmed'"
          />
          <div>
            <p
              class="font-medium"
              :class="stage.reached(meeting.status) ? '' : 'text-muted'"
            >
              {{ stage.label }}
            </p>
            <p class="text-sm text-muted">
              {{ stage.detail }}
              <template v-if="stage.key === 'upload' && stage.reached(meeting.status)">
                {{ formatMegabytes(meeting.audioBytes) }} of 16&nbsp;kHz mono Opus.
              </template>
              <template v-if="stage.key === 'transcribe' && segments.length">
                {{ segments.length }} segments.
              </template>
            </p>
          </div>
        </li>
      </ol>

      <template #footer>
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            v-if="canTranscribe"
            :loading="transcribing"
            :disabled="transcribing"
            icon="i-lucide-captions"
            @click="startTranscription"
          >
            {{ meeting.errorMessage ? 'Try transcription again' : 'Start transcription' }}
          </UButton>
          <UButton
            v-else-if="canSummarize"
            :loading="summarizing"
            :disabled="summarizing"
            icon="i-lucide-list-checks"
            @click="startSummary"
          >
            {{ meeting.errorMessage ? 'Try extraction again' : 'Extract decisions & action items' }}
          </UButton>
          <UIcon
            v-else-if="meeting.status === 'transcribing' || meeting.status === 'indexing'"
            name="i-lucide-loader-circle"
            class="size-5 shrink-0 animate-spin text-primary"
          />
          <!-- One region for the whole card, so it is never unmounted at the
               moment it has something to announce. -->
          <span
            class="text-sm text-muted"
            role="status"
            aria-live="polite"
          >{{ activityLabel }}</span>
        </div>
      </template>
    </UCard>

    <UAlert
      v-if="stepError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="stepError.step"
      :description="stepError.message"
    />
    <UAlert
      v-else-if="meeting.errorMessage"
      role="alert"
      :color="meeting.status === 'failed' ? 'error' : 'warning'"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="meeting.status === 'failed' ? 'Something went wrong' : 'The last attempt did not finish'"
      :description="meeting.errorMessage"
    />
    <UAlert
      v-else-if="meeting.status === 'pending_upload'"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock"
      title="Waiting for audio"
      description="The upload has not been confirmed yet. Return to the upload screen to retry."
    />

    <UAlert
      v-if="transcribedButEmpty"
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
