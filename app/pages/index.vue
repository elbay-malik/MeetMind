<script setup lang="ts">
import type { ExtractOptions } from '../workers/ffmpeg.protocol'

useSeoMeta({ title: 'MeetMind — Upload' })

const { demoMeetingId } = useRuntimeConfig().public

const { state, extract, cancel, reset: resetExtraction } = useAudioExtract()
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

/**
 * The extracted audio must fit Groq's free-tier upload cap. Surfaced here
 * because the server would otherwise reject it with a generic schema error
 * after the user has already waited through a full extraction.
 */
const oversized = computed(() => state.outputBytes > MAX_AUDIO_BYTES)

const uploadLabel = computed(() => ({
  idle: '',
  registering: 'Registering meeting…',
  uploading: 'Uploading audio…',
  confirming: 'Confirming upload…',
  done: 'Uploaded',
  cancelled: 'Upload cancelled',
  error: 'Upload failed',
}[uploader.state.status]))

function selectFile(files: FileList | null) {
  const file = files?.[0]
  // Never swap the recording out from under a running extraction or upload.
  if (!file || busy.value) return
  // Discard any previously extracted audio: it belongs to the old recording,
  // and pairing it with this file's metadata would store the wrong meeting.
  resetExtraction()
  uploader.reset()
  selectedFile.value = file
  title.value = titleFromFileName(file.name)
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  if (busy.value) return
  selectFile(event.dataTransfer?.files ?? null)
}

function start() {
  if (selectedFile.value) extract(selectedFile.value, EXTRACT_OPTIONS)
}

function clearSelection() {
  if (busy.value) return
  resetExtraction()
  uploader.reset()
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
        Your video is compressed to audio entirely in this browser, and the video stays on
        your machine. The compressed audio is what gets uploaded.
      </p>
      <p
        v-if="demoMeetingId"
        class="mt-3"
      >
        <UButton
          :to="`/meetings/${demoMeetingId}`"
          variant="soft"
          icon="i-lucide-play"
        >
          Open the demo meeting
        </UButton>
      </p>
    </div>

    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="This is a demo. Do not upload anything sensitive."
    >
      <template #description>
        <p class="text-default">
          The audio is stored and sent to Groq to transcribe. The transcript is sent to Groq
          to summarize and answer questions, and to Google to index it for questions.
        </p>
        <p class="mt-1 text-default">
          There are no accounts. Anyone with the link to your meeting can view it, and you
          cannot delete it yourself.
        </p>
      </template>
    </UAlert>

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
            id="recording-file"
            type="file"
            accept="video/*,audio/*"
            aria-label="Choose a meeting recording"
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
            @click="clearSelection"
          >
            Clear
          </UButton>
          <span
            v-if="statusLabel"
            class="text-sm text-muted"
            role="status"
            aria-live="polite"
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
          role="alert"
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
            :disabled="uploading || !title.trim() || oversized"
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
            role="status"
            aria-live="polite"
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
          v-if="oversized"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Recording is too long to transcribe"
          :description="`This audio is ${formatMegabytes(state.outputBytes)}, over the ${MAX_AUDIO_LABEL} limit. Split the recording and upload each part separately.`"
        />

        <UAlert
          v-if="uploader.state.error"
          role="alert"
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
