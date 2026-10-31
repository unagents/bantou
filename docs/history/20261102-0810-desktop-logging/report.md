# desktop / center 調査用ログ

branch: `feature/desktop-logging`（base: develop `344c02f`）。version bump なし。

## 変更点

### desktop (Rust)
- `tauri-plugin-log =2.9.2` と `log =0.4.30` を追加。2.10 系は tauri ^2.12 を要求するため、tauri 2.11 で入る最新の 2.9.2 を選んだ。
- `lib.rs`: LogDir ターゲットのみ（`bantou.log`）、level Info、5 MiB でローテーション、5 世代保持。capability に `log:default`。
- `center_mcp.rs`: `tools/call` の tool 名と HTTP status、非 2xx は応答本文（最大 2000 文字・1 行化）、接続失敗、tool の `isError`、initialize 系の失敗。`ping` は成功時は記録しない。
- `terminal.rs`: `StreamEnd::Rejected` を `Rejected(status, body)` に変更（`center_events.rs` の参照も追従）。output stream の connected / retrying / rejected を理由付きで記録。入力・サイズ変更の失敗は status・応答本文・送った内容（resize は cols/rows、input は base64 長のみで中身は書かない）を記録。
- `session.rs`: セッション一覧の取り直し結果（成功は件数、失敗は理由）。
- `broker.rs`: 登録成功、register / heartbeat / poll の失敗（同じ文言は 1 回だけ）と復帰、ping・message の適用失敗・ack 失敗。既存の `eprintln!` は残した。

### desktop (webview)
- `@tauri-apps/plugin-log 2.9.2` を追加。`src/api/log.ts`（`logWebview`、`[webview]` 接頭辞、失敗は握りつぶす）。
- アップデータの確認結果・失敗（auto / manual / install）、一覧取り直しの呼び出し失敗、terminal の入力・サイズ変更失敗（cols/rows 付き）。
- `src/plugins/log.client.ts`: `error` / `unhandledrejection` / `vue:error` を記録。

### center
- `packages/center/src/http.ts`: 2xx 以外の応答を `HTTP <method> <path> -> <status>: <理由>` で `log()` に出す（center.log にも入る）。query は除外。理由は応答本文の `error`、無ければ本文先頭、無ければ status message。
- テスト 1 件追加（`test/http.test.ts`）。

### README
- `desktop/README.md` に「ログ」節、`packages/center/README.md` の「ログ」節に center.log の追記。

## テスト結果
- Rust (`cargo test`, desktop/src-tauri): 238 passed / 0 failed / 5 ignored（ignore は既存の live テスト。今回の変更前から）。新規: `clip_body_is_one_line_and_bounded`、`stream_once_...reports_rejection` を本文まで検証するよう更新。sidecar は空のプレースホルダ（`binaries/` は git 管理外）で build.rs を通した。
- center (`bun run test`): 231 passed / 0 failed。`bun run typecheck` も通過。
- desktop e2e (Playwright): 69 passed / 0 failed / 0 skipped。`bun run generate` の静的ビルドを簡易静的サーバー（127.0.0.1:1420）で配信し、ms-playwright の chromium-1243 を一時 config で指定。retries 0。

## 未確認
- 実機（macOS）で `~/Library/Logs/jp.grrow.bantou/bantou.log` が書かれること、ローテーションが働くことは未確認（204 は GUI 無し。コンパイルとプラグイン設定のみ）。
- webview → ファイルの経路は e2e では mock IPC（`plugin:log|log` は null を返す）のため通っていない。
- `bun run typecheck`（nuxt typecheck）は実行していない。

## 後始末（未完了）
- 一時ファイルの削除が Bash の permission で拒否された（`rm`）。残っている: `desktop/playwright.tmp.config.ts`（未追跡・commit していない）、`/tmp/static-serve.mjs`、`desktop/src-tauri/binaries/` のプレースホルダ 2 件（git 管理外）。
- 起動したプロセス（静的サーバー）は停止済み。ポート 1420 は解放を確認。

## push した commit
- `ff21200` desktop/center: 調査用ログをファイルに残す
- この report の commit（`git log feature/desktop-logging` の先頭）
