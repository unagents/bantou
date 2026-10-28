<script setup lang="ts">
import { centerGetSettings, centerSetSettings, centerStatus } from "~/api";
import type { CenterSettings, CenterStatus } from "~/types";

const open = defineModel<boolean>("open", { required: true });
const toast = useToast();

const UNSET = "-";
const SPAWN_ITEMS = [UNSET, "same-dir", "worktree", "session"];
const PERMISSION_ITEMS = [UNSET, "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];

const settings = ref<CenterSettings | null>(null);
const status = ref<CenterStatus | null>(null);
const error = ref<string | null>(null);
const saving = ref(false);
const refreshing = ref(false);

async function refreshStatus() {
  refreshing.value = true;
  try {
    status.value = await centerStatus();
  } catch (e) {
    error.value = String(e);
  } finally {
    refreshing.value = false;
  }
}

async function load() {
  error.value = null;
  try {
    settings.value = await centerGetSettings();
  } catch (e) {
    error.value = String(e);
  }
  await refreshStatus();
}

const POLL_MS = 1000;
const POLL_TICKS = 5;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

// A restart takes a moment; follow the status for a few seconds after saving.
function pollStatus() {
  stopPolling();
  let ticks = 0;
  pollTimer = setInterval(() => {
    void refreshStatus();
    if (++ticks >= POLL_TICKS) stopPolling();
  }, POLL_MS);
}

watch(open, (v) => (v ? void load() : stopPolling()), { immediate: true });
onBeforeUnmount(stopPolling);

const portError = computed(() => {
  const p = Number(settings.value?.port);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? null : "port は 1〜65535 の整数";
});

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
const bindExposed = computed(() => {
  const b = settings.value?.bind.trim();
  return !!b && !LOOPBACK.includes(b);
});

function addProject() {
  settings.value?.projects.push({ name: "", path: "" });
}

function addServer() {
  settings.value?.servers.push({ name: "" });
}

const setOpt = (p: { spawn?: string; permissionMode?: string }, key: "spawn" | "permissionMode", v: string) => {
  p[key] = v === UNSET ? undefined : v;
};

async function save() {
  if (!settings.value || portError.value) return;
  saving.value = true;
  error.value = null;
  try {
    settings.value = await centerSetSettings({ ...settings.value, port: Number(settings.value.port) });
    toast.add({ title: "設定を保存した", color: "success" });
    await refreshStatus();
    pollStatus();
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

const stateColor = { stopped: "neutral", running: "success", restarting: "warning", error: "error" } as const;
</script>

<template>
  <UModal v-model:open="open" title="設定" description="center（sidecar）の起動と接続先" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <div v-if="settings" class="flex flex-col gap-4" data-testid="settings-dialog">
        <USwitch v-model="settings.enabled" label="center を起動する" data-testid="center-enabled" />
        <div class="flex gap-3">
          <UFormField label="port" class="w-32" :error="portError ?? undefined">
            <UInput v-model="settings.port" type="number" class="w-full" data-testid="center-port" />
          </UFormField>
          <UFormField label="bind" class="flex-1">
            <UInput v-model="settings.bind" class="w-full" data-testid="center-bind" />
          </UFormField>
        </div>
        <p v-if="bindExposed" class="text-cork-danger-text text-xs" data-testid="center-bind-warning">
          認証なしで LAN に公開される
        </p>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">projects</span>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-plus" label="追加" @click="addProject" />
          </div>
          <div
            v-for="(p, i) in settings.projects"
            :key="i"
            class="flex items-center gap-2"
            data-testid="center-project"
          >
            <UInput v-model="p.name" size="sm" placeholder="name" class="w-32" aria-label="name" />
            <UInput v-model="p.path" size="sm" placeholder="/abs/path" class="flex-1" aria-label="path" />
            <USelect
              :model-value="p.spawn ?? UNSET"
              :items="SPAWN_ITEMS"
              size="sm"
              class="w-32"
              aria-label="spawn"
              @update:model-value="setOpt(p, 'spawn', $event as string)"
            />
            <USelect
              :model-value="p.permissionMode ?? UNSET"
              :items="PERMISSION_ITEMS"
              size="sm"
              class="w-40"
              aria-label="permissionMode"
              @update:model-value="setOpt(p, 'permissionMode', $event as string)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-trash-2"
              aria-label="削除"
              @click="settings.projects.splice(i, 1)"
            />
          </div>
          <p v-if="!settings.projects.length" class="text-cork-muted text-xs">未登録（spawn / permissionMode の「-」は既定）</p>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">servers</span>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-plus" label="追加" @click="addServer" />
          </div>
          <div
            v-for="(v, i) in settings.servers"
            :key="i"
            class="flex items-center gap-2"
            data-testid="center-server"
          >
            <UInput v-model="v.name" size="sm" placeholder="name" class="w-32" aria-label="server name" />
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-trash-2"
              aria-label="削除"
              @click="settings.servers.splice(i, 1)"
            />
          </div>
          <p v-if="!settings.servers.length" class="text-cork-muted text-xs">未登録（名前だけ指定。broker は agent-messenger の通常の解決、bantou-server の peer は自動発見）</p>
        </div>

        <UFormField label="claudePath" description="空なら login shell から自動解決">
          <UInput
            :model-value="settings.claudePath ?? ''"
            placeholder="/Users/me/.local/bin/claude"
            class="w-full"
            data-testid="center-claude-path"
            @update:model-value="settings.claudePath = String($event) || undefined"
          />
        </UFormField>

        <UFormField label="remoteUrl" description="別ホストの center の MCP URL。設定すると sidecar ではなくこちらに接続する（パス省略時は /mcp）">
          <UInput
            :model-value="settings.remoteUrl ?? ''"
            placeholder="http://mac200:7910"
            class="w-full"
            data-testid="center-remote-url"
            @update:model-value="settings.remoteUrl = String($event) || undefined"
          />
        </UFormField>

        <div class="border-cork-border flex flex-col gap-2 border-t pt-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">状態</span>
            <UBadge
              v-if="status"
              :color="stateColor[status.state]"
              variant="subtle"
              :label="status.state"
              data-testid="center-state"
            />
            <span v-if="status?.pid" class="text-cork-muted text-xs">pid {{ status.pid }}</span>
            <span v-if="status?.restartCount" class="text-cork-muted text-xs" data-testid="center-restart-count"
              >自動再起動 {{ status.restartCount }} 回</span
            >
            <UButton
              class="ml-auto"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-refresh-cw"
              :loading="refreshing"
              aria-label="状態を更新"
              @click="refreshStatus"
            />
          </div>
          <p v-if="status?.lastExit" class="text-cork-muted text-xs" data-testid="center-last-exit">
            最終の終了理由: {{ status.lastExit }}
          </p>
          <p v-if="status?.error" class="text-cork-danger-text text-xs whitespace-pre-wrap">{{ status.error }}</p>
          <pre
            v-if="status?.logs.length"
            class="bg-cork-elevated max-h-40 overflow-auto p-2 text-xs"
            data-testid="center-logs"
            >{{ status.logs.join("\n") }}</pre
          >
        </div>

        <p v-if="error" class="text-cork-danger-text text-xs" data-testid="settings-error">{{ error }}</p>
        <UButton
          class="self-end"
          icon="i-lucide-save"
          label="保存"
          :loading="saving"
          :disabled="!!portError"
          data-testid="settings-save"
          @click="save"
        />
      </div>
      <p v-else-if="error" class="text-cork-danger-text text-xs">{{ error }}</p>
    </template>
  </UModal>
</template>
