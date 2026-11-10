<script setup lang="ts">
import { centerTool, pickDirectory } from "~/api";
import { INSTRUCTIONS_NOTE, type SettingsDraft } from "~/composables/sessionInstructions";
import type { CenterServerPeers } from "~/types";

// One section per project-settings item. A future item (skills, output style) is another section here.
const draft = defineModel<SettingsDraft>({ required: true });
const props = defineProps<{
  idPrefix: string;
  rows?: number;
  /** This PC's folder dialog applies to the folder rows (the center runs here): rows are read-only, picked by dialog. Otherwise typed. */
  canPick?: boolean;
}>();
const emit = defineEmits<{ error: [message: string] }>();

function addDir(path = "") {
  draft.value = { ...draft.value, addDirs: [...draft.value.addDirs, path] };
}
function setDir(i: number, v: string) {
  const addDirs = [...draft.value.addDirs];
  addDirs[i] = v;
  draft.value = { ...draft.value, addDirs };
}
function removeDir(i: number) {
  draft.value = { ...draft.value, addDirs: draft.value.addDirs.filter((_, k) => k !== i) };
}
// canPick: "追加" opens the folder dialog and adds the chosen folder as one row (a cancel adds nothing, no blank row).
// When the dialog itself fails (no dialog on this OS) the add button falls back to typed rows (a blank row).
// servers: the choices are the servers the center has discovered (`server_peers`), picked as checkboxes.
// An entry is the server_id (host name when the server reports none); a typed host name works too (it covers every server on that host).
interface ServerChoice {
  value: string;
  host: string;
  label: string;
}
const choices = ref<ServerChoice[]>([]);
const choicesError = ref<string | null>(null);
const serverInput = ref("");
async function loadChoices() {
  try {
    const r = await centerTool<CenterServerPeers>("server_peers");
    choices.value = r.peers.map((p) => {
      const host = p.host ?? p.hostname ?? p.name;
      const who = [p.user, p.workspace].filter(Boolean).join(" ");
      return { value: p.server_id ?? host, host, label: [host, p.server_id, who].filter(Boolean).join("  ") };
    });
    choicesError.value = null;
  } catch (e) {
    choices.value = [];
    choicesError.value = String(e);
  }
}
onMounted(() => void loadChoices());
const limited = computed(() => draft.value.servers !== null);
function setLimited(on: boolean) {
  draft.value = { ...draft.value, servers: on ? [] : null };
}
const matches = (entry: string, c: ServerChoice) => entry === c.value || entry.toLowerCase() === c.host.toLowerCase();
const isChosen = (c: ServerChoice) => (draft.value.servers ?? []).some((e) => matches(e, c));
function toggleChoice(c: ServerChoice, on: boolean) {
  const rest = (draft.value.servers ?? []).filter((e) => !matches(e, c));
  draft.value = { ...draft.value, servers: on ? [...rest, c.value] : rest };
}
/** Entries that match no discovered server (typed host names, servers that are not running now). */
const otherServers = computed(() => (draft.value.servers ?? []).filter((e) => !choices.value.some((c) => matches(e, c))));
function addServer() {
  const v = serverInput.value.trim();
  if (!v) return;
  const cur = draft.value.servers ?? [];
  if (!cur.includes(v)) draft.value = { ...draft.value, servers: [...cur, v] };
  serverInput.value = "";
}
function removeServer(e: string) {
  draft.value = { ...draft.value, servers: (draft.value.servers ?? []).filter((x) => x !== e) };
}

// memory: the center never returns the saved token, so the token field starts blank (blank on save = keep the saved one).
function setMemory(patch: Partial<SettingsDraft["memory"]>) {
  draft.value = { ...draft.value, memory: { ...draft.value.memory, ...patch } };
}

