<script setup lang="ts">
import { centerConnection, centerTool, serverRetire } from "../api";
import { retireBlockedReason } from "../composables/serverRetire";
import type {
  CenterRetireResult,
  CenterConnection,
  CenterFollowState,
  CenterRcStatus,
  CenterServerInfo,
  CenterServerPeer,
  CenterServerPeers,
} from "../types";

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
      versionsError.value = null;
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
 * Join between the two tools, in this order: (1) `server_list[].server_id` = `server_peers[].server_id` (stable across a re-registration;
 * only when exactly one peer has it), (2) `server_list[].serverPeer` = `server_peers[].id` (the peer id the center last sent to),
 * (3) `serverPeer` as a name ("bantou-server" when the center found no peer) when exactly one peer has that name.
 */
function peerOfLink(l: CenterServerInfo, peers: CenterServerPeer[]): CenterServerPeer | undefined {
  if (l.server_id) {
    const byServerId = peers.filter((p) => p.server_id === l.server_id);
    if (byServerId.length === 1) return byServerId[0];
  }
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
    if (!used.has(l.name)) out.push({ key: `link:${l.name}`, host: l.host ?? l.name, serverId: l.server_id, peerId: l.serverPeer ?? undefined, link: l });
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

// -- retire (irreversible): a button per server row, a confirm dialog (cancel is the default), then the host steps --
const retireBlocked = (r: ServerRow) =>
  retireBlockedReason({ known: !!r.peer, protocolVersion: r.peer?.protocol_version, serverId: r.serverId });
const retireTarget = ref<ServerRow | null>(null);
const retireOpen = ref(false);
const retireBusy = ref(false);
const retireError = ref<string | null>(null);
const cancelBtn = ref<{ $el: HTMLElement } | null>(null);
// The safe button gets the focus when the dialog opens (the default of the dialog is to cancel, not to retire).
const retireContent = {
  onOpenAutoFocus: (e: Event) => {
    e.preventDefault();
    cancelBtn.value?.$el.focus();
  },
};
const retireResult = ref<CenterRetireResult | null>(null);
function askRetire(r: ServerRow) {
  retireTarget.value = r;
  retireError.value = null;
  retireResult.value = null;
  retireOpen.value = true;
}
async function doRetire() {
  const r = retireTarget.value;
  if (!r?.serverId || retireBusy.value) return;
  retireBusy.value = true;
  retireError.value = null;
  try {
    retireResult.value = await serverRetire(r.serverId);
    void refresh();
  } catch (e) {
    retireError.value = errorOf(e);
  } finally {
    retireBusy.value = false;
  }
}
const serviceLabel = (s: NonNullable<CenterRetireResult["service"]>) =>
  s.manager === "none" ? "手で起動（service 管理なし）" : `${s.manager}${s.name ? ` ${s.name}` : ""}${s.detected === false ? "（既定名。未確認）" : ""}`;
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
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span class="max-w-full min-w-32 truncate font-medium" :title="r.host" data-testid="center-server-host">{{ r.host }}</span>
                <span v-if="r.serverId ?? r.peerId" class="text-cork-muted" data-testid="center-server-id">{{ r.serverId ?? r.peerId }}</span>
                <span v-if="sameHost(r) && (r.peer?.user || r.peer?.workspace)" class="text-cork-muted" :title="[r.peer?.user, r.peer?.workspace].filter(Boolean).join(' ')" data-testid="center-server-who">{{ [r.peer?.user, r.peer?.workspace].filter(Boolean).join(" ") }}</span>
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
                <UButton
                  class="ml-auto"
                  size="xs"
                  color="error"
                  variant="outline"
                  icon="i-lucide-power-off"
                  label="退役"
                  :disabled="!!retireBlocked(r)"
                  :title="retireBlocked(r) ?? 'この server を退役させる（取り消せない）'"
                  data-testid="center-server-retire"
                  @click="askRetire(r)"
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

  <UModal
    v-model:open="retireOpen"
    title="server を退役させる"
    :description="retireResult ? '退役を受け付けた' : '取り消せない操作'"
    :dismissible="!retireBusy"
    :content="retireContent"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div v-if="retireTarget" class="flex flex-col gap-3" data-testid="retire-dialog">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="retire-target">
          <dt class="text-cork-muted">host</dt>
          <dd class="font-medium" data-testid="retire-host">{{ retireTarget.host }}</dd>
          <dt class="text-cork-muted">server_id</dt>
          <dd class="font-mono" data-testid="retire-server-id">{{ retireTarget.serverId }}</dd>
          <template v-if="retireTarget.peer?.user || retireTarget.peer?.workspace">
            <dt class="text-cork-muted">user / workspace</dt>
            <dd data-testid="retire-who">{{ [retireTarget.peer?.user, retireTarget.peer?.workspace].filter(Boolean).join(" ") }}</dd>
          </template>
          <dt class="text-cork-muted">peer</dt>
          <dd class="font-mono">{{ retireTarget.peerId }}</dd>
        </dl>

        <template v-if="!retireResult">
          <p class="text-cork-danger-text text-xs" data-testid="retire-warning">
            この server が実行中の cap / worker を全部止めて終了させる。再起動しない（systemd / launchd も戻さない）。取り消せない。center にある、この server の cap の記録（session × server）は消える。host に残る unit・user・workspace の削除は、退役後に表示する手順を root で行う
          </p>
          <p v-if="retireError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="retire-error">{{ retireError }}</p>
          <div class="flex justify-end gap-2">
            <UButton ref="cancelBtn" label="取り消し" color="neutral" variant="soft" :disabled="retireBusy" data-testid="retire-cancel" @click="retireOpen = false" />
            <UButton label="退役する" color="error" :loading="retireBusy" data-testid="retire-confirm" @click="doRetire" />
          </div>
        </template>

        <template v-else>
          <p class="text-xs" data-testid="retire-state">
            {{ retireResult.state === "already_retiring" ? "既に退役中（server は止まっていく途中）" : "退役を受け付けた。server は終了する" }}
          </p>
          <p v-if="retireResult.stopped" class="text-xs" data-testid="retire-stopped">
            止めた cap {{ retireResult.stopped.caps }} / worker {{ retireResult.stopped.workers }}<span v-if="retireResult.exit_at">（終了予定 {{ retireResult.exit_at }}）</span>
          </p>
          <p v-if="retireResult.service" class="text-xs" data-testid="retire-service">service: {{ serviceLabel(retireResult.service) }}</p>
          <p class="text-cork-muted text-xs" data-testid="retire-records">center の記録 {{ retireResult.records_removed }} 件を消した<span v-if="retireResult.sessions.length">（session: {{ retireResult.sessions.join(", ") }}）</span></p>
          <div v-if="retireResult.host_steps?.length" class="flex flex-col gap-1">
            <span class="text-xs font-medium">host で消す手順（root で上から順に）</span>
            <pre class="bg-cork-elevated overflow-x-auto rounded p-2 text-xs" data-testid="retire-host-steps">{{ retireResult.host_steps.join("\n") }}</pre>
          </div>
          <p v-else class="text-cork-muted text-xs" data-testid="retire-no-steps">host の手順は最初の退役の結果にだけ出る。server が止まった後は、host の unit・user・workspace を root で消す</p>
          <div class="flex justify-end">
            <UButton label="閉じる" color="neutral" data-testid="retire-close" @click="retireOpen = false" />
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
