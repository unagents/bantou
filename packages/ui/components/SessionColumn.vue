<script setup lang="ts">
import type { SessionGroup } from "../composables/useBoard";
import type { Task, Thread } from "../types";

defineProps<{ group: SessionGroup; threads: Record<string, Thread>; running: Record<string, boolean> }>();
defineEmits<{ openThread: [task: Task] }>();
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
      <UTooltip v-if="group.instructions" text="追加指示つきで起動した">
        <UIcon name="i-lucide-scroll-text" class="text-cork-muted size-3.5 shrink-0" data-testid="session-instructions-mark" data-scope="header" />
      </UTooltip>
      <ContextUsage :usage="group.contextUsage" class="ml-auto" data-scope="header" />
      <span class="text-cork-muted text-xs font-normal" :class="group.contextUsage ? '' : 'ml-auto'">
        {{ group.working.length }} / {{ group.queued.length }}
      </span>
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
