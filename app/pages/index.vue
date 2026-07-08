<script setup lang="ts">
useSeoMeta({ title: 'MeetMind — Upload' })
</script>

<template>
  <UContainer class="py-10">
    <UCard>
      <template #header>
        <h1 class="text-xl font-semibold">
          Upload a meeting recording
        </h1>
      </template>
      <p class="text-muted">
        Drop-zone placeholder — the in-browser audio extraction pipeline lands here.
        Video never leaves your machine; only compressed audio is uploaded.
      </p>
    </UCard>
  </UContainer>
</template>
