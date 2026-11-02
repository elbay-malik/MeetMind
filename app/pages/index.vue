<script setup lang="ts">
import { meetingIdSchema } from '#shared/schemas/meeting'
import type { ExtractOptions } from '../workers/ffmpeg.protocol'

useSeoMeta({ title: 'MeetMind — Upload' })

// An id the server's own check refuses could only open a 404, so no button for it. This
// cannot catch a well-formed id with no meeting behind it: that would take a lookup on
// every visit to the home page. Trimmed like the server's guard, so the two agree on
// which meeting it is.
const configuredDemoId = String(useRuntimeConfig().public.demoMeetingId ?? '').trim()
const demoMeetingId = meetingIdSchema.safeParse(configuredDemoId).success ? configuredDemoId : ''
if (configuredDemoId && !demoMeetingId) {
  console.warn('NUXT_PUBLIC_DEMO_MEETING_ID is not a meeting id, so the home page shows no demo link')
}

const { state, extract, cancel, reset: resetExtraction } = useAudioExtract()
const uploader = useMeetingUpload()
const { code: inviteCode, status: inviteStatus, error: inviteError, check: checkInvite, forget: forgetInvite } = useInviteCode()

const inviteInput = ref<{ inputRef?: HTMLInputElement } | null>(null)
const recordingInput = ref<HTMLInputElement | null>(null)

/** What just happened to the code. Mounted whichever card is showing, so it is announced. */
const inviteLabel = computed(() => ({
  needed: '',
  checking: 'Checking the code…',
  accepted: 'Invite code accepted.',
}[inviteStatus.value]))

/** The code itself was judged wrong. Being closed or unreachable says nothing about it. */
const inviteRefused = computed(() => inviteError.value === INVITE_REFUSED_MESSAGE)

/** The form goes away once the code is accepted, so focus goes on with it rather than falling to <body>. */
async function submitInvite() {
  await checkInvite()
  await nextTick()
  if (inviteStatus.value === 'accepted') recordingInput.value?.focus()
  else inviteInput.value?.inputRef?.focus()
}

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
    inviteCode: inviteCode.value,
    meta: {
      title: title.value.trim() || titleFromFileName(file.name),
      sourceFileName: file.name,
      sourceBytes: file.size,
      sourceMime: file.type || null,
      durationSec: state.durationSec,
    },
  })
  if (meeting) await navigateTo(`/meetings/${meeting.id}/progress`)
  // Rotated since this page checked it. The audio stays, so a new code costs no second extraction.
  else if (uploader.state.inviteRefused) forgetInvite()
}
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-10">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">
        MeetMind
      </h1>
      <p class="mt-1 text-muted">
        Turns a meeting recording into a timestamped transcript, a summary of decisions and
        action items, and answers to your questions. Summaries and answers cite the lines
        they came from.
      </p>
      <p
        v-if="demoMeetingId"
        class="mt-4"
      >
        <UButton
          :to="`/meetings/${demoMeetingId}`"
          size="lg"
          icon="i-lucide-play"
        >
          Open the demo meeting
        </UButton>
      </p>
    </div>

    <div>
      <h2 class="text-lg font-semibold">
        Upload a meeting recording
      </h2>
      <p class="mt-1 text-muted">
        Uploading is invite-only: it takes a code from whoever runs this demo.
        <template v-if="demoMeetingId">
          The demo meeting above needs no code.
        </template>
      </p>
      <p class="mt-1 text-muted">
        Your video is compressed to audio entirely in this browser, and the video stays on
        your machine. The compressed audio is uploaded, with the original file's name, size
        and type.
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
          The audio is stored at Cloudflare and sent to Groq to transcribe. The transcript is
          sent to Groq to summarize and answer questions, and to Cloudflare to index it for
          questions. Questions typed about a meeting are sent to Cloudflare and Groq too.
        </p>
        <p class="mt-1 text-default">
          There are no accounts. Anyone with the link to your meeting can view it, including
          the file's name, and you cannot delete it yourself.
        </p>
      </template>
    </UAlert>

    <UCard v-if="inviteStatus !== 'accepted'">
      <!-- The field has no name on purpose: a form submitted before the page is
           interactive sends only named fields, and it would send them in the URL. -->
      <form
        class="space-y-3"
        @submit.prevent="submitInvite"
      >
        <!-- The refusal goes through the field, so the input reads as invalid and is described
             by it, which focus returning there then announces. An alert as well, because focus
             does not move when the code was submitted with Enter. -->
        <UFormField
          label="Invite code"
          :help="inviteRefused ? undefined : 'Held in this page only, and checked before anything is read from your recording.'"
          :error="inviteRefused ? inviteError ?? undefined : undefined"
        >
          <template
            v-if="inviteRefused"
            #error
          >
            <span role="alert">{{ inviteError }}</span>
          </template>
          <UInput
            ref="inviteInput"
            v-model="inviteCode"
            type="password"
            autocomplete="off"
            :readonly="inviteStatus === 'checking'"
            class="w-full"
          />
        </UFormField>
        <UButton
          type="submit"
          :loading="inviteStatus === 'checking'"
          :disabled="!inviteCode.trim()"
          icon="i-lucide-key-round"
        >
          Continue
        </UButton>
        <UAlert
          v-if="inviteError && !inviteRefused"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Invite code not accepted"
          :description="inviteError"
        />
      </form>
    </UCard>

    <!-- Always mounted: see inviteLabel. A span, so empty:hidden works. -->
    <span
      class="block text-sm text-muted empty:hidden"
      role="status"
      aria-live="polite"
    >{{ inviteLabel }}</span>

    <UCard v-if="inviteStatus === 'accepted'">
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
            ref="recordingInput"
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
          The video is never uploaded: only this audio and the original file's name, size and
          type. Anyone with the meeting's link can see those, even if you change the title below.
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
            :disabled="uploading || !title.trim() || oversized || inviteStatus !== 'accepted'"
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
