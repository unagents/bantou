<script setup lang="ts">
import { useElementSize, useIntervalFn } from "@vueuse/core";
import { brokerConnect, brokerStatus, centerGetSettings } from "~/api";
import type { BrokerStatus, SessionActivity, Task } from "~/types";

const { dir, loaded, load, pickAndOpen } = useWorkspace();
const { refreshNow: refreshSessions } = useSessionRefresh();
const { threads, centerList, sessions, activityCounts, waitingCount, running, refresh } = useBoard(dir);
const toast = useToast();
// --- pane widths (side | middle | right; drag the dividers) ---
const paneRow = ref<HTMLElement | null>(null);
const { width: paneRowWidth } = useElementSize(paneRow);
const pane = usePaneWidths(paneRowWidth);
const { state: updaterState, checkManually, installAndRestart } = useUpdater();

useWorkspaceWatcher(dir, () => void refresh());

const broker = ref<BrokerStatus | null>(null);

async function enterWorkspace() {
  await refresh();
  try {
    broker.value = await brokerConnect();
  } catch (e) {
    broker.value = null;
    toast.add({ title: "broker 接続エラー", description: String(e), color: "error" });
  }
}

onMounted(async () => {
  await load();
  if (dir.value) await enterWorkspace();
});

watch(dir, async (next) => {
  if (next) await enterWorkspace();
});

// Broker status is polled lightly so the header dot reflects reconnects.
const { pause, resume } = useIntervalFn(async () => {
  if (!dir.value || !broker.value) return;
  broker.value = await brokerStatus();
}, 5000);
onMounted(resume);
onBeforeUnmount(pause);

// --- thread modal ------------------------------------------------------------

const activeTask = ref<Task | null>(null);
const modalOpen = ref(false);
const activeThread = computed(() => (activeTask.value ? threads.value[activeTask.value.id] : undefined));

function openThread(t: Task) {
  activeTask.value = t;
  modalOpen.value = true;
}

watch(modalOpen, (v) => {
  if (!v) activeTask.value = null;
});

// --- session side menu (the connected center's session_list; selection lives in memory only) ----

const selectedName = ref<string | null>(null);
/** A project from the center config (not made by `session_create`) has no settings: the center cannot update it. */
const fromConfig = (name: string) => centerList.value.sessions.find((r) => r.name === name)?.source === "config";
/** Session whose project settings dialog is open. */
const settingsFor = ref<string | null>(null);
/** Whether the session of the open gear dialog was the selected one when it was opened (the list may refresh before the save returns). */
let settingsWasSelected = false;
function openSettings(name: string) {
  settingsWasSelected = selectedName.value === name;
  settingsFor.value = name;
}
const settingsDialogOpen = computed({
  get: () => settingsFor.value !== null,
  set: (v) => {
    if (!v) settingsFor.value = null;
  },
});
watch(
  sessions,
  (list) => {
    if (!list.some((g) => g.name === selectedName.value)) selectedName.value = list[0]?.name ?? null;
  },
  { immediate: true },
);
// --- work state summary / filter (side menu) ---------------------------------

const ACTIVITY_CHIPS: { key: Exclude<SessionActivity, "remote-working">; label: string; icon: string }[] = [
  { key: "working", label: "作業中", icon: "i-lucide-loader-circle" },
  { key: "needs-input", label: "判断待ち", icon: "i-lucide-message-circle-question" },
  { key: "idle", label: "待機", icon: "i-lucide-circle-check" },
];
/** Narrow the rows to one work state (click again to release). Memory only. */
const activityFilter = ref<SessionActivity | null>(null);
function toggleFilter(k: Exclude<SessionActivity, "remote-working">) {
  activityFilter.value = activityFilter.value === k ? null : k;
}
// The filter releases itself when no session is in that state any more (otherwise the list would stay empty).
watch(activityCounts, (c) => {
  if (activityFilter.value && c[activityFilter.value] === 0) activityFilter.value = null;
});
const sideRows = computed(() =>
  activityFilter.value
    ? sessions.value.filter((g) =>
        activityFilter.value === "working" ? g.activity === "working" || g.activity === "remote-working" : g.activity === activityFilter.value,
      )
    : sessions.value,
);
const selectedGroup = computed(() => sessions.value.find((g) => g.name === selectedName.value));

// --- add session -----------------------------------------------------------

const addSessionOpen = ref(false);
const settingsOpen = ref(false);
const centerOpen = ref(false);

