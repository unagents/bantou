<script setup lang="ts">
/**
 * Vertical divider between two panes. Drag (pointer events + pointer capture), arrow keys, Home / End, and a
 * double click (reset) change the width of the pane that is `side` of it.
 * `modelValue` is that pane's width in px; the parent clamps (`min` / `max` here are for the aria values and the keys).
 */
const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    /** Which pane the divider resizes: "before" = the pane on its left (dragging right widens it), "after" = on its right. */
    resizes?: "before" | "after";
    label: string;
  }>(),
  { resizes: "before" },
);
const emit = defineEmits<{
  "update:modelValue": [width: number];
  /** A drag or key press has finished: the width is final (save it). */
  commit: [];
  reset: [];
}>();

const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

const el = ref<HTMLElement | null>(null);
const dragging = ref(false);
let startX = 0;
let startWidth = 0;
let pointerId = -1;

const sign = () => (props.resizes === "before" ? 1 : -1);

function onPointerDown(ev: PointerEvent) {
  if (ev.button !== 0 || dragging.value || !el.value) return;
  // No text selection / native drag from here on; the capture keeps the moves coming over xterm, iframes and outside the window.
  ev.preventDefault();
  el.value.focus({ preventScroll: true });
  el.value.setPointerCapture(ev.pointerId);
  pointerId = ev.pointerId;
  startX = ev.clientX;
  startWidth = props.modelValue;
  dragging.value = true;
  document.documentElement.classList.add("pane-resizing");
}

function onPointerMove(ev: PointerEvent) {
  if (!dragging.value || ev.pointerId !== pointerId) return;
  emit("update:modelValue", startWidth + (ev.clientX - startX) * sign());
}

function end(ev?: PointerEvent) {
  if (!dragging.value || (ev && ev.pointerId !== pointerId)) return;
  dragging.value = false;
  document.documentElement.classList.remove("pane-resizing");
  if (el.value?.hasPointerCapture(pointerId)) el.value.releasePointerCapture(pointerId);
  emit("commit");
}

function onKeyDown(ev: KeyboardEvent) {
  const step = ev.shiftKey ? KEY_STEP_BIG : KEY_STEP;
  let next: number | null = null;
  if (ev.key === "ArrowLeft") next = props.modelValue - step * sign();
  else if (ev.key === "ArrowRight") next = props.modelValue + step * sign();
  else if (ev.key === "Home") next = props.min;
  else if (ev.key === "End") next = props.max;
  else if (ev.key === "Enter") {
    ev.preventDefault();
    emit("reset");
    emit("commit");
    return;
  }
  if (next === null) return;
  ev.preventDefault();
  emit("update:modelValue", next);
  emit("commit");
}

function onDoubleClick() {
  emit("reset");
  emit("commit");
}

onBeforeUnmount(() => {
  if (dragging.value) document.documentElement.classList.remove("pane-resizing");
});
</script>

<template>
  <div
    ref="el"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="label"
    :aria-valuenow="Math.round(modelValue)"
    :aria-valuemin="min"
    :aria-valuemax="Math.round(max)"
    :data-dragging="dragging ? 'true' : undefined"
    data-testid="pane-resizer"
    title="ドラッグで幅を変える（ダブルクリックで既定に戻す）"
    class="pane-resizer group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none select-none"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="end"
    @pointercancel="end"
    @lostpointercapture="end"
    @keydown="onKeyDown"
    @dblclick="onDoubleClick"
  >
    <!-- the visible line: 1px at rest, accent and 3px on hover / focus / drag -->
    <span
      class="bg-cork-border group-hover:bg-cork-accent group-focus-visible:bg-cork-accent absolute inset-y-0 left-1/2 -translate-x-1/2 transition-colors"
      :class="dragging ? 'bg-cork-accent w-[3px]' : 'w-px group-hover:w-[3px] group-focus-visible:w-[3px]'"
    />
  </div>
</template>

<style>
/* While dragging: keep the col-resize cursor everywhere and block text selection (the divider itself holds the pointer). */
html.pane-resizing,
html.pane-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
</style>