const failed = ref(false);
const dialog = computed(() => !!props.canPick && !failed.value);
async function pickAdd() {
  try {
    const p = await pickDirectory();
    if (p) addDir(p);
  } catch (e) {
    failed.value = true;
    emit("error", String(e));
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-instructions`">
      <h3 class="text-sm font-semibold">追加指示</h3>
      <p class="text-cork-muted text-xs">master-cap の system prompt に追記する文（--append-system-prompt）。空なら付けない</p>
      <UTextarea
        v-model="draft.instructions"
        :rows="rows ?? 8"
        autoresize
        :maxrows="18"
        class="w-full"
        :data-testid="`${idPrefix}-instructions`"
      />
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-instructions-note`">{{ INSTRUCTIONS_NOTE }}</p>
    </section>
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-add-dirs`">
      <h3 class="text-sm font-semibold">参照フォルダ</h3>
      <p class="text-cork-muted text-xs">
        master-cap が自分のフォルダ以外に読み書きしてよいフォルダ（--add-dir。1 行 1 つ{{ props.canPick ? '。行をクリックでフォルダ選択ダイアログを開いて変更' : '、center のホスト上の絶対パス' }}）。空なら付けない
      </p>
      <div v-for="(d, i) in draft.addDirs" :key="i" class="flex gap-2" :data-testid="`${idPrefix}-add-dir-row`">
        <PathField
          :model-value="d"
          mono
          :can-pick="dialog"
          placeholder="/path/to/folder"
          :testid="`${idPrefix}-add-dir`"
          :pick-testid="`${idPrefix}-add-dir-row-pick`"
          @update:model-value="setDir(i, $event)"
          @error="emit('error', $event)"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          :aria-label="`参照フォルダ ${i + 1} を外す`"
          :data-testid="`${idPrefix}-add-dir-remove`"
          @click="removeDir(i)"
        />
      </div>
      <div class="flex gap-2">
        <UButton
          v-if="dialog"
          size="xs"
          label="フォルダを追加…"
          color="neutral"
          variant="outline"
          :data-testid="`${idPrefix}-add-dir-add`"
          @click="pickAdd"
        />
        <UButton v-else size="xs" label="パスを入力して追加" color="neutral" variant="outline" :data-testid="`${idPrefix}-add-dir-add`" @click="addDir()" />
      </div>
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-add-dirs-note`">{{ INSTRUCTIONS_NOTE }}</p>
    </section>
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-output-style`">
      <h3 class="text-sm font-semibold">出力スタイル</h3>
      <p class="text-cork-muted text-xs">
        claude の output style の本文（markdown。`~/.claude/output-styles/*.md` の中身を貼る。frontmatter の name は center が差し替え、他の key は残る）。session の値があれば共通の値は使わない。空なら claude の既定
      </p>
      <UTextarea
        v-model="draft.outputStyle"
        :rows="rows ?? 8"
        autoresize
        :maxrows="18"
        class="w-full font-mono text-xs"
        :data-testid="`${idPrefix}-output-style`"
      />
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-output-style-note`">{{ INSTRUCTIONS_NOTE }}</p>
    </section>
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-servers`">
      <h3 class="text-sm font-semibold">使う server</h3>
      <p class="text-cork-muted text-xs">
        master-cap が remote-cap を送る server の範囲。オフなら全部の server（session の設定が無ければ全 session 共通の設定に従う）。オンで 1 つも選ばないと、どの server も使わない
      </p>
      <UCheckbox
        :model-value="limited"
        label="使う server を選ぶ"
        :data-testid="`${idPrefix}-servers-limit`"
        @update:model-value="setLimited(!!$event)"
      />
      <template v-if="limited">
        <div v-for="c in choices" :key="c.value" class="pl-6" :data-testid="`${idPrefix}-server-option`" :data-server="c.value">
          <UCheckbox :model-value="isChosen(c)" :label="c.label" @update:model-value="toggleChoice(c, !!$event)" />
        </div>
        <div v-for="e in otherServers" :key="e" class="flex items-center gap-2 pl-6 text-xs" :data-testid="`${idPrefix}-server-other`" :data-server="e">
          <span class="font-mono">{{ e }}</span>
          <span class="text-cork-muted">（今は見つかっていない）</span>
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="`${e} を外す`" :data-testid="`${idPrefix}-server-remove`" @click="removeServer(e)" />
        </div>
        <p v-if="choicesError" class="text-cork-muted pl-6 text-xs" :data-testid="`${idPrefix}-servers-error`">server の一覧を取れない（host 名か server_id を入力して追加できる）: {{ choicesError }}</p>
        <div class="flex gap-2 pl-6">
          <UInput v-model="serverInput" class="flex-1" size="xs" placeholder="host 名か server_id" :data-testid="`${idPrefix}-server-input`" @keydown.enter.prevent="addServer" />
          <UButton size="xs" label="追加" color="neutral" variant="outline" :data-testid="`${idPrefix}-server-add`" @click="addServer" />
        </div>
        <p v-if="(draft.servers ?? []).length === 0" class="text-cork-danger-text pl-6 text-xs" :data-testid="`${idPrefix}-servers-none`">1 つも選んでいない: この範囲ではどの server も使わない</p>
      </template>
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-servers-note`">保存すると次の呼び出しからすぐ効く（起動し直し不要）。host 名は同じ host の server すべてに効く</p>
    </section>
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-memory`">
      <h3 class="text-sm font-semibold">外部記憶</h3>
      <p class="text-cork-muted text-xs">
        外部記憶（memory）の MCP endpoint。設定すると master-cap の起動時に MCP として足され、記憶の問い合わせ（context / recall）ができる。session の値があれば共通の値は使わない。URL が空なら使わない。URL に秘密や ${…} は書かない（query の秘密は ps と log に出る。${…} は claude が展開して memory の host へ送る）。秘密は token 欄に入れる。agent ID が空なら session 名を使うので、session を改名すると変わる（固定するなら agent ID を入れる）
      </p>
      <UInput
        :model-value="draft.memory.url"
        class="w-full"
        size="sm"
        placeholder="http://host:port/mcp"
        autocomplete="off"
        :data-testid="`${idPrefix}-memory-url`"
        @update:model-value="setMemory({ url: String($event ?? '') })"
      />
      <UInput
        :model-value="draft.memory.token"
        type="password"
        class="w-full"
        size="sm"
        autocomplete="new-password"
        :placeholder="draft.memory.tokenSet ? '設定済み（変えるときだけ入力）' : 'token（Bearer。無ければ空）'"
        :data-testid="`${idPrefix}-memory-token`"
        @update:model-value="setMemory({ token: String($event ?? '') })"
      />
      <p v-if="draft.memory.tokenSet" class="text-cork-muted text-xs" :data-testid="`${idPrefix}-memory-token-set`">token は設定済み（値は表示しない。空のまま保存すると今の token のまま）</p>
      <UCheckbox
        v-if="draft.memory.tokenSet"
        :model-value="draft.memory.tokenClear"
        label="保存済みの token を消す"
        :data-testid="`${idPrefix}-memory-token-clear`"
        @update:model-value="setMemory({ tokenClear: !!$event })"
      />
      <UInput
        :model-value="draft.memory.agentId"
        class="w-full"
        size="sm"
        placeholder="agent ID（空なら session 名）"
        autocomplete="off"
        :data-testid="`${idPrefix}-memory-agent-id`"
        @update:model-value="setMemory({ agentId: String($event ?? '') })"
      />
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-memory-note`">{{ INSTRUCTIONS_NOTE }}</p>
    </section>
  </div>
</template>
