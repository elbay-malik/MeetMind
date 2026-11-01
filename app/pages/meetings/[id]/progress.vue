<script setup lang="ts">
import type { ExtractionStepResponse, Meeting, MeetingStatus, SearchIndexStatus, TranscriptionStepResponse, TranscriptSegment } from '#shared/types/meeting'

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
const justSummarized = ref(false)

/** The footer, so focus can be put back on the action after a step finishes
 * (see restoreActionFocus). Queried rather than a component ref: what needs
 * focusing is the real <button>, whatever the UI library wraps it in. */
const footer = ref<HTMLElement | null>(null)

const { data: indexData, refresh: refreshIndex }
  = await useFetch<{ index: SearchIndexStatus }>(`/api/meetings/${meetingId.value}/search-index`)
const searchIndex = computed(() => indexData.value?.index ?? null)

async function reloadAll() {
  // The index status is derived from the transcript, so it changes whenever a
  // step changes the transcript — transcription finishing makes it `none`.
  await Promise.all([refresh(), refreshTranscript(), refreshIndex()])
}

/**
 * Indexing for questions (ADR-0007 decision 6). A separate step, not part of
 * the pipeline status: it needs a finished transcript and nothing else, so it
 * neither waits for extraction nor blocks it.
 */
const indexing = ref(false)
const indexError = ref<string | null>(null)
const justIndexed = ref(false)
const questionsCard = ref<HTMLElement | null>(null)

const canIndex = computed(() =>
  searchIndex.value?.state === 'none' || searchIndex.value?.state === 'incomplete')

async function startIndexing() {
  if (indexing.value) return
  indexing.value = true
  indexError.value = null
  justIndexed.value = false
  try {
    await $fetch(`/api/meetings/${meetingId.value}/search-index`, { method: 'POST' })
    justIndexed.value = true
  }
  catch (err) {
    indexError.value = describeError(err)
  }
  finally {
    indexing.value = false
    await refreshIndex()
    // The button disappears once the index is ready; keep focus in the card
    // (on the link to ask) rather than letting it fall to <body>.
    await nextTick()
    if (!document.activeElement || document.activeElement === document.body) {
      questionsCard.value?.querySelector<HTMLElement>('a, button')?.focus()
    }
  }
}

const indexLabel = computed(() => {
  const index = searchIndex.value
  if (indexing.value) return 'Indexing the transcript for questions.'
  if (!index || index.state === 'unavailable') return 'Available once transcription has finished.'
  if (justIndexed.value && index.state === 'ready') return 'Indexing finished. This meeting can be asked questions.'
  if (index.state === 'ready') {
    return index.windowCount === 0
      ? 'Nothing to index: the transcript is empty.'
      : `Ready for questions: all ${index.windowCount} passages indexed.`
  }
  if (index.state === 'none') return 'Not indexed yet.'
  return `${index.indexedCount} of ${index.windowCount} passages indexed for the current transcript.`
})

/**
 * Put focus back on the action after a step finishes.
 *
 * Each step swaps which action is offered, and the button the user just
 * activated stops being the right one. Keeping ONE button element across those
 * transitions (see primaryAction) means the browser does not drop focus to
 * <body> merely because a v-if branch changed — but a step that ends with no
 * action at all, or with the button briefly disabled while loading, still can.
 * Measured before this: focus landed on <body> twice in a normal run, once
 * after transcription and once after extraction.
 */
async function restoreActionFocus() {
  await nextTick()
  if (document.activeElement && document.activeElement !== document.body) return
  footer.value?.querySelector('button')?.focus()
}

const summarizing = ref(false)
/** How far the extraction this page is driving has got, from the last step's answer. */
const extraction = ref<ExtractionStepResponse['progress'] | null>(null)
/** How far the transcription this page is driving has got, from the last step's answer. */
const transcription = ref<TranscriptionStepResponse['progress'] | null>(null)
/** Stops the driving loops when the page goes away; the run parks and resumes when reopened. */
let unmounted = false

