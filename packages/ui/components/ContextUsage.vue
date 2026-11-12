<script setup lang="ts">
import type { ContextUsage } from "../types";

const props = defineProps<{ usage: ContextUsage | null; percentOnly?: boolean }>();

/** At or above this percent the usage is shown in the warning colour. */
const WARN_PERCENT = 80;

/** 84000 -> "84k", 1000000 -> "1M", 1500 -> "1.5k", 800 -> "800". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1000) return `${Math.round((n / 1000) * 10) / 10}k`;
  return String(n);
}

/** "ctx 42% 84k/200k" (percentOnly: "42%"); only the tokens ("ctx 84k") when the window is unknown. */
const label = computed(() => {
  const u = props.usage;
  if (!u) return null;
  // Side row: "42%" only; nothing when the percent is unknown.
  if (props.percentOnly) return u.percent === null ? null : `${Math.round(u.percent)}%`;
  if (u.windowTokens === null || u.percent === null) return `ctx ${compact(u.usedTokens)}`;
  return `ctx ${Math.round(u.percent)}% ${compact(u.usedTokens)}/${compact(u.windowTokens)}`;
});
const title = computed(() => {
  const u = props.usage;
  // Header: unchanged from before. Only the side row (percent-only) adds the tokens.
  const tokens = u && props.percentOnly ? `${compact(u.usedTokens)}${u.windowTokens === null ? "" : `/${compact(u.windowTokens)}`} トークン` : "";
  const base = u?.updatedAt ? `コンテキスト使用量（${u.updatedAt} 時点）` : "コンテキスト使用量";
  return tokens ? `${base} ${tokens}` : base;
});
const warn = computed(() => props.usage?.percent != null && Math.round(props.usage.percent) >= WARN_PERCENT);
</script>

<template>
  <span
    v-if="label"
    data-testid="context-usage"
    :data-level="warn ? 'warn' : 'normal'"
    class="shrink-0 text-xs font-normal tabular-nums"
    :class="warn ? 'text-warning font-semibold' : 'text-cork-muted'"
    :title="title"
  >{{ label }}</span>
</template>
