# center の tool 仕様（実装済み、2026-10-29）

ドラフトを実装に落とした版。前提は `docs/concept.md`。各項目に「概念」（ユーザー確定の原則）か「今は」（いずれ変わり得る実装）を付ける。

## 前提（概念）

- ユーザーは番頭（bantou）と話し、番頭が全部を切り盛りする。PM（master-cap）を用意するのも番頭。
- master-cap は「考えて指示を出す」だけの中継役。実体（起動手段・場所・path）は本質ではない。
- center は master-cap に必要な道具を持たせてよい。agent-messenger の通信部分は center が持ち、master-cap ごとに messenger の MCP を抱えさせない。
- どの server で作業するか、worker を何本使うかは、ユーザーからはできるだけ見えなくする（master-cap に見えるのは構わない）。
- center の tool は 2 種類: (A) 番頭が使う、center 上の session（master-cap）の起動・削除。(B) center が master-cap に持たせる、server の remote-cap（session × server ごとに 1 つ）への指示・停止の道具。

## A. center 上の session（番頭が使う）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `session_create` | `name`（英数 `_-`）、`path?`、`permissionMode?`（既定 `auto`）、`settings?`（プロジェクト設定 `{ instructions?: string, … }`） | `{name, path, state, pid, sessionUrl, startedAt, source, lastError?}` | `claude remote-control --name <name>` を path で起動し、監視対象に加える |
| `session_delete` | `name` | `{name, deleted}` | remote-control を停止し、監視と保存から外す。path は消さない |
| `session_settings_get` | `name` | `{name, settings}` | session のプロジェクト設定を返す（未設定・config 由来は `settings: {}`） |
| `session_settings_update` | `name`、`settings`（項目ごとにマージ。`null` で項目を削除） | `{name, settings}` | プロジェクト設定を更新して `sessions.json` に保存。次の起動から効く。config 由来の project は拒否 |
| `session_list` | なし | 同上の配列 | config の project と session の全部（`source` で区別） |
| `center_info` | なし | `{ workspace: string \| null }` | center の情報。`workspace` は config の `workspace`（未設定は `null`）。`session_create` が `path` 省略時に使う `<workspace>/<name>` の親を、desktop の追加ダイアログが既定表示に使う。object のまま将来の項目を足す |

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
| `remote_send` | `goal`、`deliverables?`、`verify?`、`constraints?`、`workers?`、`worker_model?`、`repo?`、`branch?`、`server?` | `{remote_id, server, serverName, state, created, task_id, worker_model?}` | この session の remote-cap（cap_id = `c-<center-id>-<session 名>`。server ごとに 1 つ）に `task` を送る。`goal` だけなら他は既定（`deliverables:{}` `verify:{}` `constraints:[]` `workers:{}`。items 無し = implement + review の最低 2 体）。`task_id` は center が採番。返信（`task_result`）は待たない。cap が無い時は server が作る。他の session の cap には届かない |
| `remote_create` | 同上 | 同上 | `remote_send` の互換の別名（同じ処理） |
| `worker_reply` | `remote_id?`、`worker_id`、`text`、`server?` | `{remote_id, server, worker_id, accepted:true}` | server の worker へ返答を送る（`worker_report` の ask / approve への回答）。`remote_id` 省略時は呼び出し元 session の cap（server が複数あれば `server` で絞る）。他の session の cap には送れない（旧共有 cap は `remote_id` で明示）。desktop は外向け `/mcp` の同名 tool を `center_call` で呼ぶ |
| `remote_delete` | `remote_id?`、`server?`、`force?` | `{remote_id, deleted, stopped, warning?}` | server に `stop_cap` を送って実行を止め、記録を外す。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ（他の session の cap は見えない・触れない） |
| `remote_list` | `owner?`（外向け）、`include_shared?`（session 向け） | `RemoteView[]` | session × server の cap 単位。`session` を持つ。最新の `result` / `error` と時刻、最新の `task_result`、直近の `worker_reports`（最大 20 件、到着順）、未完了の指示 `pending`、`owners`（pending を持つ session）、`activity?` を含む（履歴は無い）。owner が分かればその session の未完了の指示がある cap、分からなければ全件（session 無しの旧共有 cap も含む）。session 向けは自分の cap だけで、`include_shared: true` で旧共有 cap も含める |
| `remote_wait` | `remote_id?`、`server?`、`timeout_sec?`、`owner?` | `RemoteView` | cap が idle で配下の worker に running / stalled が無くなるまで待つ。timeout は `state: running`。完了通知を受けられない session 用 |

決めた点:

