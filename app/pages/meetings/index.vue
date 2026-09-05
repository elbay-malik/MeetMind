<script setup lang="ts">
import type { Meeting } from '#shared/types/meeting'

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

    <p class="text-sm text-muted">
      Cross-meeting semantic search lands in a later phase.
    </p>
  </UContainer>
</template>
