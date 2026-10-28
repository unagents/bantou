<script setup lang="ts">
import { centerConnection, centerTool } from "~/api";
import type {
  CenterConnection,
  CenterRcStatus,
  CenterServerInfo,
  CenterServerStatus,
} from "~/types";

const open = defineModel<boolean>("open", { required: true });

interface ServerView {
  info: CenterServerInfo;
  status?: CenterServerStatus;
  error?: string;
}

const connection = ref<CenterConnection | null>(null);
const rc = ref<CenterRcStatus[]>([]);
const servers = ref<ServerView[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

const errorOf = (e: unknown) => String(e);

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    connection.value = await centerConnection();
    if (!connection.value.connected) {
      rc.value = [];
      servers.value = [];
      return;
    }
    rc.value = await centerTool<CenterRcStatus[]>("rc_list");
    const infos = await centerTool<CenterServerInfo[]>("server_list");
    servers.value = await Promise.all(
      infos.map(async (info): Promise<ServerView> => {
        try {
          return { info, status: await centerTool<CenterServerStatus>("server_status", { server: info.name }) };
        } catch (e) {
          return { info, error: errorOf(e) };
        }
      }),
    );
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
            <span class="text-sm font-medium">remote-control</span>
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

          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium">servers</span>
            <div v-for="s in servers" :key="s.info.name" class="flex flex-col gap-1" data-testid="center-server-row">
              <div class="flex items-center gap-2 text-xs">
                <span class="w-32 truncate font-medium">{{ s.info.name }}</span>
                <UBadge
                  :color="s.info.connected ? 'success' : 'neutral'"
                  variant="subtle"
                  :label="s.info.connected ? 'connected' : 'not connected'"
                />
                <UBadge
                  :color="s.info.reachable ? 'success' : 'warning'"
                  variant="subtle"
                  :label="s.info.reachable ? 'reachable' : 'unreachable'"
                />
              </div>
              <p v-if="s.error" class="text-cork-danger-text pl-2 text-xs whitespace-pre-wrap">{{ s.error }}</p>
              <template v-if="s.status">
                <div
                  v-for="a in [...s.status.caps, ...s.status.workers]"
                  :key="`${a.kind}:${a.id}`"
                  class="text-cork-muted flex items-center gap-2 pl-2 text-xs"
                  data-testid="center-agent"
                >
                  <span class="w-12">{{ a.kind }}</span>
                  <span class="w-40 truncate">{{ a.id }}</span>
                  <span>{{ a.state }}</span>
                </div>
                <p v-if="!s.status.caps.length && !s.status.workers.length" class="text-cork-muted pl-2 text-xs">
                  cap / worker なし
                </p>
              </template>
            </div>
            <p v-if="!servers.length" class="text-cork-muted text-xs">server 未登録</p>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
