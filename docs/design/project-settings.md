# プロジェクト設定（settings）

session（プロジェクト）ごとの設定を、center が session の記録と一緒に持つ。2026-11-04 決定。

## 背景

master-cap への追加指示（`--append-system-prompt`）を session ごとに desktop で設定したい。今後も skills・出力スタイルなど、プロジェクトごとの設定が増える見込み。項目のたびに専用の tool と保存先を作らず、1 つの構造にまとめる。

## 決定

1. 保存先は center の session の記録（`sessions.json` の各 session の `settings`）。desktop の `settings.json` には置かない（session を起動するのは center で、別ホストの desktop からも同じ値を見せる必要があるため）。center の共通設定（`center.json`）にも置かない（全 session 共通になるため。`remoteControl.sessionInstructions` は廃止）。
2. 形は 1 つの object。既知の項目は検証し、未知の項目は JSON のまま保持する（中身を解釈しない）。
3. API は center の MCP tool（desktop の `session_list` と同じ経路）。
   - `session_settings_get { name }` → `{ name, settings }`。未設定と config 由来の project は `settings: {}`。未定義の name は `isError`。
   - `session_settings_update { name, settings }` → `{ name, settings }`（更新後の全体）。
   - `session_create` の `settings`（新規作成時に同じ形で渡す）。
4. 更新はマージ。`settings` に書いた項目だけ変わる（省略した項目は変えない）。値 `null` はその項目を削除する。`instructions` の空文字は削除と同じ（保存しない）。未知の項目も同じ規則で、値は検証せず保持する。
   - 比較した案: (A) 全体を置き換える（desktop が知らない項目を、更新のたびに消す。項目が増えるほど危ない）、(B) 項目ごとの tool（項目のたびに tool が増える）、(C) マージ更新。(C) を採用。古い desktop が新しい項目を持つ記録を更新しても、知らない項目を壊さない。
5. 更新は次の起動から効く。動いている session は起動し直さない（center が master-cap を勝手に止めないため）。
6. config 由来の project（`center.json` の `projects`）には設定を持たせない（center は `center.json` を書き換えない）。get は `{}`、update は拒否。
7. `session_list` / `rc_status` には設定の本文を出さない。`instructions`（真偽、その起動で付けたか）だけ出す。設定の読み出しは `session_settings_get`。

## 項目

| 項目 | 型 | 意味 |
|---|---|---|
| `instructions` | string（16000 文字以内、空文字 = 無し） | master-cap への追加指示。起動のたびに claude へ `--append-system-prompt <値>`（新規・再起動・`--continue`・復元のすべて）。wrapper 経由の session だけが対象 |

## 項目を足す手順（将来用。今は実装しない）

skills・出力スタイルなど新しい項目を足す時は、次を同じ場所に足す。

1. `packages/center/src/project-settings.ts` の `ProjectSettings` に型、`projectSettingsPatchSchema` に検証（`nullable().optional()`。`null` で削除できる形を保つ）を足す。値の空の扱い（`instructions` の空文字のような正規化）が要る項目は `mergeSettings` に規則を足す。
2. その項目を使う起動の引数は `buildWrapperArgs` と `launch`（`remote-control.ts`）に足す。supervisor の entry に値を持たせ、更新は `setInstructions` と同じ形の関数で次の起動に反映する。
3. tool（`session_settings_get` / `session_settings_update` / `session_create`）の形は変えない。desktop は新しい項目をその名前で読み書きできる（未知の項目は center が保持するので、desktop が先に対応しても壊れない）。
4. この表に項目を足し、`packages/center/README.md` を更新する。
