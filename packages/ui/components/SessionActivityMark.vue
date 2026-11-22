<script setup lang="ts">
import type { RemoteIssue, SessionActivity } from "../types";

const props = defineProps<{
  activity: SessionActivity;
  /** Unanswered worker asks / approvals on the session's remote-caps (the tooltip of "needs-input" names them). */
  waitingReply?: number;
  /** The remote-caps in trouble (the tooltip of "remote-unreachable" / "remote-lost" names the servers and the times). */
  issues?: { unreachable: RemoteIssue[]; lost: RemoteIssue[] };
}>();

/**
 * The mark of the cap's (the session's claude) own state on the side row: icon only. The label is only in the title (tooltip) and aria-label.
 * Whether work is going on is another mark (SessionProgressMark); an idle cap can have work in progress.
 */
const META: Record<SessionActivity, { label: string; icon: string; cls: string; tip: string }> = {
  working: { label: "cap 処理中", icon: "i-lucide-hourglass", cls: "text-info", tip: "cap 自体が何かをしていて、利用者の入力に反応できない" },
  "needs-input": { label: "返答待ち", icon: "i-lucide-message-circle-question", cls: "text-warning", tip: "質問・判断・許可の返事を待っている" },
  "remote-unreachable": { label: "到達不能", icon: "i-lucide-server-off", cls: "text-error", tip: "remote の server に届かない（状態が分からない）" },
  "remote-lost": { label: "lost", icon: "i-lucide-unplug", cls: "text-error", tip: "remote の cap が lost（server 側で実行が失われた）" },
  idle: { label: "待機", icon: "i-lucide-circle-check", cls: "text-success", tip: "cap は次の指示を待っている（作業が進行中でも、cap は入力を受けられる）" },
};
/** "11/10 20:57" in the local time. */
function at(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "なし";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const tip = computed(() => {
  if (props.activity === "remote-unreachable") {
    const items = props.issues?.unreachable ?? [];
    const d = items.map((i) => `server ${i.server}（最後の応答 ${at(i.lastOkAt)}）`).join("、");
    return `${META[props.activity].label}: ${META[props.activity].tip}${d ? `: ${d}` : ""}`;
  }
  if (props.activity === "remote-lost") {
    const items = props.issues?.lost ?? [];
    const d = items.map((i) => `server ${i.server}（${at(i.at)} に通知）`).join("、");
    return `${META[props.activity].label}: ${META[props.activity].tip}${d ? `: ${d}` : ""}`;
  }
  const base = META[props.activity].tip;
  const n = props.waitingReply ?? 0;
  const detail = props.activity === "needs-input" && n > 0 ? `${base}（worker の質問に未返答 ${n} 件）` : base;
  return `${META[props.activity].label}: ${detail}`;
});
</script>

<template>
  <span
    class="flex shrink-0 items-center gap-1 text-xs"
    :class="activity === 'needs-input' ? 'text-warning font-semibold' : 'text-cork-muted'"
    :title="tip"
    role="img"
    :aria-label="tip"
    data-testid="session-activity"
    :data-activity="activity"
  >
    <UIcon :name="META[activity].icon" class="size-3.5" :class="META[activity].cls" aria-hidden="true" />
  </span>
</template>
