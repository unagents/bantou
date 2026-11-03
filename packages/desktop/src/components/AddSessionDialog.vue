<script setup lang="ts">
import { createSession } from "~/api";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ existing: string[] }>();
const emit = defineEmits<{ done: [name: string] }>();

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const name = ref("");
const busy = ref(false);
const actionError = ref<string | null>(null);

const trimmed = computed(() => name.value.trim());
const nameError = computed(() => {
  if (!trimmed.value) return null;
  if (!NAME_PATTERN.test(trimmed.value)) return "英数字と _ - のみ";
  if (props.existing.includes(trimmed.value)) return "既に使われている名前";
  return null;
});

async function create() {
  if (!trimmed.value || nameError.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    await createSession(trimmed.value);
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
        <UButton
          class="self-end"
          label="作成"
          :loading="busy"
          :disabled="!trimmed || !!nameError"
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
