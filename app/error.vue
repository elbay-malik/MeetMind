<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const notFound = computed(() => props.error.statusCode === 404)
const title = computed(() => {
  if (!notFound.value) return 'This page could not be loaded'
  return props.error.statusMessage === 'Meeting not found' ? 'Meeting not found' : 'Page not found'
})
useSeoMeta({ title: () => `MeetMind — ${title.value}` })

/** Past the rate rule's 10-second block, which is the likeliest reason for being here. */
const RETRY_MS = 11_000
const MAX_RETRIES = 3
const RETRIES_KEY = 'meetmind-error-reloads'

const retrying = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

/** How many reloads this tab has spent on this page, so an outage does not reload it for ever. */
function spendRetry(): boolean {
  try {
    const spent = JSON.parse(sessionStorage.getItem(RETRIES_KEY) ?? '{}') as { path?: string, count?: number }
    const count = spent.path === location.pathname ? spent.count ?? 0 : 0
    if (count >= MAX_RETRIES) return false
    sessionStorage.setItem(RETRIES_KEY, JSON.stringify({ path: location.pathname, count: count + 1 }))
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
  timer = setTimeout(reload, RETRY_MS)
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
          The link may be wrong, or the meeting may have been deleted.
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
            @click="reload"
          >
            Try again
          </UButton>
          <UButton
            to="/"
            external
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
