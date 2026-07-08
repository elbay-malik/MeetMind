<script setup lang="ts">
const route = useRoute()
const meetingId = computed(() => String(route.params.id))

useSeoMeta({ title: 'MeetMind — Processing' })
</script>

<template>
  <UContainer class="py-10">
    <UCard>
      <template #header>
        <h1 class="text-xl font-semibold">
          Pipeline progress
        </h1>
      </template>
      <p class="text-muted">
        Progress placeholder for meeting <code>{{ meetingId }}</code> —
        uploading → transcribing → summarizing → indexing stages stream here.
      </p>
    </UCard>
  </UContainer>
</template>
