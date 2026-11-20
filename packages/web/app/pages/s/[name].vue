<script setup lang="ts">
// Phone screen, level 2: one session's terminal (design 7.1). The shared TerminalView as it is: the special-key row, the
// input box and the width handling come with 6a / 6b.
const route = useRoute();
const name = computed(() => String(route.params.name ?? ""));
</script>

<template>
  <div class="bg-default text-default flex h-dvh flex-col overflow-hidden">
    <WebHeader :title="name" back="/" />
    <main class="min-h-0 flex-1" data-testid="terminal-page">
      <TerminalView :key="name" :session="name" />
    </main>
  </div>
</template>