- （概念）master-cap から server が見えること自体は構わないが、選ばなくても動く。`server` 省略で自動選択。
- （今は）server 選択は発見ベース: messenger の `listPeers("all", {protocol: "bantou"})` の先頭。`server` 引数は peer id、一致しなければ name。`config.servers` には依存しない（desktop は 2eceed7 以降 `servers` を書かない）。`config.servers` があれば先頭の client を共有し、無ければ内部 client 1 本（接続を増やさない）。既存 tool の挙動は変えていない。
- （確定: 2026-11-04。同日に次項で改訂）**remote-cap は 1 つの server につき 1 つだけ**。作業が何であれ、center はその cap に次の指示を送る。作業ごとに cap を作るのは資源（cap の path・プロセス・state）と設計（同じ server の cap が際限なく増え、片付けも要る）の両面で無意味なので止めた。protocol の `kick_cap` は同じ cap_id なら resume で、server は cap ごとに直列実行し worker の report で cap を再開するので、server 側の取り決めは変えていない。
- （確定: 2026-11-04、利用者の決定）**cap は session × server に 1 つ**（session = master-cap と remote-cap を 1 対 1）。理由: 1 server に cap 1 つを全 session で共有すると、他の session が作った cap とその指示・結果が見え、指示も混ざる。「作業ごとに cap を作らない」は維持する（session の cap に次の指示を送る）。
  - cap_id = `<center の cap_id>-<session 名>` = `c-<10 桁 hex>-<session 名>`（例 `c-0a1b2c3d4e-main`）。`remote_id` = cap_id。
  - 文字種と変換: session 名は `[A-Za-z0-9_-]+`（`SESSION_NAME` / `OWNER_PATTERN`。cap_id の `AGENT_ID_PATTERN` と同じ）で **64 文字まで**（`MAX_SESSION_NAME`。`session_create`・config の `projects[].name`・cap_id の生成（`remote_send`）で検証する）なので、**変換は恒等でエスケープは要らない**。この文字種に合わない名前、64 文字を超える名前は `remote_send` が error にする（黙って別の名前に寄せない・短縮もしない）。衝突しない根拠（server の FS が大文字小文字を区別しない場合を除く。下記）: center-id は `loadCapId` が正規表現 `^[0-9a-f]{10}$` で検証する**固定長 10 桁 hex（`-` を含まない）**で、接頭辞 `c-<10 桁 hex>-` は常に 13 文字。session 名に `-` が入っても、先頭 13 文字が center を、残りが session 名を一意に決める（`(center-id, session)` の組と cap_id は 1 対 1。別 center の `c-ab-c` のような id は作れない）。旧共有 cap の `c-<10 桁 hex>`（12 文字）は session 名の接尾辞が無く、どの session の cap_id（14 文字以上）とも一致しない。長さ上限の根拠: cap_id は server の `<workspace>/caps/<cap_id>` のディレクトリ名で、Linux の上限は 255 byte。server の検証（`AGENT_ID_PATTERN`）に長さ上限は無いので center 側で絞る。cap_id は最大 13 + 64 = 77 文字。大文字・`-`・`_` を含む 77 文字の id で作成・status・孤児回収が通ることは server のテストで確かめた。既に 65 文字以上の名前で作られた session（保存済み）は復元して残る（`remote_send` だけが error になる。session 自体は使える）。config の `projects[].name` は読み込み時に検証するので、65 文字以上の名前は center が起動時に config の error にする（名前を短くする）。大文字小文字を区別しない FS の server（macOS など）では `Main` と `main` が同じ dir になる（Linux の server では別。現状の server は Linux 前提で、center は server の FS を知らない）。将来 session 名の文字種を広げる時は、許可外の文字を `_` + 2 桁 hex（UTF-8 のバイトごと）に、`_` 自体も `_5F` に変えれば衝突しない（今は使わない。`_` を含む今の名前を変えないため）。
  - **境界（「他 session から見えない・触れない」を保証する範囲）**: 保証するのは **`/mcp/session`**（session ごとの使い捨て token + `X-Bantou-Session` の照合。owner = 認証済みの session 名で、引数の owner は受けない）だけ。**外向け `/mcp`（center token。desktop 用）**の `remote_list` / `remote_wait` / `worker_reply` は owner を自己申告でき、省略すると全件が対象になる。desktop は全件を取り、client 側で選択中 session の owner に絞って出す。外向け token を持つ呼び手は全 session の cap を見られる（desktop 用の窓口なので意図どおり）。
  - **session を消しても cap は残る（利用者の判断待ち）**: `session_delete` は remotes に触れない。その session の cap の記録・server の cap・動いている worker は残り、通知は送り先の session が無いので届かず、失敗のログだけ残る。同名の session を作り直すと同じ cap_id なので旧 cap を引き継ぐ。不要なら、session を消す前にその master-cap から `remote_delete` で消す（`remote_delete` は `/mcp/session` だけの tool。消した後は、同名の session を作り直してその master-cap から消す）。session 削除と一緒に cap を片付けるか、削除時に確認するかは未決定。
  - 記録は session × server に 1 件。記録（`remotes.json`）は cap_id をキーに `session` を持つ。server は記録の peer id（無ければ名前 + host）で照合する。同じ session が別の server に cap を持つ時、cap_id は同じで server が違う記録になる。
  - `remote_send`: 呼び出し元 session（`X-Bantou-Session`）の cap へ送る。記録が無ければ作る（cap は server が最初の `task` で作る）。`remote_list` / `remote_wait` / `remote_delete` / `worker_reply` は呼び出し元 session の cap だけが対象で、他 session の cap は `remote_id` を指定しても見えない（「未定義の remote」）。`remote_id` 省略時は自分の cap（server が複数あれば `server` で絞る）。外向け `/mcp`（desktop の `center_call`）は owner を持たないので全件。
  - 通知は cap の session にだけ送る（完了通知・`worker_report` の push）。`worker_report` は未完了の指示が無くても cap の session へ送る（cap に owner が 1 人に決まったため）。
  - 旧共有 cap（center 起動時の引き継ぎ）: 既存の `c-<center-id>`（と旧形式の cap）は **session 無し**の記録として残す。新しい指示は送らない（`remote_send` は常に session の cap_id へ行く）。session 向けの `remote_list` には出さない（`include_shared: true` で出す。外向け `remote_list` は全件なので出る）。`remote_delete` / `remote_wait` / `worker_reply` は **`remote_id` を明示した時だけ**旧共有 cap を対象にできる（例 `remote_delete({remote_id: "c-0a1b2c3d4e"})`。複数の server にあれば `server` で絞る）。`remote_id` 省略では対象にならず、他の session の cap はどちらにしても対象にならない。引き継ぎ前の未完了の指示があれば、その owner へ完了通知は届く。同じ server に旧形式が複数ある時の整理（動いている記録を残し他に `stop_cap`）は旧共有 cap の間でだけ行う（session の記録には触れない）。
  - server は変更不要: `cap_id` は `AGENT_ID_PATTERN` の検証だけで使い（path は `<workspace>/caps/<cap_id>`）、cap が増えるだけ。
