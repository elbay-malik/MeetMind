<script setup lang="ts">
import type { Meeting, MeetingSearchMatch, MeetingSearchResult } from '#shared/types/meeting'
import { MAX_QUESTION_CHARS } from '#shared/schemas/qa'

useSeoMeta({ title: 'MeetMind — Meetings' })

const { data, status, error, refresh } = await useFetch<{ meetings: Meeting[] }>('/api/meetings')
const meetings = computed(() => data.value?.meetings ?? [])

const statusColor = (s: Meeting['status']) => ({
  pending_upload: 'warning',
  uploaded: 'success',
  transcribing: 'info',
  summarizing: 'info',
  indexing: 'info',
  ready: 'success',
  failed: 'error',
} as const)[s]

const query = ref('')
const searching = ref(false)
const searchResults = ref<MeetingSearchMatch[] | null>(null)
const searchFailure = ref<string | null>(null)

/** The server's message when it gave one, rather than a generic failure. */
function describeSearchError(err: unknown): string {
  const data = (err as { data?: { message?: string } }).data
  return data?.message ?? (err instanceof Error ? err.message : String(err))
}

async function search() {
  const text = query.value.trim()
  if (!text || searching.value) return
  searching.value = true
  searchFailure.value = null
  try {
    const { results } = await $fetch<MeetingSearchResult>('/api/meetings/search', { query: { q: text } })
    searchResults.value = results
  }
  catch (err) {
    searchFailure.value = describeSearchError(err)
    searchResults.value = null
  }
  finally {
    searching.value = false
  }
}

/** What the live region says. One region, always mounted — see MeetingQuestions.vue's identical reasoning. */
const searchStatus = computed(() => {
  if (searching.value) return 'Searching your meetings.'
  if (!searchResults.value) return ''
  return searchResults.value.length
    ? `${searchResults.value.length} result${searchResults.value.length === 1 ? '' : 's'} found.`
    : 'No matches found in your indexed meetings.'
})

/** A window's own start, not a more specific line within it — see searchMeetings' doc comment for why. */
function seekTarget(match: MeetingSearchMatch): string {
  return `/meetings/${match.meetingId}?t=${match.startMs}&seg=${match.segmentIdx}`
}
</script>

<template>
  <UContainer class="max-w-3xl space-y-6 py-10">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold tracking-tight">
        Meeting archive
      </h1>
      <UButton
        to="/"
        icon="i-lucide-upload-cloud"
      >
        Upload
      </UButton>
    </div>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          Search your meetings
        </h2>
      </template>

      <form
        class="flex gap-2"
        @submit.prevent="search"
      >
        <UInput
          v-model="query"
          :maxlength="MAX_QUESTION_CHARS"
          class="w-full"
          placeholder="e.g. What did we decide about the budget?"
        />
        <UButton
          type="submit"
          :loading="searching"
          :disabled="!query.trim()"
          icon="i-lucide-search"
        >
          Search
        </UButton>
      </form>

      <!-- Always true, not computed per search: an honest floor on what a
           result list can promise without recomputing every meeting's own
           index status (indexing is a manual, per-meeting step — ADR-0007
           decision 6) on every search just to report it precisely. -->
      <p class="mt-2 text-xs text-muted">
        Searches only meetings indexed for questions.
      </p>

      <!-- Always mounted: see `searchStatus`. A span, not a p, so the text stays
           tight against its tags — whitespace inside would defeat empty:hidden. -->
      <span
        class="mt-3 block text-sm text-muted empty:hidden"
        role="status"
        aria-live="polite"
      >{{ searchStatus }}</span>

      <UAlert
        v-if="searchFailure"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mt-3"
        title="Could not search"
        :description="searchFailure"
      />

      <ul
        v-if="searchResults?.length"
        class="mt-3 space-y-1"
      >
        <li
          v-for="(match, i) in searchResults"
          :key="`${match.meetingId}:${match.segmentIdx}:${i}`"
        >
          <NuxtLink
            :to="seekTarget(match)"
            class="flex flex-col gap-1 rounded px-2 py-2 hover:bg-elevated/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
          >
            <span class="flex items-center gap-2 text-sm font-medium">
              <span class="truncate">{{ match.meetingTitle }}</span>
              <span class="shrink-0 font-mono text-xs text-muted tabular-nums">
                {{ formatDuration(match.startMs / 1000) }}
              </span>
            </span>
            <q class="line-clamp-2 text-sm text-muted italic">{{ match.quote }}</q>
          </NuxtLink>
        </li>
      </ul>
    </UCard>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Could not load meetings"
      :description="error.message"
      :actions="[{ label: 'Retry', onClick: () => refresh() }]"
    />

    <UCard v-else-if="status !== 'pending' && meetings.length === 0">
      <div class="py-8 text-center text-muted">
        <UIcon
          name="i-lucide-archive"
          class="mx-auto mb-3 size-8 text-dimmed"
        />
        <p>No meetings yet. Upload a recording to get started.</p>
      </div>
    </UCard>

    <UCard
      v-else
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <ul class="divide-y divide-default">
        <li
          v-for="m in meetings"
          :key="m.id"
        >
          <NuxtLink
            :to="`/meetings/${m.id}/progress`"
            class="flex items-center justify-between gap-4 px-4 py-3 hover:bg-elevated/50"
          >
            <div class="min-w-0">
              <p class="truncate font-medium">
                {{ m.title }}
              </p>
              <p class="truncate text-sm text-muted">
                {{ new Date(m.createdAt).toLocaleString() }}
                <template v-if="m.durationSec">
                  · {{ formatDuration(m.durationSec) }}
                </template>
                · {{ formatMegabytes(m.audioBytes) }} audio
              </p>
            </div>
            <UBadge
              :color="statusColor(m.status)"
              variant="subtle"
              class="shrink-0 capitalize"
            >
              {{ m.status.replace('_', ' ') }}
            </UBadge>
          </NuxtLink>
        </li>
      </ul>
    </UCard>
  </UContainer>
</template>
