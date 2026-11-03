# center の tool 仕様（実装済み、2026-10-29）

ドラフトを実装に落とした版。前提は `docs/concept.md`。各項目に「概念」（ユーザー確定の原則）か「今は」（いずれ変わり得る実装）を付ける。

## 前提（概念）

- ユーザーは番頭（bantou）と話し、番頭が全部を切り盛りする。PM（master-cap）を用意するのも番頭。
- master-cap は「考えて指示を出す」だけの中継役。実体（起動手段・場所・path）は本質ではない。
- center は master-cap に必要な道具を持たせてよい。agent-messenger の通信部分は center が持ち、master-cap ごとに messenger の MCP を抱えさせない。
- どの server で作業するか、worker を何本使うかは、ユーザーからはできるだけ見えなくする（master-cap に見えるのは構わない）。
- center の tool は 2 種類: (A) 番頭が使う、center 上の session（master-cap）の起動・削除。(B) center が master-cap に持たせる、server の remote-cap（server ごとに 1 つ）への指示・停止の道具。

## A. center 上の session（番頭が使う）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `session_create` | `name`（英数 `_-`）、`path?`、`permissionMode?`（既定 `auto`） | `{name, path, state, pid, sessionUrl, startedAt, source, lastError?}` | `claude remote-control --name <name>` を path で起動し、監視対象に加える |
| `session_delete` | `name` | `{name, deleted}` | remote-control を停止し、監視と保存から外す。path は消さない |
| `session_list` | なし | 同上の配列 | config の project と session の全部（`source` で区別） |

決めた点（今は）:

- 実体は supervisor（`remote-control.ts`）の entry。構築時固定だった entry を `add` / `remove` で動的に足し引きできるようにした。`remove` できるのは `add` したものだけ（config 由来は不可）。
- 保存は center 自前の状態ファイル（config と同じ dir の `sessions.json`）。config の projects には書かない。center 起動時に復元し、`--continue` で起動する。`--continue` が接続前（30 秒以内）に終了したら、素の起動へ fallback する（claude は約 4 時間以内の記録が無いと `--continue` で error exit する。実測: `No recent session found in this directory or its worktrees`）。
- `path` 省略時は config の project `workspace`（desktop が渡す 1 件）の path の下に `<name>` を作る。`workspace` が無ければ `path` 必須。
- 拒否: name 重複、既存 project 名（`workspace` 含む）との衝突、他の project / session と同じ path、相対 path。
- 新規 path の trust（実測、claude 2.1.312）: プロンプトは出ず `Error: Workspace not trusted. Please run \`claude\` in <path> first ...` で即 exit 1。親 dir が trust 済みなら配下は通る。未 trust の path では `session_create` は `lastError` 付きの `starting` を返し、再起動を繰り返して上限で `error`。center が claude の設定に trust を書く案は、ユーザー設定の書換えになるので入れていない（今は。人が一度 `claude` を起動して承認する）。
- 同じ folder を直前まで別の remote-control が握っていると、`This folder is already served by a terminal ...` で約 1 分待たされて終了する（実測）。
- `session_delete` は path を消さない（ドラフトの案どおり）。

## B. remote session（center が master-cap に持たせる道具）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `remote_send` | `goal`、`deliverables?`、`verify?`、`constraints?`、`workers?`、`worker_model?`、`repo?`、`branch?`、`server?` | `{remote_id, server, serverName, state, created, task_id, worker_model?}` | server の remote-cap（1 つ）に `task` を送る。`goal` だけなら他は既定（`deliverables:{}` `verify:{}` `constraints:[]` `workers:{}`。items 無し = implement + review の最低 2 体）。`task_id` は center が採番。返信（`task_result`）は待たない。cap が無い時は server が作る |
| `remote_create` | 同上 | 同上 | `remote_send` の互換の別名（同じ処理） |
| `worker_reply` | `remote_id?`、`worker_id`、`text`、`server?` | `{remote_id, server, worker_id, accepted:true}` | server の worker へ返答を送る（`worker_report` の ask / approve への回答）。`remote_id` 省略時は center の cap。desktop は外向け `/mcp` の同名 tool を `center_call` で呼ぶ |
| `remote_delete` | `remote_id?`、`server?`、`force?` | `{remote_id, deleted, stopped, warning?}` | server に `stop_cap` を送って実行を止め、記録を外す |
| `remote_list` | `owner?` | `RemoteView[]` | server の cap 単位。最新の `result` / `error` と時刻、最新の `task_result`、直近の `worker_reports`（最大 20 件、到着順）、未完了の指示 `pending`、`owners`（pending を持つ session）、`activity?` を含む（履歴は無い）。owner が分かればその session の未完了の指示がある cap、分からなければ全件 |
| `remote_wait` | `remote_id?`、`server?`、`timeout_sec?`、`owner?` | `RemoteView` | cap が idle で配下の worker に running / stalled が無くなるまで待つ。timeout は `state: running`。完了通知を受けられない session 用 |

