/**
 * session（wrapper 経由の対話型 claude）の再ログイン。`/login` を pty に打ち込み、supervisor が pty 出力から拾う
 * loginUrl / auth / loginError を待つ。認証 URL をブラウザで開いてコードを得るのは利用者。
 */
import type { Core } from "./core.js";
import type { Logger } from "./log.js";
import type { AuthState, RemoteControlSupervisor } from "./remote-control.js";

export interface LoginStartResult {
  name: string;
  /** ブラウザで開く認証 URL。 */
  loginUrl: string;
}

export interface LoginCodeResult {
  name: string;
  /** 認証が通り、保存もできた。 */
  ok: boolean;
  auth: AuthState;
  /** 失敗理由（`Invalid code` / `Couldn't save your login`）。ok の時は null。 */
  error: string | null;
}

export interface LoginFlow {
  /** `/login` を始め、認証 URL が出るまで待つ。 */
  start(name: string): Promise<LoginStartResult>;
  /** 認証コードを投入し、成功か失敗が出るまで待つ。 */
  code(name: string, code: string): Promise<LoginCodeResult>;
}

/** 入力の間隔と待ち上限（テストで短くする）。 */
export interface LoginTimings {
  /** Esc で前の表示を閉じてから `/login` を打つまで。 */
  escapeMs: number;
  /** `/login` を打ってから、方法の選択（Enter）まで。 */
  menuMs: number;
  /** コードを打ってから Enter を別送するまで（同じチャンクだと貼り付け扱いで Enter が落ちる）。 */
  enterMs: number;
  /** 認証 URL を待つ上限。 */
  urlTimeoutMs: number;
  /** コード投入の結果を待つ上限。 */
  codeTimeoutMs: number;
  /** 状態の確認間隔。 */
  pollMs: number;
}

export const DEFAULT_LOGIN_TIMINGS: LoginTimings = {
  escapeMs: 300,
  menuMs: 1500,
  enterMs: 300,
  urlTimeoutMs: 15_000,
  codeTimeoutMs: 30_000,
  pollMs: 200,
};

/** 認証コード。英数字と `#` `_` `-`（claude が表示するコードは `<code>#<state>`）。 */
export const LOGIN_CODE = /^[A-Za-z0-9#_-]{1,512}$/;

const ESC = Buffer.from("\u001b");
const ENTER = Buffer.from("\r");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createLoginFlow(opts: {
  supervisor: RemoteControlSupervisor;
  core: Core;
  log: Logger;
  timings?: Partial<LoginTimings>;
}): LoginFlow {
  const { supervisor, core, log } = opts;
  const t: LoginTimings = { ...DEFAULT_LOGIN_TIMINGS, ...opts.timings };

  const send = (name: string, data: Buffer): void => {
    if (!core.input(name, data)) throw new Error(`session が実行中でない: ${name}`);
  };

  /** cond が真になるまで待つ。上限を過ぎたら false。 */
  const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() >= end) return false;
      await sleep(t.pollMs);
    }
    return true;
  };

  return {
    async start(name) {
      supervisor.status(name); // 未定義なら投げる
      if (!core.running(name)) throw new Error(`session が実行中でない: ${name}`);
      supervisor.resetLogin(name);
      log(`session 再ログイン開始: ${name}`);
      send(name, ESC);
      await sleep(t.escapeMs);
      send(name, Buffer.from("/login\r"));
      await sleep(t.menuMs);
      // ログイン方法の選択: 先頭（Claude account with subscription）
      send(name, ENTER);
      const got = await waitFor(() => supervisor.status(name).loginUrl !== null, t.urlTimeoutMs);
      const st = supervisor.status(name);
      if (!got || !st.loginUrl) throw new Error(`認証 URL が出ない（${t.urlTimeoutMs}ms）: ${name}`);
      return { name, loginUrl: st.loginUrl };
    },

    async code(name, code) {
      supervisor.status(name);
      if (!LOGIN_CODE.test(code)) throw new Error("code は英数字と # _ - のみ（512 文字まで）");
      if (!core.running(name)) throw new Error(`session が実行中でない: ${name}`);
      // 前回の失敗理由を消し、今回の結果だけを見る（auth は変えない。成功で ok になる）
      supervisor.resetLogin(name);
      send(name, Buffer.from(code));
      await sleep(t.enterMs);
      send(name, ENTER);
      const settled = (): boolean => {
        const s = supervisor.status(name);
        return s.loginError !== null || (s.auth === "ok" && s.loginUrl === null);
      };
      const done = await waitFor(settled, t.codeTimeoutMs);
      const st = supervisor.status(name);
      if (!done) throw new Error(`ログインの結果が出ない（${t.codeTimeoutMs}ms）: ${name}`);
      const ok = st.loginError === null && st.auth === "ok";
      log(`session 再ログイン結果: ${name} ok=${ok} auth=${st.auth}${st.loginError ? ` error=${st.loginError}` : ""}`);
      return { name, ok, auth: st.auth, error: st.loginError };
    },
  };
}
