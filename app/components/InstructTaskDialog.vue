<script setup lang="ts">
const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ session: string }>();
const emit = defineEmits<{ submit: [session: string, title: string, body: string] }>();

const title = ref("");
const body = ref("");

function submit() {
  if (!title.value.trim()) return;
  emit("submit", props.session, title.value.trim(), body.value.trim());
  title.value = "";
  body.value = "";
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :title="`${session} にタスク追加を指示`">
    <template #body>
      <div class="flex flex-col gap-3">
        <UFormField label="タスク名" required><UInput v-model="title" class="w-full" autofocus /></UFormField>
        <UFormField label="作業内容">
          <UTextarea v-model="body" :rows="5" autoresize class="w-full" placeholder="何をやるか" />
        </UFormField>
        <UButton label="指示を送信" class="self-end" :disabled="!title.trim()" @click="submit" />
      </div>
    </template>
  </UModal>
</template>