- （旧。protocol 1.4.0 まで。1.5.0 は次項）`remote_id` = cap_id = `c-<10 桁 hex>`。center の状態 dir の `center-id` に持つ center ごとに固定の値（center を再起動しても同じ）。指示のたびに server の `status` で cap の有無を確かめ、無い時だけ最初の `kick_cap`（`model` / `worker_model` は引数 ?? config の `servers[]`（送信のたびに読み直す）、無ければ付けない。既存の cap では `model` は無視して `model_ignored` を返し、`worker_model` は引数があった時だけ載せる）。あれば同じ cap_id の `kick_cap`（resume）。返信は待たず `{state: "running", created}` を返す。返信（`cap_result` / `error`）で記録を更新し、最新の result / error（8000 文字まで）と時刻を更新する（履歴には積まない）。cap が実行中なら center の link が同じ cap_id の指示を直列にし（返信の取り違え防止）、server 側も cap ごとに直列。
- （今は、protocol 1.5.0）`remote_send` は `kick_cap` ではなく `task`（`goal` と、省略可の `deliverables` / `verify` / `constraints` / `workers` / `repo` / `branch` / `worker_model`）を送る。`task_id` は center が採番し、未完了の指示にも持つ。返信は `task_result`（最新を `RemoteView.task_result` に持ち、`result` は summary）。同じ `task_id` の `task_result` が report 起因の再開で重ねて届いても、完了判定・通知は指示ごとに 1 回（未完了の指示が無ければ何も起きない）。`model`（cap のモデル）は `task` に載せる欄が無いので `remote_send` から外した。server が `worker_report` 通知（progress / ask / approve / done）を送ってきたら、center は `RemoteView.worker_reports`（最大 20 件、到着順）に積み、未完了の指示の owner へ push する（progress は同じ worker から 60 秒に 1 回まで、ask / approve / done は毎回。owner が分からない = 未完了の指示が無い時は完了通知と同じく push しない）。ask / approve への返答は `worker_reply`。protocol の版が合わない server へは `task` / `worker_reply` を送らず error。
- （今は）center が remote 記録（server の cap 単位: remote_id, server, state, 時刻, 最新の result・error, 最新の result・error と時刻、最新の `task_result`、直近の `worker_reports`、未完了の指示 `pending`）をメモリ + `remotes.json` に持つ。未完了の指示 = 通知先の session（owner）、送った時刻、goal の先頭、`task_id` で、完了したら消す。履歴は持たない。center 再起動後は `running` と未完了の指示を失敗にせず復元し、server の status で追従する（取れなければ `unknown`）。完了は `cap_result` の即時ではなく、次の activity か猶予 15 秒の後の status で判定する（`cap_result` と activity の競合の対策）。
- （今は）完了 = cap が idle かつ配下の worker に running / stalled が無い。その時点で未完了の指示を全て完了にし、cap の session に 1 回通知する（`cap_result` が来るたびに古い指示から順に完了にはしない。cap の返答本文がどの指示の結果かを含む）。（旧: 「どの session からでも同じ cap に行く」は cap per session で廃止）
- （確定: 2026-11-04）remote-cap は center の指示で作られ、その記録は center が保存して再起動で復元し、以後の指示はその記録の cap に送る。**記録を消すのは `remote_delete` だけ**。旧形式（作業ごとの cap。`remote_id` が center の cap_id と違う・`history` 形式など）の記録は、center の起動時に、その server の cap として新しい形に引き継ぐ（cap_id はそのまま）。同じ server に複数あれば、動いている（`running` / `unknown` / 未完了の指示あり）記録を最優先し、同順位なら最新（`createdAt` / `finishedAt` / `result_at` / `error_at` のうち最も新しい時刻）を残し（同じ server = peer id が同じ、または名前 + host が同じ。host の無い旧記録は、今の peer で同名の server が 1 つだけと確かめられた時だけその host の server とみなす。確かめられない（peer が引けない・同名の peer が複数）host 無しの記録は、他の記録と一緒にせず、stop_cap も送らずそのまま残す。次の status 成功時に host が入る）。理由: 最新だけで選ぶと、動いている旧 cap より新しい完了済みの記録が残り、動いている cap へ `stop_cap` が飛ぶため（利用者の決定「最新の 1 件を残す」からの意図した調整）。動いている記録が複数なら最新の動いている記録を残し、他（動いている記録を含む）へ `stop_cap` を送る。他は `stop_cap` を送って（届かなくてもよい。結果は center.log）記録を消す（作業ごとの cap の後始末。1 回限り）。cap_id は **server ごとに記録が持つ**（記録の無い server は center の `center-id` の cap_id で作る）。以前の「旧形式の記録は一覧に残さず `stop_cap` で掃除」は止めた。
- （確定: 2026-11-04、protocol 1.6.0）server は cap の center を peer の**名前**（`from_name`。center は `bantou-center` で固定）で覚え、送る時に今の peer id へ引く。理由: center を再起動すると peer id が変わり、peer id で覚えていた server からの activity / cap_result / task_result / worker_report が古い id 宛てに送られて消えた（実機で確認: 再起動後、hello の返信だけ届き、動いている cap の activity が一切来なかった）。名前で同じ peer が複数いれば、最後に命令を送ってきた id を優先する（いなければ最後に登録した peer）。cap_id 付きの命令（`task` / `kick_cap` / `status`（cap_id 付き）/ `worker_reply` / `stop_cap`）を受けるたびに通知先を更新する。center は起動時に、記録の各 cap について server へ `status`（`cap_id` 付き。protocol 1.6.0 で `cap_id?` を追加）を送り、通知先を取り戻す（server が見えるまで 15 秒ごとに最大 20 回再試行。状態の追従の `status` を送る記録はそれが兼ねる）。
- （今は）`remote_delete` は server に新命令 `stop_cap`（protocol `bantou` 1.1.0）を送る。止められない時、記録が `running` なら error（`force` で記録だけ消す）。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ（旧: 「cap は共有なので owner は見ない」は廃止）。
- （今は）owner の識別: http の header `X-Bantou-Session`（または URL query `session`）→ 無ければ tool 引数 `owner` → どちらも無ければ `remote_send` は error。`remote_list` は owner が分かればその session の cap だけ、分からなければ全件。
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
| `cap_kick` | `remote_send` の同期版（返信まで待つ）。B は center の session ごとの cap_id（`c-<center-id>-<session>`）の cap への指示、`cap_kick` は呼び手が cap_id を指定。外向けからは外している |
| `worker_resume` | B に対応なし（server は `resume_worker` を処理しない。型だけ残る） |
| `server_status` | B に対応なし（`remote_list` は center の記録で、server の state は見ない） |

## 未決

1. owner を master-cap の接続に自動で載せる手段（上記）。
2. （解決: 2026-11-04）既存 cap への追加指示は `remote_send` で B に入れた（cap は server ごとに 1 つ → 2026-11-04 以降は session × server に 1 つ）。`cap_kick` を残すかは未決。
3. `server_list` / `server_status` / `worker_resume` の扱い（残す・消す）。
4. `running` のまま返信を失った remote の再同期（server の `status` と突き合わせる）。
5. 未 trust の path に session を作る手段（trust の付与を center が担うか）。
6. remote 記録の寿命（`done` / `failed` を自動で消すか）。
7. 古い peer が broker に残っている時の server 選択（先頭が古い peer になり得る）。
8. claude.ai 側に残る remote-control の environment / session 表示の後始末（CLI で消す手段を確認できていない）。
