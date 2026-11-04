<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const notFound = computed(() => props.error.statusCode === 404)
const title = computed(() => {
  if (!notFound.value) return 'This page could not be loaded'
  return props.error.statusMessage === 'Meeting not found' ? 'Meeting not found' : 'Page not found'
})
useSeoMeta({ title: () => `MeetMind — ${title.value}` })

/** Separate blocks minutes apart are not one outage, and each recovered. */
const RETRIES_FORGOTTEN_MS = 60_000
const RETRIES_KEY = 'meetmind-error-reloads'

const retrying = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

/** How many reloads this tab has spent on this page, so an outage does not reload it for ever. */
function spendRetry(): boolean {
  try {
    const spent = JSON.parse(sessionStorage.getItem(RETRIES_KEY) ?? '{}') as { path?: string, count?: number, at?: number }
    const recent = spent.path === location.pathname && Date.now() - (spent.at ?? 0) < RETRIES_FORGOTTEN_MS
    const count = recent ? spent.count ?? 0 : 0
    if (count >= PAGE_MAX_RETRIES) return false
    sessionStorage.setItem(RETRIES_KEY, JSON.stringify({ path: location.pathname, count: count + 1, at: Date.now() }))
    return true
  }
  catch {
    return false
  }
}

function reload() {
  location.reload()
}

onMounted(() => {
  if (notFound.value || !spendRetry()) return
  retrying.value = true
  timer = setTimeout(reload, PAGE_RETRY_MS)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <UApp>
    <NuxtLayout>
      <UContainer class="max-w-3xl space-y-4 py-16">
        <h1 class="text-2xl font-semibold tracking-tight">
          {{ title }}
        </h1>
        <p
          v-if="notFound"
          class="text-muted"
        >
          {{ title === 'Meeting not found' ? 'The link may be wrong, or the meeting may have been deleted.' : 'The link may be wrong.' }}
        </p>
        <p
          v-else
          class="text-muted"
          role="status"
        >
          {{ retrying ? 'Trying again in a few seconds.' : 'Try again in a moment.' }}
        </p>
        <div class="flex gap-3">
          <UButton
            v-if="!notFound"
            icon="i-lucide-refresh-cw"
            :disabled="retrying"
            @click="reload"
          >
            Try again
          </UButton>
          <UButton
            to="/"
            variant="subtle"
            color="neutral"
          >
            Go to the home page
          </UButton>
        </div>
      </UContainer>
    </NuxtLayout>
  </UApp>
</template>
