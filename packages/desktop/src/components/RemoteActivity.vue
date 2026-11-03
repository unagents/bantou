<script setup lang="ts">
import { centerTool } from "~/api";
import type { CenterActivityState, CenterRemoteRecord, CenterWorkerReport } from "~/types";

const props = defineProps<{ owner?: string }>();

// test ids: the center dialog's list (all owners) and a session's list (one owner) can be on screen together.
const tp = computed(() => (props.owner === undefined ? "center-" : "session-"));

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
    const all = await centerTool<CenterRemoteRecord[]>("remote_list");
    remotes.value = props.owner === undefined ? all : all.filter((r) => r.owners.includes(props.owner!));
    fetchedAt.value = Date.now();
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    polling = false;
  }
}

// A different owner: drop the previous owner's list and read again now.
watch(
  () => props.owner,
  () => {
    remotes.value = null;
    void poll();
  },
);

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

/**
 * Unanswered ask / approve: the last report of its worker is an ask / approve (a later report from the same worker
 * means it went on, so it counts as answered), and this desktop has not sent a reply to it.
 */
const repliedKeys = ref(new Set<string>());
const reportKey = (r: CenterWorkerReport) => `${r.cap_id}:${r.worker_id}:${r.at}`;
function pendingAsks(r: CenterRemoteRecord): CenterWorkerReport[] {
  const reports = r.worker_reports ?? [];
  return reports.filter(
    (w, i) =>
      (w.kind === "ask" || w.kind === "approve") &&
      !reports.slice(i + 1).some((n) => n.worker_id === w.worker_id) &&
      !repliedKeys.value.has(reportKey(w)),
  );
}

const replyText = ref<Record<string, string>>({});
const replyError = ref<Record<string, string>>({});
const replySending = ref(new Set<string>());
async function sendReply(r: CenterRemoteRecord, w: CenterWorkerReport) {
  const key = reportKey(w);
  const text = (replyText.value[key] ?? "").trim();
  if (!text || replySending.value.has(key)) return;
  replySending.value.add(key);
  try {
    await centerTool("worker_reply", { remote_id: r.remote_id, worker_id: w.worker_id, text });
    repliedKeys.value.add(key);
    delete replyError.value[key];
    delete replyText.value[key];
  } catch (e) {
    replyError.value[key] = String(e);
  } finally {
    replySending.value.delete(key);
  }
}

const verdictLabel = { ok: "問題なし", issues: "指摘あり", unknown: "不明" } as const;
const severityColor = { high: "error", medium: "warning", low: "neutral" } as const;

/** Head of the latest result shown on the row. */
const RESULT_HEAD_MAX = 80;
function resultHead(r: CenterRemoteRecord): string {
  const t = (r.result ?? "").replace(/\s+/g, " ").trim();
  return t.length > RESULT_HEAD_MAX ? `${t.slice(0, RESULT_HEAD_MAX)}…` : t;
}

