<script setup lang="ts">
import type { DrawerMessage } from "../composables/useMessageDrawer";

/**
 * Right-edge drawer: a column beside the main screen (not over it). The strip on its left edge opens / closes it with a click.
 * Opened, it takes room from the main screen, which narrows and re-wraps. Its width is fixed per viewport size (two steps, see the
 * template classes); there is no resizing. It lists the sessions' final messages (the replies to the user) in arrival order.
 */
const props = defineProps<{ messages: DrawerMessage[] }>();
const emit = defineEmits<{ select: [session: string] }>();

const open = defineModel<boolean>("open", { default: false });

const list = ref<HTMLElement | null>(null);
// New messages stack at the bottom; keep the newest in view. (The newest seq, not the length: the length stops growing at the cap.)
watch(
  () => [props.messages.at(-1)?.seq, open.value],
  async () => {
    await nextTick();
    if (list.value) list.value.scrollTop = list.value.scrollHeight;
  },
);

const timeText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
};
</script>

<template>
  <aside
    class="border-cork-border flex h-full min-h-0 shrink-0 border-l bg-default"
    aria-label="最終メッセージ"
    data-testid="message-drawer"
    :data-open="open ? 'true' : 'false'"
  >
    <button
      type="button"
      class="bg-cork-elevated hover:bg-cork-border flex w-3.5 shrink-0 cursor-pointer items-center justify-center"
      :aria-label="open ? '最終メッセージを閉じる' : '最終メッセージを開く'"
      :aria-expanded="open"
      data-testid="message-drawer-handle"
      @click="open = !open"
    >
      <UIcon :name="open ? 'i-lucide-chevron-right' : 'i-lucide-chevron-left'" class="text-cork-muted size-3" aria-hidden="true" />
    </button>
    <!-- two widths by viewport: 18rem, and 24rem from 1500px up -->
    <div v-show="open" class="border-cork-border flex w-72 min-w-0 flex-col border-l min-[1500px]:w-96" data-testid="message-drawer-panel">
      <div class="border-cork-border flex items-center justify-between border-b px-3 py-1.5 text-sm font-semibold">
        <span>最終メッセージ</span>
        <UButton
          variant="ghost"
          color="neutral"
          size="xs"
          icon="i-lucide-x"
          aria-label="閉じる"
          data-testid="message-drawer-close"
          @click="open = false"
        />
      </div>
      <ul ref="list" class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="message-drawer-list">
        <li v-if="!messages.length" class="text-cork-muted p-3 text-xs">まだ無い</li>
        <li v-for="m in messages" :key="m.seq" class="border-cork-border border-b">
          <button
            type="button"
            class="hover:bg-cork-elevated block w-full px-3 py-2 text-left"
            data-testid="message-drawer-item"
            :data-session="m.session"
            @click="emit('select', m.session)"
          >
            <div class="text-cork-muted flex items-baseline justify-between gap-2 text-xs">
              <span class="truncate font-semibold" data-testid="message-drawer-session">{{ m.session }}</span>
              <time :datetime="m.at" data-testid="message-drawer-time">{{ timeText(m.at) }}</time>
            </div>
            <p class="mt-0.5 line-clamp-6 whitespace-pre-wrap break-words text-sm" data-testid="message-drawer-text">{{ m.text }}</p>
          </button>
        </li>
      </ul>
    </div>
  </aside>
</template>
