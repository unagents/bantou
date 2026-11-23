<script setup lang="ts">
// Phone screen, tab "server / cap" (design 7.1): the shared parts stacked as cards. The caps are the shared
// RemoteActivity list (polls `remotes`); the servers (version, rc state) are the shared CenterDialog, opened from a button.
const serverOpen = ref(false);
</script>

<template>
  <div class="flex flex-col gap-3 p-3" data-testid="server-cap-cards">
    <section class="border-cork-border rounded border p-3" data-testid="cap-card">
      <RemoteActivity />
    </section>
    <section class="border-cork-border flex items-center gap-2 rounded border p-3" data-testid="server-card">
      <span class="text-sm font-medium">server</span>
      <UButton class="ml-auto" size="sm" color="neutral" variant="soft" icon="i-lucide-server" label="server の一覧" data-testid="server-open" @click="serverOpen = true" />
    </section>
    <CenterDialog v-model:open="serverOpen" />
  </div>
</template>
