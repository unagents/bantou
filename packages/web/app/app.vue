<script setup lang="ts">
// The shared right-edge drawer of the sessions' last messages; it lives here so the messages survive page changes.
const { messages } = useMessageDrawer();
const goSession = (name: string) => void navigateTo(`/s/${encodeURIComponent(name)}`);
</script>

<template>
  <UApp>
    <NuxtPage />
    <MessageDrawer :messages="messages" @select="goSession" />
  </UApp>
</template>
