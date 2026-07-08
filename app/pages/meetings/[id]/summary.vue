<script setup lang="ts">
const route = useRoute()
const meetingId = computed(() => String(route.params.id))

useSeoMeta({ title: 'MeetMind — Summary' })
</script>

<template>
  <UContainer class="py-10">
    <UCard>
      <template #header>
        <h1 class="text-xl font-semibold">
          Summary &amp; action items
        </h1>
      </template>
      <p class="text-muted">
        Summary placeholder for meeting <code>{{ meetingId }}</code> —
        structured summary, decisions and action items with timestamp references land here.
      </p>
    </UCard>
  </UContainer>
</template>
