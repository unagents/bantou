<script setup lang="ts">
import { pickDirectory } from "~/api";
import { INSTRUCTIONS_NOTE, type SettingsDraft } from "~/composables/sessionInstructions";

// One section per project-settings item. A future item (skills, output style) is another section here.
const draft = defineModel<SettingsDraft>({ required: true });
const props = defineProps<{
  idPrefix: string;
  rows?: number;
  /** This PC's folder dialog applies to the folder rows (the center runs here). Otherwise the rows are typed. */
  canPick?: boolean;
}>();
const emit = defineEmits<{ error: [message: string] }>();

function addDir(path = "") {
  draft.value = { ...draft.value, addDirs: [...draft.value.addDirs, path] };
}
function setDir(i: number, v: string) {
  const addDirs = [...draft.value.addDirs];
  addDirs[i] = v;
  draft.value = { ...draft.value, addDirs };
}
function removeDir(i: number) {
  draft.value = { ...draft.value, addDirs: draft.value.addDirs.filter((_, k) => k !== i) };
}
async function pickDir() {
  try {
    const p = await pickDirectory();
    if (p) addDir(p);
  } catch (e) {
    emit("error", String(e));
  }
}
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
    <section class="flex flex-col gap-1" :data-testid="`${idPrefix}-section-add-dirs`">
      <h3 class="text-sm font-semibold">参照フォルダ</h3>
      <p class="text-cork-muted text-xs">
        master-cap が自分のフォルダ以外に読み書きしてよいフォルダ（--add-dir。1 行 1 つ、center のホスト上の絶対パス）。空なら付けない
      </p>
      <div v-for="(d, i) in draft.addDirs" :key="i" class="flex gap-2" :data-testid="`${idPrefix}-add-dir-row`">
        <UInput
          :model-value="d"
          class="w-full font-mono"
          placeholder="/path/to/folder"
          :data-testid="`${idPrefix}-add-dir`"
          @update:model-value="setDir(i, String($event))"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          :aria-label="`参照フォルダ ${i + 1} を外す`"
          :data-testid="`${idPrefix}-add-dir-remove`"
          @click="removeDir(i)"
        />
      </div>
      <div class="flex gap-2">
        <UButton v-if="props.canPick" size="xs" label="フォルダを選択…" color="neutral" variant="outline" :data-testid="`${idPrefix}-add-dir-pick`" @click="pickDir" />
        <UButton size="xs" label="パスを入力して追加" color="neutral" variant="outline" :data-testid="`${idPrefix}-add-dir-add`" @click="addDir()" />
      </div>
      <p class="text-cork-muted text-xs" :data-testid="`${idPrefix}-add-dirs-note`">{{ INSTRUCTIONS_NOTE }}</p>
    </section>
  </div>
</template>
