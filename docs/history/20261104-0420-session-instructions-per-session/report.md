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

### 未対応（要判断）

- `docs/protocol.md` の「read again at every `remote_send` like `sessionInstructions`」が参照切れ（担当範囲外のため未修正）。

## desktop（w-si-desktop）

（desktop worker が追記）