async function startSummary() {
  // Guarded rather than disabled: a disabled button loses focus, which is the
  // behaviour restoreActionFocus exists to undo. Re-entry is what actually
  // needed preventing.
  if (summarizing.value) return
  summarizing.value = true
  stepError.value = null
  // Otherwise the completion announcement from transcription survives into
  // extraction: once summarizing flips back to false, activityLabel falls
  // through past its own "extracting"/"running" checks to this stale flag,
  // announcing "Transcription finished" again for an already-summarized,
  // ready meeting.
  justFinished.value = false
  extraction.value = null
  try {
    // One step per request (ADR-0012): ask again until the summary is stored,
    // waiting when the server says when to come back. The jitter keeps two
    // tabs that were told the same moment from arriving together.
    let finished = false
    while (!finished && !unmounted) {
      const res = await $fetch.raw<ExtractionStepResponse>(`/api/meetings/${meetingId.value}/summarize`, { method: 'POST' })
      finished = res.status !== 202
      const step = res._data
      if (finished || !step) continue
      extraction.value = step.progress
      // The server's duration, not `retryAt` against this browser's clock,
      // which may be minutes off.
      if (step.next === 'wait' && step.retryAfterMs !== null) {
        await sleep(step.retryAfterMs + Math.random() * 2000)
      }
    }
    if (finished) justSummarized.value = true
  }
  catch (err) {
    stepError.value = { step: 'Extraction failed', message: describeError(err) }
  }
  finally {
    summarizing.value = false
    extraction.value = null
    await reloadAll()
    await restoreActionFocus()
  }
}

async function startTranscription() {
  if (transcribing.value) return
  transcribing.value = true
  stepError.value = null
  justFinished.value = false
  justSummarized.value = false
  transcription.value = null
  try {
    // One step per request (ADR-0012), driven the same way as extraction above.
    let finished = false
    while (!finished && !unmounted) {
      const res = await $fetch.raw<TranscriptionStepResponse>(`/api/meetings/${meetingId.value}/transcribe`, { method: 'POST' })
      finished = res.status !== 202
      const step = res._data
      if (finished || !step) continue
      transcription.value = step.progress
      if (step.next === 'wait' && step.retryAfterMs !== null) {
        await sleep(step.retryAfterMs + Math.random() * 2000)
      }
    }
    if (finished) justFinished.value = true
  }
  catch (err) {
    stepError.value = { step: 'Transcription failed', message: describeError(err) }
  }
  finally {
    transcribing.value = false
    transcription.value = null
    await reloadAll()
    await restoreActionFocus()
  }
}

/**
 * Ask the route that owns this meeting to carry on. Both stages move only while
 * a page asks them to (ADR-0012), so one left in progress by a closed tab or a
 * killed step is paused until someone does. The server still decides: if a step
 * is live, it answers when to look again, and the loop waits.
 */
