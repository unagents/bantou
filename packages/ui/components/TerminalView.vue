<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  logWebview,
  onFilesDropped,
  sessionAttachBytes,
  sessionAttachPaths,
  sessionAttachPick,
  sessionInput,
  sessionResize,
  type AttachOutcome,
} from "../api";
import { encodeBase64 } from "../composables/terminalBuffer";
import type { CenterAuthState } from "../types";

const props = defineProps<{
  session: string;
  /** The claude's auth state as the center reports it (null / `ok`: nothing to show). */
  auth?: CenterAuthState | null;
}>();
const emit = defineEmits<{ relogin: [] }>();

const { attach, detach, status } = useTerminalStore();

const host = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);
const pane = ref<HTMLElement | null>(null);
// Image attachments in flight (shown as a small progress note).
const sending = ref(0);

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let current: string | null = null;

function report(e: unknown) {
  error.value = String(e);
}

function sendInput(session: string, b64: string) {
  sessionInput(session, b64).then(
    () => (error.value = null),
    (e) => {
      logWebview("warn", `terminal input failed [${session}]: ${String(e)}`);
      report(e);
    },
  );
}

// Runs one attachment request; the Rust side already typed the saved paths into the pty.
async function sendAttachment(session: string, n: number, job: () => Promise<AttachOutcome>) {
  sending.value += n;
  try {
    const r = await job();
    if (r.errors.length > 0) {
      logWebview("warn", `attachment [${session}]: ${r.errors.join(" / ")}`);
      error.value = r.errors.join(" / ");
    } else if (r.saved.length > 0) {
      error.value = null;
    }
  } catch (e) {
    logWebview("warn", `attachment failed [${session}]: ${String(e)}`);
    report(e);
  } finally {
    sending.value -= n;
  }
}

// Cmd/Ctrl+V with an image on the clipboard (and no text): send the image. Text keeps going to xterm.
function onPaste(ev: ClipboardEvent) {
  const session = current;
  const dt = ev.clipboardData;
  if (!session || !dt || dt.getData("text/plain") !== "") return;
  const files = Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) {
      error.value = `画像の型が違う（${f.type}。png / jpeg / gif / webp のみ）`;
      continue;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      error.value = "20MB を超えている（1 枚 20MB まで）";
      continue;
    }
    void sendAttachment(session, 1, async () => sessionAttachBytes(session, new Uint8Array(await f.arrayBuffer())));
  }
}

// Files dropped on the window count only when released over this pane (position is in physical pixels).
function onDrop(paths: string[], pos: { x: number; y: number }) {
  const session = current;
  const r = pane.value?.getBoundingClientRect();
  if (!session || !r || paths.length === 0) return;
  const x = pos.x / window.devicePixelRatio;
  const y = pos.y / window.devicePixelRatio;
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
  void sendAttachment(session, paths.length, () => sessionAttachPaths(session, paths));
}

function pick() {
  const session = current;
  if (session) void sendAttachment(session, 1, () => sessionAttachPick(session));
}

let unlistenDrop: (() => void) | null = null;

// center accepts cols / rows as integers in 1..1000.
const clampSize = (n: number) => Math.min(1000, Math.max(1, Math.floor(n)));
const RESIZE_DEBOUNCE_MS = 100;
let lastSent: { session: string; cols: number; rows: number } | null = null;
let sizeTimer: ReturnType<typeof setTimeout> | null = null;
let fitFrame = 0;

// Sends the size only when it differs from the last one sent for this session.
function sendSize(session: string) {
  if (!term) return;
  const cols = clampSize(term.cols);
  const rows = clampSize(term.rows);
  if (lastSent && lastSent.session === session && lastSent.cols === cols && lastSent.rows === rows) return;
  lastSent = { session, cols, rows };
  sessionResize(session, cols, rows).catch((e) => {
    logWebview("warn", `terminal resize failed [${session}] (${cols}x${rows}): ${String(e)}`);
    report(e);
  });
}

// Fit bursts (layout, window drag) are collapsed into one send.
function scheduleSize() {
  if (sizeTimer) clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    sizeTimer = null;
    if (current) sendSize(current);
  }, RESIZE_DEBOUNCE_MS);
}

