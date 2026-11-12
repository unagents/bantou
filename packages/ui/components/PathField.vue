<script setup lang="ts">
import { pickDirectory } from "~/api";

// One folder path. canPick (this PC's folder dialog applies): the field is read-only and a click / Enter / Space
// (or the 選択… button) opens the dialog; a cancel keeps the value. Otherwise it is a plain text input.
// When the dialog itself fails (e.g. no dialog on this OS) the field falls back to a text input (value kept).
const model = defineModel<string>({ required: true });
const props = defineProps<{
  canPick?: boolean;
  placeholder?: string;
  /** testid of the field itself; the button gets `<testid>-pick` unless pickTestid is given. */
  testid: string;
  pickTestid?: string;
  mono?: boolean;
}>();
const emit = defineEmits<{ error: [message: string]; enter: [] }>();

const failed = ref(false);
const dialog = computed(() => !!props.canPick && !failed.value);
const busy = ref(false);

async function pick() {
  if (busy.value) return;
  busy.value = true;
  try {
    const p = await pickDirectory();
    if (p) model.value = p;
  } catch (e) {
    failed.value = true;
    emit("error", String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex w-full gap-2">
    <UInput
      v-model="model"
      :class="['w-full', props.mono ? 'font-mono' : '', dialog ? 'cursor-pointer' : '']"
      :placeholder="placeholder"
      :readonly="dialog"
      :aria-haspopup="dialog ? 'dialog' : undefined"
      :data-testid="testid"
      @click="dialog && pick()"
      @keydown.space="dialog && ($event.preventDefault(), pick())"
      @keydown.enter="dialog ? pick() : emit('enter')"
    />
    <UButton
      v-if="dialog"
      aria-haspopup="dialog"
      label="選択…"
      color="neutral"
      variant="outline"
      :data-testid="pickTestid ?? `${testid}-pick`"
      @click="pick"
    />
  </div>
</template>
