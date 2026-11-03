<script setup lang="ts">
import { INSTRUCTIONS_NOTE, type SettingsDraft } from "~/composables/sessionInstructions";

// One section per project-settings item. A future item (skills, output style) is another section here.
const draft = defineModel<SettingsDraft>({ required: true });
defineProps<{ idPrefix: string; rows?: number }>();
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
  </div>
</template>
