<script setup lang="ts">
// In the render of every page, so the payload has them wherever a visit lands: a page reached
// by a link after that asks the browser, which cannot work them out.
useDeploymentFacts()
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
