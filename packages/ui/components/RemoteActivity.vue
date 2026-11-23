<script setup lang="ts">
import { remoteList } from "../api";
import type { CenterRemoteRecord } from "../types";

const props = defineProps<{ owner?: string }>();

// test ids: the center dialog's list (all sessions) and a session's list (one session) can be on screen together.
const tp = computed(() => (props.owner === undefined ? "center-" : "session-"));

const POLL_MS = 3000;

const remotes = ref<CenterRemoteRecord[] | null>(null);
const error = ref<string | null>(null);

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const all = await remoteList();
    // One remote-cap per session × server: a session sees only its own caps (the shared old cap has no session and is shown in the center dialog only).
    remotes.value = props.owner === undefined ? all : all.filter((r) => r.session === props.owner);
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    polling = false;
  }
}

// A different owner: drop the previous owner's list and read again now.
watch(
  () => props.owner,
  () => {
    remotes.value = null;
    void poll();
  },
);

let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
});
</script>

<template>
  <div class="flex flex-col gap-2" :data-testid="`${tp}remotes`">
    <span class="text-sm font-medium">remotes</span>
    <p v-if="error" class="text-cork-danger-text text-xs whitespace-pre-wrap" :data-testid="`${tp}remotes-error`">
      {{ error }}
    </p>
    <div
      v-for="r in remotes ?? []"
      :key="`${r.server}:${r.remote_id}`"
      class="flex flex-col gap-1"
      :data-testid="`${tp}remote`"
      :data-remote-id="r.remote_id"
    >
      <div class="flex items-center gap-2 text-xs">
        <span class="font-medium">{{ r.remote_id }}</span>
        <span class="text-cork-muted">{{ r.server }}</span>
        <span v-if="props.owner === undefined" class="text-cork-muted" :data-testid="`${tp}remote-session`">{{ r.session ?? "共有（旧）" }}</span>
        <span v-if="r.model" class="text-cork-muted" :data-testid="`${tp}remote-model`">{{ r.model }}</span>
        <span class="text-cork-muted" :data-testid="`${tp}remote-state`">{{ r.state }}</span>
      </div>
    </div>
    <p v-if="remotes && !remotes.length" class="text-cork-muted text-xs" :data-testid="`${tp}remotes-none`">
      remote なし
    </p>
  </div>
</template>