/** HH:MM:SS (local) of an ISO time. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("ja-JP", { hour12: false });
}

/** The cap is idle, has no worker and no pending instruction: one line "待機中". */
function waiting(r: CenterRemoteRecord): boolean {
  if (r.state !== "done" || (r.pending?.length ?? 0) > 0) return false;
  const agents = r.activity?.agents ?? [];
  return !agents.some((a) => a.kind === "worker") && !agents.some((a) => a.kind === "cap" && a.state !== "idle" && a.state !== "done");
}

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
  <div class="flex flex-col gap-2" :data-testid="`${tp}remotes`">
    <span class="text-sm font-medium">remotes</span>
    <p v-if="error" class="text-cork-danger-text text-xs whitespace-pre-wrap" :data-testid="`${tp}remotes-error`">
      {{ error }}
    </p>
    <div
      v-for="r in remotes ?? []"
      :key="r.remote_id"
      class="flex flex-col gap-1"
      :data-testid="`${tp}remote`"
      :data-remote-id="r.remote_id"
    >
      <div class="flex items-center gap-2 text-xs">
        <span class="font-medium">{{ r.remote_id }}</span>
        <span class="text-cork-muted">{{ r.serverName ?? r.server }}</span>
        <span class="text-cork-muted" :data-testid="`${tp}remote-owners`">{{ r.owners.join(", ") }}</span>
        <span v-if="r.model" class="text-cork-muted" :data-testid="`${tp}remote-model`">{{ r.model }}</span>
        <UBadge
          v-if="r.activity?.stale"
          color="warning"
          variant="subtle"
          label="更新途絶"
          :data-testid="`${tp}remote-stale`"
        />
        <span v-if="waiting(r)" class="text-cork-muted" :data-testid="`${tp}remote-waiting`">待機中</span>
        <template v-else-if="!r.activity">
          <span class="text-cork-muted">活動情報なし</span>
          <span class="text-cork-muted">{{ r.state }}</span>
        </template>
        <span v-if="resultHead(r)" class="text-cork-muted min-w-0 flex-1 truncate" :data-testid="`${tp}remote-result`">{{ resultHead(r) }}</span>
      </div>
      <template v-if="r.activity && !waiting(r)">
        <div
          v-for="a in r.activity.agents"
          :key="`${a.kind}:${a.id}`"
          class="flex flex-col pl-2 text-xs"
          :data-testid="`${tp}remote-agent`"
          :data-kind="a.kind"
          :data-state="a.state"
        >
          <div class="flex items-center gap-2">
            <span class="w-12">{{ a.kind }}</span>
            <span class="w-32 truncate">{{ a.id }}</span>
            <span v-if="a.model" class="text-cork-muted shrink-0" :data-testid="`${tp}remote-agent-model`">{{ a.model }}</span>
            <UBadge
              :color="stateColor[a.state]"
              variant="subtle"
              :label="stateLabel[a.state]"
              :data-testid="`${tp}remote-agent-state`"
            />
            <span class="min-w-0 flex-1 truncate" :data-testid="`${tp}remote-task`">{{ a.task }}</span>
            <span class="text-cork-muted shrink-0" :data-testid="`${tp}remote-elapsed`">{{ elapsed(a.silent_ms) }}</span>
          </div>
          <span v-if="a.last_activity" class="text-cork-muted truncate pl-14" :data-testid="`${tp}remote-last`">
            {{ a.last_activity }}
          </span>
          <span v-if="a.error" class="text-cork-danger-text truncate pl-14">{{ a.error }}</span>
        </div>
      </template>
      <div v-if="r.task_result" class="flex flex-col gap-1 pl-2 text-xs" :data-testid="`${tp}task-result`" :data-state="r.task_result.state">
        <div class="flex items-center gap-2">
          <span class="w-12 shrink-0">task</span>
          <span class="shrink-0">{{ r.task_result.task_id }}</span>
          <UBadge
            :color="r.task_result.state === `done` ? `info` : `error`"
            variant="subtle"
            :label="r.task_result.state === `done` ? `完了` : `失敗`"
          />
          <span class="min-w-0 flex-1 truncate" :data-testid="`${tp}task-summary`">{{ r.task_result.summary }}</span>
        </div>
        <p v-if="r.task_result.error" class="text-cork-danger-text pl-14" :data-testid="`${tp}task-error`">{{ r.task_result.error }}</p>
        <div
          v-for="w in r.task_result.workers"
          :key="w.worker_id"
          class="flex flex-col pl-14"
          :data-testid="`${tp}task-worker`"
          :data-state="w.state"
        >
          <div class="flex items-center gap-2">
            <span class="shrink-0">{{ w.role }}</span>
            <span class="w-32 truncate">{{ w.worker_id }}</span>
            <UBadge :color="stateColor[w.state]" variant="subtle" :label="stateLabel[w.state]" />
            <span v-if="w.branch" class="text-cork-muted shrink-0" :data-testid="`${tp}task-worker-branch`">{{ w.branch }}</span>
            <span v-if="w.commit" class="text-cork-muted shrink-0" :data-testid="`${tp}task-worker-commit`">{{ w.commit }}</span>
            <span v-if="w.tests" class="text-cork-muted min-w-0 truncate" :data-testid="`${tp}task-worker-tests`">{{ w.tests }}</span>
          </div>
          <span class="text-cork-muted truncate" :data-testid="`${tp}task-worker-result`">{{ w.result }}</span>
        </div>
        <div class="flex flex-col pl-14" :data-testid="`${tp}task-review`" :data-verdict="r.task_result.review.verdict">
          <div class="flex items-center gap-2">
            <span class="shrink-0">review</span>
            <span :data-testid="`${tp}task-review-verdict`">{{ verdictLabel[r.task_result.review.verdict] }}</span>
            <span class="text-cork-muted">{{ r.task_result.review.rounds }} 往復</span>
          </div>
          <div
            v-for="(it, i) in r.task_result.review.items"
            :key="i"
            class="flex items-center gap-2 pl-4"
            :data-testid="`${tp}task-review-item`"
            :data-severity="it.severity"
            :data-resolved="it.resolved ? `true` : `false`"
          >
            <UBadge :color="severityColor[it.severity]" variant="subtle" :label="it.severity" />
            <span class="min-w-0 flex-1 truncate">{{ it.text }}</span>
            <span class="text-cork-muted shrink-0">{{ it.resolved ? `解消済み` : `未解消` }}</span>
          </div>
        </div>
        <div v-if="r.task_result.remaining.length" class="flex flex-col pl-14" :data-testid="`${tp}task-remaining`">
          <span class="shrink-0">残った問題</span>
          <span v-for="(m, i) in r.task_result.remaining" :key="i" class="pl-4">{{ m }}</span>
        </div>
      </div>
      <div
        v-for="w in pendingAsks(r)"
        :key="reportKey(w)"
        class="flex flex-col gap-1 pl-2 text-xs"
        :data-testid="`${tp}worker-ask`"
        :data-kind="w.kind"
        :data-worker-id="w.worker_id"
      >
        <div class="flex items-center gap-2">
          <span class="text-cork-muted shrink-0">{{ clock(w.at) }}</span>
          <UBadge color="warning" variant="subtle" :label="w.kind === `ask` ? `質問` : `承認依頼`" />
          <span class="shrink-0">{{ w.worker_id }}</span>
          <span class="min-w-0 flex-1 whitespace-pre-wrap" :data-testid="`${tp}worker-ask-text`">{{ w.text }}</span>
        </div>
        <form class="flex items-center gap-2 pl-14" @submit.prevent="sendReply(r, w)">
          <input
            v-model="replyText[reportKey(w)]"
            class="border-cork-border min-w-0 flex-1 rounded border px-2 py-1"
            :placeholder="w.kind === `ask` ? `返答` : `承認 / 却下の返答`"
            :data-testid="`${tp}worker-reply-input`"
          />
          <UButton
            type="submit"
            size="xs"
            label="返信"
            :disabled="!(replyText[reportKey(w)] ?? '').trim() || replySending.has(reportKey(w))"
            :data-testid="`${tp}worker-reply-send`"
          />
        </form>
        <p v-if="replyError[reportKey(w)]" class="text-cork-danger-text pl-14 whitespace-pre-wrap" :data-testid="`${tp}worker-reply-error`">
          {{ replyError[reportKey(w)] }}
        </p>
      </div>
    </div>
    <p v-if="remotes && !remotes.length" class="text-cork-muted text-xs" :data-testid="`${tp}remotes-none`">
      remote なし
    </p>
  </div>
</template>
