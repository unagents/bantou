<script setup lang="ts">
import { addSessions, centerTool, createSession } from "~/api";
import type { CenterSession, Session } from "~/types";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ added: Session[] }>();
const emit = defineEmits<{ done: [names: string[]] }>();

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const listed = ref<CenterSession[]>([]);
const loading = ref(false);
const listError = ref<string | null>(null);
const picked = ref<Set<string>>(new Set());
const name = ref("");
const busy = ref(false);
const actionError = ref<string | null>(null);

const stateColor = { stopped: "neutral", starting: "warning", connected: "success", error: "error" } as const;

async function load() {
  loading.value = true;
  listError.value = null;
  picked.value = new Set();
  try {
    listed.value = await centerTool<CenterSession[]>("session_list");
  } catch (e) {
    listed.value = [];
    listError.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(open, (v) => v && void load(), { immediate: true });

/** Sessions of the center's list that are not added yet. */
const rows = computed(() => {
  const have = new Set(props.added.map((s) => s.name));
  return listed.value.filter((s) => !have.has(s.name));
});

function toggle(n: string) {
  const s = new Set(picked.value);
  if (!s.delete(n)) s.add(n);
  picked.value = s;
}

const trimmed = computed(() => name.value.trim());
const nameError = computed(() => {
  if (!trimmed.value) return null;
  if (!NAME_PATTERN.test(trimmed.value)) return "英数字と _ - のみ";
  if (listed.value.some((s) => s.name === trimmed.value) || props.added.some((s) => s.name === trimmed.value)) {
    return "既に使われている名前";
  }
  return null;
});

async function run(names: string[], action: () => Promise<unknown>) {
  busy.value = true;
  actionError.value = null;
  try {
    await action();
    emit("done", names);
    open.value = false;
  } catch (e) {
    actionError.value = String(e);
    await load();
  } finally {
    busy.value = false;
  }
}

const addPicked = () => {
  const names = [...picked.value];
  if (names.length) void run(names, () => addSessions(names));
};

const create = () => {
  if (!trimmed.value || nameError.value) return;
  void run([trimmed.value], () => createSession(trimmed.value));
};
</script>

<template>
  <UModal v-model:open="open" title="セッション追加" description="center のセッション一覧から選ぶか、名前を付けて新しく作る" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="add-dialog">
        <div class="flex flex-col gap-2">
          <div class="flex items-center">
            <span class="text-sm font-medium">center のセッション</span>
            <UButton
              class="ml-auto"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-refresh-cw"
              label="更新"
              :loading="loading"
              data-testid="add-refresh"
              @click="load"
            />
          </div>
          <p v-if="listError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="add-list-error">
            {{ listError }}
          </p>
          <div
            v-for="s in rows"
            :key="s.name"
            class="hover:bg-cork-elevated/50 flex cursor-pointer items-center gap-2 text-xs"
            data-testid="add-row"
            :data-name="s.name"
            @click="toggle(s.name)"
          >
            <UCheckbox :model-value="picked.has(s.name)" :aria-label="s.name" />
            <span class="w-40 truncate font-medium">{{ s.name }}</span>
            <UBadge :color="stateColor[s.state]" variant="subtle" :label="s.state" />
            <span v-if="s.lastError" class="text-cork-danger-text truncate">{{ s.lastError }}</span>
            <span v-if="s.sessionUrl" class="text-cork-muted ml-auto truncate">{{ s.sessionUrl }}</span>
          </div>
          <p v-if="!rows.length && !loading && !listError" class="text-cork-muted text-xs" data-testid="add-none">
            追加できるセッションがない
          </p>
          <UButton
            class="self-end"
            icon="i-lucide-user-plus"
            :label="`追加（${picked.size}）`"
            :loading="busy"
            :disabled="!picked.size"
            data-testid="add-submit"
            @click="addPicked"
          />
        </div>

        <div class="border-cork-border flex flex-col gap-2 border-t pt-3">
          <UFormField label="新しく作る" :error="nameError ?? undefined" help="名前を付けて作る。英数字と _ - のみ。既存名とは重複できない">
            <UInput v-model="name" class="w-full" placeholder="セッション名" data-testid="add-name" @keydown.enter="create" />
          </UFormField>
          <UButton
            class="self-end"
            label="作成して追加"
            :loading="busy"
            :disabled="!trimmed || !!nameError"
            data-testid="add-create"
            @click="create"
          />
        </div>
        <p v-if="actionError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="add-action-error">
          {{ actionError }}
        </p>
      </div>
    </template>
  </UModal>
</template>
