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
const transcribeError = ref<string | null>(null)

async function startTranscription() {
  transcribing.value = true
  transcribeError.value = null
  try {
    await $fetch(`/api/meetings/${meetingId.value}/transcribe`, { method: 'POST' })
  }
  catch (err) {
    const data = (err as { data?: { message?: string } }).data
    transcribeError.value = data?.message ?? (err instanceof Error ? err.message : String(err))
  }
  finally {
    transcribing.value = false
    await Promise.all([refresh(), refreshTranscript()])
  }
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
    reached: s => s !== 'pending_upload' && s !== 'failed',
  },
  { key: 'transcribe', label: 'Transcribed', detail: 'Speech turned into timestamped segments.', reached: s => ['summarizing', 'indexing', 'ready'].includes(s) },
  { key: 'summarize', label: 'Summarizing', detail: 'Decisions and action items — next build phase.', reached: s => ['indexing', 'ready'].includes(s) },
  { key: 'index', label: 'Indexing', detail: 'Semantic search across the transcript.', reached: s => s === 'ready' },
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
const createdAt = computed(() => new Date(meeting.value.createdAt).toLocaleString())
const canTranscribe = computed(() => meeting.value.status === 'uploaded')
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

      <template
        v-if="canTranscribe"
        #footer
      >
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            :loading="transcribing"
            :disabled="transcribing"
            icon="i-lucide-captions"
            @click="startTranscription"
          >
            Start transcription
          </UButton>
          <span
            class="text-sm text-muted"
            role="status"
            aria-live="polite"
          >
            {{ transcribing ? 'Transcribing…' : 'Transcription runs on demand until the pipeline is automated.' }}
          </span>
        </div>
      </template>
    </UCard>

    <UAlert
      v-if="transcribeError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Transcription failed"
      :description="transcribeError"
    />
    <UAlert
      v-else-if="meeting.status === 'failed'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Something went wrong"
      :description="meeting.errorMessage ?? 'The audio did not reach storage intact.'"
    />
    <UAlert
      v-else-if="meeting.status === 'pending_upload'"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock"
      title="Waiting for audio"
      description="The upload has not been confirmed yet. Return to the upload screen to retry."
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
          <span class="shrink-0 font-mono text-xs text-dimmed tabular-nums">
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
        to="/meetings"
        variant="ghost"
        color="neutral"
        icon="i-lucide-arrow-left"
      >
        All meetings
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
