<script setup lang="ts">
// The shared right-edge drawer of the sessions' last messages; it lives here so the messages survive page changes.
const { messages } = useMessageDrawer();
const goSession = (name: string) => void navigateTo(`/s/${encodeURIComponent(name)}`);
</script>

<template>
  <UApp>
    <!-- the drawer is a column beside the page: opened, the page narrows (below WebHeader, h-12) -->
    <div class="flex">
      <div class="min-w-0 flex-1">
        <NuxtPage />
      </div>
      <MessageDrawer class="sticky top-12 h-[calc(100vh-3rem)] self-start" :messages="messages" @select="goSession" />
    </div>
  </UApp>
</template>
