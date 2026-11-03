# session ごとの追加指示（プロジェクト設定）

branch: `feature/session-instructions-per-session`（base: develop）。

## 仕様

- 追加指示（`--append-system-prompt` に渡す文）は session（プロジェクト）ごとに個別で、desktop の画面で設定する。保存先は center のプロジェクト設定（`settings`）。desktop の `settings.json` でも、center の共通設定（`center.json`）でもない。
- 設計メモ: `docs/design/project-settings.md`（構造・API・将来の項目の足し方）。`docs/design/master-cap-session.md` の決定 13〜16 を改訂。

## center（w-si-center）

### 内容

- `sessions.json` の各 session に `settings`（`{ instructions?: string, …未知の項目も保持 }`）。
- session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動・center 再起動後の復元）に、`settings.instructions` があれば `--append-system-prompt <値>` を付ける。16000 文字以内、空文字は無し。
- 更新は次の起動から効く。動いている session は起動し直さない。
- `center.json` の `remoteControl.sessionInstructions` は廃止。schema から外し、読み直しの対象からも外した。残っていれば無視し、起動時の読み込みで `center.log` に warning を 1 行（値は出さない）。他の項目の読み直しは変えていない。
- `session_list` / `rc_status` の `instructions`（真偽）は変更なし。

### API（MCP tool。center に REST route は無く、desktop の `session_list` と同じ `POST /mcp`）

- `session_settings_get { name }` → `{ name, settings }`。未設定と config 由来の project は `settings: {}`。未定義の name は `isError`。
- `session_settings_update { name, settings }` → `{ name, settings }`（更新後の全体）。マージ: 書いた項目だけ変わる・省略した項目は変わらない・`null` で項目を削除・`instructions` の空文字は削除と同じ・未知の項目は保持。`session_create` で作った session のみ（config 由来は `isError`）。`instructions` が 16000 文字超・string 以外は入力検証エラー。
- `session_create { name, path?, permissionMode?, settings? }`（`settings` は update と同じ形）。
- `rc_start` は変更なし（`instructions` 引数は無い）。

### 判断

- 全体置換でなくマージ更新にした（古い desktop が、知らない項目を消さないため）。比較は設計メモの決定 4。
- 設定の本文は `session_list` に載せない（一覧が重くなるため）。編集ダイアログは `session_settings_get` で読む。
- config 由来の project には設定を持たせない（center は `center.json` を書き換えないため）。
- sessionInstructions の warning は起動時の読み込みだけ（session 起動のたびの読み直しでは毎回並ぶため）。

### 変更ファイル

- `packages/center/src/project-settings.ts`（新規）、`config.ts`、`daemon.ts`、`remote-control.ts`、`sessions.ts`、`tools.ts`
- `packages/center/test/project-settings.test.ts`（新規）、`config` / `remote-control-wrapper` / `sessions` / `tools` / `http` の各 test
- `docs/design/master-cap-session.md`、`docs/design/project-settings.md`（新規）、`packages/center/README.md`

### 参照切れの修正（修正済み）

- `docs/protocol.md` の「read again at every `remote_send` like `sessionInstructions`」と `packages/center/src/remotes.ts` のコメントの `sessionInstructions` への言及は、`remoteControl.model` に直した（c3a29e9・adae3c5）。

## desktop（w-si-desktop）

### 内容

- 保存先は center のプロジェクト設定（`session_settings_get` / `session_settings_update` / `session_create` の `settings`）。desktop の `settings.json` には持たない（前の作りは破棄）。
- Rust（`session.rs`）: `session_get_settings` / `session_update_settings`（center の tool を呼ぶ）、`create_session` が `settings` を受ける。16000 文字・型の検査と、空の `instructions` を `null` にする処理を持つ。未知の項目は素通し。
- 画面: 左サイドバーの各行の歯車 → `ProjectSettingsDialog`（項目ごとの節。今は追加指示のみ）。追加ダイアログも同じ欄（`ProjectSettingsFields`）。注意文あり。巻物印は据え置き。設定ダイアログの center 共通の欄は削除。
- config 由来の project（`session_list` の `source` が `config`）は歯車を無効にする（center が更新を拒否するため）。tooltip「center の config 由来の project は設定を持てない」。`source` が不明（古い center）の時は有効。
- 将来項目（skills / outputStyle）は `SettingsDraft` と `ProjectSettingsFields` の節を足す形にしただけで、実装していない。

