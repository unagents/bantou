<script setup lang="ts">
import { openReleaseNotes } from "~/api";
import type { UpdaterState } from "~/types";

// Bridges `useUpdater`'s state to Nuxt UI toasts. Renders nothing. Each state kind has its
// own toast id: an action button closes its toast (and Nuxt UI removes it 200ms later), so
// reusing one id would make that removal swallow the next state's toast.
//   available   -> action "再起動して更新"
//   downloading -> progress description
//   installing  -> "再起動します"
//   error       -> error toast
//   idle/checking -> no surfaced UI (a visible toast is removed on idle)
const props = defineProps<{ state: UpdaterState }>();
const emit = defineEmits<{ install: []; dismiss: [] }>();

const ID_PREFIX = "bantou-updater-";
const toast = useToast();

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressText(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return fmt(downloaded);
  const pct = Math.floor(Math.min(100, (downloaded / total) * 100));
  return `${fmt(downloaded)} / ${fmt(total)} · ${pct}%`;
}

// The id of the toast currently shown (null when none).
let shownId: string | null = null;

// An action click also closes its toast: that close must not reset the state the click
// just advanced (available -> downloading), so the dismiss is deferred and the state
// owner ignores it unless it is still available / error.
function emitDismiss() {
  setTimeout(() => emit("dismiss"), 0);
}

watch(
  () => props.state,
  (s) => {
    if (s.kind === "checking") return;
    if (s.kind === "idle") {
      if (shownId) toast.remove(shownId);
      shownId = null;
      return;
    }
    const TOAST_ID = ID_PREFIX + s.kind;
    if (shownId && shownId !== TOAST_ID) toast.remove(shownId);
    shownId = TOAST_ID;
    switch (s.kind) {
      case "available": {
        const version = s.version;
        toast.add({
          id: TOAST_ID,
          title: `bantou ${version} が利用可能`,
          description: undefined,
          icon: "i-lucide-download",
          color: "primary",
          duration: 0,
          close: true,
          actions: [
            { label: "再起動して更新", onClick: () => emit("install") },
            { label: "リリースノート", color: "neutral", variant: "ghost", onClick: () => void openReleaseNotes(version).catch(console.error) },
          ],
          "onUpdate:open": (open: boolean) => {
            if (!open) emitDismiss();
          },
        });
        break;
      }
      case "downloading":
        toast.add({
          id: TOAST_ID,
          title: `bantou ${s.version} をダウンロード中`,
          description: progressText(s.downloaded, s.contentLength),
          icon: "i-lucide-loader-circle",
          color: "primary",
          duration: 0,
          close: false,
          actions: [],
          "onUpdate:open": undefined,
        });
        break;
      case "installing":
        toast.add({
          id: TOAST_ID,
          title: `bantou ${s.version} をインストール中`,
          description: "まもなく再起動します…",
          icon: "i-lucide-loader-circle",
          color: "primary",
          duration: 0,
          close: false,
          actions: [],
          "onUpdate:open": undefined,
        });
        break;
      case "error":
        toast.add({
          id: TOAST_ID,
          title: "アップデートに失敗",
          description: s.message,
          icon: "i-lucide-circle-alert",
          color: "error",
          duration: 0,
          close: true,
          actions: [],
          "onUpdate:open": (open: boolean) => {
            if (!open) emitDismiss();
          },
        });
        break;
    }
  },
  { deep: false },
);
</script>

<template>
  <span class="hidden" data-testid="updater-toast-host" />
</template>
