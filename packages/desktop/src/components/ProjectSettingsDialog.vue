<script setup lang="ts">
import { getSessionSettings, sessionPathHints, updateSession, updateSessionSettings } from "~/api";
import { draftError, draftOf, emptyDraft, toUpdate, type SettingsDraft } from "~/composables/sessionInstructions";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ name: string; path?: string | null; existing?: string[] }>();
const emit = defineEmits<{ renamed: [from: string, to: string]; updated: [] }>();

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const draft = ref<SettingsDraft>(emptyDraft());
const saved = ref<SettingsDraft>(emptyDraft());
const loaded = ref(false);
const busy = ref(false);
const actionError = ref<string | null>(null);
/** This PC's folder dialog applies to the folder rows (own sidecar center on macOS / Windows). */
const canPick = ref(false);
const nameInput = ref("");
const pathInput = ref("");
const moveDir = ref(true);

watch(
  open,
  async (v) => {
    if (!v) return;
    loaded.value = false;
    actionError.value = null;
    nameInput.value = props.name;
    pathInput.value = props.path ?? "";
    moveDir.value = true;
    sessionPathHints().then((h) => (canPick.value = h.canPick)).catch(() => (canPick.value = false));
    try {
      saved.value = draftOf(await getSessionSettings(props.name));
      loaded.value = true;
    } catch (e) {
      saved.value = emptyDraft();
      actionError.value = String(e);
    }
    draft.value = { ...saved.value };
  },
  { immediate: true },
);

const settingsDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value));
const newName = computed(() => nameInput.value.trim());
const newPath = computed(() => pathInput.value.trim());
const nameChanged = computed(() => newName.value !== props.name);
const pathChanged = computed(() => !!newPath.value && newPath.value !== (props.path ?? ""));
const dirty = computed(() => settingsDirty.value || nameChanged.value || pathChanged.value);
const nameError = computed(() => {
  if (!newName.value) return "名前を入れる";
  if (!NAME_PATTERN.test(newName.value)) return "英数字と _ - のみ";
  if (nameChanged.value && props.existing?.includes(newName.value)) return "既に使われている名前";
  return null;
});
const problem = computed(() => draftError(draft.value));

async function save() {
  busy.value = true;
  actionError.value = null;
  try {
    if (settingsDirty.value) await updateSessionSettings(props.name, toUpdate(draft.value));
    if (nameChanged.value || pathChanged.value) {
      await updateSession(props.name, {
        newName: nameChanged.value ? newName.value : undefined,
        path: pathChanged.value ? newPath.value : undefined,
        move: pathChanged.value ? moveDir.value : undefined,
      });
      if (nameChanged.value) emit("renamed", props.name, newName.value);
      emit("updated");
    }
    open.value = false;
  } catch (e) {
    actionError.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`${name} の設定`" description="このプロジェクト（session）の設定。center に保存される" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-3" data-testid="settings-dialog">
        <UFormField label="名前" :error="nameError ?? undefined" help="英数字と _ - のみ。center の一覧にある他の名前とは重複できない">
          <UInput v-model="nameInput" class="w-full" data-testid="settings-name" />
        </UFormField>
        <UFormField
          label="フォルダ"
          :help="
            canPick
              ? 'クリックでフォルダ選択ダイアログを開く。保存すると session をすぐ再起動する'
              : 'center のホスト上の絶対パス（この PC のパスではない）。無ければ作られる。保存すると session をすぐ再起動する'
          "
        >
          <PathField v-model="pathInput" :can-pick="canPick" placeholder="（center が返していない）" testid="settings-path" @error="actionError = $event" />
        </UFormField>
        <p v-if="pathChanged" class="text-cork-muted text-xs" data-testid="settings-path-note">
          フォルダを変えると以前の会話は引き継がれず新しい会話で始まる（移動チェックの有無に関わらず。claude の --continue が効かない）。名前だけの変更なら会話は続く
        </p>
        <UCheckbox
          v-if="pathChanged"
          v-model="moveDir"
          label="今のフォルダを新しい場所へ移動する"
          description="OFF なら新しいフォルダを作るだけ（中身は移らない）。移動してもしなくても、以前の会話は引き継がれず新しい会話で始まる"
          data-testid="settings-path-move"
        />
        <ProjectSettingsFields v-model="draft" id-prefix="settings" :can-pick="canPick" @error="actionError = $event" />
        <p v-if="problem" class="text-cork-danger-text text-xs" data-testid="settings-problem">{{ problem }}</p>
        <UButton
          class="self-end"
          label="保存"
          :loading="busy"
          :disabled="!loaded || !dirty || !!problem || !!nameError"
          data-testid="settings-save"
          @click="save"
        />
        <p v-if="actionError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="settings-error">
          {{ actionError }}
        </p>
      </div>
    </template>
  </UModal>
</template>