決めた点:

- （概念）master-cap から server が見えること自体は構わないが、選ばなくても動く。`server` 省略で自動選択。
- （今は）server 選択は発見ベース: messenger の `listPeers("all", {protocol: "bantou"})` の先頭。`server` 引数は peer id、一致しなければ name。`config.servers` には依存しない（desktop は 2eceed7 以降 `servers` を書かない）。`config.servers` があれば先頭の client を共有し、無ければ内部 client 1 本（接続を増やさない）。既存 tool の挙動は変えていない。
- （確定: 2026-11-04）**remote-cap は 1 つの server につき 1 つだけ**。作業が何であれ、center はその cap に次の指示を送る。作業ごとに cap を作るのは資源（cap の path・プロセス・state）と設計（同じ server の cap が際限なく増え、片付けも要る）の両面で無意味なので止めた。protocol の `kick_cap` は同じ cap_id なら resume で、server は cap ごとに直列実行し worker の report で cap を再開するので、server 側の取り決めは変えていない。
- （旧。protocol 1.4.0 まで。1.5.0 は次項）`remote_id` = cap_id = `c-<10 桁 hex>`。center の状態 dir の `center-id` に持つ center ごとに固定の値（center を再起動しても同じ）。指示のたびに server の `status` で cap の有無を確かめ、無い時だけ最初の `kick_cap`（`model` / `worker_model` は引数 ?? config の `servers[]`（送信のたびに読み直す）、無ければ付けない。既存の cap では `model` は無視して `model_ignored` を返し、`worker_model` は引数があった時だけ載せる）。あれば同じ cap_id の `kick_cap`（resume）。返信は待たず `{state: "running", created}` を返す。返信（`cap_result` / `error`）で記録を更新し、最新の result / error（8000 文字まで）と時刻を更新する（履歴には積まない）。cap が実行中なら center の link が同じ cap_id の指示を直列にし（返信の取り違え防止）、server 側も cap ごとに直列。
- （今は、protocol 1.5.0）`remote_send` は `kick_cap` ではなく `task`（`goal` と、省略可の `deliverables` / `verify` / `constraints` / `workers` / `repo` / `branch` / `worker_model`）を送る。`task_id` は center が採番し、未完了の指示にも持つ。返信は `task_result`（最新を `RemoteView.task_result` に持ち、`result` は summary）。同じ `task_id` の `task_result` が report 起因の再開で重ねて届いても、完了判定・通知は指示ごとに 1 回（未完了の指示が無ければ何も起きない）。`model`（cap のモデル）は `task` に載せる欄が無いので `remote_send` から外した。server が `worker_report` 通知（progress / ask / approve / done）を送ってきたら、center は `RemoteView.worker_reports`（最大 20 件、到着順）に積み、未完了の指示の owner へ push する（progress は同じ worker から 60 秒に 1 回まで、ask / approve / done は毎回。owner が分からない = 未完了の指示が無い時は完了通知と同じく push しない）。ask / approve への返答は `worker_reply`。protocol の版が合わない server へは `task` / `worker_reply` を送らず error。
- （今は）center が remote 記録（server の cap 単位: remote_id, server, state, 時刻, 最新の result・error, 最新の result・error と時刻、最新の `task_result`、直近の `worker_reports`、未完了の指示 `pending`）をメモリ + `remotes.json` に持つ。未完了の指示 = 通知先の session（owner）、送った時刻、goal の先頭、`task_id` で、完了したら消す。履歴は持たない。center 再起動後は `running` と未完了の指示を失敗にせず復元し、server の status で追従する（取れなければ `unknown`）。完了は `cap_result` の即時ではなく、次の activity か猶予 15 秒の後の status で判定する（`cap_result` と activity の競合の対策）。
- （今は）完了 = cap が idle かつ配下の worker に running / stalled が無い。その時点で未完了の指示を全て完了にし、指示を送った session ごとに 1 回通知する（`cap_result` が来るたびに古い指示から順に完了にはしない。cap の返答本文がどの指示の結果かを含む）。どの session からでも同じ cap に行く。
- （今は）旧形式（作業ごとの cap）の記録は一覧に残さない。center の起動時に見つけたら server へ `stop_cap` を送り（届かなくてもよい。結果は center.log）、記録を消す。
- （今は）`remote_delete` は server に新命令 `stop_cap`（protocol `bantou` 1.1.0）を送る。止められない時、記録が `running` なら error（`force` で記録だけ消す）。cap は共有なので owner は見ない。
- （今は）owner の識別: http の header `X-Bantou-Session`（または URL query `session`）→ 無ければ tool 引数 `owner` → どちらも無ければ `remote_send` は error。`remote_list` は絞らず全件。
  - master-cap の接続に header を自動で載せる仕組みは入れていない。`claude remote-control` が `--mcp-config` / `--settings` を受けない（remote-control の前の global flag は spawn した session に引き継がれない）。`~/.claude.json` の書換えはユーザー設定の変更。`.mcp.json` の配置は承認プロンプト・未 trust・token 平文の問題がある。
  - 移行先: center が master-cap に道具を持たせる手段（remote-control 以外の起動、または master-cap 向けの MCP 設定を渡せる起動）が取れたら、session 名入りの header を center が付けて引数 `owner` は不要にする。
  - owner は自己申告で認証しない。

