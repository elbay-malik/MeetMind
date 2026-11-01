<script setup lang="ts">
const props = defineProps<{ meetingId: string }>()

/**
 * The meeting page, not the page this renders on and not its query string: a link
 * that opens one moment or the pipeline view is not the one to keep. The path until
 * mounted, because the server and the browser can disagree about the origin.
 */
const path = computed(() => `/meetings/${props.meetingId}`)
const origin = ref('')
onMounted(() => {
  origin.value = window.location.origin
})
const link = computed(() => `${origin.value}${path.value}`)

const input = ref<{ inputRef?: HTMLInputElement } | null>(null)
const copyStatus = ref('')

async function copyLink() {
  try {
    // Undefined outside a secure context, which lands in the catch below.
    await navigator.clipboard.writeText(link.value)
    copyStatus.value = 'Link copied.'
  }
  catch {
    input.value?.inputRef?.select()
    copyStatus.value = 'Could not copy automatically. The link is selected, so copy it from there.'
  }
}
</script>

<template>
  <UCard>
    <h2 class="font-semibold">
      Keep this link
    </h2>
    <p class="mt-1 text-sm text-muted">
      It is the only way back to this meeting: there are no accounts, and if you lose it
      you lose access. Anyone with this link can read the transcript and summary and play
      the audio.
    </p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <UInput
        ref="input"
        :model-value="link"
        readonly
        aria-label="Link to this meeting"
        class="min-w-0 flex-1"
      />
      <UButton
        icon="i-lucide-copy"
        variant="soft"
        @click="copyLink"
      >
        Copy link
      </UButton>
    </div>
    <!-- Always mounted, so the change is announced. A span, so the text stays tight
         against its tags and empty:hidden works. -->
    <span
      class="mt-2 block text-sm text-muted empty:hidden"
      role="status"
      aria-live="polite"
    >{{ copyStatus }}</span>
  </UCard>
</template>
