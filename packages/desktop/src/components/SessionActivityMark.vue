<script setup lang="ts">
import type { SessionActivity } from "~/types";

const props = defineProps<{
  activity: SessionActivity;
  /** Unanswered worker asks / approvals on the session's remote-caps (the tooltip of "needs-input" names them). */
  waitingReply?: number;
}>();

/** The mark of a session's work state on the side row: icon + short Japanese label. */
const META: Record<SessionActivity, { label: string; icon: string; cls: string; tip: string }> = {
  working: { label: "作業中", icon: "i-lucide-loader-circle", cls: "text-info animate-spin", tip: "作業が続いている" },
  "remote-working": {
    label: "remote 作業中",
    icon: "i-lucide-server-cog",
    cls: "text-info animate-spin",
    tip: "remote（server の cap / worker）に預けた作業が続いている",
  },
  "needs-input": { label: "判断待ち", icon: "i-lucide-message-circle-question", cls: "text-warning", tip: "質問・判断・許可の返事を待っている" },
  idle: { label: "待機", icon: "i-lucide-circle-check", cls: "text-success", tip: "完了して次の指示を待っている" },
};
const tip = computed(() => {
  const base = META[props.activity].tip;
  const n = props.waitingReply ?? 0;
  return props.activity === "needs-input" && n > 0 ? `${base}（worker の質問に未返答 ${n} 件）` : base;
});
</script>

<template>
  <span
    class="flex shrink-0 items-center gap-1 text-xs"
    :class="activity === 'needs-input' ? 'text-warning font-semibold' : 'text-cork-muted'"
    :title="tip"
    data-testid="session-activity"
    :data-activity="activity"
  >
    <UIcon :name="META[activity].icon" class="size-3.5" :class="META[activity].cls" />
    {{ META[activity].label }}
  </span>
</template>
