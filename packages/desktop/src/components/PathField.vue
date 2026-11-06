<script setup lang="ts">
import { pickDirectory } from "~/api";

// One folder path. canPick (this PC's folder dialog applies): the field is read-only and a click (or the
// 選択… button) opens the dialog; a cancel keeps the value. Otherwise it is a plain text input.
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

async function pick() {
  try {
    const p = await pickDirectory();
    if (p) model.value = p;
  } catch (e) {
    emit("error", String(e));
  }
}
</script>

<template>
  <div class="flex w-full gap-2">
    <UInput
      v-model="model"
      :class="['w-full', props.mono ? 'font-mono' : '', props.canPick ? 'cursor-pointer' : '']"
      :placeholder="placeholder"
      :readonly="props.canPick"
      :data-testid="testid"
      @click="props.canPick && pick()"
      @keydown.enter="props.canPick ? pick() : emit('enter')"
    />
    <UButton
      v-if="props.canPick"
      label="選択…"
      color="neutral"
      variant="outline"
      :data-testid="pickTestid ?? `${testid}-pick`"
      @click="pick"
    />
  </div>
</template>
