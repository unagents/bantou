<script setup lang="ts">
import { centerConnection, centerTool } from "~/api";
import type {
  CenterConnection,
  CenterFollowState,
  CenterRcStatus,
  CenterServerInfo,
  CenterServerPeer,
  CenterServerPeers,
} from "~/types";

const open = defineModel<boolean>("open", { required: true });

/** One server row: the discovered peer (`server_peers`: version) and the configured link (`server_list`: connection). Either may be missing. */
interface ServerRow {
  key: string;
  host: string;
  serverId?: string;
  peerId?: string;
  peer?: CenterServerPeer;
  link?: CenterServerInfo;
}

const connection = ref<CenterConnection | null>(null);
const rc = ref<CenterRcStatus[]>([]);
const links = ref<CenterServerInfo[]>([]);
const versions = ref<CenterServerPeers | null>(null);
const versionsError = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const errorOf = (e: unknown) => String(e);

/** Which server versions are paired with this build, and each server's state. refresh asks the center to check now. */
async function loadVersions(refreshNow: boolean) {
  try {
    versions.value = await centerTool<CenterServerPeers>("server_peers", refreshNow ? { refresh: true } : undefined);
    versionsError.value = null;
  } catch (e) {
    versionsError.value = errorOf(e);
  }
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    connection.value = await centerConnection();
    if (!connection.value.connected) {
      rc.value = [];
      links.value = [];
      versions.value = null;
      return;
    }
    void loadVersions(true);
    rc.value = await centerTool<CenterRcStatus[]>("rc_list");
    links.value = await centerTool<CenterServerInfo[]>("server_list");
  } catch (e) {
    error.value = errorOf(e);
  } finally {
    loading.value = false;
  }
}

watch(open, (v) => v && void refresh(), { immediate: true });

const rcColor = { stopped: "neutral", starting: "warning", connected: "success", error: "error" } as const;
const hostOf = (p: CenterServerPeer) => p.host ?? p.hostname ?? p.name;

/**
 * Join between the two tools: `server_list[].serverPeer` is the peer id the center last sent to (or the plain name
 * "bantou-server" when it found no peer); `server_peers[].id` is that peer id. A name matches only when exactly one peer has it.
 */
function peerOfLink(l: CenterServerInfo, peers: CenterServerPeer[]): CenterServerPeer | undefined {
  if (!l.serverPeer) return undefined;
  const byId = peers.find((p) => p.id === l.serverPeer);
  if (byId) return byId;
  const byName = peers.filter((p) => p.name === l.serverPeer);
  return byName.length === 1 ? byName[0] : undefined;
}

/** One row per server. A server in only one of the two lists still gets a row. */
const rows = computed<ServerRow[]>(() => {
  const peers = versions.value?.peers ?? [];
  const out: ServerRow[] = [];
  const used = new Set<string>();
  const linkOf = new Map<string, CenterServerInfo>();
  for (const l of links.value) {
    const p = peerOfLink(l, peers);
    if (p && !linkOf.has(p.key)) {
      linkOf.set(p.key, l);
      used.add(l.name);
    }
  }
  for (const p of peers) {
    out.push({ key: `peer:${p.key}`, host: hostOf(p), serverId: p.server_id, peerId: p.id, peer: p, link: linkOf.get(p.key) });
  }
  for (const l of links.value) {
    if (!used.has(l.name)) out.push({ key: `link:${l.name}`, host: l.name, peerId: l.serverPeer ?? undefined, link: l });
  }
  return out;
});

/** Another server shares this host name: show user / workspace so they can be told apart. */
function sameHost(r: ServerRow): boolean {
  const h = r.host.toLowerCase();
  return rows.value.filter((x) => x.host.toLowerCase() === h).length > 1;
}

type LinkState = "reachable" | "disconnected" | "unreachable" | "unknown";
const linkStateOf = (l?: CenterServerInfo): LinkState =>
  !l ? "unknown" : !l.reachable ? "unreachable" : l.connected ? "reachable" : "disconnected";
const linkColor = { reachable: "success", disconnected: "neutral", unreachable: "warning", unknown: "neutral" } as const;
const linkLabel = { reachable: "到達可", disconnected: "未接続", unreachable: "到達不可", unknown: "不明" } as const;

const versionColor: Record<CenterFollowState, "success" | "warning" | "neutral" | "error"> = {
  ok: "success",
  updating: "warning",
  unknown: "neutral",
  mismatch: "error",
  unsupported: "error",
  failed: "error",
  lost: "error",
};
const versionLabel: Record<CenterFollowState, string> = {
  ok: "一致",
  updating: "更新中",
  unknown: "確認中",
  mismatch: "版違い",
  unsupported: "版違い",
  failed: "更新失敗",
  lost: "更新失敗",
};
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
            <p v-if="versions" class="text-cork-muted text-xs" data-testid="center-pair">
              この desktop と組の版: server {{ versions.pair.server ?? "不明" }} / protocol {{ versions.pair.protocol }}
            </p>
            <p v-if="versionsError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="center-versions-error">
              {{ versionsError }}
            </p>
            <div
              v-for="r in rows"
              :key="r.key"
              class="flex flex-col gap-0.5"
              :data-host="r.host"
              :data-server-id="r.serverId ?? r.peerId ?? ''"
              :data-state="r.peer?.state ?? 'none'"
              :data-link="linkStateOf(r.link)"
              data-testid="center-server-row"
            >
              <div class="flex items-center gap-2 text-xs">
                <span class="w-32 truncate font-medium" data-testid="center-server-host">{{ r.host }}</span>
                <span v-if="r.serverId ?? r.peerId" class="text-cork-muted" data-testid="center-server-id">{{ r.serverId ?? r.peerId }}</span>
                <span v-if="sameHost(r) && (r.peer?.user || r.peer?.workspace)" class="text-cork-muted" data-testid="center-server-who">{{ [r.peer?.user, r.peer?.workspace].filter(Boolean).join(" ") }}</span>
                <UBadge
                  v-if="r.peer"
                  :color="versionColor[r.peer.state]"
                  variant="subtle"
                  :label="versionLabel[r.peer.state]"
                  data-testid="center-server-version-badge"
                />
                <span v-if="r.peer" class="text-cork-muted" data-testid="center-server-version">server {{ r.peer.server_version ?? "?" }}</span>
                <UBadge
                  :color="linkColor[linkStateOf(r.link)]"
                  variant="subtle"
                  :label="linkLabel[linkStateOf(r.link)]"
                  data-testid="center-server-link-badge"
                />
                <span
                  v-if="r.peer?.state === 'updating' && r.peer.update?.running"
                  class="text-cork-muted"
                  data-testid="center-server-running"
                >
                  待機 cap {{ r.peer.update.running.caps }} / worker {{ r.peer.update.running.workers }}
                </span>
              </div>
              <p
                v-if="r.peer && r.peer.state !== 'ok' && r.peer.detail"
                class="text-cork-muted pl-2 text-xs"
                data-testid="center-server-detail"
              >
                {{ r.peer.detail }}
              </p>
            </div>
            <p v-if="!rows.length" class="text-cork-muted text-xs" data-testid="center-versions-none">server なし</p>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
