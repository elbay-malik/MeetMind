<script setup lang="ts">
import { DEMO_GUIDE_HEAD_SCRIPT } from '~/utils/demo-guide'

/**
 * A card for a first visit to the public demo: in the page below the player, and in the
 * corner only from 1344px, where the margin beside the 768px page holds its 256px and a gap,
 * so it never covers the player's controls. It never takes focus by itself or blocks the page: there is no
 * backdrop, and Esc closes it from anywhere. It is rendered by the server, so it shifts
 * nothing when the page comes up.
 */
useHead({ script: [{ key: 'demo-guide', innerHTML: DEMO_GUIDE_HEAD_SCRIPT }] })
const emit = defineEmits<{
  /** Focus was inside the card, which is gone now, so the page puts it back on its button. */
  closedWithFocus: []
}>()

const { open, close, dismiss } = useDemoGuide()
const card = ref<HTMLElement | null>(null)

function end(action: () => void) {
  const hadFocus = !!card.value?.contains(document.activeElement)
  action()
  if (hadFocus) emit('closedWithFocus')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) end(close)
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <aside
    v-if="open"
    id="demo-guide"
    ref="card"
    aria-labelledby="demo-guide-title"
    data-testid="demo-guide"
    data-demo-guide
    class="rounded-lg border border-default bg-default p-4 min-[1344px]:fixed min-[1344px]:right-4 min-[1344px]:bottom-4 min-[1344px]:z-40 min-[1344px]:w-64 min-[1344px]:shadow-lg"
  >
    <h2
      id="demo-guide-title"
      tabindex="-1"
      class="font-semibold focus:outline-none"
    >
      Try this
    </h2>
    <ol class="mt-2 list-decimal space-y-1 pl-5 text-sm">
      <li>Ask a question below, for example “What caused the outage?”. The answer cites the lines it came from.</li>
      <li>Click a timestamp in an answer to jump the recording to that moment.</li>
      <li>Read the decisions and action items. Each one quotes the line it came from.</li>
    </ol>
    <p class="mt-2 text-sm text-muted">
      The demo answers a limited number of questions a day, shared by every visitor. Uploading
      your own recording needs an invite code.
    </p>
    <div class="mt-3 flex flex-wrap gap-2">
      <UButton
        size="sm"
        @click="end(close)"
      >
        Close
      </UButton>
      <UButton
        size="sm"
        color="neutral"
        variant="subtle"
        @click="end(dismiss)"
      >
        Don't show again
      </UButton>
    </div>
  </aside>
</template>

<style>
/* The head script's class: a dismissed guide is never painted, so hiding it moves nothing. */
html.demo-guide-dismissed [data-demo-guide] {
  display: none;
}
</style>
