<script setup lang="ts">
const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ statuses: string[]; sessions: string[] }>();
const emit = defineEmits<{ create: [title: string, status: string, tags: string[]] }>();

const title = ref("");
const status = ref(props.statuses[0] ?? "Todo");
const session = ref("");

function submit() {
  if (!title.value.trim()) return;
  emit("create", title.value.trim(), status.value, session.value.trim() ? [session.value.trim()] : []);
  title.value = "";
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" title="新しいタスク">
    <template #body>
      <div class="flex flex-col gap-3">
        <UFormField label="タイトル"><UInput v-model="title" class="w-full" autofocus /></UFormField>
        <UFormField label="セッション（tags）">
          <UInputMenu v-model="session" :items="sessions" create-item class="w-full" @create="session = $event" />
        </UFormField>
        <UFormField label="ステータス"><USelect v-model="status" :items="statuses" class="w-full" /></UFormField>
        <UButton label="作成" class="self-end" :disabled="!title.trim()" @click="submit" />
      </div>
    </template>
  </UModal>
</template>
