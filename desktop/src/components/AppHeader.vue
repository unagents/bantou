<script setup lang="ts">
import type { BrokerStatus, UpdaterState } from "~/types";

defineProps<{
  workspacePath: string | null;
  waitingCount: number;
  broker: BrokerStatus | null;
  /** Why the PM button is off (no center to talk to). Unset: usable. */
  pmDisabledReason?: string | null;
  /** State of the in-app updater; drives the single update control. */
  updater: UpdaterState;
}>();
defineEmits<{
  open: [];
  addSession: [];
  pm: [];
  center: [];
  settings: [];
  checkUpdate: [];
  installUpdate: [];
}>();

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressText(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return fmt(downloaded);
  const pct = Math.floor(Math.min(100, (downloaded / total) * 100));
  return `${fmt(downloaded)} / ${fmt(total)} · ${pct}%`;
}
</script>

<template>
  <header
    data-tauri-drag-region="deep"
    class="border-cork-border bg-cork-surface sticky top-0 z-10 flex h-(--cork-header-height) items-center gap-3 border-b pr-4 pl-20"
  >
    <h1 class="font-display text-lg font-semibold">bantou</h1>
    <span v-if="workspacePath" class="text-cork-muted min-w-0 truncate text-xs">{{ workspacePath }}</span>
    <div class="ml-auto flex items-center gap-3">
      <UBadge
        v-if="waitingCount > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-message-circle-question"
        :label="`返答待ち ${waitingCount}`"
      />
      <UTooltip
        v-if="workspacePath"
        :text="
          broker?.connected
            ? `${broker.name} @ ${broker.broker_url}`
            : (broker?.error ?? 'broker を探索中…')
        "
      >
        <span class="flex items-center gap-1 text-xs">
          <span
            class="size-2 rounded-full"
            :class="broker?.connected ? 'bg-green-400' : 'bg-amber-400'"
          />
          <span class="text-cork-muted">messenger</span>
        </span>
      </UTooltip>
      <UButton
        v-if="workspacePath"
        size="sm"
        variant="ghost"
        color="neutral"
        icon="i-lucide-user-plus"
        label="セッション追加"
        :disabled="!broker?.connected"
        @click="$emit('addSession')"
      />
      <UTooltip :text="pmDisabledReason ?? 'PM を立てる'">
        <span>
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            icon="i-lucide-crown"
            label="PM を立てる"
            :disabled="!!pmDisabledReason"
            data-testid="open-pm"
            @click="$emit('pm')"
          />
        </span>
      </UTooltip>
      <span v-if="pmDisabledReason" class="text-cork-muted max-w-48 truncate text-xs" data-testid="pm-disabled-reason">{{ pmDisabledReason }}</span>
      <UTooltip :text="updater.kind === 'error' ? updater.message : ''" :disabled="updater.kind !== 'error'">
        <span>
          <UButton
            v-if="updater.kind === 'available'"
            size="sm"
            variant="soft"
            color="primary"
            icon="i-lucide-download"
            :label="`アップデートして再起動（v${updater.version}）`"
            data-testid="updater-control"
            data-updater-state="available"
            @click="$emit('installUpdate')"
          />
          <UButton
            v-else-if="updater.kind === 'downloading'"
            size="sm"
            variant="soft"
            color="primary"
            icon="i-lucide-loader-circle"
            :label="`ダウンロード中 ${progressText(updater.downloaded, updater.contentLength)}`"
            disabled
            data-testid="updater-control"
            data-updater-state="downloading"
          />
          <UButton
            v-else-if="updater.kind === 'installing'"
            size="sm"
            variant="soft"
            color="primary"
            icon="i-lucide-loader-circle"
            label="再起動します…"
            disabled
            data-testid="updater-control"
            data-updater-state="installing"
          />
          <UButton
            v-else-if="updater.kind === 'error'"
            size="sm"
            variant="ghost"
            color="error"
            icon="i-lucide-circle-alert"
            :label="`${updater.version ? 'アップデートに失敗' : '確認に失敗'}: ${updater.message}`"
            class="max-w-72"
            data-testid="updater-control"
            data-updater-state="error"
            @click="$emit('checkUpdate')"
          />
          <UButton
            v-else
            size="sm"
            variant="ghost"
            color="neutral"
            :icon="updater.kind === 'checking' ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
            :label="updater.kind === 'checking' ? '確認中…' : updater.kind === 'latest' ? '最新' : 'アップデートを確認'"
            :disabled="updater.kind !== 'idle'"
            data-testid="updater-control"
            :data-updater-state="updater.kind"
            @click="$emit('checkUpdate')"
          />
        </span>
      </UTooltip>
      <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-folder-open" @click="$emit('open')" />
      <UButton
        size="sm"
        variant="ghost"
        color="neutral"
        icon="i-lucide-server"
        aria-label="center"
        data-testid="open-center"
        @click="$emit('center')"
      />
      <UButton
        size="sm"
        variant="ghost"
        color="neutral"
        icon="i-lucide-settings"
        aria-label="設定"
        data-testid="open-settings"
        @click="$emit('settings')"
      />
    </div>
  </header>
</template>
