# 報告: center の projects を workspace 1 つにする / servers 廃止

- 日付: 2026-10-28（204 local cap の worker が作業し、cap が本ファイルに記録。worker はこのファイルを書く権限が無かった）。
- 指示: `task.md`（追加指示・訂正・訂正 2 を含む）。

## 変更ファイル

- `desktop/src-tauri/src/center.rs`
- `desktop/src/components/SettingsDialog.vue`
- `desktop/src/types/index.ts`
- `desktop/e2e/mock/bantou.ts` / `desktop/e2e/settings.spec.ts`
- `desktop/README.md`
- `packages/center`: 変更なし（途中で発見方式に書き換えたが、訂正を受けて全て戻した。`git diff packages/` が空なのを cap が確認）。

## 挙動の変化

- 設定は `workspace`（文字列 1 つ、既定 `~/.bantou`）。`projects` / `servers` は型・UI・保存から削除。
- 設定画面は projects 一覧と servers 欄を廃止し、workspace 入力欄（`data-testid="center-workspace"`）1 つ。spawn / permissionMode / autostart は UI に出さない。
- workspace は絶対パスか `~` / `~/…` のみ有効。空白のみなら既定 `~/.bantou`。
- center 起動時（`write_config`）に `~` を home へ展開し、ディレクトリが無ければ `create_dir_all` で作る。
- `center.json` の `projects` は `{name:"workspace", path:<展開後>, autostart:true}` の 1 件だけ。spawn / permissionMode は書かず center の既定（same-dir / auto）に任せる。`servers` は書かない。
- 再起動判定は projects / servers の代わりに workspace の変更で行う。

## 移行

- 移行処理なし（訂正 2）。旧 `projects` / `servers` は型から外しただけで、settings.json の既存値に手を加えるコードは無い。
- 旧キーが残った settings.json を読んでもエラーにならないことを unit test `old_projects_and_servers_keys_are_ignored_not_errors` で確認。旧キーは読み捨てられ、再保存では書かれない。workspace が無い旧設定は既定 `~/.bantou`。
- 副作用: 旧 projects の path は引き継がれない。必要なら設定画面で workspace を入れ直す。

## servers 廃止と packages/center（訂正により tool の形は不変）

- desktop 側は `servers` を設定と `center.json` から除去しただけ。
- protocol `bantou` による server 自動発見は、tool の形を変えずには実現できないため実装していない。
- 影響箇所（変更せず残したもの）:
  - `packages/center/src/config.ts` の `servers` スキーマと `server-link.ts`: `servers` が無い config では空配列。`server_list` は `[]`、`cap_kick` / `worker_resume` / `server_status` は「未定義の server」エラー。desktop 経由の center ではこれらの tool は事実上使えない。
  - `packages/center/src/tools.ts` の `server` 引数説明（"config の servers[].name"）、`packages/center/README.md` の `servers[]` 記述、`packages/center/test/` の servers 前提テスト。
  - `desktop/src/components/CenterDialog.vue` の「server 未登録」表示と `server_list` / `server_status` 呼び出し（常に空表示）。
  - `desktop/e2e/mock/bantou.ts` の `centerServers` / `centerAgents` と `desktop/e2e/center.spec.ts`（mock の tool 応答なので記述はそのまま有効）。

## テスト

- `cd desktop/src-tauri && CARGO_BUILD_JOBS=2 cargo test -j 2`: 205 passed / 0 failed / 5 ignored（lib。他 target 0 件）。cap が再実行して同値を確認。
- 追加・更新: 既定値、workspace 検証、`~` 展開、`write_config` のディレクトリ作成と既存内容保持、`center.json` の projects 1 件、servers を書かない、旧キー読み込み、restart 判定。

## 未実施

- e2e と型チェック（vue / ts）: このホストで実行不可（前回 report 参照）。記述の更新のみ。mac200 等で要実行。
- `packages/center` のテスト: 変更が無いため未実行。
- worker の一時ファイル削除: worker の権限で拒否され未実施。worker は `/tmp/claude-1002/` に作業用 `*.js` / `*.mjs` / `sl_tail.ts` / `tt_tail.ts` が残る可能性を報告。同ディレクトリには過去セッションの物も混在し、cap は本件分を特定できないため削除していない。
- 残存プロセス: cap が確認し、cargo / rustc / nuxt / playwright の残存なし。
