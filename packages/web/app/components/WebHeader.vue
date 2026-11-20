<script setup lang="ts">
// Header of the phone screens: no drag region, no window-control padding (the desktop AppHeader has both).
defineProps<{ title: string; unreachable?: boolean; /** Where the back arrow leads (none: no arrow). */ back?: string }>();
defineEmits<{ settings: [] }>();
</script>

<template>
  <header class="border-cork-border flex h-12 shrink-0 items-center gap-2 border-b px-3" data-testid="web-header">
    <NuxtLink v-if="back" :to="back" class="hover:bg-cork-elevated -ml-2 flex size-9 shrink-0 items-center justify-center rounded" aria-label="一覧へ戻る" data-testid="web-back">
      <UIcon name="i-lucide-arrow-left" class="size-5" aria-hidden="true" />
    </NuxtLink>
    <h1 class="font-display truncate text-base font-semibold">{{ title }}</h1>
    <UBadge v-if="unreachable" class="ml-auto" color="warning" variant="subtle" label="つながらない" data-testid="web-unreachable" />
    <UButton
      :class="unreachable ? '' : 'ml-auto'"
      size="md"
      variant="ghost"
      color="neutral"
      icon="i-lucide-settings"
      aria-label="設定"
      data-testid="web-settings-open"
      @click="$emit('settings')"
    />
  </header>
</template>
