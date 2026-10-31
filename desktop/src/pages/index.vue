<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { brokerConnect, brokerStatus, centerGetSettings, instructAddTask } from "~/api";
import type { BrokerStatus, Task } from "~/types";

const { dir, loaded, load, pickAndOpen } = useWorkspace();
const { refreshNow: refreshSessions } = useSessionRefresh();
const { threads, registered, sessions, waitingCount, running, refresh } = useBoard(dir);
const toast = useToast();
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
function onSessionsAdded(names: string[]) {
  toast.add({ title: `${names.join(", ")} を追加`, color: "success" });
}

// --- instruct a session to add a task ------------------------------------------

const instructTarget = ref<string | null>(null);
async function onInstruct(session: string, title: string, body: string) {
  try {
    await instructAddTask(session, title, body);
    toast.add({ title: `${session} にタスク追加を指示`, description: title, color: "success" });
  } catch (e) {
    toast.add({ title: "指示の送信に失敗", description: String(e), color: "error" });
  }
}
</script>

<template>
  <div class="min-h-screen bg-default text-default">
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
      <main class="mx-auto flex w-full max-w-5xl flex-col p-6">
        <SessionColumn
          v-for="g in sessions"
          :key="g.name"
          :group="g"
          :threads="threads"
          :running="running"
          @open-thread="openThread"
          @instruct="instructTarget = $event"
        />
        <div
          v-if="!sessions.length"
          class="border-cork-border text-cork-muted flex flex-col items-center gap-3 border border-dashed py-10 text-sm"
        >
          <p>作業セッションが未追加。center のセッション一覧から追加する。</p>
          <UButton
            icon="i-lucide-user-plus"
            label="セッション追加"
            :disabled="!!addSessionDisabledReason"
            @click="addSessionOpen = true"
          />
        </div>
      </main>
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
      :added="registered"
      @done="onSessionsAdded"
    />
    <SettingsDialog v-if="settingsOpen" v-model:open="settingsOpen" />
    <CenterDialog v-if="centerOpen" v-model:open="centerOpen" />
    <InstructTaskDialog
      :open="instructTarget !== null"
      :session="instructTarget ?? ''"
      @update:open="(v) => !v && (instructTarget = null)"
      @submit="onInstruct"
    />
  </div>
</template>