// "セッション追加" needs a center to talk to: enabled, or a pasted remote (the same rule as the Rust side).
const addSessionDisabledReason = ref<string | null>(null);
async function refreshAddTarget() {
  try {
    const s = await centerGetSettings();
    addSessionDisabledReason.value = s.enabled || s.remote ? null : "center が無効で接続先も無い（設定で center を有効にするか、別ホストの接続設定を貼る）";
  } catch (e) {
    addSessionDisabledReason.value = String(e);
  }
}
onMounted(() => void refreshAddTarget());
// The target may have changed (settings, pasted connection): re-read the center.
watch(settingsOpen, (v) => {
  if (v) return;
  void refreshAddTarget();
  void refreshSessions();
});
/** The gear does not change the selection; a rename only carries it along when the renamed session was the selected one. */
function onSessionRenamed(from: string, to: string) {
  if (settingsWasSelected) selectedName.value = to;
}
function onSessionUpdated() {
  void refreshSessions();
}

function onSessionCreated(name: string) {
  toast.add({ title: `${name} を作成`, color: "success" });
}

// --- re-login of the selected session's claude (the center read `Please run /login` from its pty) ---

const loginOpen = ref(false);
function onLoggedIn(name: string) {
  toast.add({ title: `${name} に再ログインした`, color: "success" });
  void refreshSessions();
}

