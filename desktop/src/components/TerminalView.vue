<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { sessionInput, sessionResize } from "~/api";
import { encodeBase64 } from "~/composables/terminalBuffer";

const props = defineProps<{ session: string }>();

const { attach, detach, status } = useTerminalStore();

const host = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let current: string | null = null;

function report(e: unknown) {
  error.value = String(e);
}

function sendInput(session: string, b64: string) {
  sessionInput(session, b64).then(() => (error.value = null), report);
}

function sendSize(session: string) {
  if (!term) return;
  sessionResize(session, term.cols, term.rows).catch(report);
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
  term.onData((d) => current && sendInput(current, encodeBase64(new TextEncoder().encode(d))));
  // Mouse reports and similar arrive as a Latin-1 string, one byte per char.
  term.onBinary((d) => {
    if (!current) return;
    sendInput(current, btoa(d));
  });
  term.onResize(() => current && sendSize(current));
  observer = new ResizeObserver(() => fit?.fit());
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
  await close();
  term?.dispose();
  term = null;
});

const link = computed(() => status[props.session]);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" role="region" :aria-label="`${session} のターミナル`" data-testid="terminal-pane">
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
      <span v-if="error" class="text-cork-danger-text ml-auto truncate" data-testid="terminal-error">{{ error }}</span>
    </div>
    <div ref="host" class="min-h-0 flex-1 bg-[#020617] p-2" data-testid="terminal" />
  </div>
</template>
