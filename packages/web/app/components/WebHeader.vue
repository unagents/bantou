<script setup lang="ts">
// Header of the phone screens: no drag region, no window-control padding (the desktop AppHeader has both).
defineProps<{ title: string; unreachable?: boolean }>();
</script>

<template>
  <header class="border-cork-border flex h-12 shrink-0 items-center gap-2 border-b px-3" data-testid="web-header">
    <h1 class="font-display truncate text-base font-semibold">{{ title }}</h1>
    <UBadge v-if="unreachable" class="ml-auto" color="warning" variant="subtle" label="つながらない" data-testid="web-unreachable" />
  </header>
</template>
