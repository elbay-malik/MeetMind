<script setup lang="ts">
import type { ExtractOptions } from '../../workers/ffmpeg.protocol'

useSeoMeta({ title: 'MeetMind — FFmpeg spike' })

const { state, measurements, extract, cancel } = useAudioExtract()

const selectedFile = ref<File | null>(null)
const dragOver = ref(false)
const copied = ref(false)

const options = reactive<ExtractOptions>({
  mountMode: 'workerfs',
  selfHostedClassWorker: false,
  voipTuning: false,
})

const busy = computed(() =>
  ['loading-core', 'probing', 'extracting'].includes(state.status))

const statusColor = computed(() => ({
  'idle': 'neutral',
  'loading-core': 'info',
  'probing': 'info',
  'extracting': 'primary',
  'done': 'success',
  'error': 'error',
  'cancelled': 'warning',
} as const)[state.status])

function onFiles(files: FileList | null) {
  const file = files?.[0]
  if (file) selectedFile.value = file
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  onFiles(event.dataTransfer?.files ?? null)
}

function start() {
  if (selectedFile.value) extract(selectedFile.value, { ...options })
}

const measurementsMarkdown = computed(() => {
  const header = '| started | input | MB in | duration | mount | wall-clock ms | MB out | kbps | JS heap peak MB | result | note |'
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  const rows = measurements.value.map(m => [
    m.startedAt,
    m.inputName,
    m.inputMB,
    m.durationSec === null ? '?' : formatDuration(m.durationSec),
    m.mountMode,
    m.wallClockMs,
    m.outputMB ?? '—',
    m.realizedKbps ?? '—',
    m.jsHeapPeakMB ?? 'n/a',
    m.result,
    m.note,
  ].join(' | ')).map(r => `| ${r} |`)
  return [header, sep, ...rows].join('\n')
})

async function copyMeasurements() {
  await navigator.clipboard.writeText(measurementsMarkdown.value)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}
</script>

<template>
  <UContainer class="max-w-3xl space-y-6 py-10">
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <h1 class="text-xl font-semibold">
            FFmpeg WASM spike
          </h1>
          <UBadge
            :color="statusColor"
            variant="subtle"
          >
            {{ state.status }}
          </UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <div
          class="rounded-lg border-2 border-dashed p-8 text-center transition-colors"
          :class="dragOver ? 'border-primary bg-primary/5' : 'border-default'"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <p class="mb-2 text-muted">
            Drop a meeting video here, or
          </p>
          <input
            type="file"
            accept="video/*,audio/*"
            @change="onFiles(($event.target as HTMLInputElement).files)"
          >
          <p
            v-if="selectedFile"
            class="mt-3 text-sm"
          >
            <strong>{{ selectedFile.name }}</strong>
            · {{ formatMegabytes(selectedFile.size) }} · {{ selectedFile.type || 'unknown type' }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-6 text-sm">
          <USwitch
            v-model="options.selfHostedClassWorker"
            :disabled="busy"
            label="Self-hosted class worker (escape hatch)"
          />
          <USwitch
            :model-value="options.mountMode === 'memfs'"
            :disabled="busy"
            label="MEMFS copy (debug, small files only)"
            @update:model-value="options.mountMode = $event ? 'memfs' : 'workerfs'"
          />
          <USwitch
            v-model="options.voipTuning"
            :disabled="busy"
            label="Opus voip tuning"
          />
        </div>

        <div class="flex items-center gap-3">
          <UButton
            :disabled="!selectedFile || busy"
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
          <span
            v-if="busy || state.status === 'done'"
            class="text-sm text-muted"
          >
            elapsed {{ formatDuration(state.elapsedMs / 1000) }}
            <template v-if="state.jsHeapPeakMB !== null">
              · JS heap peak ~{{ state.jsHeapPeakMB }} MB
            </template>
          </span>
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
            <UBadge
              v-if="state.progressSource"
              size="sm"
              variant="outline"
              class="ml-2"
            >
              source: {{ state.progressSource }}
            </UBadge>
          </p>
        </div>

        <UAlert
          v-if="state.error"
          color="error"
          variant="subtle"
          title="Extraction failed"
          :description="state.error"
        />

        <UCard
          v-if="state.status === 'done' && state.outputUrl"
          variant="subtle"
        >
          <div class="space-y-3">
            <p class="text-sm">
              <strong>{{ formatMegabytes(state.outputBytes) }}</strong> Opus 16 kHz mono
              <template v-if="state.durationSec">
                · realized {{ ((state.outputBytes * 8) / state.durationSec / 1000).toFixed(1) }} kbps
              </template>
              · done in {{ formatDuration(state.elapsedMs / 1000) }}
            </p>
            <audio
              :src="state.outputUrl"
              controls
              class="w-full"
            />
            <UButton
              :to="state.outputUrl"
              download="audio.ogg"
              variant="soft"
              size="sm"
            >
              Download output.ogg
            </UButton>
          </div>
        </UCard>
      </div>
    </UCard>

    <UCard v-if="state.logs.length">
      <template #header>
        <h2 class="font-semibold">
          ffmpeg log (last {{ state.logs.length }} lines)
        </h2>
      </template>
      <pre class="max-h-64 overflow-auto text-xs leading-relaxed">{{ state.logs.join('\n') }}</pre>
    </UCard>

    <UCard v-if="measurements.length">
      <template #header>
        <div class="flex items-center justify-between">
          <h2 class="font-semibold">
            Measurements
          </h2>
          <UButton
            size="sm"
            variant="soft"
            @click="copyMeasurements"
          >
            {{ copied ? 'Copied!' : 'Copy for ADR' }}
          </UButton>
        </div>
      </template>
      <div class="overflow-x-auto">
        <pre class="text-xs leading-relaxed">{{ measurementsMarkdown }}</pre>
      </div>
    </UCard>
  </UContainer>
</template>
