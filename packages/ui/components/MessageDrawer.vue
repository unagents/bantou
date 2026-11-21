<script setup lang="ts">
import { DRAWER_HANDLE as HANDLE, DRAWER_WIDTH, type DrawerMessage } from "../composables/useMessageDrawer";

/**
 * Right-edge drawer: grab the strip on the right edge and pull it left to open, push it back to close
 * (a click on the strip or the close button toggles too). It lists the sessions' last messages in arrival order.
 */
const props = withDefaults(
  defineProps<{
    messages: DrawerMessage[];
    /** Where the panel starts from the top (CSS length): below the app's header. */
    top?: string;
  }>(),
  { top: "var(--cork-header-height, 0px)" },
);
const emit = defineEmits<{ select: [session: string] }>();

/** Moves shorter than this (px) count as a click on the strip. */
const CLICK_SLOP = 3;

const open = ref(false);
/** How many px of the panel are out (0 .. DRAWER_WIDTH). Follows the pointer while dragging. */
const visible = ref(0);
const dragging = ref(false);
let startX = 0;
let startVisible = 0;
let moved = false;

function settle(isOpen: boolean) {
  open.value = isOpen;
  visible.value = isOpen ? DRAWER_WIDTH : 0;
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
  moved = false;
  startX = e.clientX;
  startVisible = visible.value;
}
function onMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dx = startX - e.clientX; // pulling left is positive
  if (Math.abs(dx) > CLICK_SLOP) moved = true;
  visible.value = Math.min(DRAWER_WIDTH, Math.max(0, startVisible + dx));
}
function onUp() {
  if (!dragging.value) return;
  dragging.value = false;
  settle(moved ? visible.value > DRAWER_WIDTH / 2 : !open.value);
}

const list = ref<HTMLElement | null>(null);
// New messages stack at the bottom; keep the newest in view. (The newest seq, not the length: the length stops growing at the cap.)
watch(
  () => props.messages.at(-1)?.seq,
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
    class="border-cork-border fixed right-0 z-30 flex bg-default shadow-lg"
    :class="dragging ? '' : 'transition-transform duration-150'"
    :style="{
      top,
      bottom: '0',
      width: `${DRAWER_WIDTH + HANDLE}px`,
      transform: `translateX(${DRAWER_WIDTH - visible}px)`,
    }"
    aria-label="最終メッセージ"
    data-testid="message-drawer"
    :data-open="open ? 'true' : 'false'"
    :data-visible="Math.round(visible)"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="最終メッセージの引き出し"
      class="bg-cork-elevated hover:bg-cork-border flex shrink-0 cursor-ew-resize touch-none items-center justify-center"
      :style="{ width: `${HANDLE}px` }"
      data-testid="message-drawer-handle"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <UIcon name="i-lucide-grip-vertical" class="text-cork-muted size-3" aria-hidden="true" />
    </div>
    <div class="border-cork-border flex min-w-0 flex-1 flex-col border-l">
      <div class="border-cork-border flex items-center justify-between border-b px-3 py-1.5 text-sm font-semibold">
        <span>最終メッセージ</span>
        <UButton
          variant="ghost"
          color="neutral"
          size="xs"
          icon="i-lucide-x"
          aria-label="閉じる"
          data-testid="message-drawer-close"
          @click="settle(false)"
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
