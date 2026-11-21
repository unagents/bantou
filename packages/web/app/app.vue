<script setup lang="ts">
// The shared right-edge drawer of the sessions' last messages; it lives here so the messages survive page changes.
const { messages } = useMessageDrawer();
const goSession = (name: string) => void navigateTo(`/s/${encodeURIComponent(name)}`);
</script>

<template>
  <UApp>
    <!-- the right edge is left free for the closed drawer's grab strip -->
    <div :style="{ paddingRight: `${DRAWER_HANDLE}px` }">
      <NuxtPage />
    </div>
    <!-- top: below WebHeader (h-12) -->
    <MessageDrawer :messages="messages" top="3rem" @select="goSession" />
  </UApp>
</template>