async function open(session: string) {
  if (!term) return;
  current = session;
  error.value = null;
  term.reset();
  fit?.fit();
  await attach(session, (ev) => {
    if (!term || current !== session) return;
    if ("reset" in ev) term.reset();
    else term.write(ev.bytes);
  });
  // The last desktop to send a size wins (the pty follows it): announce ours when a session is shown.
  lastSent = null;
  sendSize(session);
}

async function close() {
  const s = current;
  current = null;
  if (s) await detach(s).catch(() => {});
}

onMounted(async () => {
  term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    theme: { background: "#020617" },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  host.value!.addEventListener("paste", onPaste, true);
  onFilesDropped(onDrop).then(
    (u) => (unlistenDrop = u),
    () => {}, // plain browser: no drag-drop events
  );
  term.onData((d) => current && sendInput(current, encodeBase64(new TextEncoder().encode(d))));
  // Mouse reports and similar arrive as a Latin-1 string, one byte per char.
  term.onBinary((d) => {
    if (!current) return;
    sendInput(current, btoa(d));
  });
  term.onResize(() => current && scheduleSize());
  // Fit on the next frame: fitting inside the observer callback re-triggers it ("ResizeObserver loop").
  observer = new ResizeObserver(() => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fit?.fit();
    });
  });
  observer.observe(host.value!);
  await open(props.session);
});

watch(
  () => props.session,
  async (next) => {
    // From now on keystrokes belong to the session being shown, not to the one being left (detach is async).
    const prev = current;
    current = next;
    term?.reset();
    if (prev) await detach(prev).catch(() => {});
    if (current !== next) return; // switched again while detaching
    await open(next);
  },
);

onBeforeUnmount(async () => {
  observer?.disconnect();
  host.value?.removeEventListener("paste", onPaste, true);
  unlistenDrop?.();
  if (fitFrame) cancelAnimationFrame(fitFrame);
  if (sizeTimer) clearTimeout(sizeTimer);
  await close();
  term?.dispose();
  term = null;
});

const link = computed(() => status[props.session]);
</script>

<template>
  <div ref="pane" class="flex h-full max-h-full min-h-0 flex-col overflow-hidden" role="region" :aria-label="`${session} のターミナル`" data-testid="terminal-pane">
    <div class="bg-cork-elevated border-cork-border flex items-center gap-2 border-b px-3 py-1.5 text-xs">
      <UIcon name="i-lucide-square-terminal" class="text-cork-accent size-4" />
      <span class="font-display truncate font-semibold">{{ session }}</span>
      <UBadge
        v-if="link === 'retrying'"
        color="warning"
        variant="subtle"
        label="再接続中"
        data-testid="terminal-retrying"
      />
      <UBadge
        v-else-if="link === 'rejected'"
        color="error"
        variant="subtle"
        label="接続できない"
        data-testid="terminal-rejected"
      />
      <!-- The center read `Please run /login` (or a failed save) from the pty: the user re-logs in from here. -->
      <UTooltip
        v-if="auth === 'login_required' || auth === 'keychain_locked'"
        :text="auth === 'keychain_locked' ? 'ログインを保存できなかった。ホストの keychain を解錠してから再ログイン' : 'claude の認証が切れた。再ログインが要る'"
      >
        <UButton
          size="xs"
          :color="auth === 'keychain_locked' ? 'error' : 'warning'"
          variant="subtle"
          icon="i-lucide-key-round"
          :label="auth === 'keychain_locked' ? 'keychain ロック中' : '要再ログイン'"
          data-testid="terminal-auth"
          :data-auth="auth"
          @click="emit('relogin')"
        />
      </UTooltip>
      <span v-if="sending > 0" class="text-cork-muted ml-auto truncate" data-testid="terminal-sending">画像を送信中… {{ sending }} 枚</span>
      <span v-if="error" class="text-cork-danger-text truncate" :class="{ 'ml-auto': sending === 0 }" data-testid="terminal-error">{{ error }}</span>
      <UButton
        icon="i-lucide-paperclip"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="画像を添付"
        title="画像を添付（png / jpeg / gif / webp、1 枚 20MB まで）"
        class="shrink-0"
        :class="{ 'ml-auto': sending === 0 && !error }"
        data-testid="terminal-attach"
        @click="pick"
      />
    </div>
    <div ref="host" class="min-h-0 flex-1 overflow-hidden bg-[#020617] p-2" data-testid="terminal" />
  </div>
</template>
