<script setup lang="ts">
import type { Task, Thread } from "~/types";

const props = defineProps<{
  task: Task;
  thread?: Thread;
  kind: "working" | "queued" | "done";
  /** The task's ping timer has time left. */
  running?: boolean;
}>();
defineEmits<{ openThread: [task: Task] }>();
const spinning = computed(() => props.kind === "working" && !!props.running);
</script>

<template>
  <li
    class="hover:bg-cork-elevated/50 flex items-center gap-2 py-2 pr-3 pl-9 text-sm"
    :class="{ 'opacity-60': kind !== 'working' }"
    :data-task-id="task.id"
    :data-running="spinning"
  >
    <UIcon
      :name="kind === 'working' ? 'i-lucide-loader' : kind === 'queued' ? 'i-lucide-clock' : 'i-lucide-check'"
      class="text-cork-muted size-4 shrink-0"
      :class="{ 'animate-spin': spinning }"
      data-testid="task-icon"
    />
    <span class="min-w-0 flex-1 truncate">{{ task.title }}</span>
    <span class="text-cork-muted w-24 shrink-0 text-xs">{{ task.status }}</span>
    <span class="flex w-7 shrink-0 justify-end">
    <UButton
      v-if="thread?.status === 'waiting'"
      size="xs"
      color="warning"
      variant="soft"
      icon="i-lucide-message-circle-question"
      aria-label="返答待ち"
      class="animate-pulse"
      @click="$emit('openThread', task)"
    />
    <UButton
      v-else-if="thread"
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-lucide-messages-square"
      aria-label="やり取り履歴"
      @click="$emit('openThread', task)"
    />
    </span>
  </li>
</template>
