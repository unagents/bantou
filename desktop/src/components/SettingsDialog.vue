<script setup lang="ts">
import {
  centerConnectSnippets,
  centerIpStatus,
  centerLocalIps,
  centerGetSettings,
  centerParseConnect,
  centerRegenerateToken,
  centerSetSettings,
  centerStatus,
} from "~/api";
import type { CenterConnectSnippets, CenterIpStatus, CenterParsedConnect, CenterSettings, CenterStatus } from "~/types";

const open = defineModel<boolean>("open", { required: true });
const toast = useToast();

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
  ipChoice.value = null;
  await Promise.all([refreshStatus(), loadLocalIps(), loadIpStatus()]);
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

const MIN_TOKEN_LEN = 12;
const tokenError = computed(() =>
  (settings.value?.token.length ?? 0) < MIN_TOKEN_LEN ? `token は ${MIN_TOKEN_LEN} 文字以上` : null,
);

// This machine's addresses. The chosen one is only the host the snippets name (the center listens on all).
const localIps = ref<string[]>([]);
async function loadLocalIps() {
  try {
    localIps.value = await centerLocalIps();
  } catch (e) {
    error.value = String(e);
  }
}
// The saved IP against this machine's addresses now. When it is gone (or the center could not
// listen) the banner at the top lets the user keep it or pick a new one; nothing changes until then.
const ipStatus = ref<CenterIpStatus | null>(null);
// keep: stay with the saved IP. new: a new IP is picked (stored by save). done: it was saved.
const ipChoice = ref<"keep" | "new" | "done" | null>(null);
const newIp = ref("");
async function loadIpStatus() {
  try {
    ipStatus.value = await centerIpStatus();
    newIp.value = ipStatus.value.defaultIp;
  } catch (e) {
    error.value = String(e);
  }
}
const ipBannerVisible = computed(
  () =>
    !!settings.value?.enabled &&
    (!!ipStatus.value?.missing || !!status.value?.bindFailed) &&
    ipChoice.value !== "keep" &&
    ipChoice.value !== "done",
);
function keepIp() {
  ipChoice.value = "keep";
}
function useNewIp(ip: string) {
  newIp.value = ip;
  ipChoice.value = "new";
  if (settings.value) settings.value.bind = ip;
}

// Items for the select: this machine's addresses, plus the saved bind when it is not among them
// (an address that went away), so the current value is never hidden.
const bindItems = computed(() => {
  const b = settings.value?.bind ?? "";
  return b && !localIps.value.includes(b) ? [...localIps.value, b] : localIps.value;
});

// Connection snippets follow the draft port / bind / token, so a regenerated token shows up at once.
const snippets = ref<CenterConnectSnippets | null>(null);
const snippetTab = ref<"mcpJson" | "claudeCode">("mcpJson");
const SNIPPET_TABS = [
  { label: "mcp.json", value: "mcpJson", },
  { label: "claude mcp add", value: "claudeCode", },
];
let snippetSeq = 0;
watch(
  () => [settings.value?.enabled, settings.value?.bind, settings.value?.port, settings.value?.token] as const,
  async ([enabled, bind, port, token]) => {
    const seq = ++snippetSeq;
    if (!enabled || !bind || token === undefined || portError.value || tokenError.value) {
      snippets.value = null;
      return;
    }
    try {
      const r = await centerConnectSnippets(bind, Number(port), token);
      if (seq === snippetSeq) snippets.value = r;
    } catch (e) {
      if (seq === snippetSeq) error.value = String(e);
    }
  },
  { immediate: true },
);

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.add({ title: `${what} をコピーした`, color: "success" });
  } catch (e) {
    error.value = `コピーに失敗: ${String(e)}`;
  }
}

const regenerating = ref(false);
async function regenerateToken() {
  if (!settings.value) return;
  regenerating.value = true;
  error.value = null;
  try {
    // Stored and applied (a running center restarts with it) right away; other draft fields stay unsaved.
    settings.value.token = await centerRegenerateToken();
    await refreshStatus();
    pollStatus();
  } catch (e) {
    error.value = String(e);
  } finally {
    regenerating.value = false;
  }
}

