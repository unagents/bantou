<script setup lang="ts">
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_EVENT, agentAnswer, agentClose, agentOpen, agentSay } from "~/api";
import type { AgentEvent, Task, Thread } from "~/types";

const props = defineProps<{ task: Task; thread: Thread; workspace: string }>();
const open = defineModel<boolean>("open", { required: true });

const agentState = ref<AgentEvent["state"] | "starting">("starting");
const chat = ref("");
const selected = ref<string | null>(null);
const freeAnswer = ref("");
const error = ref<string | null>(null);
const timelineEl = ref<HTMLElement | null>(null);

const answered = computed(() => props.thread.status === "answered");
const busy = computed(() => agentState.value === "busy" || agentState.value === "starting");

let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen<AgentEvent>(AGENT_EVENT, (e) => {
    if (e.payload.workspace === props.workspace && e.payload.task_id === props.thread.task_id) {
      agentState.value = e.payload.state;
    }
  });
  if (!answered.value) {
    try {
      await agentOpen(props.thread.task_id);
      // A resumed thread that already has bantou comments sends nothing on
      // open, so no `result` event will come — treat it as idle.
      if (props.thread.timeline.some((x) => x.role === "bantou")) agentState.value = "idle";
    } catch (e) {
      error.value = String(e);
      agentState.value = "error";
    }
  } else {
    agentState.value = "exited";
  }
});

onBeforeUnmount(() => {
  unlisten?.();
  void agentClose(props.thread.task_id);
});

watch(
  () => props.thread.timeline.length,
  async () => {
    await nextTick();
    timelineEl.value?.scrollTo({ top: timelineEl.value.scrollHeight, behavior: "smooth" });
  },
);

/**
 * Enter that only confirms an IME conversion (Japanese input) must not
 * send. WKWebView reports that keydown with `isComposing` false but
 * keyCode 229, so both are checked.
 */
function isImeEnter(e: KeyboardEvent) {
  return e.isComposing || e.keyCode === 229;
}

function onChatEnter(e: KeyboardEvent) {
  if (isImeEnter(e)) return;
  void send();
}

function onAnswerEnter(e: KeyboardEvent) {
  if (isImeEnter(e)) return;
  void submitAnswer();
}

async function send() {
  const text = chat.value.trim();
  if (!text) return;
  chat.value = "";
  try {
    await agentSay(props.thread.task_id, text);
  } catch (e) {
    error.value = String(e);
  }
}

async function submitAnswer() {
  const answer = freeAnswer.value.trim() || selected.value;
  if (!answer) return;
  try {
    await agentAnswer(props.thread.task_id, answer);
    selected.value = null;
    freeAnswer.value = "";
  } catch (e) {
    error.value = String(e);
  }
}

const roleLabel: Record<string, string> = {
  session: "作業セッション",
  bantou: "bantou",
  user: "あなた",
  system: "system",
};

function time(at: string) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="task.title"
    :description="`${thread.request.from_name} ／ ${task.id}`"
    :ui="{ content: 'max-w-6xl w-[92vw] h-[82vh]', body: 'p-0 sm:p-0 flex-1 min-h-0' }"
  >
    <template #body>
      <div class="flex h-full min-h-0">
        <!-- Left: task close-up -->
        <aside class="border-cork-border flex w-2/5 flex-col gap-3 overflow-y-auto border-r p-5">
          <div class="flex flex-wrap gap-1">
            <UBadge v-for="t in task.tags" :key="t" :label="t" variant="subtle" color="neutral" />
            <UBadge :label="task.status" variant="outline" />
          </div>
          <pre class="text-cork-text font-sans text-sm whitespace-pre-wrap">{{ task.body.trim() || "（本文なし）" }}</pre>
        </aside>

        <!-- Right: timeline -->
        <section class="flex min-w-0 flex-1 flex-col">
          <div ref="timelineEl" class="flex flex-1 flex-col gap-3 overflow-y-auto p-5" data-testid="timeline">
            <div
              v-for="(m, i) in thread.timeline"
              :key="i"
              class="flex flex-col"
              :class="m.role === 'user' ? 'items-end' : 'items-start'"
            >
              <span class="text-cork-muted mb-0.5 text-[11px]">{{ roleLabel[m.role] }} · {{ time(m.at) }}</span>
              <div
                class="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap"
                :class="{
                  'bg-amber-500/15 ring-1 ring-amber-400/40': m.role === 'session',
                  'bg-cork-elevated': m.role === 'bantou',
                  'bg-cork-accent text-white': m.role === 'user',
                  'text-cork-muted self-center bg-transparent text-xs': m.role === 'system',
                }"
              >
                {{ m.text }}
              </div>
            </div>
            <div v-if="busy && !answered" class="text-cork-muted flex items-center gap-2 text-xs">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> bantou 応答中…
            </div>
          </div>

          <p v-if="error" class="text-cork-danger-text px-5 text-xs">{{ error }}</p>

          <!-- Answer: AskUserQuestion-style options + free input -->
          <div v-if="!answered" class="border-cork-border flex flex-col gap-2 border-t p-4">
            <div class="text-cork-muted text-xs">作業セッションへの回答</div>
            <div class="flex flex-col gap-1.5">
              <button
                v-for="o in thread.request.options"
                :key="o.label"
                class="border-cork-border rounded-md border px-3 py-1.5 text-left text-sm transition"
                :class="selected === o.label ? 'border-cork-accent bg-cork-accent/15' : 'hover:bg-cork-elevated'"
                @click="selected = selected === o.label ? null : o.label"
              >
                <span class="font-medium">{{ o.label }}</span>
                <span v-if="o.description" class="text-cork-muted ml-2 text-xs">{{ o.description }}</span>
              </button>
            </div>
            <div class="flex gap-2">
              <UInput
                v-model="freeAnswer"
                class="flex-1"
                placeholder="どれにも当てはまらない場合は自由入力"
                @keydown.enter.meta="onAnswerEnter"
              />
              <UButton
                label="回答を送る"
                icon="i-lucide-send"
                :disabled="!(freeAnswer.trim() || selected)"
                @click="submitAnswer"
              />
            </div>
          </div>
          <div v-else class="border-cork-border text-cork-muted border-t p-4 text-xs">
            回答済み: {{ thread.answer }}
          </div>

          <!-- Chat with bantou -->
          <div v-if="!answered" class="border-cork-border flex gap-2 border-t p-4">
            <UInput
              v-model="chat"
              class="flex-1"
              placeholder="bantou に質問・相談"
              @keydown.enter="onChatEnter"
            />
            <UButton icon="i-lucide-message-circle" color="neutral" variant="soft" :disabled="!chat.trim()" @click="send" />
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
