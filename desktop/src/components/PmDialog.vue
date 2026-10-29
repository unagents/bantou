<script setup lang="ts">
import { centerTool } from "~/api";
import type { CenterSession } from "~/types";

const open = defineModel<boolean>("open", { required: true });

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const sessions = ref<CenterSession[]>([]);
const listError = ref<string | null>(null);
const name = ref("");
const creating = ref(false);
const created = ref<CenterSession | null>(null);
const createError = ref<string | null>(null);

const stateColor = { stopped: "neutral", starting: "warning", connected: "success", error: "error" } as const;

async function refresh() {
  try {
    sessions.value = await centerTool<CenterSession[]>("session_list");
    listError.value = null;
  } catch (e) {
    listError.value = String(e);
  }
}

watch(open, (v) => v && void refresh(), { immediate: true });

const trimmed = computed(() => name.value.trim());
const nameError = computed(() => {
  if (!trimmed.value) return null;
  if (!NAME_PATTERN.test(trimmed.value)) return "英数字と _ - のみ";
  if (sessions.value.some((s) => s.name === trimmed.value)) return "既に使われている名前";
  return null;
});

async function create() {
  if (!trimmed.value || nameError.value) return;
  creating.value = true;
  created.value = null;
  createError.value = null;
  try {
    created.value = await centerTool<CenterSession>("session_create", { name: trimmed.value });
    name.value = "";
  } catch (e) {
    createError.value = String(e);
  } finally {
    creating.value = false;
    await refresh();
  }
}
</script>

<template>
  <UModal v-model:open="open" title="PM" description="PM（center 上の master-cap）を立てる" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="pm-dialog">
        <div class="flex flex-col gap-2">
          <UFormField label="PM の名前" :error="nameError ?? undefined" help="英数字と _ - のみ。既存名とは重複できない">
            <UInput v-model="name" class="w-full" autofocus data-testid="pm-name" @keydown.enter="create" />
          </UFormField>
          <UButton
            class="self-end"
            label="立てる"
            :loading="creating"
            :disabled="!trimmed || !!nameError"
            data-testid="pm-create"
            @click="create"
          />
        </div>
        <p v-if="created" class="text-xs" data-testid="pm-created">
          {{ created.name }} を立てた
          <span v-if="created.sessionUrl" data-testid="pm-created-url">{{ created.sessionUrl }}</span>
          <span v-else class="text-cork-muted" data-testid="pm-created-pending">（sessionUrl は未取得: {{ created.state }}）</span>
          <span v-if="created.lastError" class="text-cork-danger-text ml-1">{{ created.lastError }}</span>
        </p>
        <p v-if="createError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="pm-create-error">
          {{ createError }}
        </p>

        <div class="flex flex-col gap-2">
          <div class="flex items-center">
            <span class="text-sm font-medium">立てた PM</span>
            <UButton
              class="ml-auto"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-refresh-cw"
              label="更新"
              data-testid="pm-refresh"
              @click="refresh"
            />
          </div>
          <p v-if="listError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="pm-list-error">
            {{ listError }}
          </p>
          <div
            v-for="s in sessions.filter((x) => x.source === 'session')"
            :key="s.name"
            class="flex items-center gap-2 text-xs"
            data-testid="pm-row"
          >
            <span class="w-32 truncate font-medium" data-testid="pm-row-name">{{ s.name }}</span>
            <UBadge :color="stateColor[s.state]" variant="subtle" :label="s.state" data-testid="pm-row-state" />
            <span v-if="s.lastError" class="text-cork-danger-text truncate">{{ s.lastError }}</span>
            <span v-if="s.sessionUrl" class="text-cork-muted ml-auto truncate" data-testid="pm-row-url">{{ s.sessionUrl }}</span>
          </div>
          <p v-if="!sessions.some((x) => x.source === 'session')" class="text-cork-muted text-xs" data-testid="pm-none">
            PM なし
          </p>
        </div>
      </div>
    </template>
  </UModal>
</template>
