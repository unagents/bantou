<script setup lang="ts">
import { createSession, sessionPathHints } from "../api";
import { useHideAddDirs } from "../composables/centerRole";
import { draftError, emptyDraft, toCreate } from "../composables/sessionInstructions";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ existing: string[] }>();
const emit = defineEmits<{ done: [name: string] }>();

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const name = ref("");
const folder = ref("");
const workspace = ref<string | null>(null);
const canPick = ref(false);
const draft = ref(emptyDraft());
/** Reference folders are left out when this desktop runs no sidecar (they are paths on another host). */
const { hideAddDirs, refresh: refreshHideAddDirs } = useHideAddDirs();
const problem = computed(() => draftError(draft.value));
const busy = ref(false);
const actionError = ref<string | null>(null);

const trimmed = computed(() => name.value.trim());
const nameError = computed(() => {
  if (!trimmed.value) return null;
  if (!NAME_PATTERN.test(trimmed.value)) return "英数字と _ - のみ";
  // While our own create runs, the center already lists the name (it lists, then starts): that is not a clash.
  if (!busy.value && props.existing.includes(trimmed.value)) return "既に使われている名前";
  return null;
});

/** The center's default folder shown while the field is empty (follows the name). */
const folderPlaceholder = computed(() => {
  if (!workspace.value) return "空ならセンターが決める（<workspace>/<名前>）";
  const sep = workspace.value.includes("\\") ? "\\" : "/";
  return `${workspace.value.replace(/[\\/]+$/, "")}${sep}${NAME_PATTERN.test(trimmed.value) ? trimmed.value : "<名前>"}`;
});

onMounted(async () => {
  void refreshHideAddDirs();
  try {
    const h = await sessionPathHints();
    workspace.value = h.workspace;
    canPick.value = h.canPick;
  } catch {
    // the hints only help; the field works without them
  }
});

async function create() {
  if (busy.value || !trimmed.value || nameError.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    await createSession(trimmed.value, toCreate(draft.value), folder.value);
    emit("done", trimmed.value);
    open.value = false;
  } catch (e) {
    actionError.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="セッション追加" description="名前を付けて center に新しく作る" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="add-dialog">
        <UFormField label="新しく作る" :error="nameError ?? undefined" help="英数字と _ - のみ。center の一覧にある名前とは重複できない">
          <UInput v-model="name" class="w-full" placeholder="セッション名" data-testid="add-name" @keydown.enter="create" />
        </UFormField>
        <UFormField
          label="フォルダ"
          :help="
            canPick
              ? 'クリックでフォルダ選択ダイアログを開く。選ばなければ既定の場所に作る。無ければ作られる'
              : 'center のホスト上の絶対パス（この PC のパスではない）。空なら center の既定の場所に作る。無ければ作られる'
          "
        >
          <PathField v-model="folder" :can-pick="canPick" :placeholder="folderPlaceholder" testid="add-folder" @enter="create" @error="actionError = $event" />
        </UFormField>
        <ProjectSettingsFields v-model="draft" id-prefix="add" :rows="4" :can-pick="canPick" :hide-add-dirs="hideAddDirs" @error="actionError = $event" />
        <p v-if="problem" class="text-cork-danger-text text-xs" data-testid="add-problem">{{ problem }}</p>
        <UButton
          class="self-end"
          label="作成"
          :loading="busy"
          :disabled="!trimmed || !!nameError || !!problem"
          data-testid="add-create"
          @click="create"
        />
        <p v-if="actionError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="add-action-error">
          {{ actionError }}
        </p>
      </div>
    </template>
  </UModal>
</template>