</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-default text-default">
    <AppHeader
      v-if="loaded"
      :workspace-path="dir"
      :waiting-count="waitingCount"
      :broker="broker"
      :add-session-disabled-reason="addSessionDisabledReason"
      :updater="updaterState"
      @open="pickAndOpen"
      @add-session="addSessionOpen = true"
      @center="centerOpen = true"
      @settings="settingsOpen = true"
      @check-update="checkManually"
      @install-update="installAndRestart"
    />
    <div
      v-if="loaded && !dir"
      data-tauri-drag-region="deep"
      class="flex min-h-[calc(100vh-var(--cork-header-height))] flex-col items-center justify-center gap-6 p-8"
    >
      <div class="text-center">
        <h1 class="font-display text-2xl font-semibold">bantou</h1>
        <p class="mt-1 text-sm text-muted">作業セッションとの橋渡し（Cork 形式のタスクフォルダ）</p>
      </div>
      <UButton icon="i-lucide-folder-open" label="フォルダを開く" size="lg" @click="pickAndOpen" />
    </div>

    <template v-else-if="dir">
      <div ref="paneRow" class="flex min-h-0 flex-1 overflow-x-auto" data-testid="pane-row">
      <div class="flex min-h-0 flex-1" :style="{ minWidth: `${PANE_ROW_MIN}px` }">
        <nav aria-label="セッション一覧" class="shrink-0 overflow-y-auto" :style="{ width: `${pane.side.value}px` }">
          <UTooltip v-if="!centerList.reachable" :text="centerList.reason ?? 'center に問い合わせられなかった'">
            <UBadge
              class="m-2"
              color="warning"
              variant="subtle"
              label="つながらない"
              data-testid="side-unreachable"
            />
          </UTooltip>
          <div
            v-if="sessions.length"
            class="border-cork-border flex flex-wrap items-center gap-1 border-b px-2 py-1.5 text-xs"
            data-testid="session-activity-summary"
            title="session ごとの作業状態（押すと絞り込み）。ヘッダーの「返答待ち」は thread の件数"
          >
            <button
              v-for="c in ACTIVITY_CHIPS"
              :key="c.key"
              type="button"
              class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-cork-elevated"
              :class="[
                activityFilter === c.key ? 'bg-cork-elevated ring-1 ring-current' : '',
                c.key === 'needs-input' && activityCounts[c.key] > 0 ? 'text-warning font-semibold' : 'text-cork-muted',
              ]"
              :aria-pressed="activityFilter === c.key"
              :title="c.label"
              :aria-label="`${c.label} ${activityCounts[c.key]}`"
              :data-testid="`session-activity-summary-${c.key}`"
              :data-count="activityCounts[c.key]"
              @click="toggleFilter(c.key)"
            >
              <UIcon :name="c.icon" class="size-3.5" aria-hidden="true" />
              {{ activityCounts[c.key] }}
            </button>
          </div>
          <ul class="flex flex-col">
            <li v-for="g in sideRows" :key="g.name" class="border-cork-border relative flex items-stretch border-b">
              <button
                type="button"
                data-testid="side-row"
                :data-name="g.name"
                :aria-current="g.name === selectedName ? 'true' : undefined"
                class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-cork-elevated"
                :class="g.name === selectedName ? 'bg-cork-elevated font-semibold' : ''"
                @click="selectedName = g.name"
              >
                <UIcon name="i-lucide-terminal-square" class="text-cork-accent size-4 shrink-0" />
                <span class="truncate">{{ g.name }}</span>
                <UIcon
                  v-if="g.instructions"
                  name="i-lucide-scroll-text"
                  class="text-cork-muted size-3.5 shrink-0"
                  title="追加指示つきで起動した"
                  data-testid="session-instructions-mark"
                  data-scope="side"
                />
                <UIcon
                  v-if="g.auth === 'login_required' || g.auth === 'keychain_locked'"
                  name="i-lucide-key-round"
                  class="size-4 shrink-0"
                  :class="g.auth === 'keychain_locked' ? 'text-cork-danger-text' : 'text-warning'"
                  :title="g.auth === 'keychain_locked' ? 'keychain ロック中' : '要再ログイン'"
                  data-testid="side-auth"
                  :data-auth="g.auth"
                />
                <SessionActivityMark v-if="g.activity" :activity="g.activity" :waiting-reply="g.remoteWaiting" class="ml-auto" />
                <ContextUsage :usage="g.contextUsage" percent-only :class="g.activity ? '' : 'ml-auto'" data-scope="side" />
              </button>
              <UButton
                class="rounded-none"
                variant="ghost"
                color="neutral"
                size="xs"
                icon="i-lucide-settings"
                :aria-label="`${g.name} の設定`"
                :disabled="fromConfig(g.name)"
                :title="fromConfig(g.name) ? 'center の config 由来の project は設定を持てない' : undefined"
                data-testid="session-settings-open"
                :data-name="g.name"
                @click="openSettings(g.name)"
              />
            </li>
          </ul>
        </nav>
        <PaneResizer
          label="セッション一覧の幅"
          :model-value="pane.side.value"
          :min="PANE_MIN.side"
          :max="pane.sideMax.value"
          @update:model-value="pane.setSide"
          @commit="pane.save"
          @reset="pane.resetSide"
        />
        <main
          v-if="selectedGroup"
          class="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)]"
          :style="{ gridTemplateColumns: `${pane.middle.value}px auto minmax(0,1fr)` }"
          data-testid="session-main"
        >
          <!-- middle: remote instruction tasks of the session, the Cork task list below them -->
          <div class="flex min-w-0 flex-col gap-4 overflow-y-auto p-4" data-testid="middle-col">
            <RemoteActivity :key="selectedGroup.name" :owner="selectedGroup.name" />
            <SessionColumn
              :key="selectedGroup.name"
              :group="selectedGroup"
              :threads="threads"
              :running="running"
              @open-thread="openThread"
            />
          </div>
          <PaneResizer
            label="中央列の幅"
            :model-value="pane.middle.value"
            :min="PANE_MIN.middle"
            :max="pane.middleMax.value"
            @update:model-value="pane.setMiddle"
            @commit="pane.save"
            @reset="pane.resetMiddle"
          />
          <!-- right: conversation history (the session's terminal) -->
          <div
            class="min-h-0 min-w-0 overflow-hidden"
            data-testid="right-col"
          >
            <TerminalView :session="selectedGroup.name" :auth="selectedGroup.auth" @relogin="loginOpen = true" />
          </div>
        </main>
        <main v-else class="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
          <div
            class="border-cork-border text-cork-muted flex flex-col items-center gap-3 border border-dashed py-10 text-sm"
          >
            <p>center にセッションが無い。名前を付けて作成する。</p>
            <UButton
              icon="i-lucide-user-plus"
              label="セッション追加"
              :disabled="!!addSessionDisabledReason"
              @click="addSessionOpen = true"
            />
          </div>
        </main>
      </div>
      </div>
    </template>

    <ThreadModal
      v-if="activeTask && activeThread && dir"
      :key="activeTask.id"
      v-model:open="modalOpen"
      :task="activeTask"
      :thread="activeThread"
      :workspace="dir"
    />
    <AddSessionDialog
      v-if="addSessionOpen"
      v-model:open="addSessionOpen"
      :existing="centerList.sessions.map((s) => s.name)"
      @done="onSessionCreated"
    />
    <ProjectSettingsDialog
      v-if="settingsFor !== null"
      v-model:open="settingsDialogOpen"
      :name="settingsFor"
      :path="centerList.sessions.find((s) => s.name === settingsFor)?.path ?? null"
      :existing="centerList.sessions.map((s) => s.name)"
      @renamed="onSessionRenamed"
      @updated="onSessionUpdated"
    />
    <LoginDialog
    <LoginDialog
      v-if="loginOpen && selectedGroup"
      v-model:open="loginOpen"
      :session="selectedGroup.name"
      :auth="selectedGroup.auth"
      :login-error="selectedGroup.loginError"
      @done="onLoggedIn"
    />
    <SettingsDialog v-if="settingsOpen" v-model:open="settingsOpen" />
    <CenterDialog v-if="centerOpen" v-model:open="centerOpen" />
  </div>
</template>
