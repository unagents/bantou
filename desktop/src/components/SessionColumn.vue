<script setup lang="ts">
import type { SessionGroup } from "~/composables/useBoard";
import type { Task, Thread } from "~/types";

defineProps<{ group: SessionGroup; threads: Record<string, Thread>; running: Record<string, boolean> }>();
defineEmits<{ openThread: [task: Task]; instruct: [session: string] }>();
const showDone = ref(false);
</script>

<template>
  <section :aria-label="group.name" class="border-cork-border flex flex-col border-x border-t last:border-b">
    <h2 class="font-display bg-cork-elevated border-cork-border flex items-center gap-2 border-b px-3 py-2 font-semibold">
      <UIcon name="i-lucide-terminal-square" class="text-cork-accent size-4" />
      <span class="truncate">{{ group.name }}</span>
      <UTooltip v-if="group.unreachable" :text="group.reason ?? 'center に問い合わせられなかった'">
        <UBadge color="warning" variant="subtle" label="つながらない" data-testid="session-unreachable" />
      </UTooltip>
      <span class="text-cork-muted ml-auto text-xs font-normal">
        {{ group.working.length }} / {{ group.queued.length }}
      </span>
      <UTooltip text="タスク追加を指示">
        <UButton
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-circle-plus"
          :aria-label="`${group.name} にタスク追加を指示`"
          @click="$emit('instruct', group.name)"
        />
      </UTooltip>
    </h2>
    <ul class="divide-cork-border flex flex-col divide-y">
      <TaskRow
        v-for="t in group.working"
        :key="t.path"
        :task="t"
        :thread="threads[t.id]"
        :running="running[t.id]"
        kind="working"
        @open-thread="$emit('openThread', $event)"
      />
      <TaskRow
        v-for="t in group.queued"
        :key="t.path"
        :task="t"
        :thread="threads[t.id]"
        :running="running[t.id]"
        kind="queued"
        @open-thread="$emit('openThread', $event)"
      />
    </ul>
    <p
      v-if="!group.working.length && !group.queued.length"
      class="text-cork-muted border-cork-border border-b py-2 pl-9 text-xs"
    >
      進行中・待機中のタスクなし
    </p>
    <button
      v-if="group.done.length"
      class="text-cork-muted border-cork-border border-t py-1.5 pl-9 text-left text-xs hover:underline"
      @click="showDone = !showDone"
    >
      完了 {{ group.done.length }} 件 {{ showDone ? "▲" : "▼" }}
    </button>
    <ul v-if="showDone" class="flex flex-col gap-1.5 pl-4">
      <TaskRow
        v-for="t in group.done"
        :key="t.path"
        :task="t"
        :thread="threads[t.id]"
        :running="running[t.id]"
        kind="done"
        @open-thread="$emit('openThread', $event)"
      />
    </ul>
  </section>
</template>
