<script setup lang="ts">
import { getSessionInstructions, setSessionInstructions } from "~/api";
import { INSTRUCTIONS_NOTE } from "~/composables/sessionInstructions";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ name: string }>();

const text = ref("");
const saved = ref("");
const busy = ref(false);
const actionError = ref<string | null>(null);

watch(
  open,
  async (v) => {
    if (!v) return;
    actionError.value = null;
    try {
      saved.value = await getSessionInstructions(props.name);
    } catch (e) {
      saved.value = "";
      actionError.value = String(e);
    }
    text.value = saved.value;
  },
  { immediate: true },
);

const dirty = computed(() => text.value !== saved.value);

async function save() {
  busy.value = true;
  actionError.value = null;
  try {
    await setSessionInstructions(props.name, text.value);
    open.value = false;
  } catch (e) {
    actionError.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`${name} の追加指示`" description="master-cap の system prompt に追記する文（--append-system-prompt）" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-3" data-testid="instructions-dialog">
        <UTextarea v-model="text" :rows="8" autoresize :maxrows="18" class="w-full" data-testid="instructions-text" />
        <p class="text-cork-muted text-xs" data-testid="instructions-note">{{ INSTRUCTIONS_NOTE }}</p>
        <UButton class="self-end" label="保存" :loading="busy" :disabled="!dirty" data-testid="instructions-save" @click="save" />
        <p v-if="actionError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="instructions-error">
          {{ actionError }}
        </p>
      </div>
    </template>
  </UModal>
</template>
