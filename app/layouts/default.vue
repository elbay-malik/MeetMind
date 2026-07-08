<template>
  <div class="min-h-screen">
    <header class="border-b border-default">
      <UContainer class="flex h-14 items-center justify-between">
        <NuxtLink to="/">
          <AppLogo />
        </NuxtLink>
        <nav class="flex items-center gap-4 text-sm">
          <NuxtLink
            to="/"
            class="hover:text-primary"
          >Upload</NuxtLink>
          <NuxtLink
            to="/meetings"
            class="hover:text-primary"
          >Meetings</NuxtLink>
        </nav>
      </UContainer>
    </header>
    <main>
      <slot />
    </main>
  </div>
</template>
