<script setup lang="ts">
import type { QuestionAnswer, SearchIndexStatus } from '#shared/types/meeting'
import { MAX_QUESTION_CHARS } from '#shared/schemas/qa'

const props = defineProps<{ meetingId: string }>()
const emit = defineEmits<{
  /** Jump the player to a cited line. The page owns the player. */
  seek: [startMs: number, segmentIdx: number]
}>()

const { data: indexData, error: indexUnread, refresh: refreshIndex } = await useFetch<{ index: SearchIndexStatus }>(
  () => `/api/meetings/${props.meetingId}/search-index`,
)
const index = computed(() => indexData.value?.index ?? null)

const question = ref('')
const asking = ref(false)
const result = ref<{ question: string, answer: QuestionAnswer } | null>(null)
const failure = ref<string | null>(null)
const answerHeading = ref<HTMLElement | null>(null)

/**
 * When a refused question can be asked again. The answering model's slot is
 * shared with extraction (ADR-0012), and the embedding provider has a daily limit
 * (ADR-0014), so a question can be turned away for a while; the button stays off
 * until then rather than inviting a repeat 429.
 */
const retryAt = ref<Date | null>(null)
let retryTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(retryTimer))

function holdUntil(at: Date) {
  clearTimeout(retryTimer)
  retryAt.value = at
  retryTimer = setTimeout(() => {
    retryAt.value = null
  }, Math.max(0, at.getTime() - Date.now()))
}

/** The server's message when it gave one, rather than a generic failure. */
function describeError(err: unknown): string {
  const data = (err as { data?: { message?: string } }).data
  return data?.message ?? (err instanceof Error ? err.message : String(err))
}

/**
 * When the server said to try again, if it did -- by this browser's clock, from
 * the relative delay, so a skewed clock neither holds too long nor not at all.
 */
function retryAtOf(err: unknown): Date | null {
  const seconds = (err as { data?: { data?: { retryAfterSec?: unknown } } }).data?.data?.retryAfterSec
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(Date.now() + seconds * 1000)
}

const formatClock = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

async function ask() {
  const text = question.value.trim()
  if (!text || asking.value || retryAt.value) return
  asking.value = true
  failure.value = null
  try {
    const { answer } = await $fetch<{ answer: QuestionAnswer }>(`/api/meetings/${props.meetingId}/ask`, {
      method: 'POST',
      body: { question: text },
    })
    result.value = { question: text, answer }
    // Land keyboard and screen-reader users on the answer, not wherever the
    // button left them: the result appears below and would otherwise be found
    // only by exploring.
    await nextTick()
    answerHeading.value?.focus()
  }
  catch (err) {
    const at = retryAtOf(err)
    if (at) {
      holdUntil(at)
      failure.value = `${describeError(err)} Try again at ${formatClock(at)}.`
    }
    else {
      failure.value = describeError(err)
    }
    // A 409 here means the index went stale under us (a replaced transcript);
    // re-read it so the card offers the right next step instead of a form that
    // will keep failing.
    await refreshIndex()
  }
  finally {
    asking.value = false
  }
}

/**
 * What the live region says. One region, always mounted, for the same reason
 * as the progress page: a region created at the moment it has something to say
 * is not announced.
 */
const status = computed(() => {
  if (asking.value) {
    // Questions share the answering model's per-account allowance with
    // extraction (ADR-0007 decision 7), so one can wait its turn -- briefly.
    return 'Finding an answer. If an extraction is running, this waits its turn for up to 20 seconds.'
  }
  if (!result.value) return ''
  return result.value.answer.found
    ? `Answer ready, citing ${result.value.answer.citations.length} line${result.value.answer.citations.length === 1 ? '' : 's'}.`
    : 'Nothing retrieved from this meeting supports an answer.'
})
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-semibold">
        Ask about this meeting
      </h2>
    </template>

    <!-- First: with no status to read, every reason below would be a guess. -->
    <p
      v-if="indexUnread"
      class="text-sm text-muted"
    >
      Could not check whether this meeting can be asked questions. Reload the page to try again.
    </p>

    <p
      v-else-if="!index || index.state === 'unavailable'"
      class="text-sm text-muted"
    >
      Questions become available once the transcript is ready.
    </p>

    <div
      v-else-if="index.state !== 'ready'"
      class="space-y-3"
    >
      <p class="text-sm text-muted">
        {{ index.state === 'none'
          ? 'This meeting has not been indexed for questions yet.'
          : 'This meeting\'s index is incomplete or out of date with its transcript.' }}
      </p>
      <UButton
        :to="`/meetings/${meetingId}/progress`"
        variant="soft"
        icon="i-lucide-arrow-right"
        trailing
      >
        {{ index.state === 'none' ? 'Index it on the pipeline page' : 'Update the index on the pipeline page' }}
      </UButton>
    </div>

    <form
      v-else
      class="space-y-3"
      @submit.prevent="ask"
    >
      <UFormField
        label="Your question"
        name="question"
        :hint="`${question.length}/${MAX_QUESTION_CHARS}`"
      >
        <UInput
          v-model="question"
          :maxlength="MAX_QUESTION_CHARS"
          class="w-full"
          placeholder="e.g. What did we decide about the budget?"
        />
      </UFormField>
      <UButton
        type="submit"
        :loading="asking"
        :disabled="!question.trim() || !!retryAt"
        icon="i-lucide-message-circle-question"
      >
        Ask
      </UButton>
      <p
        v-if="retryAt"
        class="text-sm text-muted"
      >
        Questions can be asked again at {{ formatClock(retryAt) }}.
      </p>
    </form>

    <!-- Always mounted: see `status`. A span, not a p, so the text stays tight
         against its tags — whitespace inside would defeat empty:hidden. -->
    <span
      class="mt-3 block text-sm text-muted empty:hidden"
      role="status"
      aria-live="polite"
    >{{ status }}</span>

    <UAlert
      v-if="failure"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      class="mt-3"
      title="Could not answer"
      :description="failure"
    />

    <section
      v-if="result"
      class="mt-4 space-y-3"
      aria-labelledby="answer-heading"
    >
      <h3
        id="answer-heading"
        ref="answerHeading"
        tabindex="-1"
        class="text-sm font-semibold focus:outline-none"
      >
        {{ result.question }}
      </h3>

      <template v-if="result.answer.found">
        <p class="text-sm">
          {{ result.answer.answer }}
        </p>
        <ul class="space-y-1">
          <li
            v-for="citation in result.answer.citations"
            :key="`${citation.segmentIdx}:${citation.quote}`"
          >
            <button
              type="button"
              class="flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-elevated/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
              @click="emit('seek', citation.startMs, citation.segmentIdx)"
            >
              <span class="w-16 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
                {{ formatDuration(citation.startMs / 1000) }}
              </span>
              <!-- The evidence, shown. Checked against the transcript, but only
                   proof the words were said, not that they support the answer. -->
              <q class="min-w-0 text-muted italic">{{ citation.quote }}</q>
            </button>
          </li>
        </ul>
      </template>

      <!-- Honest about what it knows: no citation survived the check, which is
           not the same as proving the meeting never covered the subject. -->
      <p
        v-else
        class="text-sm text-muted"
      >
        Nothing retrieved from this meeting supports an answer to that. It may not have come up,
        or it may be worded differently than asked.
      </p>
    </section>
  </UCard>
</template>
