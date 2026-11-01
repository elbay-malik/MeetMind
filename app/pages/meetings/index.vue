<script setup lang="ts">
import type { LocalMeeting } from '~/utils/local-meetings'

useSeoMeta({ title: 'MeetMind — Your meetings' })

/**
 * Read once mounted, so the server and the first client render agree: neither can
 * know what is in this browser. `null` until then.
 */
const stored = ref<{ available: boolean, meetings: LocalMeeting[] } | null>(null)
onMounted(() => {
  stored.value = readLocalMeetings(browserStorage())
})
</script>

<template>
  <UContainer class="max-w-3xl space-y-6 py-10">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold tracking-tight">
        Your meetings
      </h1>
      <UButton
        to="/"
        icon="i-lucide-upload-cloud"
      >
        Upload
      </UButton>
    </div>

    <p class="text-muted">
      This list lives only in this browser. MeetMind has no accounts and no list of
      meetings on the server: a meeting can only be reached through its link, so if you
      lose the link you lose access. Clearing this browser's data clears this list. Anyone
      you give a link to can read that meeting.
    </p>

    <UAlert
      v-if="stored && !stored.available"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="This browser is not letting MeetMind store anything"
      description="Meetings you upload will not appear here, so keep each meeting's link yourself."
    />

    <UCard v-else-if="stored && stored.meetings.length === 0">
      <div class="py-8 text-center text-muted">
        <UIcon
          name="i-lucide-list"
          class="mx-auto mb-3 size-8 text-dimmed"
        />
        <p>No meetings uploaded from this browser. Upload a recording to get started.</p>
      </div>
    </UCard>

    <UCard
      v-else-if="stored"
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <ul class="divide-y divide-default">
        <li
          v-for="m in stored.meetings"
          :key="m.id"
        >
          <NuxtLink
            :to="`/meetings/${m.id}/progress`"
            class="block px-4 py-3 hover:bg-elevated/50"
          >
            <p class="truncate font-medium">
              {{ m.title }}
            </p>
            <p class="truncate text-sm text-muted">
              {{ new Date(m.createdAt).toLocaleString() }}
            </p>
          </NuxtLink>
        </li>
      </ul>
    </UCard>
  </UContainer>
</template>
