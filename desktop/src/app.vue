<script setup lang="ts">
const { state, installAndRestart, dismiss } = useUpdater();
</script>

<template>
  <UApp>
    <NuxtPage />
    <UpdaterToast :state="state" @install="installAndRestart" @dismiss="dismiss" />
  </UApp>
</template>
