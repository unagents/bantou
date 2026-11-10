<script setup lang="ts">
import type { SessionActivity } from "~/types";

defineProps<{ activity: SessionActivity }>();

/** The mark of a session's work state on the side row: icon + short Japanese label. */
const META: Record<SessionActivity, { label: string; icon: string; cls: string; tip: string }> = {
  working: { label: "作業中", icon: "i-lucide-loader-circle", cls: "text-info animate-spin", tip: "作業が続いている" },
  "needs-input": { label: "判断待ち", icon: "i-lucide-message-circle-question", cls: "text-warning", tip: "質問・判断・許可の返事を待っている" },
  idle: { label: "待機", icon: "i-lucide-circle-check", cls: "text-success", tip: "完了して次の指示を待っている" },
};
</script>

<template>
  <span
    class="flex shrink-0 items-center gap-1 text-xs"
    :class="activity === 'needs-input' ? 'text-warning font-semibold' : 'text-cork-muted'"
    :title="META[activity].tip"
    data-testid="session-activity"
    :data-activity="activity"
  >
    <UIcon :name="META[activity].icon" class="size-3.5" :class="META[activity].cls" />
    {{ META[activity].label }}
  </span>
</template>
