<script setup lang="ts">
import { fetchHealth, type WebHealth } from "~/utils/health";
import { isAccessDenied, onAccessDenied } from "~/tauri/session-watch";

// Phone screen, level 1: the center's session list (design 7.1). The selection / filter state is the shared
// composable the desktop's 3 columns use; only the layout is the web's own. A row leads to the session's page (`/s/:name`).
// The tab "server / cap" shows the servers and the caps' state as cards.
const tab = ref<"session" | "server">("session");
// Reloading did not bring the session back (a 403 a login cannot fix): say so instead of looping.
const denied = ref(isAccessDenied());
let stopDenied: (() => void) | null = null;
onMounted(() => (stopDenied = onAccessDenied((d) => (denied.value = d))));
onBeforeUnmount(() => stopDenied?.());

const board = useBoard(ref<string | null>(null));
const { centerList, activityCounts } = board;
const { sideRows, activityFilter, toggleFilter } = useSessionBoard(board);

onMounted(() => void board.refresh());

const loaded = computed(() => centerList.value.rev >= 0 || !centerList.value.reachable);
const sessionCount = computed(() => board.sessions.value.length);

// Why the center cannot be asked: the backend knows ("no-target": nothing to connect to yet).
const health = ref<WebHealth | null>(null);
watch(
  () => centerList.value.reachable,
  async (ok) => {
    health.value = ok ? null : await fetchHealth();
  },
  { immediate: true },
);
const noTarget = computed(() => health.value?.status === "no-target");
const reason = computed(() => health.value?.reason ?? centerList.value.reason);
</script>

<template>
  <div class="bg-default text-default flex h-dvh flex-col overflow-hidden">
    <WebHeader title="bantou" :unreachable="loaded && !centerList.reachable && !noTarget" />
    <nav class="border-cork-border flex shrink-0 border-b text-sm" role="tablist" data-testid="web-tabs">
      <button
        v-for="t in ([['session', 'session'], ['server', 'server・cap']] as const)"
        :key="t[0]"
        type="button"
        role="tab"
        class="min-h-11 flex-1 px-3"
        :class="tab === t[0] ? 'border-cork-accent border-b-2 font-semibold' : 'text-cork-muted'"
        :aria-selected="tab === t[0]"
        :data-testid="`tab-${t[0]}`"
        @click="tab = t[0]"
      >
        {{ t[1] }}
      </button>
    </nav>
    <main v-if="tab === 'server'" class="min-h-0 flex-1 overflow-y-auto" data-testid="server-cap-page">
      <ServerCapCards />
    </main>
    <main v-else class="min-h-0 flex-1 overflow-y-auto" data-testid="session-list-page">
      <div v-if="denied" class="p-4 text-sm" role="alert" data-testid="access-denied">
        <p class="font-semibold">許可されていません</p>
        <p class="text-cork-muted mt-1">このアカウントではこの web を使えない。管理者に確認してほしい。</p>
      </div>
      <p v-else-if="!loaded" class="text-cork-muted p-4 text-sm" data-testid="list-loading">読み込み中…</p>
      <div v-else-if="noTarget" class="p-4 text-sm" data-testid="no-target">
        <p class="font-semibold">接続先が無い</p>
        <p class="text-cork-muted mt-1">この web が指す center が設定されていない。</p>
      </div>
      <div v-else-if="!centerList.reachable" class="p-4 text-sm" data-testid="center-unreachable">
        <p class="font-semibold">center に問い合わせられなかった</p>
        <p v-if="reason" class="text-cork-muted mt-1 break-words">{{ reason }}</p>
      </div>
      <template v-if="!denied && loaded && !noTarget">
        <div
          v-if="sessionCount"
          class="border-cork-border flex flex-wrap items-center gap-1 border-b px-2 py-1.5 text-xs"
          data-testid="session-activity-summary"
        >
          <button
            v-for="c in ACTIVITY_CHIPS.filter((x) => !x.hideZero || activityCounts[x.key] > 0)"
            :key="c.key"
            type="button"
            class="hover:bg-cork-elevated flex min-h-9 items-center gap-1 rounded px-2 py-1"
            :class="[
              activityFilter === c.key ? 'bg-cork-elevated ring-1 ring-current' : '',
              c.key === 'needs-input' && activityCounts[c.key] > 0 ? 'text-warning font-semibold' : (c.cls ?? 'text-cork-muted'),
            ]"
            :aria-pressed="activityFilter === c.key"
            :aria-label="`${c.label} ${activityCounts[c.key]}`"
            :data-testid="`session-activity-summary-${c.key}`"
            :data-count="activityCounts[c.key]"
            @click="toggleFilter(c.key)"
          >
            <UIcon :name="c.icon" class="size-4" aria-hidden="true" />
            {{ activityCounts[c.key] }}
          </button>
        </div>
        <ul class="flex flex-col" aria-label="セッション一覧">
          <li
            v-for="g in sideRows"
            :key="g.name"
            class="border-cork-border flex min-h-12 items-center gap-2 border-b text-sm"
            data-testid="side-row"
            :data-name="g.name"
          >
            <NuxtLink :to="`/s/${encodeURIComponent(g.name)}`" class="flex min-h-12 min-w-0 flex-1 items-center gap-2 py-2 pr-3 pl-3" data-testid="side-link">
            <UIcon name="i-lucide-terminal-square" class="text-cork-accent size-4 shrink-0" />
            <span class="truncate">{{ g.name }}</span>
            <UIcon
              v-if="g.auth === 'login_required' || g.auth === 'keychain_locked'"
              name="i-lucide-key-round"
              class="size-4 shrink-0"
              :class="g.auth === 'keychain_locked' ? 'text-cork-danger-text' : 'text-warning'"
              :title="g.auth === 'keychain_locked' ? 'keychain ロック中' : '要再ログイン'"
              data-testid="side-auth"
              :data-auth="g.auth"
            />
            <SessionActivityMark v-if="g.activity" :activity="g.activity" :waiting-reply="g.remoteWaiting" :issues="g.remoteIssues" class="ml-auto" />
            <ContextUsage :usage="g.contextUsage" percent-only :class="g.activity ? '' : 'ml-auto'" data-scope="side" />
            </NuxtLink>
          </li>
        </ul>
        <p v-if="centerList.reachable && !sessionCount" class="text-cork-muted p-4 text-sm" data-testid="no-sessions">session が無い</p>
      </template>
    </main>
  </div>
</template>
