<script setup lang="ts">
import type { LocalMeeting } from '~/utils/local-meetings'

useSeoMeta({ title: 'MeetMind — Your meetings' })

/**
 * Read once mounted, so the server and the first client render agree: neither can
 * know what is in this browser. `null` until then.
 */
const stored = ref<{ available: boolean, writable: boolean, meetings: LocalMeeting[] } | null>(null)
function load() {
  const storage = browserStorage()
  stored.value = { ...readLocalMeetings(storage), writable: canStoreLocalMeetings(storage) }
}
onMounted(load)

/** Not `available` alone: storage that reads fine and refuses writes loses uploads too. */
const refused = computed(() => stored.value !== null && (!stored.value.available || !stored.value.writable))

const removeFailed = ref(false)

function remove(meeting: LocalMeeting) {
  const message = `Remove "${meeting.title}" from this list? The meeting itself is not deleted, but this browser stops holding its link, so unless you kept the link you lose access.`
  if (!window.confirm(message)) return
  removeFailed.value = !forgetLocalMeeting(browserStorage(), meeting.id)
  load()
}
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
      v-if="refused"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="This browser is not letting MeetMind store anything"
      description="Meetings you upload will not appear here, so keep each meeting's link yourself."
    />

    <UAlert
      v-if="removeFailed"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Could not remove that meeting from this list"
    />

    <UCard v-if="stored && !refused && stored.meetings.length === 0">
      <div class="py-8 text-center text-muted">
        <UIcon
          name="i-lucide-list"
          class="mx-auto mb-3 size-8 text-dimmed"
        />
        <p>No meetings uploaded from this browser. Upload a recording to get started.</p>
      </div>
    </UCard>

    <UCard
      v-if="stored && stored.meetings.length > 0"
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <ul class="divide-y divide-default">
        <li
          v-for="m in stored.meetings"
          :key="m.id"
          class="flex items-center gap-2 pr-3 hover:bg-elevated/50"
        >
          <NuxtLink
            :to="`/meetings/${m.id}/progress`"
            class="block min-w-0 flex-1 py-3 pl-4"
          >
            <p class="truncate font-medium">
              {{ m.title }}
            </p>
            <p class="truncate text-sm text-muted">
              {{ new Date(m.createdAt).toLocaleString() }}
              <span
                v-if="m.unfinished"
                class="text-warning"
              >· Upload not finished</span>
            </p>
          </NuxtLink>
          <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="sm"
            :aria-label="`Remove ${m.title} from this list`"
            @click="remove(m)"
          />
        </li>
      </ul>
    </UCard>
  </UContainer>
</template>
