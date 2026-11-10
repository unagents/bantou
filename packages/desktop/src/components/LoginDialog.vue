<script setup lang="ts">
import { sessionLogin, sessionLoginCode, sessionRestart } from "~/api";
import type { CenterAuthState } from "~/types";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  session: string;
  /** The center's auth state of the session (what the badge showed). */
  auth: CenterAuthState | null;
  /** The center's `loginError` (why the last attempt failed), shown until a new attempt starts. */
  loginError: string | null;
}>();
const emit = defineEmits<{ done: [name: string] }>();

/** The dialog's own steps: ask the center for the URL, then take the code, then show the result. */
type Step = "idle" | "starting" | "code" | "sending" | "done";
const step = ref<Step>("idle");
const loginUrl = ref<string | null>(null);
const code = ref("");
const actionError = ref<string | null>(null);
const copied = ref(false);
const restarting = ref(false);

const CODE_PATTERN = /^[A-Za-z0-9#_-]{1,512}$/;
const trimmedCode = computed(() => code.value.trim());
const codeError = computed(() => {
  if (!trimmedCode.value) return null;
  return CODE_PATTERN.test(trimmedCode.value) ? null : "英数字と # _ - のみ";
});

/** The failure of this dialog's own last attempt (shown at once; the center's list catches up on the next read). */
const lastFailure = ref<string | null>(null);
const keychainLocked = computed(
  () =>
    props.auth === "keychain_locked" ||
    props.loginError === "Couldn't save your login" ||
    lastFailure.value === "Couldn't save your login",
);

async function start() {
  step.value = "starting";
  actionError.value = null;
  lastFailure.value = null;
  loginUrl.value = null;
  code.value = "";
  try {
    loginUrl.value = (await sessionLogin(props.session)).loginUrl;
    step.value = "code";
  } catch (e) {
    actionError.value = String(e);
    step.value = "idle";
  }
}

async function copyUrl() {
  if (!loginUrl.value) return;
  try {
    await navigator.clipboard.writeText(loginUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    actionError.value = `コピーできない: ${String(e)}`;
  }
}

async function send() {
  if (!trimmedCode.value || codeError.value) return;
  step.value = "sending";
  actionError.value = null;
  try {
    const r = await sessionLoginCode(props.session, trimmedCode.value);
    if (r.ok) {
      step.value = "done";
      emit("done", props.session);
      open.value = false;
      return;
    }
    // Invalid code: the same URL is still usable, keep the code step. Keychain locked: start over after unlocking.
    lastFailure.value = r.error;
    actionError.value =
      r.error === "Couldn't save your login"
        ? "ログインを保存できなかった。ホスト（center の Mac）の keychain を解錠してから、もう一度「ログイン URL を取得」から"
        : r.error === "Invalid code"
          ? "コードが受け付けられなかった。ブラウザの表示を全部コピーして貼り直す"
          : (r.error ?? "ログインできなかった");
    step.value = r.error === "Couldn't save your login" ? "idle" : "code";
  } catch (e) {
    actionError.value = String(e);
    step.value = "code";
  }
}

/** The other sessions share the credential but may keep failing until restarted: stop and start with --continue. */
async function restart() {
  restarting.value = true;
  actionError.value = null;
  try {
    await sessionRestart(props.session);
    emit("done", props.session);
    open.value = false;
  } catch (e) {
    actionError.value = String(e);
  } finally {
    restarting.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`${session} の再ログイン`" description="claude の認証が切れた。ブラウザで認証してコードを貼る" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="login-dialog">
        <UAlert
          v-if="keychainLocked && step !== 'code'"
          color="error"
          variant="subtle"
          icon="i-lucide-lock"
          title="ホストの keychain がロックされている"
          description="center の Mac で keychain を解錠（画面のロック解除・keychain のパスワード入力）してから進める。解錠しないと保存に失敗する"
          data-testid="login-keychain"
        />
        <p v-else-if="loginError && step === 'idle'" class="text-cork-danger-text text-xs" data-testid="login-last-error">
          前回: {{ loginError }}
        </p>

        <!-- step 1: the URL -->
        <div class="flex flex-col gap-2">
          <UButton
            class="self-start"
            :label="step === 'code' || step === 'sending' ? 'ログイン URL を取り直す' : 'ログイン URL を取得'"
            icon="i-lucide-key-round"
            :loading="step === 'starting'"
            :disabled="step === 'sending' || restarting"
            data-testid="login-start"
            @click="start"
          />
          <template v-if="loginUrl">
            <p class="text-cork-muted text-xs">この URL をブラウザで開き、認証後に表示されるコードを下に貼る。</p>
            <div class="flex items-start gap-2">
              <code class="bg-cork-elevated border-cork-border min-w-0 flex-1 overflow-hidden rounded border p-2 text-[11px] break-all select-all" data-testid="login-url">{{ loginUrl }}</code>
              <UButton
                size="xs"
                variant="subtle"
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied ? 'コピー済' : 'コピー'"
                data-testid="login-copy"
                @click="copyUrl"
              />
            </div>
          </template>
        </div>

        <!-- step 2: the code -->
        <UFormField v-if="step === 'code' || step === 'sending'" label="認証コード" :error="codeError ?? undefined" help="ブラウザに出た文字列を全部（# 以降も）貼る">
          <div class="flex gap-2">
            <UInput v-model="code" class="flex-1" placeholder="コード" data-testid="login-code" :disabled="step === 'sending'" @keydown.enter="send" />
            <UButton label="送信" :loading="step === 'sending'" :disabled="!trimmedCode || !!codeError" data-testid="login-send" @click="send" />
          </div>
        </UFormField>

        <p v-if="actionError" class="text-cork-danger-text text-xs whitespace-pre-wrap" data-testid="login-action-error">
          {{ actionError }}
        </p>

        <div class="border-cork-border flex items-center justify-between gap-2 border-t pt-3">
          <p class="text-cork-muted text-xs">
            別の session で既にログインし直した時は、この session を再起動すれば新しい認証を使う。
          </p>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-rotate-cw"
            label="再起動"
            :loading="restarting"
            :disabled="step === 'starting' || step === 'sending'"
            data-testid="login-restart"
            @click="restart"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