## server 側（`stop_cap`）

- protocol `bantou` を 1.0.0 → 1.1.0（`stop_cap` / `stop_result` 追加、error の `command` enum に `stop_cap`）。
- 走っている `claude -p` を process group ごと SIGTERM、3 秒で SIGKILL。子を `detached`（setsid）で起動するように変えた。中断された `kick_cap` は `cap_result`（`ok: false`、`stop_cap により停止`、再試行しない）で返る。待ちの指示も実行されない。
- 限界: 孫が別 group に出ていれば止まらない。cap の dir と state.json は消さない。stop 要求は全指示が片付くまで有効。

## 既存 tool との重複（整理はユーザー判断）

| 既存 | A / B との関係 |
|---|---|
| `rc_list` | `session_list` と同じ情報（`session_list` は `source` 付き、`RcStatus` の全項目ではない） |
| `rc_start` / `rc_stop` | config の project（`workspace` など）を起動・停止する。session は `session_create` / `session_delete`（`rc_stop` は session の entry も止められるが外さない） |
| `rc_status` | `session_list` の 1 件分（`RcStatus` の全項目 `args` `claude` `restarts` `environmentUrl` を含む） |
| `server_list` | `config.servers` ベース。B の発見ベースの選択とは別系統（B 用の一覧 tool は無い） |
| `cap_kick` | `remote_send` の同期版（返信まで待つ）。B は center の固定 cap_id の cap への指示、`cap_kick` は呼び手が cap_id を指定。外向けからは外している |
| `worker_resume` | B に対応なし（server は `resume_worker` を処理しない。型だけ残る） |
| `server_status` | B に対応なし（`remote_list` は center の記録で、server の state は見ない） |

## 未決

1. owner を master-cap の接続に自動で載せる手段（上記）。
2. （解決: 2026-11-04）既存 cap への追加指示は `remote_send` で B に入れた（cap は server ごとに 1 つ）。`cap_kick` を残すかは未決。
3. `server_list` / `server_status` / `worker_resume` の扱い（残す・消す）。
4. `running` のまま返信を失った remote の再同期（server の `status` と突き合わせる）。
5. 未 trust の path に session を作る手段（trust の付与を center が担うか）。
6. remote 記録の寿命（`done` / `failed` を自動で消すか）。
7. 古い peer が broker に残っている時の server 選択（先頭が古い peer になり得る）。
8. claude.ai 側に残る remote-control の environment / session 表示の後始末（CLI で消す手段を確認できていない）。
