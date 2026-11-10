# center-relogin merge（feat/center-relogin → develop 0.1.43）

- branch: `merge/center-relogin`（origin/develop `76af3d9` から切り、`feat/center-relogin` `41980fd` を `--no-ff` で merge）
- merge-base: `23ba98d`（develop 0.1.31 時点）。develop 側は 187 commit 先行
- 版は bump していない。feat の設計は変えていない

## 前提の変化

develop 側で `desktop/` → `packages/desktop/`（`plugin/` → `packages/plugin/` なども）に移動していた。feat の desktop 変更（README / session.rs / LoginDialog.vue / login.spec.ts ほか）は新パスへ載せ替えた。

## 衝突箇所と解消方針

| ファイル | 解消 |
|---|---|
| `packages/center/src/daemon.ts` | import は両方。`createEventHub()` は feat の位置（supervisor より前。`onAuthChange` が使う）に 1 つだけ置き、develop 側の後ろの宣言を除いた。contextUsage / activityTracker は develop のまま |
| `packages/center/src/events.ts` | `reason` は develop の union に `"changed"` を足した（created / deleted / restored / updated / context / activity / remote / changed）。コメントに changed の意味を追記 |
| `packages/center/src/server.ts` | develop の `systemInstructions` / `workspace` に feat の `login` を足して `registerTools` へ渡す |
| `packages/center/src/sessions.ts` | `SessionInfo` / `toInfo` に develop の contextUsage / activity / remote / instructions と feat の auth / loginUrl / loginError を併記 |
| `packages/center/src/tools.ts` | import・deps に `login` を追加。`session_login` / `session_login_code` は feat のまま。develop の `session_update` / `center_info` / settings 系は維持 |
| `packages/center/src/remote-control.ts` | `RcStatus` は instructions / systemInstructions / auth 系を併記。supervisor opts は `systemInstructions` と `onAuthChange` を併記。`childEnv` は develop の `(p, cur)` 版（config 読み直し `currentRc`）を採用し、feat の `setAuth` は残した（feat の `childEnv(p)` 旧版は捨てた） |
| `packages/center/test/*` | http（TOOLS に `session_login*` を追加）、sessions（fakeSupervisor が `opts, failStart, map` を返す。status に auth 3 項目）、tools（`connect` に `login`、tool 数 20 → 22）、wrapper（develop の読み直し等の test + feat の認証検知 test）を併記 |
| `packages/center/README.md` | tool 表は develop のものに `session_login` / `session_login_code` を追加。feat 側の古い `remote_create` 等の行は捨てた（develop の `remote_send` 等が正）。`GET /events` の reason に `changed` を追記し、develop の「添付画像」節は維持 |
| `docs/design/center-tools.md` | `session_list` 行を auth 付きにし、`session_login*` 行を追加 |
| `packages/desktop/README.md`（旧 `desktop/README.md`、DU） | develop の版を土台に「再ログイン」bullet を追加。SSE の reason 一覧に `changed` を追記。feat の古い記述（`server/package.json` 等）は採用していない |
| `packages/desktop/src-tauri/src/session.rs`（旧パス、DU） | `Session` に auth / login_url / login_error を develop の fields と併記。test の構築子・assert も併記 |
| `packages/desktop/src/types/index.ts` | `Session` / `CenterSession` に併記。`CenterAuthState` / `CenterLoginStart` / `CenterLoginCode` を追加 |
| `src/api/center.ts` `src/api/index.ts` | import / export を併記（`centerCommonSettings*` と `sessionLogin*` / `sessionRestart` / `centerToolStrict`） |
| `src/components/TerminalView.vue` | develop の画像添付 UI（sending / error / 添付ボタン）の前に再ログインボタンを置く |
| `src/composables/useBoard.ts` | group に develop の contextUsage / instructions / activity / remoteWaiting と feat の auth / loginError を併記 |
| `src/pages/index.vue` | サイドメニュー行は、develop の（instructions 印 → 活動印 → context %）の間に鍵アイコンを挿入。feat の「working / queued」件数表示（`side-count`）は develop が活動印に置き換え済みのため復活させていない。LoginDialog は develop の ProjectSettingsDialog の後ろ |
| `e2e/mock/bantou.ts` | session の mock に develop の項目と feat の auth / loginUrl / loginError を併記 |

自動 merge の docs（`docs/protocol.md` `docs/handoff.md`）は衝突なし。

## develop に合わせて直した点

- SSE: reason の union に `changed` を足しただけ。desktop 側は reason で絞らず `center-sessions-changed` で `session_list` を取り直す流儀のため追加の変更は無し。
- 状態の持ち方: `daemon.ts` で `events` を前倒し（上記）。`SessionInfo` の併記。
- `docs/design/center-tools.md` は develop 側が既に前提〜A 節を二重に持っている（origin/develop 時点の既存）。そのまま両方の `session_list` 行を更新し、重複は直していない（残課題）。
- tool 数の test: 22。

## テスト結果

host に bun / cargo が無い。npm 経路で実施。

- `npm install --no-package-lock`（root）→ `packages/protocol` `npm run build`: OK
- center: `tsc --noEmit` OK、`node --import tsx --test test/*.test.ts` **519/519 pass**（relogin の login.test.ts・wrapper 認証検知・tools の session_login 含む）
- desktop: `nuxt typecheck` exit 0。e2e は `nuxt generate` の静的ビルドを簡易 node サーバーで配信し、ms-playwright の chromium を指定した一時 config（後で削除）で実行。`global-setup` の `bun build` は esbuild で同じ IIFE を作って代替。**168/168 pass**（`login.spec.ts` 4 件を含む）
- src-tauri: cargo が無く **cargo test は未実施**。`session.rs` の変更は fields と test 構築子の併記のみ（目視確認）
- packages/server / protocol: 変更は及んでいない（差分に無し）ので回していない

## 残課題

- cargo test（`session.rs` の test）は cargo のある環境で未確認。
- `docs/design/center-tools.md` の二重化（develop 既存）。
- 実際の `/login` 往復は実機のみ。
