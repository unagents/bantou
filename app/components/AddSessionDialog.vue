<script setup lang="ts">
import { listPeers, registerSessions } from "~/api";
import type { Peer, RegisterResult, Session } from "~/types";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ registered: Session[]; selfName: string }>();
const emit = defineEmits<{ done: [results: RegisterResult[]] }>();

const peers = ref<Peer[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const query = ref("");
const picked = ref<Set<string>>(new Set());
/** Session names typed for unnamed peers, keyed by peer id. */
const assigned = ref<Record<string, string>>({});

const baseName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? "";

async function load() {
  loading.value = true;
  error.value = null;
  picked.value = new Set();
  assigned.value = {};
  try {
    peers.value = await listPeers();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(open, (v) => v && void load(), { immediate: true });

const rows = computed(() => {
  const reg = new Set(props.registered.map((s) => s.name));
  const q = query.value.trim().toLowerCase();
  return peers.value
    .filter((p) => p.name !== props.selfName && !reg.has(p.name))
    .filter((p) => !q || `${p.name} ${p.hostname} ${p.cwd} ${p.summary}`.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
});

function toggle(p: Peer) {
  const s = new Set(picked.value);
  if (s.has(p.id)) s.delete(p.id);
  else {
    s.add(p.id);
    if (!p.name && !assigned.value[p.id]) assigned.value[p.id] = baseName(p.cwd);
  }
  picked.value = s;
}

/** Every picked unnamed peer needs a non-empty name that is not taken. */
const invalid = computed(() => {
  const taken = new Set([...props.registered.map((s) => s.name), ...peers.value.map((p) => p.name).filter(Boolean)]);
  const seen = new Set<string>();
  for (const p of peers.value) {
    if (!picked.value.has(p.id) || p.name) continue;
    const n = (assigned.value[p.id] ?? "").trim();
    if (!n || taken.has(n) || seen.has(n)) return true;
    seen.add(n);
  }
  return false;
});

async function submit() {
  const chosen = peers.value
    .filter((p) => picked.value.has(p.id))
    .map((p) => (p.name ? p : { ...p, assign_name: (assigned.value[p.id] ?? "").trim() }));
  if (!chosen.length || invalid.value) return;
  try {
    emit("done", await registerSessions(chosen));
    open.value = false;
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <UModal v-model:open="open" title="セッション追加" description="messenger に接続中のセッションから選ぶ" :ui="{ content: 'max-w-4xl' }">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex gap-2">
          <UInput v-model="query" icon="i-lucide-search" placeholder="名前・ホスト・cwd で絞り込み" class="flex-1" />
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" aria-label="再読込" @click="load" />
        </div>
        <p v-if="error" class="text-cork-danger-text text-xs">{{ error }}</p>
        <table class="w-full text-sm">
          <thead class="text-cork-muted text-left text-xs">
            <tr class="border-cork-border border-b">
              <th class="w-8 py-1.5" />
              <th class="py-1.5">名前</th>
              <th class="py-1.5">ホスト</th>
              <th class="py-1.5">cwd</th>
              <th class="py-1.5">summary</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in rows"
              :key="p.id"
              class="border-cork-border hover:bg-cork-elevated/50 cursor-pointer border-b"
              :data-peer="p.name || p.id"
              @click="toggle(p)"
            >
              <td class="py-1.5">
                <UCheckbox :model-value="picked.has(p.id)" :aria-label="p.name || p.id" />
              </td>
              <td class="py-1.5">
                <template v-if="p.name">{{ p.name }}</template>
                <UInput
                  v-else-if="picked.has(p.id)"
                  v-model="assigned[p.id]"
                  size="xs"
                  placeholder="セッション名"
                  :aria-label="`${p.id} のセッション名`"
                  @click.stop
                />
                <span v-else class="text-cork-muted">（名前なし: {{ p.id }}）</span>
              </td>
              <td class="text-cork-muted py-1.5 text-xs">{{ p.hostname }}</td>
              <td class="text-cork-muted max-w-56 truncate py-1.5 text-xs" :title="p.cwd">{{ p.cwd }}</td>
              <td class="text-cork-muted max-w-56 truncate py-1.5 text-xs" :title="p.summary">
                {{ p.name ? p.summary : "登録時に名前を付ける" }}
              </td>
            </tr>
            <tr v-if="!rows.length && !loading">
              <td colspan="5" class="text-cork-muted py-4 text-center text-xs">追加できるセッションがない</td>
            </tr>
          </tbody>
        </table>
        <UButton
          class="self-end"
          icon="i-lucide-user-plus"
          :label="`登録して規約を送る（${picked.size}）`"
          :disabled="!picked.size || invalid"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
