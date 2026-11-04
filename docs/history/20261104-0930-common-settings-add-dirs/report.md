# center 共通の設定（追加指示・参照フォルダ）と workspace のフォルダ選択

2026-11-04。branch `feature/common-instructions`。

## 何を変えたか

- center 共通の設定: `center_settings_get` / `center_settings_update`（`packages/center/src/tools.ts`）。形は session の `settings` と同じ `{ instructions?, addDirs?, … }`。保存は config と同じ dir の `center-settings.json`（`createJsonObjectStore`、`store.ts`）。`sessions.json` には混ぜない。
- 合成（`project-settings.ts`）: `composeInstructions` = 共通 + 空行 + session。`composeAddDirs` = 共通が先、重複を除く。`sessions.ts` が add / `setInstructions` / `setAddDirs` に渡し、共通の更新は保存済みの全 session に次の起動から効く。
- 参照フォルダ `addDirs`（絶対パス、20 個以内、空配列は削除）: `remote-control.ts` の entry に持ち、`buildWrapperArgs` が `--add-dir <path>` を 1 つずつ付ける（`--append-system-prompt` の後、`--mcp-config` の前）。再起動・`--continue` でも付く。
- desktop:
  - 設定ダイアログ（ヘッダーの歯車）に「全 session 共通の設定」の節。`ProjectSettingsFields.vue` を接頭辞 `center-common` で出し、center の tool で読み書き。専用の保存ボタン。center に問い合わせられない時は欄を無効にして理由を出す。
  - `ProjectSettingsFields.vue` に「参照フォルダ」の節（行の追加・選択・削除）。歯車のダイアログと追加ダイアログで共用。フォルダ選択は自分の sidecar かつ macOS / Windows の時だけ（`session_path_hints.canPick`。共通の節は「center を起動する」が ON の時）。
  - `workspace` 欄に「選択…」（`pick_directory` = rfd）。

## 確認

- center: `bun run test` 404 件中 402 pass。残り 2 件は macOS 環境起因の既知（`add: wrapper 設定が無い supervisor…`、添付の EPIPE）。typecheck OK。
- desktop: e2e 109 件 pass（新規: 共通の設定の読み書き・エラー・長さ、workspace の選択、参照フォルダの行操作・保存・`session_create` の body・共通の参照フォルダ）。`nuxt typecheck` は vue-tsc の MODULE_NOT_FOUND でこの環境では走らない（既知）。
- Rust は変更なし（`addDirs` は `normalize_settings` を素通しする未知項目として届く）。

## 残り

- 実機での見た目は未確認（release 後に確認）。
- `addDirs` の存在確認は center ではしない（claude が起動時に無いフォルダを拒否した場合はログに出る）。
