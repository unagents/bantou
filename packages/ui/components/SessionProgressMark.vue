<script setup lang="ts">
import type { SessionProgress } from "../composables/sessionStatus";

const props = defineProps<{ progress: SessionProgress }>();

/** The mark of "work is going on in this session" (apart from the cap's own state): icon only. The detail is in the title (tooltip) and aria-label. */
const tip = computed(() => {
  const p = props.progress;
  const parts: string[] = [];
  if (p.cap) parts.push("cap が実行中");
  if (p.subagents > 0) parts.push(`subagent ${p.subagents} 件`);
  if (p.tasks > 0) parts.push(`background の実行 ${p.tasks} 件`);
  if (p.remote > 0) parts.push(`remote の作業 ${p.remote} 件`);
  return `作業進行中: ${parts.join("、")}`;
});
</script>

<template>
  <span class="flex shrink-0 items-center text-xs text-cork-muted" :title="tip" role="img" :aria-label="tip" data-testid="session-progress">
    <UIcon name="i-lucide-loader-circle" class="size-3.5 text-info animate-spin" aria-hidden="true" />
  </span>
</template>
