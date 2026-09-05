<script setup lang="ts">
import type { ExtractOptions } from '../workers/ffmpeg.protocol'

useSeoMeta({ title: 'MeetMind — Upload' })

const { state, extract, cancel } = useAudioExtract()
const uploader = useMeetingUpload()

const selectedFile = ref<File | null>(null)
const dragOver = ref(false)
const title = ref('')

// Production path: always WORKERFS, no debug toggles (those live on /spike/ffmpeg).
const EXTRACT_OPTIONS: ExtractOptions = {
  mountMode: 'workerfs',
  selfHostedClassWorker: false,
  voipTuning: false,
}

const extracting = computed(() =>
  ['loading-core', 'probing', 'extracting'].includes(state.status))
const uploading = uploader.busy
const busy = computed(() => extracting.value || uploading.value)

const statusLabel = computed(() => ({
  'idle': '',
  'loading-core': 'Loading audio engine…',
  'probing': 'Reading recording…',
  'extracting': 'Extracting audio…',
  'done': 'Audio ready',
  'error': 'Something went wrong',
  'cancelled': 'Cancelled',
}[state.status]))

const uploadLabel = computed(() => ({
  idle: '',
  registering: 'Registering meeting…',
  uploading: 'Uploading audio…',
  confirming: 'Confirming upload…',
  done: 'Uploaded',
  error: 'Upload failed',
}[uploader.state.status]))

function selectFile(files: FileList | null) {
  const file = files?.[0]
  if (!file) return
  selectedFile.value = file
  title.value = titleFromFileName(file.name)
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
  title.value = ''
}

async function uploadAndContinue() {
  const file = selectedFile.value
  const audio = state.outputBlob
  if (!file || !audio) return
  const meeting = await uploader.upload({
    audio,
    meta: {
      title: title.value.trim() || titleFromFileName(file.name),
      sourceFileName: file.name,
      sourceBytes: file.size,
      sourceMime: file.type || null,
      durationSec: state.durationSec,
    },
  })
  if (meeting) await navigateTo(`/meetings/${meeting.id}/progress`)
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
            v-if="extracting"
            color="error"
            variant="soft"
            @click="cancel"
          >
            Cancel
          </UButton>
          <UButton
            v-else-if="selectedFile && !uploading"
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
          v-if="extracting"
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

    <UCard v-if="state.status === 'done' && state.outputBlob">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-check-circle"
            class="size-5 text-success"
          />
          <h2 class="font-semibold">
            Audio ready to upload
          </h2>
        </div>
      </template>
      <div class="space-y-4">
        <p class="text-sm text-muted">
          Compressed to <strong class="text-default">{{ formatMegabytes(state.outputBytes) }}</strong>
          of 16&nbsp;kHz mono Opus in {{ formatDuration(state.elapsedMs / 1000) }}.
          Only this audio is uploaded — never the video.
        </p>
        <audio
          :src="state.outputUrl ?? undefined"
          controls
          class="w-full"
        />
        <UFormField
          label="Meeting title"
          name="title"
        >
          <UInput
            v-model="title"
            :maxlength="MAX_TITLE_LENGTH"
            :disabled="uploading"
            class="w-full"
            placeholder="e.g. Weekly product sync"
          />
        </UFormField>
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            :disabled="uploading || !title.trim()"
            :loading="uploading"
            icon="i-lucide-arrow-right"
            trailing
            @click="uploadAndContinue"
          >
            Upload audio &amp; continue
          </UButton>
          <UButton
            v-if="uploader.state.status === 'uploading'"
            color="error"
            variant="soft"
            size="sm"
            @click="uploader.cancel"
          >
            Cancel upload
          </UButton>
          <UButton
            :to="state.outputUrl ?? undefined"
            download="meeting-audio.ogg"
            variant="soft"
            color="neutral"
            size="sm"
          >
            Download audio
          </UButton>
          <span
            v-if="uploadLabel"
            class="text-sm text-muted"
          >{{ uploadLabel }}</span>
        </div>

        <div
          v-if="uploading"
          class="space-y-1"
        >
          <UProgress
            :model-value="uploader.state.ratio * 100"
            :max="100"
          />
          <p class="text-xs text-muted">
            {{ formatMegabytes(uploader.state.sentBytes) }} / {{ formatMegabytes(uploader.state.totalBytes) }}
          </p>
        </div>

        <UAlert
          v-if="uploader.state.error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Upload failed"
          :description="uploader.state.error"
        />
      </div>
    </UCard>
  </UContainer>
</template>