### テスト

- cargo test 259 passed / 0 failed（5 ignored）。設定の検査、create / update の body、center の返答（`{ name, settings }`）の読み取り。
- e2e 92 passed / 0 failed（静的ビルド + ms-playwright chromium）。歯車 → ダイアログ → 保存・再表示・消去、行を選択しない、上限超過で保存不可、追加ダイアログの欄・注意文・body の `settings`、設定ダイアログに共通欄が無いこと。

### 変更ファイル

- `packages/desktop/src-tauri/src/{session,center,lib}.rs`
- `packages/desktop/src/{api/index.ts,api/sessions.ts,types/index.ts,pages/index.vue}`
- `packages/desktop/src/components/{ProjectSettingsDialog,ProjectSettingsFields}.vue`（新規）、`AddSessionDialog.vue`、`SettingsDialog.vue`
- `packages/desktop/src/composables/sessionInstructions.ts`（新規）
- `packages/desktop/e2e/{mock/bantou.ts,session-instructions.spec.ts}`、`packages/desktop/README.md`

### 未検証

- 実 center との結合（mock の center 応答のみ）。

## 追記: develop との merge

develop（6d8b8b5）を feature/session-instructions-per-session（2988bff）へ merge した。衝突は 4 ファイル（src/ は衝突なし）。

### 解消方針（ファイルごと）

- `docs/protocol.md`: remote_send の Models 段落は develop（task + worker_model）を正とした。「like `sessionInstructions`」は廃止済みのため「like `remoteControl.model` is at every session launch」に直した。
- `packages/center/README.md`: `session_list` / 保存の節は session-instructions 側（`settings.instructions`、`sessions.json` の各 session の `settings`、`remoteControl.sessionInstructions` の廃止と warning）を残し、`contextUsage` に develop の `model?`（statusLine 由来の時だけ）を足した。tool 表は両方（`session_settings_*`、`worker_reply`、`task` 形式の `remote_send`）が載る。
- `packages/center/test/http.test.ts`: 外向け tool 一覧は `session_settings_get` / `session_settings_update` と `worker_reply` の両方。
- `packages/center/test/tools.test.ts`: 同じ一覧、件数を「16 個」に更新（develop の 14 + `session_settings_*` 2）。`connect` のモックは `getSettings` / `updateSettings` と `workerReply` の両方を持つ。

### 確認

- master-cap 起動引数: `wrapper.ts` の `buildWrapperArgs` が `--append-system-prompt`（`--mcp-config` の前）と `--settings`（statusLine のみ、`--mcp-config` の後）を両方付ける。両方が同時に付く test を `remote-control-wrapper.test.ts` に追加した。
- `remotes.ts` の restore 説明と README の「動いている記録を最優先」の記述は develop と矛盾しない（変更なし）。

### テスト

- center: test 375 passed / 0 failed、typecheck OK
- server: npm test 232 passed / 0 failed、typecheck OK
- desktop: build:sidecar OK、cargo test 259 passed / 0 failed（5 ignored）、e2e 97 passed / 0 failed（generate の静的ビルド + 簡易静的サーバー + ms-playwright chromium-1243 の一時 config、retries 0）

### review

- 未実施。cap が後で追記を頼む。

### 残存物

- 一時物（静的サーバー・一時 config・スクリプト）は停止・削除済み。`bun install` による bun.lock の変更は戻して commit していない。
- 作業 dir（`workers/w-si-merge`）に clone（`bantou`）が残る。
