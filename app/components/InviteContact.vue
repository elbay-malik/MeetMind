<script setup lang="ts">
const INVITE_EMAIL = 'elbay.malik@gmail.com'
const mailto = `mailto:${INVITE_EMAIL}?subject=${encodeURIComponent('MeetMind invite code')}`
</script>

<template>
  <span>To try it on a real meeting, email
    <a
      :href="mailto"
      class="text-primary underline"
    >{{ INVITE_EMAIL }}</a>
    for an invite code.</span>
</template>
