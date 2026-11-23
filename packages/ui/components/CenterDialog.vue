<script setup lang="ts">
import { centerConnection, rcList, serverList } from "../api";
import type { CenterConnection, CenterRcStatus, CenterServer } from "../types";

const open = defineModel<boolean>("open", { required: true });

const connection = ref<CenterConnection | null>(null);
const rc = ref<CenterRcStatus[]>([]);
const servers = ref<CenterServer[]>([]);
const serversError = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const errorOf = (e: unknown) => String(e);

/** The servers registered on the broker with protocol "bantou" (`server_list`). */
async function loadServers() {
  try {
    servers.value = await serverList();
    serversError.value = null;
  } catch (e) {
    servers.value = [];
    serversError.value = errorOf(e);
  }
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    connection.value = await centerConnection();
    if (!connection.value.connected) {
      rc.value = [];
      servers.value = [];
      serversError.value = null;
      return;
    }
    void loadServers();
    rc.value = await rcList();
  } catch (e) {
    error.value = errorOf(e);
  } finally {
    loading.value = false;
  }
}

watch(open, (v) => v && void refresh(), { immediate: true });

const rcColor = { stopped: "neutral", starting: "warning", connected: "success", error: "error" } as const;
const sourceLabel = { remote: "remote", sidecar: "sidecar" } as const;
</script>

<template>
  <UModal v-model:open="open" title="center" description="center の状態（MCP 経由）" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="center-dialog">
        <div class="flex items-center gap-2">
          <UBadge
            v-if="connection"
            :color="connection.connected ? 'success' : 'error'"
            variant="subtle"
            :label="connection.connected ? 'connected' : 'disconnected'"
            data-testid="center-conn-state"
          />
          <span v-if="connection?.url" class="text-cork-muted text-xs" data-testid="center-conn-url">
            {{ connection.url }}
            <span v-if="connection.source">（{{ sourceLabel[connection.source] }}）</span>
          </span>
          <UButton
            class="ml-auto"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-refresh-cw"
            label="更新"
            :loading="loading"
            data-testid="center-refresh"
            @click="refresh"
          />
        </div>
        <p
          v-if="connection && !connection.connected && connection.lastError"
          class="text-cork-danger-text text-xs whitespace-pre-wrap"
          data-testid="center-conn-error"
        >
          {{ connection.lastError }}
        </p>
        <p v-if="error" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="center-error">
          {{ error }}
        </p>

        <template v-if="connection?.connected">
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">remote session</span>
            <div
              v-for="r in rc"
              :key="r.project"
              class="flex items-center gap-2 text-xs"
              data-testid="center-rc"
            >
              <span class="w-32 truncate font-medium">{{ r.project }}</span>
              <UBadge :color="rcColor[r.state]" variant="subtle" :label="r.state" />
              <span v-if="r.pid" class="text-cork-muted">pid {{ r.pid }}</span>
              <span v-if="r.restarts" class="text-cork-muted">再起動 {{ r.restarts }}</span>
              <span v-if="r.lastError" class="text-cork-danger-text truncate">{{ r.lastError }}</span>
              <span v-if="r.sessionUrl" class="text-cork-muted ml-auto truncate">{{ r.sessionUrl }}</span>
            </div>
            <p v-if="!rc.length" class="text-cork-muted text-xs">project 未登録</p>
          </div>

          <div class="flex flex-col gap-2" data-testid="center-servers">
            <span class="text-sm font-medium">server</span>
            <p v-if="serversError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="center-versions-error">
              {{ serversError }}
            </p>
            <div
              v-for="s in servers"
              :key="s.name"
              class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
              :data-host="s.host ?? ''"
              data-testid="center-server-row"
            >
              <span class="max-w-full min-w-32 truncate font-medium" :title="s.name" data-testid="center-server-name">{{ s.name }}</span>
              <span class="text-cork-muted truncate" data-testid="center-server-host">{{ s.host ?? "?" }}</span>
              <span class="text-cork-muted" data-testid="center-server-version">{{ s.protocol ?? "?" }}</span>
            </div>
            <p v-if="!servers.length" class="text-cork-muted text-xs" data-testid="center-versions-none">server なし</p>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
