<script setup lang="ts">
const route = useRoute()
const meetingId = computed(() => String(route.params.id))

useSeoMeta({ title: 'MeetMind — Transcript' })
</script>

<template>
  <UContainer class="py-10">
    <UCard>
      <template #header>
        <h1 class="text-xl font-semibold">
          Transcript &amp; player
        </h1>
      </template>
      <p class="text-muted">
        Split-view placeholder for meeting <code>{{ meetingId }}</code> —
        timestamped transcript synced with the Wavesurfer waveform player lands here.
      </p>
    </UCard>
  </UContainer>
</template>
