<script setup lang="ts">
import type { BrokerStatus } from "~/types";

defineProps<{
  workspacePath: string;
  waitingCount: number;
  broker: BrokerStatus | null;
}>();
defineEmits<{ open: []; addSession: [] }>();
</script>

<template>
  <header
    data-tauri-drag-region="deep"
    class="border-cork-border bg-cork-surface sticky top-0 z-10 flex h-(--cork-header-height) items-center gap-3 border-b pr-4 pl-20"
  >
    <h1 class="font-display text-lg font-semibold">bantou</h1>
    <span class="text-cork-muted min-w-0 truncate text-xs">{{ workspacePath }}</span>
    <div class="ml-auto flex items-center gap-3">
      <UBadge
        v-if="waitingCount > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-message-circle-question"
        :label="`返答待ち ${waitingCount}`"
      />
      <UTooltip
        :text="
          broker?.connected
            ? `${broker.name} @ ${broker.broker_url}`
            : (broker?.error ?? 'broker を探索中…')
        "
      >
        <span class="flex items-center gap-1 text-xs">
          <span
            class="size-2 rounded-full"
            :class="broker?.connected ? 'bg-green-400' : 'bg-amber-400'"
          />
          <span class="text-cork-muted">messenger</span>
        </span>
      </UTooltip>
      <UButton
        size="sm"
        variant="ghost"
        color="neutral"
        icon="i-lucide-user-plus"
        label="セッション追加"
        :disabled="!broker?.connected"
        @click="$emit('addSession')"
      />
      <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-folder-open" @click="$emit('open')" />
    </div>
  </header>
</template>
