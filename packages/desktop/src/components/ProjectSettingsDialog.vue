<script setup lang="ts">
import { getSessionSettings, updateSessionSettings } from "~/api";
import { draftError, draftOf, emptyDraft, toUpdate, type SettingsDraft } from "~/composables/sessionInstructions";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ name: string; path?: string | null }>();

const draft = ref<SettingsDraft>(emptyDraft());
const saved = ref<SettingsDraft>(emptyDraft());
const loaded = ref(false);
const busy = ref(false);
const actionError = ref<string | null>(null);

watch(
  open,
  async (v) => {
    if (!v) return;
    loaded.value = false;
    actionError.value = null;
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

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value));
const problem = computed(() => draftError(draft.value));

async function save() {
  busy.value = true;
  actionError.value = null;
  try {
    await updateSessionSettings(props.name, toUpdate(draft.value));
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
        <UFormField label="フォルダ" help="作成時に決まる（変更できない）。center のホスト上のパス">
          <UInput :model-value="path ?? '（center が返していない）'" class="w-full" readonly data-testid="settings-path" />
        </UFormField>
        <ProjectSettingsFields v-model="draft" id-prefix="settings" />
        <p v-if="problem" class="text-cork-danger-text text-xs" data-testid="settings-problem">{{ problem }}</p>
        <UButton
          class="self-end"
          label="保存"
          :loading="busy"
          :disabled="!loaded || !dirty || !!problem"
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
