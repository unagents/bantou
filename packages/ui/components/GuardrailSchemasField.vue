<script setup lang="ts">
import type { GuardrailRow } from "../composables/guardrailSchemas";

// The guardrail settings: openspec's schema definitions (center-wide). Rows of name + definition text (JSON); a saved
// row's name is fixed, a new row's name is typed. Checks and the update body: composables/guardrailSchemas.ts.
const rows = defineModel<GuardrailRow[]>({ required: true });
const props = defineProps<{ idPrefix: string }>();

function add() {
  rows.value = [...rows.value, { name: "", text: "", saved: false }];
}
function remove(i: number) {
  rows.value = rows.value.filter((_, k) => k !== i);
}
function patch(i: number, p: Partial<GuardrailRow>) {
  rows.value = rows.value.map((r, k) => (k === i ? { ...r, ...p } : r));
}
</script>

<template>
  <section class="flex flex-col gap-2" :data-testid="`${props.idPrefix}-section`">
    <h3 class="text-sm font-semibold">guardrail の schema 定義</h3>
    <p class="text-cork-muted text-xs">
      openspec 向けの schema 定義（名前 → 中身）。中身は JSON で書き、bantou は読まずにそのまま保存する。名前は英数字と _ - のみで、保存した名前は変えられない（変えるなら削除して足す）。保存で center に反映する
    </p>
    <p v-if="!rows.length" class="text-cork-muted text-xs" :data-testid="`${props.idPrefix}-empty`">schema 定義は無い</p>
    <div v-for="(r, i) in rows" :key="i" class="border-cork-border flex flex-col gap-1 rounded border p-2" :data-testid="`${props.idPrefix}-row`">
      <div class="flex items-center gap-2">
        <UInput
          :model-value="r.name"
          :disabled="r.saved"
          placeholder="schema-name"
          size="xs"
          class="w-64 font-mono"
          :data-testid="`${props.idPrefix}-name`"
          @update:model-value="patch(i, { name: String($event) })"
        />
        <UButton
          class="ml-auto"
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-trash-2"
          label="削除"
          :data-testid="`${props.idPrefix}-remove`"
          @click="remove(i)"
        />
      </div>
      <UTextarea
        :model-value="r.text"
        :rows="6"
        autoresize
        :maxrows="24"
        class="w-full font-mono text-xs"
        placeholder='{ "name": "…", … }'
        :data-testid="`${props.idPrefix}-text`"
        @update:model-value="patch(i, { text: String($event) })"
      />
    </div>
    <div>
      <UButton size="xs" label="schema を足す" icon="i-lucide-plus" color="neutral" variant="outline" :data-testid="`${props.idPrefix}-add`" @click="add" />
    </div>
  </section>
</template>
