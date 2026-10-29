<script setup lang="ts">
import { centerTool } from "~/api";
import type { CenterActivityState, CenterRemoteRecord } from "~/types";

const POLL_MS = 3000;

const remotes = ref<CenterRemoteRecord[] | null>(null);
const error = ref<string | null>(null);
const fetchedAt = ref(Date.now());
const now = ref(Date.now());

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    remotes.value = await centerTool<CenterRemoteRecord[]>("remote_list");
    fetchedAt.value = Date.now();
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    polling = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
  tickTimer = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
});

const stateColor: Record<CenterActivityState, "success" | "warning" | "neutral" | "info" | "error"> = {
  running: "success",
  stalled: "warning",
  idle: "neutral",
  done: "info",
  failed: "error",
  lost: "error",
};
const stateLabel: Record<CenterActivityState, string> = {
  running: "動作中",
  stalled: "停滞",
  idle: "待機",
  done: "完了",
  failed: "失敗",
  lost: "消失",
};

/** `silent_ms` as of the fetch plus the time since, so host clock skew does not matter. */
function elapsed(silentMs: number): string {
  const s = Math.max(0, Math.floor((silentMs + (now.value - fetchedAt.value)) / 1000));
  if (s < 60) return `最終出力 ${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `最終出力 ${m}分前`;
  return `最終出力 ${Math.floor(m / 60)}時間${m % 60}分前`;
}
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="center-remotes">
    <span class="text-sm font-medium">remotes</span>
    <p v-if="error" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="center-remotes-error">
      {{ error }}
    </p>
    <div
      v-for="r in remotes ?? []"
      :key="r.remote_id"
      class="flex flex-col gap-1"
      data-testid="center-remote"
      :data-remote-id="r.remote_id"
    >
      <div class="flex items-center gap-2 text-xs">
        <span class="font-medium">{{ r.remote_id }}</span>
        <span class="text-cork-muted">{{ r.serverName ?? r.server }}</span>
        <span class="text-cork-muted">{{ r.owner }}</span>
        <UBadge
          v-if="r.activity?.stale"
          color="warning"
          variant="subtle"
          label="更新途絶"
          data-testid="center-remote-stale"
        />
        <template v-if="!r.activity">
          <span class="text-cork-muted">活動情報なし</span>
          <span class="text-cork-muted">{{ r.state }}</span>
        </template>
      </div>
      <template v-if="r.activity">
        <div
          v-for="a in r.activity.agents"
          :key="`${a.kind}:${a.id}`"
          class="flex flex-col pl-2 text-xs"
          data-testid="center-remote-agent"
          :data-kind="a.kind"
          :data-state="a.state"
        >
          <div class="flex items-center gap-2">
            <span class="w-12">{{ a.kind }}</span>
            <span class="w-32 truncate">{{ a.id }}</span>
            <UBadge
              :color="stateColor[a.state]"
              variant="subtle"
              :label="stateLabel[a.state]"
              data-testid="center-remote-agent-state"
            />
            <span class="min-w-0 flex-1 truncate" data-testid="center-remote-task">{{ a.task }}</span>
            <span class="text-cork-muted shrink-0" data-testid="center-remote-elapsed">{{ elapsed(a.silent_ms) }}</span>
          </div>
          <span v-if="a.last_activity" class="text-cork-muted truncate pl-14" data-testid="center-remote-last">
            {{ a.last_activity }}
          </span>
          <span v-if="a.error" class="text-cork-danger-text truncate pl-14">{{ a.error }}</span>
        </div>
      </template>
    </div>
    <p v-if="remotes && !remotes.length" class="text-cork-muted text-xs" data-testid="center-remotes-none">
      remote なし
    </p>
  </div>
</template>
