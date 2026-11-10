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
| `addDirs` | string[]（絶対パス、20 個以内、空配列 = 無し） | master-cap が参照してよいフォルダ。起動のたびに 1 つずつ `--add-dir <path>`。center 共通の値が先、session の値が後ろ（重複は除く） |
| `outputStyle` | string（32000 文字以内、空文字 = 無し） | claude の output style の本文（markdown）。起動のたびに session のフォルダの `.claude/output-styles/bantou.md` に書き、`--settings {"outputStyle":"bantou"}` で選ぶ。session の値があれば center 共通の値は使わない（1 つしか選べないので連結しない）。2026-11-11 追加。比較した案: (A) 共通の `instructions` に style の本文を貼る（実装不要だが claude 既定の出力指示が残る）、(B) ホストの `~/.claude/output-styles/` の style を名前で指定（bantou 外のファイルが要る）、(C) 本文を設定に持ち center が書き出す。(C) を採用 |
| `servers` | string[]（host 名か server_id、50 個以内、重複は除く） | この session が `remote_send` / `remote_delete` / `worker_reply` で使ってよい server の範囲。**未設定 = 全部。空配列 = どの server も使わない**（保存する。未設定と区別）。`null` で削除（= center 共通の値に戻る）。session の値があれば center 共通（`center_settings_*`）の値は見ない（置き換え。和ではない）。範囲外の server を明示指定するとエラー「この session の servers に無い」。通知（worker_report / activity / cap_result）は範囲外の server からも受ける（送信先を絞る設定であり、受信は絞らない。既に起動済みの cap の通知を捨てない）。起動し直し不要で次の呼び出しから効く（他の項目と違い、起動時に claude へ渡さない）。center 全体の除外設定は作らない（利用者の指示） |
| `memory` | `{ url: string, token?: string, agentId?: string } \| null` | 外部記憶（memory の MCP endpoint）。設計は `docs/design/external-memory.md`。2026-11-11 追加。起動のたびに `--mcp-config` の `mcpServers` に `memory`（`type: "http"`, `url`, `headers: { Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}", "X-Agent-Id": <agentId か session 名> }`）を足し、system-instructions に部品 `memory@1` を付ける。session の値があれば center 共通の値は使わない（`outputStyle` と同じ。項目ごとには合成しない）。`null` で削除（= center 共通の値に戻る）。**検証**: `url` は必須、http / https の絶対 URL、2048 文字以内、`user:pass@` は不可（argv・log に出るため）。`token` は 4096 文字以内、空白・制御文字・非 ASCII を含まない（header の値になる）、空文字 = token 無し（Authorization を付けない）。`agentId` は `^[A-Za-z0-9_-]+$` で 64 文字以内（session 名と同じ文字種・同じ上限）、空文字 = 無し（session 名を使う）。**token の扱い**: 起動する claude の環境変数 `BANTOU_MEMORY_TOKEN` だけで渡す（`BANTOU_SESSION_TOKEN` と同じ）。`--mcp-config` の中身・argv・`center.log`・status・`session_list`・`center_info` には実値を出さず、header は `${BANTOU_MEMORY_TOKEN}` のまま。token が無い時は env も渡さず（center 自身の同名 env も継承しない）Authorization を付けない。`sessions.json` / `center-settings.json` には起動に要るので保存する。**読み出し**: `session_settings_get` / `center_settings_get` と update の応答は token の値を返さず `{ url, agentId?, tokenSet: boolean }` を返す（応答は master-cap の LLM 文脈にも入り得るため）。**更新**: object ごと置き換える。`token` を省略すると今の token を引き継ぎ、空文字で消す（desktop は token 欄が空のまま保存しても token を消さない）。比較した案: (A) get が token を返す、(B) get は常に token を伏せ、設定済みかだけ返す。(B) を採用 |

## session のフォルダ（path）

settings の項目ではなく、session の記録の `path`（master-cap の claude の cwd）。作成時にだけ決まり、変更しない（desktop の歯車では読み取り専用）。2026-11-04 決定。

- 作成: desktop の追加ダイアログの「フォルダ」欄（既定は空）。空なら `session_create` に `path` を渡さず、center が `<workspace>/<name>` に決める。入力は絶対パス。center は無ければ作り、相対パス・別 session と同じ path・作れない場合は error を返す（desktop はそのままダイアログに出す）。
- プレースホルダ: center の `workspace`。desktop が取る手段として center に tool `center_info`（引数なし → `{ workspace: string | null }`）を足した。旧 center（tool が無い）や取れない時は汎用文。
- フォルダ選択ダイアログ: 自分の sidecar center で macOS / Windows の時だけ。別ホストの center ではフォルダは center のホスト上のパスなので、手入力のみ。
- 表示: 歯車のダイアログは `session_list` の `path` を読み取り専用で出す（`session_settings_get` は変えない）。
- 比較した案（workspace の取り方）: (A) `session_list` の返り値を `{sessions, workspace}` に変える（既存の読み手を壊す）、(B) `session_settings_get` に載せる（追加ダイアログの時点では session が無い）、(C) 新 tool `center_info`。(C) を採用。

## 項目を足す手順

skills など新しい項目を足す時は、次を同じ場所に足す（`addDirs`・`outputStyle` はこの手順で足した）。

1. `packages/center/src/project-settings.ts` の `ProjectSettings` に型、`projectSettingsPatchSchema` に検証（`nullable().optional()`。`null` で削除できる形を保つ）を足す。値の空の扱い（`instructions` の空文字のような正規化）が要る項目は `mergeSettings` に規則を足す。
2. その項目を使う起動の引数は `buildWrapperArgs` と `launch`（`remote-control.ts`）に足す。supervisor の entry に値を持たせ、更新は `setInstructions` と同じ形の関数で次の起動に反映する。
3. tool（`session_settings_get` / `session_settings_update` / `session_create`）の形は変えない。desktop は新しい項目をその名前で読み書きできる（未知の項目は center が保持するので、desktop が先に対応しても壊れない）。
4. この表に項目を足し、`packages/center/README.md` を更新する。
