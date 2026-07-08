<script setup lang="ts">
import type { ExtractOptions } from '../workers/ffmpeg.protocol'

useSeoMeta({ title: 'MeetMind — Upload' })

const { state, extract, cancel } = useAudioExtract()

const selectedFile = ref<File | null>(null)
const dragOver = ref(false)

// Production path: always WORKERFS, no debug toggles (those live on /spike/ffmpeg).
const EXTRACT_OPTIONS: ExtractOptions = {
  mountMode: 'workerfs',
  selfHostedClassWorker: false,
  voipTuning: false,
}

const busy = computed(() =>
  ['loading-core', 'probing', 'extracting'].includes(state.status))

const statusLabel = computed(() => ({
  'idle': '',
  'loading-core': 'Loading audio engine…',
  'probing': 'Reading recording…',
  'extracting': 'Extracting audio…',
  'done': 'Audio ready',
  'error': 'Something went wrong',
  'cancelled': 'Cancelled',
}[state.status]))

function selectFile(files: FileList | null) {
  const file = files?.[0]
  if (file) selectedFile.value = file
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  selectFile(event.dataTransfer?.files ?? null)
}

function start() {
  if (selectedFile.value) extract(selectedFile.value, EXTRACT_OPTIONS)
}

function reset() {
  selectedFile.value = null
}
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-10">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">
        Upload a meeting recording
      </h1>
      <p class="mt-1 text-muted">
        Your video is compressed to audio entirely in this browser — the recording itself
        never leaves your machine. Only a small audio file is sent for transcription.
      </p>
    </div>

    <UCard>
      <div class="space-y-5">
        <div
          class="rounded-lg border-2 border-dashed p-10 text-center transition-colors"
          :class="dragOver ? 'border-primary bg-primary/5' : 'border-default'"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <UIcon
            name="i-lucide-upload-cloud"
            class="mx-auto mb-3 size-8 text-dimmed"
          />
          <p class="mb-3 text-muted">
            Drag a meeting video here, or choose a file
          </p>
          <input
            type="file"
            accept="video/*,audio/*"
            :disabled="busy"
            @change="selectFile(($event.target as HTMLInputElement).files)"
          >
          <p
            v-if="selectedFile"
            class="mt-4 text-sm"
          >
            <strong>{{ selectedFile.name }}</strong>
            · {{ formatMegabytes(selectedFile.size) }}
          </p>
        </div>

        <div class="flex items-center gap-3">
          <UButton
            :disabled="!selectedFile || busy"
            icon="i-lucide-scissors"
            @click="start"
          >
            Extract audio
          </UButton>
          <UButton
            v-if="busy"
            color="error"
            variant="soft"
            @click="cancel"
          >
            Cancel
          </UButton>
          <UButton
            v-else-if="selectedFile && state.status !== 'extracting'"
            variant="ghost"
            color="neutral"
            @click="reset"
          >
            Clear
          </UButton>
          <span
            v-if="statusLabel"
            class="text-sm text-muted"
          >{{ statusLabel }}</span>
        </div>

        <div
          v-if="busy"
          class="space-y-1"
        >
          <UProgress
            :model-value="state.ratio * 100"
            :max="100"
          />
          <p class="text-xs text-muted">
            {{ formatDuration(state.outTimeSec) }}
            <template v-if="state.durationSec">
              / {{ formatDuration(state.durationSec) }}
            </template>
          </p>
        </div>

        <UAlert
          v-if="state.error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Extraction failed"
          :description="state.error"
        />
      </div>
    </UCard>

    <UCard v-if="state.status === 'done' && state.outputUrl">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-check-circle"
            class="size-5 text-success"
          />
          <h2 class="font-semibold">
            Audio ready to transcribe
          </h2>
        </div>
      </template>
      <div class="space-y-4">
        <p class="text-sm text-muted">
          Compressed to <strong class="text-default">{{ formatMegabytes(state.outputBytes) }}</strong>
          of 16&nbsp;kHz mono Opus in {{ formatDuration(state.elapsedMs / 1000) }}
          — ready for the transcription pipeline.
        </p>
        <audio
          :src="state.outputUrl"
          controls
          class="w-full"
        />
        <div class="flex items-center gap-3">
          <UTooltip text="Upload & transcription arrives in the next build phase">
            <UButton
              disabled
              icon="i-lucide-arrow-right"
              trailing
            >
              Continue to transcription
            </UButton>
          </UTooltip>
          <UButton
            :to="state.outputUrl"
            download="meeting-audio.ogg"
            variant="soft"
            color="neutral"
            size="sm"
          >
            Download audio
          </UButton>
        </div>
      </div>
    </UCard>
  </UContainer>
</template>