// Another host's center: a pasted connection snippet gives the URL and token.
const pasteText = ref("");
const parsed = ref<CenterParsedConnect | null>(null);
const parseError = ref<string | null>(null);
let parseSeq = 0;
async function onPaste(text: string) {
  pasteText.value = text;
  const seq = ++parseSeq;
  if (!text.trim()) {
    parsed.value = null;
    parseError.value = null;
    return;
  }
  try {
    const r = await centerParseConnect(text);
    if (seq !== parseSeq) return;
    parsed.value = r;
    parseError.value = null;
    if (settings.value) settings.value.remote = { url: r.url, ...(r.token ? { token: r.token } : {}) };
  } catch (e) {
    if (seq !== parseSeq) return;
    parsed.value = null;
    parseError.value = String(e);
  }
}

function clearRemote() {
  if (settings.value) settings.value.remote = undefined;
  pasteText.value = "";
  parsed.value = null;
  parseError.value = null;
  parseSeq++;
}

async function save() {
  if (!settings.value || portError.value || tokenError.value) return;
  saving.value = true;
  error.value = null;
  try {
    settings.value = await centerSetSettings({ ...settings.value, port: Number(settings.value.port) });
    toast.add({ title: "設定を保存した", color: "success" });
    if (ipChoice.value === "new") ipChoice.value = "done";
    await Promise.all([refreshStatus(), loadIpStatus()]);
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
  <UModal v-model:open="open" title="設定" description="center（sidecar）の起動、token、接続設定" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <div v-if="settings" class="flex flex-col gap-4" data-testid="settings-dialog">
        <div
          v-if="ipBannerVisible"
          class="border-cork-border bg-cork-elevated flex flex-col gap-2 border p-3 text-xs"
          data-testid="center-ip-banner"
        >
          <p v-if="ipStatus?.missing" data-testid="center-ip-banner-missing">
            保存の IP {{ ipStatus.saved }} は今このマシンに無い。今の候補: {{ ipStatus.ips.join(", ") }}
          </p>
          <p v-if="status?.bindFailed" data-testid="center-ip-banner-bind-failed">
            center が待ち受けに失敗した（port の競合など。ログを参照）。今の候補: {{ ipStatus?.ips.join(", ") }}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              size="xs"
              variant="outline"
              color="neutral"
              :label="`前と同じ IP のまま${ipStatus?.saved ? ` (${ipStatus.saved})` : ''}`"
              data-testid="center-ip-keep"
              @click="keepIp"
            />
            <UButton
              size="xs"
              :variant="ipChoice === 'new' ? 'solid' : 'outline'"
              label="新しい IP にする"
              data-testid="center-ip-new"
              @click="useNewIp(newIp)"
            />
            <USelect
              :model-value="newIp"
              :items="localIps"
              size="xs"
              class="w-48"
              data-testid="center-ip-new-select"
              @update:model-value="useNewIp(String($event))"
            />
          </div>
          <p v-if="ipChoice === 'new'" class="text-cork-muted" data-testid="center-ip-banner-hint">
            {{ newIp }} を選んだ。保存すると接続設定に反映する
          </p>
        </div>
        <span class="text-sm font-semibold">この PC の center</span>
        <USwitch v-model="settings.enabled" label="center を起動する" data-testid="center-enabled" />
        <!-- Everything below is this host's center: hidden (not reset) while it is off. -->
        <div v-if="settings.enabled" class="flex flex-col gap-4" data-testid="center-own-section">
        <div class="flex gap-3">
          <UFormField label="port" class="w-32" :error="portError ?? undefined">
            <UInput v-model="settings.port" type="number" class="w-full" data-testid="center-port" />
          </UFormField>
          <UFormField label="接続設定の IP（この PC の IP）" class="flex-1" description="接続設定の URL のホストになる IP（既定は外側 IP の先頭）。center 自体は全アドレス（0.0.0.0）で待ち受ける">
            <USelect v-model="settings.bind" :items="bindItems" class="w-full" data-testid="center-bind" />
          </UFormField>
        </div>
        <p class="text-cork-danger-text text-xs" data-testid="center-bind-warning">
          center は全アドレスで待ち受ける（接続は token で守られる）
        </p>

        <div v-if="settings.enabled" class="flex flex-col gap-3" data-testid="center-mcp-section">
          <UFormField label="Auth Token" :error="tokenError ?? undefined">
            <div class="flex items-center gap-2">
              <UInput v-model="settings.token" class="flex-1 font-mono" autocomplete="off" data-testid="center-token" />
              <UButton
                size="sm"
                variant="ghost"
                color="neutral"
                icon="i-lucide-copy"
                aria-label="token をコピー"
                data-testid="center-token-copy"
                @click="copy(settings.token, 'token')"
              />
              <UButton
                size="sm"
                variant="ghost"
                color="neutral"
                icon="i-lucide-refresh-cw"
                :loading="regenerating"
                aria-label="token を再生成"
                data-testid="center-token-regenerate"
                @click="regenerateToken"
              />
            </div>
          </UFormField>
          <UFormField label="接続設定" description="MCP クライアント（別ホストの bantou desktop や Claude Code）に貼る。token 入り">
            <UTabs v-model="snippetTab" :items="SNIPPET_TABS" size="sm" :content="false" class="w-full" data-testid="center-snippet-tabs" />
            <div v-if="snippets" class="relative">
              <pre
                class="bg-cork-elevated max-h-48 overflow-auto p-2 pr-10 text-xs"
                data-testid="center-snippet"
                >{{ snippets[snippetTab] }}</pre
              >
              <UButton
                class="absolute top-1 right-1"
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-copy"
                aria-label="接続設定をコピー"
                data-testid="center-snippet-copy"
                @click="copy(snippets[snippetTab], '接続設定')"
              />
            </div>
          </UFormField>
        </div>

        <UFormField label="workspace" description="center が扱う作業ディレクトリ（1 つ）。無ければ作る。~ 始まりも可">
          <UInput
            v-model="settings.workspace"
            placeholder="~/.bantou"
            class="w-full"
            data-testid="center-workspace"
          />
        </UFormField>

        <UFormField label="claudePath" description="空なら login shell から自動解決">
          <UInput
            :model-value="settings.claudePath ?? ''"
            placeholder="/Users/me/.local/bin/claude"
            class="w-full"
            data-testid="center-claude-path"
            @update:model-value="settings.claudePath = String($event) || undefined"
          />
        </UFormField>
        </div>

        <div v-else class="flex flex-col gap-2" data-testid="center-remote-section">
          <span class="text-sm font-semibold">別ホストの center に接続（貼り付け）</span>
          <p class="text-cork-muted text-xs">
            相手の設定画面でコピーした接続設定（mcp.json か claude mcp add）を貼る。保存すると sidecar ではなくこちらに接続する
          </p>
          <UTextarea
            :model-value="pasteText"
            :rows="4"
            class="w-full font-mono"
            placeholder="{ &quot;mcpServers&quot;: ... } または claude mcp add --transport http ..."
            data-testid="center-remote-paste"
            @update:model-value="onPaste(String($event))"
          />
          <p v-if="parseError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="center-remote-error">
            {{ parseError }}
          </p>
          <div v-if="parsed" class="text-xs" data-testid="center-remote-parsed">
            <div>URL: <span class="font-mono" data-testid="center-remote-parsed-url">{{ parsed.url }}</span></div>
            <div data-testid="center-remote-parsed-token">token: {{ parsed.token ? "あり" : "なし（401 になる）" }}</div>
          </div>
          <div v-if="settings.remote" class="flex items-center gap-2 text-xs" data-testid="center-remote-current">
            <span class="text-cork-muted">接続先:</span>
            <span class="font-mono">{{ settings.remote.url }}</span>
            <span class="text-cork-muted">token {{ settings.remote.token ? "あり" : "なし" }}</span>
            <UButton
              class="ml-auto"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-x"
              label="解除"
              data-testid="center-remote-clear"
              @click="clearRemote"
            />
          </div>
        </div>

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
          :disabled="!!portError || !!tokenError"
          data-testid="settings-save"
          @click="save"
        />
      </div>
      <p v-else-if="error" class="text-cork-danger-text text-xs">{{ error }}</p>
    </template>
  </UModal>
</template>
