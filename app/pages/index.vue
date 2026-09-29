<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { brokerConnect, brokerStatus, createTask, instructAddTask, updateTaskStatus } from "~/api";
import type { BrokerStatus, RegisterResult, Task } from "~/types";

const { dir, loaded, load, pickAndOpen } = useWorkspace();
const { statuses, threads, registered, sessions, waitingCount, refresh } = useBoard(dir);
const toast = useToast();

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

async function onSetStatus(t: Task, status: string) {
  try {
    await updateTaskStatus(t.path, status);
    await refresh();
  } catch (e) {
    toast.add({ title: "ステータス変更に失敗", description: String(e), color: "error" });
  }
}

// --- add session -----------------------------------------------------------

const addSessionOpen = ref(false);
async function onSessionsAdded(results: RegisterResult[]) {
  await refresh();
  for (const r of results) {
    toast.add(
      r.delivered
        ? { title: `${r.name} を登録`, description: "規約を送信した", color: "success" }
        : { title: `${r.name} の登録に失敗`, description: r.error ?? "", color: "error" },
    );
  }
}

// --- new task ----------------------------------------------------------------

const createOpen = ref(false);
async function onCreate(title: string, status: string, tags: string[]) {
  try {
    await createTask(title, status, tags);
    await refresh();
  } catch (e) {
    toast.add({ title: "作成に失敗", description: String(e), color: "error" });
  }
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
    <div
      v-if="loaded && !dir"
      data-tauri-drag-region="deep"
      class="flex min-h-screen flex-col items-center justify-center gap-6 p-8"
    >
      <div class="text-center">
        <h1 class="font-display text-2xl font-semibold">bantou</h1>
        <p class="mt-1 text-sm text-muted">作業セッションとの橋渡し（Cork 形式のタスクフォルダ）</p>
      </div>
      <UButton icon="i-lucide-folder-open" label="フォルダを開く" size="lg" @click="pickAndOpen" />
    </div>

    <template v-else-if="dir">
      <AppHeader
        :workspace-path="dir"
        :waiting-count="waitingCount"
        :broker="broker"
        @open="pickAndOpen"
        @create="createOpen = true"
        @add-session="addSessionOpen = true"
      />
      <main class="mx-auto flex w-full max-w-5xl flex-col p-6">
        <SessionColumn
          v-for="g in sessions"
          :key="g.name"
          :group="g"
          :threads="threads"
          :statuses="statuses"
          @open-thread="openThread"
          @set-status="onSetStatus"
          @instruct="instructTarget = $event"
        />
        <div
          v-if="!sessions.length"
          class="border-cork-border text-cork-muted flex flex-col items-center gap-3 border border-dashed py-10 text-sm"
        >
          <p>作業セッションが未登録。messenger に接続中のセッションから登録する。</p>
          <UButton
            icon="i-lucide-user-plus"
            label="セッション追加"
            :disabled="!broker?.connected"
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
      :registered="registered"
      :self-name="broker?.name ?? 'bantou-core'"
      @done="onSessionsAdded"
    />
    <NewTaskDialog
      v-model:open="createOpen"
      :statuses="statuses"
      :sessions="sessions.map((s) => s.name)"
      @create="onCreate"
    />
    <InstructTaskDialog
      :open="instructTarget !== null"
      :session="instructTarget ?? ''"
      @update:open="(v) => !v && (instructTarget = null)"
      @submit="onInstruct"
    />
  </div>
</template>