async function resumeStalled() {
  if (meeting.value.status === 'transcribing') return startTranscription()
  return startSummary()
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
  unmounted = true
  if (poller) clearInterval(poller)
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

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

// See shared/utils/meeting.ts for what this actually checks and why.
const showTranscribedButEmpty = computed(() => transcribedButEmpty(meeting.value, segments.value.length))
const createdAt = computed(() => new Date(meeting.value.createdAt).toLocaleString())
const canTranscribe = computed(() =>
  meeting.value.status === 'uploaded'
  || (meeting.value.status === 'failed' && meeting.value.failedStage === 'transcription'))
// Not gated on segments.length: a silent recording (transcribedButEmpty
// above) genuinely finished transcription with zero segments, and
// summarize.post.ts finishes that too — with a valid empty summary, not an
// error — so hiding this button for that case left it stuck in
// `summarizing` with no reachable transition at all.
const canSummarize = computed(() =>
  meeting.value.status === 'summarizing'
  || (meeting.value.status === 'failed' && meeting.value.failedStage === 'summarization'))

/**
 * A stage this page is not driving. Both move only while a page asks them to
 * (ADR-0012), so one left in progress is paused until someone resumes it; if
 * another tab is driving it, resuming here just takes turns. Offered while this
 * page drives it too, shown busy: the button the user activated stays put
 * rather than vanish and drop focus to <body>.
 */
const canResume = computed(() =>
  meeting.value.status === 'transcribing' || meeting.value.status === 'indexing')

/** The failure with no retry at all: the audio was rejected and removed. */

/**
 * The one action this meeting can take, as data rather than a chain of v-if
 * branches in the template. One button element then survives every transition,
 * so activating it does not drop keyboard focus to <body> when the next step
 * replaces which action is offered.
 */
const primaryAction = computed(() => {
  if (canTranscribe.value) {
    return {
      icon: 'i-lucide-captions',
      label: meeting.value.errorMessage ? 'Try transcription again' : 'Start transcription',
      busy: transcribing.value,
      run: startTranscription,
    }
  }
  if (canSummarize.value) {
    return {
      icon: 'i-lucide-list-checks',
      label: meeting.value.errorMessage ? 'Try extraction again' : 'Extract decisions & action items',
      busy: summarizing.value,
      run: startSummary,
    }
  }
  if (canResume.value) {
    return {
      icon: 'i-lucide-rotate-ccw',
      label: meeting.value.status === 'transcribing' ? 'Resume transcription' : 'Resume extraction',
      busy: meeting.value.status === 'transcribing' ? transcribing.value : summarizing.value,
      run: resumeStalled,
    }
  }
  return null
})

/**
 * What the card is doing, as one string in one live region. Screen readers only
 * announce a region that stays mounted, so the completion message has to appear
 * in the same element the in-progress message did.
 */
const activityLabel = computed(() => {
  if (summarizing.value) {
    const step = extraction.value
    if (!step?.total) return 'Extracting decisions and action items.'
    const retrying = step.lastError ? ' The last attempt did not finish; it will be retried.' : ''
    return `Extracting decisions and action items: ${step.done} of ${step.total} parts done.${retrying}`
  }
  if (transcribing.value) {
    const step = transcription.value
    if (!step?.total) return 'Transcribing. This can take a moment.'
    const retrying = step.lastError ? ' The last attempt did not finish; it will be retried.' : ''
    return `Transcribing: ${step.segments} segments stored so far.${retrying}`
  }
  if (canResume.value) {
    return meeting.value.status === 'transcribing'
      ? 'Transcription is paused, or running in another tab. Resume it here to carry on.'
      : 'Extraction is paused, or running in another tab. Resume it here to carry on.'
  }
  // Both completions are announced, not just transcription's: this region is
  // the only thing a screen reader hears, and it used to go from "Extracting
  // decisions and action items." straight to empty, which announces nothing
  // at all — the one moment the user is waiting to be told about.
  if (justSummarized.value) return 'Extraction finished. Decisions and action items are ready.'
  if (justFinished.value) return `Transcription finished with ${segments.value.length} segments.`
  if (uploadWasRejected(meeting.value)) {
    return 'The uploaded audio was rejected and removed. Upload the recording again.'
  }
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
              <!-- Only once the stage is actually reached: rendering "7
                   segments." under a grey, not-reached stage contradicts the
                   tick beside it, which is the shape a failed-at-transcription
                   meeting that still has an older transcript produces. -->
              <template v-if="stage.key === 'transcribe' && stage.reached(meeting.status) && segments.length">
                {{ segments.length }} segments.
              </template>
            </p>
          </div>
        </li>
      </ol>

      <template #footer>
        <div
          ref="footer"
          class="flex flex-wrap items-center gap-3"
        >
          <!-- ONE button across every state, driven by primaryAction: a v-if
               chain unmounts the focused control the moment a step finishes,
               dropping keyboard focus to <body>. -->
          <UButton
            v-if="primaryAction"
            :loading="primaryAction.busy"
            :icon="primaryAction.icon"
            @click="primaryAction.run()"
          >
            {{ primaryAction.label }}
          </UButton>
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

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Questions
        </h2>
      </template>
      <div
        ref="questionsCard"
        class="flex flex-wrap items-center gap-3"
      >
        <UButton
          v-if="canIndex"
          :loading="indexing"
          icon="i-lucide-search"
          variant="soft"
          @click="startIndexing"
        >
          {{ searchIndex?.state === 'incomplete' ? 'Update the index' : 'Index for questions' }}
        </UButton>
        <UButton
          v-else-if="searchIndex?.state === 'ready' && searchIndex.windowCount > 0"
          :to="`/meetings/${meetingId}`"
          variant="ghost"
          icon="i-lucide-message-circle-question"
        >
          Ask on the meeting page
        </UButton>
        <!-- Always mounted, like the pipeline card's region. -->
        <span
          class="text-sm text-muted"
          role="status"
          aria-live="polite"
        >{{ indexLabel }}</span>
      </div>
      <UAlert
        v-if="indexError"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mt-3"
        title="Indexing failed"
        :description="indexError"
      />
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
    <!-- Before the generic failure alert: this one has no retry, so saying
         only "Something went wrong" left the page with no next step at all
         while the pipeline card offered an action that could never work. -->
    <UAlert
      v-else-if="uploadWasRejected(meeting)"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-file-x"
      title="The audio was rejected and removed"
      :description="`${meeting.errorMessage} This meeting cannot be transcribed — upload the recording again.`"
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
