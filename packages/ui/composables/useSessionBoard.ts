import { centerGetSettings } from "#bantou-ui/api";
import type { SessionActivity } from "#bantou-ui/types";
import type { SessionGroup, useBoard } from "./useBoard";

type Board = ReturnType<typeof useBoard>;

export type ChipKey = Exclude<SessionActivity, "remote-working">;

/** hideZero: shown only while at least one session is in that state (the three work states are always shown). */
export const ACTIVITY_CHIPS: { key: ChipKey; label: string; icon: string; hideZero?: boolean; cls?: string }[] = [
  { key: "working", label: "作業中", icon: "i-lucide-loader-circle" },
  { key: "needs-input", label: "判断待ち", icon: "i-lucide-message-circle-question" },
  { key: "idle", label: "待機", icon: "i-lucide-circle-check" },
  { key: "remote-unreachable", label: "到達不能", icon: "i-lucide-server-off", hideZero: true, cls: "text-error" },
  { key: "remote-lost", label: "lost", icon: "i-lucide-unplug", hideZero: true, cls: "text-error" },
];

/**
 * Selection, work-state filter and dialog state of the session board
 * (the connected center's session_list; selection lives in memory only).
 * Layout-free: desktop uses it with 3 columns, web will use the same state with its own screens.
 */
export function useSessionBoard(board: Pick<Board, "sessions" | "centerList" | "activityCounts">) {
  const { sessions, centerList, activityCounts } = board;
  const { refreshNow: refreshSessions } = useSessionRefresh();
  const toast = useToast();

  // --- session side menu ----------------------------------------------------

  const selectedName = ref<string | null>(null);
  /** A project from the center config (not made by `session_create`) has no settings: the center cannot update it. */
  const fromConfig = (name: string) => centerList.value.sessions.find((r) => r.name === name)?.source === "config";
  /** Session whose project settings dialog is open. */
  const settingsFor = ref<string | null>(null);
  /** Whether the session of the open gear dialog was the selected one when it was opened (the list may refresh before the save returns). */
  let settingsWasSelected = false;
  function openSettings(name: string) {
    settingsWasSelected = selectedName.value === name;
    settingsFor.value = name;
  }
  const settingsDialogOpen = computed({
    get: () => settingsFor.value !== null,
    set: (v) => {
      if (!v) settingsFor.value = null;
    },
  });
  watch(
    sessions,
    (list) => {
      if (!list.some((g) => g.name === selectedName.value)) selectedName.value = list[0]?.name ?? null;
    },
    { immediate: true },
  );

  // --- work state summary / filter (side menu) -----------------------------

  /** Narrow the rows to one work state (click again to release). Memory only. */
  const activityFilter = ref<SessionActivity | null>(null);
  function toggleFilter(k: ChipKey) {
    activityFilter.value = activityFilter.value === k ? null : k;
  }
  // The filter releases itself when no session is in that state any more (otherwise the list would stay empty).
  watch(activityCounts, (c) => {
    if (activityFilter.value && c[activityFilter.value] === 0) activityFilter.value = null;
  });
  const sideRows = computed<SessionGroup[]>(() =>
    activityFilter.value
      ? sessions.value.filter((g) =>
          activityFilter.value === "working" ? g.activity === "working" || g.activity === "remote-working" : g.activity === activityFilter.value,
        )
      : sessions.value,
  );
  const selectedGroup = computed(() => sessions.value.find((g) => g.name === selectedName.value));

  // --- add session ---------------------------------------------------------

  const addSessionOpen = ref(false);
  const settingsOpen = ref(false);
  const centerOpen = ref(false);

  // "セッション追加" needs a center to talk to: enabled, or a pasted remote (the same rule as the Rust side).
  const addSessionDisabledReason = ref<string | null>(null);
  async function refreshAddTarget() {
    try {
      const s = await centerGetSettings();
      addSessionDisabledReason.value = s.enabled || s.remote ? null : "center が無効で接続先も無い（設定で center を有効にするか、別ホストの接続設定を貼る）";
    } catch (e) {
      addSessionDisabledReason.value = String(e);
    }
  }
  onMounted(() => void refreshAddTarget());
  // The target may have changed (settings, pasted connection): re-read the center.
  watch(settingsOpen, (v) => {
    if (v) return;
    void refreshAddTarget();
    void refreshSessions();
  });
  /** The gear does not change the selection; a rename only carries it along when the renamed session was the selected one. */
  function onSessionRenamed(_from: string, to: string) {
    if (settingsWasSelected) selectedName.value = to;
  }
  function onSessionUpdated() {
    void refreshSessions();
  }

  function onSessionCreated(name: string) {
    toast.add({ title: `${name} を作成`, color: "success" });
  }

  // --- re-login of the selected session's claude (the center read `Please run /login` from its pty) ---

  const loginOpen = ref(false);
  function onLoggedIn(name: string) {
    toast.add({ title: `${name} に再ログインした`, color: "success" });
    void refreshSessions();
  }

  return {
    selectedName,
    selectedGroup,
    fromConfig,
    settingsFor,
    settingsDialogOpen,
    openSettings,
    activityFilter,
    toggleFilter,
    sideRows,
    addSessionOpen,
    settingsOpen,
    centerOpen,
    addSessionDisabledReason,
    onSessionRenamed,
    onSessionUpdated,
    onSessionCreated,
    loginOpen,
    onLoggedIn,
  };
}
