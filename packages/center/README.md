# bantou-center

素のエージェント（Claude Code など）が MCP tool 経由で cap 運用できるようにする MCP server。stdio と Streamable HTTP で動く。

役割は 3 つ。

- center 上の session（master-cap）の起動・削除（`session_*`、下記「session」）。
- master-cap に持たせる remote session（remote-cap）の起動・削除（`remote_*`、下記「remote」）。
- project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰。
- リモートホストの bantou-server への指示（task / worker_reply / kick_cap / resume_worker / status）の中継。

desktop が裏で起動する予定（アプリ設定で on/off）。現時点では単体で `claude mcp add` して使う。

## 起動

```bash
npx bantou-center --config ~/.config/bantou/center.json
```

`--config` の既定は `~/.config/bantou/center.json`。

```
bantou-center [--config <path>] [--transport stdio|http] [--port <n>] [--bind <addr>]
```

| フラグ | 既定 | 説明 |
|---|---|---|
| `--transport` | `stdio` | `stdio` / `http` |
| `--port` | `7910` | http の待受ポート。`0` は OS 任せ（実ポートは stderr のログに出る）。stdio では無視 |
| `--bind` | `127.0.0.1` | http の bind アドレス。stdio では無視 |

不明な引数・不正な値は usage を stderr に出して exit 2。

### http transport

- エンドポイントは `http://<bind>:<port>/mcp`（外向け。MCP Streamable HTTP。POST / GET / DELETE）と `/mcp/session`（master-cap 向け。下記「窓口の分離」）。pty 出力の配信は `/sessions/<name>/{output,input,resize,attachments}`（下記「core」「添付画像」）。statusLine の受信は `POST /sessions/<name>/status-line`、claude の hook の受信は `POST /sessions/<name>/hook`（どちらも session token。下記「context 使用量」「作業状態（activity）」）。それ以外は 404。
- **認証は Bearer token**。`/mcp` へのリクエスト（POST / GET / DELETE すべて）は `Authorization: Bearer <config の token>` が必要で、欠落・形式違い・不一致は 401（`WWW-Authenticate: Bearer`）。比較は定時間。token が無い・12 文字未満だと http は起動しない。既定は loopback にだけ bind する。`--bind 0.0.0.0` 等で外に出しても、token を知らない相手は rc_start などを呼べない（ただし TLS は無いので平文。信頼できる LAN だけで使う）。
- MCP session ごとに McpServer を作る。supervisor と server 接続は全 session で共有。
- SIGTERM / SIGINT で http server・全 session・全 project を停止して exit 0。http では stdin を見ない（親が `/dev/null` を渡しても落ちない。親は SIGTERM で止める）。
- 親プロセスが死んだら同じ手順で停止して exit 0。2 秒ごとに `ppid` を見て、起動時の値から変わったら（orphan で 1 / launchd に付け替わったら）終了する。
- DNS rebinding 対策（Host / Origin 検査）は `--bind` が loopback（`127.0.0.1` / `localhost` / `::1`）の時だけ効く: Host は `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` だけ通し、それ以外は 403（ポート無しも 403）。Origin は付いていれば `http://<上記 Host>` だけ通す。loopback 以外の bind（`0.0.0.0` / `::` / LAN の IP）では別ホストから届く前提なので Host / Origin は絞らず、Bearer token だけで守る。
- session は 30 分リクエストが無いと閉じる（処理中のリクエストや開いたままの SSE がある間は閉じない）。閉じた session への要求は 404 なので、クライアントは再 initialize する。
- 同時 session は最大 32。超えた新規 initialize は 503（`Retry-After: 30`）。
- POST ボディは 4 MiB まで。超えたら 413 を返して接続を閉じる。

Claude Code への登録例:

```bash
claude mcp add bantou-center -- node /path/to/packages/center/dist/cli.js --config ~/.config/bantou/center.json
```

stdout は MCP の通信路。ログは全て stderr に出る。

## config

```json
{
  "projects": [
    { "name": "bantou", "path": "/home/me/work/bantou", "spawn": "same-dir", "permissionMode": "auto", "capacity": 4, "autostart": true, "env": { "FOO": "bar" } }
  ],
  "remoteControl": { "env": { "CLAUDE_CONFIG_DIR": "/home/me/.claude-rc" }, "continueOnRestart": true, "restartDelayMs": 5000, "maxRestarts": 5, "stopGraceMs": 5000 },
  "servers": [
    { "name": "linux204", "timeoutMs": 2100000 },
    { "name": "named", "peer": "my-bantou-server", "model": "opus", "workerModel": "sonnet" }
  ],
  "logDir": "/home/me/.config/bantou/center-logs",
  "workspace": "/home/me/.bantou",
  "token": "（http transport で必須。12 文字以上のランダム文字列）"
}
```

| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `projects[].name` | `[A-Za-z0-9_-]+` | 必須 | project 名。重複不可。`--name` に渡す |
| `projects[].path` | 絶対パス | 必須 | remote-control の cwd |
| `projects[].spawn` | `same-dir` / `worktree` / `session` | `same-dir` | `--spawn` |
| `projects[].permissionMode` | `acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan` | `auto` | `--permission-mode` |
| `projects[].capacity` | 1 以上の整数 | 指定なし | `--capacity` |
| `projects[].autostart` | boolean | `false` | center 起動時に remote-control も起動する |
| `projects[].env` | `{ KEY: string }` | なし | この project の子プロセスに足す環境変数（`remoteControl.env` より優先） |
| `remoteControl.claude` | string | 未指定 | claude 実行ファイル。未指定なら起動時に自動解決（「claude の解決」節） |
| `remoteControl.env` | `{ KEY: string }` | なし | 全 project の子プロセスに足す環境変数 |
| `remoteControl.continueOnRestart` | boolean | `true` | 再起動時に `--continue` を付ける（`spawn` が `worktree` / `session`、または `capacity` 指定の project は付けない。下記参照） |
| `remoteControl.autoConsent` | boolean | `true` | 起動時の確認プロンプト（`Enable Remote Control? (y/n)`）に自動で `y` を返す |
| `remoteControl.restartDelayMs` | 0 以上の整数 | `5000` | 異常終了から再起動までの待ち |
| `remoteControl.maxRestarts` | 0 以上の整数 | `5` | 再起動回数の上限 |
| `remoteControl.stopGraceMs` | 0 以上の整数 | `5000` | SIGTERM から SIGKILL までの猶予 |
| `remoteControl.model` | 文字列（`^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`） | なし | master-cap（`session_create` の wrapper 経由の対話型 claude）の `--model` にそのまま渡す。未指定なら付けない。config 由来の project（`claude remote-control` 直起動）には効かない |
| `servers[].name` | `[A-Za-z0-9_-]+` | 必須 | server 名。重複不可。tool の `server` 引数で使う |
| `servers[].peer` | string | なし | server の peer 名または id。指定すると発見せずその名前へ送る（従来の名前指定）。省略すると `list_peers`（`protocol: "bantou"`）で自動発見する |
| `servers[].timeoutMs` | 正の整数 | `2100000`（35 分） | 返信待ちの打ち切り |
| `servers[].model` | 文字列（`remoteControl.model` と同じ形式） | なし | この server の remote-cap（cap を作る最初の `kick_cap`）の `--model` の既定。`remote_send` は `task` を送り、`task` に cap のモデルの欄は無いので、`remote_send` では使われない（`cap_kick` 用） |
| `servers[].workerModel` | 同上 | なし | この server の remote-cap が起動する worker の既定モデル（`task` の `worker_model`）の既定。`remote_send` の `worker_model` 引数が優先。cap が無い時（新規の cap）の `task` にだけ載せる。省略時は指定しない。同上（送信のたびに読み直す） |
| `remotes.pushProgress` | boolean | `false` | server の `worker_report` のうち kind=progress を session へ push するか。`false` なら push しない（`remote_list` の `worker_reports` には常に積む）。`true` なら同じ worker から 60 秒に 1 回まで push する。ask / approve / done と完了通知（`task_result`）は常に push する。center の設定のみ（desktop の設定画面には無い）。progress を受けるたびに読み直す |
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |
| `workspace` | 絶対パス | なし | `session_create` で `path` 省略時の置き場所 `<workspace>/<name>` の親。session は起動時に立てない |
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### config の読み直し

center は wrapper 経由の session（master-cap）を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に `--config` のファイルを読み直す。center は再起動しない。動いている session には効かない。保存後に起動する session から効く。

- 読み直しで効く: `remoteControl.model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`（その session の起動時点の値。再起動の予約もその起動で読んだ値で決める）。
- `remotes.pushProgress` は progress の `worker_report` を受けるたびに読み直す（読めない時は直前に読めた値）。
- `servers[].model` / `servers[].workerModel` は `remote_send` のたびに読み直す（読めない時は直前に読めた値で送り、center.log に残す）。
- 起動時にしか効かない（変えるには center の再起動が要る）: `remoteControl.claude`（起動時に解決する）、`remoteControl.stopGraceMs`、`projects`、`servers`（`model` / `workerModel` 以外）、`logDir`、`workspace`、`token`、port / bind。
- 読み直しに失敗した時（ファイル無し・JSON が壊れている・検証 NG）は、直前に読めた値（まだ読めていなければ起動時の値）で起動し、理由を `center.log` に 1 行残す: `config の読み直しに失敗。直前の値で起動: project=… <理由>`。session の起動は止めない。
- config 由来の project（`claude remote-control` 直起動）の `projects[]` の値は起動時にしか効かない。`remoteControl` の値は、その project の起動でも読み直した値になる。
- 設計: `docs/design/master-cap-session.md` 決定 16。

### server の発見（protocol 方式）

- center は普通の agent-messenger client として、通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）で broker につなぐ。broker の URL は指名しない（旧 `servers[].broker` / `servers[].token` は廃止。書いても無視される。token が要る場合は `AGENT_MESSENGER_TOKEN`）。server の peer は、リクエストごとに `listPeers("all", {protocol: "bantou"})` で発見する（peer id は再登録で変わるため）。複数見つかれば name が `bantou-server` のものを優先し、無ければ先頭。0 件、または 0.9 系 broker（`BROKER_UNSUPPORTED`）の時は peer 名 `bantou-server` 宛てにフォールバックする。`servers[].peer` を指定すると発見せずその名前へ送る。
- 送信は `send(to, text, "pull", {protocol: "bantou", version})`。version は発見した peer が宣言している値（名前宛ての時は `MESSENGER_PROTOCOL.version`）。
- 受信は、送信元が解決済みの peer id、meta の protocol が `bantou`、name が `bantou-server`、`servers[].peer` のいずれかなら server の返信として扱う。text 先頭の `[agent-messenger warning]` 行（version 不一致時に付く）は除いてから JSON として解釈する。
- 仕様は `../protocol/messenger/protocol.json` と `../../docs/protocol.md`。

## tools

概念は `docs/concept.md`、設計の経緯は `docs/design/center-tools.md`。`session_*` が A（番頭が使う、center 上の master-cap）、`remote_*` が B（center が master-cap に持たせる、server への指示の道具）。`rc_*` `server_*` `worker_resume` は従来の tool で、そのまま残している。窓口は 2 つに分かれる（「窓口の分離」）。外向け `/mcp` の tool は下の表のうち `remote_send` / `remote_create` / `remote_delete`（session 向け `/mcp/session` だけ）を除いたもの（`worker_reply` は両方にある。desktop は `center_call` で外向けの `worker_reply` を呼ぶ）。`cap_kick` は外向けからも外した。

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `session_create` | `name`, `path?`, `permissionMode?`, `settings?`（プロジェクト設定。下記） | `SessionInfo`（下記） |
| `session_update` | `name`, `newName?`, `path?`（絶対パス）, `move?`（`path` 指定時のみ） | `SessionInfo`（更新後。手順と注意は下記） |
| `session_settings_get` | `name` | `{ name, settings }`（未設定・config 由来は `settings: {}`） |
| `session_settings_update` | `name`, `settings`（項目ごとにマージ。`null` で項目を削除） | `{ name, settings }`（更新後の全体） |
| `center_settings_get` | なし | `{ settings }`（center 共通の設定。`servers` は無い。未設定は `{}`） |
| `center_settings_update` | `settings`（項目ごとにマージ。`null` で項目を削除。`servers` は共通では持てず、null 以外を渡すと error） | `{ settings }`（更新後の全体。全 session の次の起動から効く） |
| `session_delete` | `name` | `{ name, deleted }` |
| `session_list` | なし | `SessionInfo[]` |
| `session_login` | `name` | `{ name, loginUrl }`。session の claude に `/login` を打ち、認証 URL が出るまで待つ（上限 15 秒）。下記「再ログイン」 |
| `session_login_code` | `name`, `code` | `{ name, ok, auth, error }`。認証コードを投入して結果を待つ（上限 30 秒）。`ok: false` は `isError` |
| `center_info` | なし | `{ workspace: string \| null, systemInstructions: [{ id, version, title }] }`（`workspace` は config の `workspace`。未設定は `null`。desktop の追加ダイアログがフォルダ欄の既定 `<workspace>/<name>` を出すのに使う。`systemInstructions` は master-cap の起動時に付けるシステム埋め込み指示の部品（条件付きの `memory@1` も含む）。項目は今後増える） |
| `remote_send`（session 向けのみ） | `goal`, `deliverables?`, `verify?`, `constraints?`, `workers?`, `worker_model?`, `repo?`, `branch?`, `server?` | `{ remote_id, server, server_id?, peer, host?, serverName, state, created, task_id, worker_model?, delivered, delivery, delivered_at?, delivery_basis?, error? }`（task_result は待たない。server が task を受け付けたことは最大 15 秒（`ACK_TIMEOUT_MS`、環境変数 `BANTOU_REMOTE_ACK_TIMEOUT_MS`）確かめてから返す。確認できなければ isError で `delivered: false`。`server` は server_id、旧 server は peer id。`peer` は今の到達先、`host` は host 名）。呼び出し元 session の remote-cap（server ごとに 1 つ。cap_id = `c-<center-id>-<session 名>`）へ `task` を送る。owner は header の session 名。他の session の cap には届かない。`goal` だけなら `deliverables: {}` / `verify: {}` / `constraints: []` / `workers: {}`（items 無し = implement + review の最低 2 体）。`task_id` は center が採番。`worker_model` は新規の cap なら「引数 ?? config `servers[].workerModel`」、既存の cap は引数があった時だけ載せる（server が cap の既定として記憶する）。protocol の版が合わない server へは送らず isError。受け付けを観測できた時は `delivered: true`・`delivery: "observed"`・`delivered_at`・`delivery_basis`（`task_id` = 自分の task_id の worker_report が届いた / `task_result` / `status` = status の変化からの推定。server の ack ではないので accepted とは名乗らず observed）、確認できない時は isError で `delivered: false`・`delivery: "sent"`（または `"unsent"`）・`error`（task は pending に残る。再送する前に `remote_list` で `delivery` を確認する） |
| `remote_create`（session 向けのみ） | 同上 | `remote_send` の互換の別名（同じ処理） |
| `worker_reply` | `remote_id?`, `worker_id`, `text`, `server?` | `{ remote_id, server, worker_id, accepted: true }`。server の worker へ返答を送る（`worker_report` の ask / approve への回答。server が同じ `worker_id` で worker を起動し直して `text` を渡す）。`remote_id` 省略時は呼び出し元 session の cap（server が複数あれば `server` で絞る）。他の session の cap には送れない（旧共有 cap は `remote_id` で明示）。外向け（desktop）は owner を持たないので全件が対象。protocol の版が合わない server へは送らず isError。session 向け・外向けの両方 |
| `remote_delete`（session 向けのみ） | `remote_id?`, `server?`, `force?` | `{ remote_id, deleted, stopped, session_cleared, previous_session_id?, warning? }`。cap を閉じる（`stop_cap`: 実行中なら止め、server 側の cap の会話も破棄）と記録の削除。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ（他の session の cap は見えない・触れない）。`remote_id` 省略時は自分の cap（server が複数あれば `server` で絞る） |
| `remote_list` | `owner?`（外向け。無ければ全件）。session 向けは `include_shared?`（旧共有 cap も含める）で、自分の session の cap だけ | `RemoteView[]`（server の cap 単位。`RemoteRecord` + `owners` + `worker_reports` + `reachability` + `cap_state` + `activity?`、下記。`task_result?`（最新の `task_result` 本体）、`server_label`（host 名を主に server_id を添えた表示）を含む） |
| `remote_wait` | `remote_id?`, `server?`, `timeout_sec?`（既定 600、上限 1800）, `owner?`（外向けのみ） | 終わった `RemoteView`。timeout なら `state: "running"` のまま。下記「完了通知」 |
| `rc_list` | なし | `RcStatus[]` |
| `rc_start` | `project`, `resume?` | `RcStatus`（起動済みなら現状を返す。`resume: true` で `--continue`、復帰できなければ素の起動） |
| `rc_stop` | `project` | `RcStatus` |
| `rc_status` | `project` | `RcStatus` |
| `server_peers` | `refresh?` | `{ pair: { server, protocol }, peers: FollowEntry[] }`。下記「server の版合わせ」 |
| `server_list` | なし | `{ name, connected, reachable, peerId, serverPeer, server_id?, host?, user?, workspace? }[]`（`reachable` は broker への接続を確保できたか、`peerId` は center 自身の peer id、`serverPeer` は直近に解決した server の送信先（peer id か名前、未解決は null）。`server_id` / `host` / `user` / `workspace` は、その `serverPeer` から hello_result / status_result で識別を学習済みの時だけ付く（未学習・旧 server は無い。`server_peers` の `server_id` と突き合わせる鍵）） |
| `worker_resume` | `server`, `worker_id`, `prompt`, `repo?`, `branch?` | `worker_result` / `error` 返信そのまま |
| `server_status` | `server` | `status_result` / `error` 返信そのまま |
| `server_retire` | `server`（server_id / host 名 / peer id。省略不可）, `reason?` | `{ ok, state: "retiring" \| "already_retiring", server_id, host?, user?, workspace?, peer, stopped?: { caps, workers }, exit_at?, exit_code?, host_steps?, service?, records_removed, sessions, message }`。server を退役させる（取り消せない）。下記「server の退役」 |

- `worker_id` は `[A-Za-z0-9_-]+`、`prompt` は 1 文字以上、`repo` / `branch` は `-` で始められない。
- `worker_resume` / `server_status` は、返信が `error` か `ok: false` の時に `isError: true` になる。本文は返信そのまま。
- `worker_resume` は返信が来るまで待つ（claude の実行が終わるまで数分）。`timeoutMs` で打ち切り、`タイムアウト` の `error` 返信になる。
- 同じ `cap_id`（`worker_id`）への指示は center 側でも直列にする。`error` 返信は `cap_id` / `worker_id` があればその ID で照合し、無ければ同じ `command` の最古の待ちに割り当てる。
- 返信の形は `packages/protocol` の `server.ts` と `packages/server/README.md` を参照。

`RcStatus`:

| フィールド | 説明 |
|---|---|
| `project` / `path` | project 名と cwd |
| `state` | `stopped` / `starting` / `connected` / `error` |
| `pid` | 子プロセスの pid。動いていなければ `null` |
| `sessionUrl` / `environmentUrl` | 出力から拾った URL（`claude.ai/code/session_...`、`environment=env_...`） |
| `restarts` | 自動再起動の回数 |
| `lastExit` | 直近の終了 `{ code, signal, at }` |
| `lastError` | `error` 状態の理由。接続前に終了した時は `接続前に終了: <直近の出力 1 行>` |
| `startedAt` / `args` | 直近の起動時刻と引数 |
| `claude` | 起動に使う実行ファイル `{ path, source }`。`source` は `config` / `login-shell` / `fallback-path` / `PATH` |
| `auth` | claude の認証状態（wrapper 経由の session のみ変わる）。`ok` / `login_required`（`Please run /login` が出た。OAuth token 切れ）/ `keychain_locked`（`/login` の保存に失敗 `Couldn't save your login`。macOS の keychain がロック）。起動ごとに `ok` に戻る |
| `loginUrl` | `/login` が表示した認証 URL。`Login successful` か次の起動まで残る |
| `loginError` | `/login` の失敗理由（`Invalid code` / `Couldn't save your login`）。`session_login` / `session_login_code` の開始と成功で消える |

`SessionInfo` は `RcStatus` の `project`（`name` として）/ `path` / `state` / `pid` / `sessionUrl` / `startedAt` / `lastError?` / `auth` / `loginUrl` / `loginError` に `source`（`config` / `session`）を足したもの。`state` は `stopped` / `starting` / `connected` / `error`。

### session（A）

- `session_create`: pty wrapper 経由の対話型 `claude --remote-control <name> --permission-mode <permissionMode> --mcp-config '<JSON>'`（再起動時は `--continue` 付き）を `path` で起動し、supervisor に動的に足す（起動の詳細は「master-cap の起動（wrapper）」）。`path` 省略時は config の `workspace` の下の `<name>`（無ければ作る）。`workspace` が無ければ `path` が必須。`permissionMode` の既定は `auto`。`name` の重複、既存 project 名との衝突、他の project / session と同じ path は拒否。接続（URL 取得）か早期終了まで最大 15 秒待って状態を返す（待ちきれなければ `starting`）。
- `session_update`: `session_create` で作ったものだけ（config 由来・未定義は `session_delete` と同じ文言で拒否）。`newName`（既存の session / project 名と重複不可）と `path`（他の session / project と重複不可、絶対パス）を変える。`newName` も `path` も実質変わらない呼び出しは拒否。手順: (1) 検証 (2) `supervisor.remove`（停止・core / token の解除） (3) `path` 指定時は、`move: true` なら今のフォルダを新しい `path` へ `fs.rename` で移動（親 dir は作る。EXDEV など失敗したら error にして何も変えない。コピーはしない）、そうでなければ新しい `path` を作るだけ（今のフォルダは残す。`move` は `path` が無ければ無視） (4) `sessions.json` の `name` / `path` を更新（`settings`・並び順はそのまま） (5) 名前を変えたら remotes の記録を付け替え (6) 新しい名前で `add` → `start(resume)` (7) `session_create` と同じ待ちで `SessionInfo` を返し、`GET /events` に `reason: "updated"`（`name` = 新しい名前）を流す。途中で失敗したら記録・フォルダの移動・remotes の付け替えを戻し、元の名前で起動し直す（best effort。失敗は center.log）。`instructions` / `addDirs` は新しい名前へ引き継ぐ。
  - **path を変えると `--continue` が効かない**: claude の会話は path ごとに保存されるため、新しい path では `--continue` が「会話が無い」で落ち、既存の fallback で素の起動（新しい会話）になる（仕様）。名前だけ変えた時は同じ path なので会話は続く。`move: true` でフォルダを移しても会話の保存先（`~/.claude/projects/<path を変換した dir>`）は移らない。
  - **cap_id は変わらない**: remote の記録（`session` と未完了の指示の `owner`）だけ新しい名前へ付け替える。cap_id は `c-<center-id>-<旧名前>` のままで、server 上の cap をそのまま使う（以後の `remote_send` も記録の cap_id を使う）。
  - **別の session の remote 記録と衝突する名前は使えない**（`remote_delete` で記録を消せば使える）: (a) 改名後、旧名の cap_id を新しい名前の記録が持つので、旧名での `session_create` と、別の session から旧名への改名は拒否（改名した session 自身が旧名へ戻す改名は、その記録が改名元のものなので許す: pm1 → pm2 → pm1）。(b) 削除済み session の記録が残る名前への改名も拒否。許す: `session_delete` 後に**同じ名前で `session_create`** した時は、その名前の記録を続きとして引き継ぐ（旧 cap を使う。従来どおり）。
  - 名前を変えると remote-control 名・messenger の peer 名・ログ名（`<name>.log`）・statusLine の URL も新しい名前になる。旧名前宛ての messenger 通知は届かない。
- `session_delete`: `session_create` で作ったものだけ。remote-control を停止（SIGTERM → `stopGraceMs` 後 SIGKILL）して監視と保存から外す。path は消さない。config 由来の project は拒否。
- `session_list`: config の project と session の全部。`source` が `config` / `session`。`instructions`（真偽。その session を起動した時に `--append-system-prompt`（session の `instructions`）を付けたか。本文は出さない。`rc_status` の `instructions` と同じで、`rc_status` の `args` でも値は `<N 文字>` に伏せる）が付く。`contextUsage`（`{ usedTokens, windowTokens, percent, updatedAt, model? }`。`model` は statusLine 由来の時だけ。まだ分からない時は `null`）が付く。取得の仕組みは「context 使用量」。
- プロジェクト設定（`settings`、設計は `docs/design/project-settings.md`）: session ごとの設定。`{ instructions?: string, addDirs?: string[], outputStyle?: string, servers?: string[], memory?: { url, token?, agentId? }, … }`。`servers` は下記「session ごとの使う server（servers）」。`addDirs` は master-cap が参照してよいフォルダ（center のホスト上の絶対パス、20 個以内、重複は除く）で、起動のたびに 1 つずつ `claude --add-dir <path>` で渡す（空配列は削除と同じ）。`session_create` の `settings` で作成時に渡し、`session_settings_get` で読み、`session_settings_update` でマージ更新する（`settings` に書いた項目だけ変わる・省略した項目は変わらない・`null` で項目を削除・未知の項目は保持して返す）。`sessions.json` の各 session の `settings` に保存する。config 由来の project は更新できない（get は `{}`）。更新は次の起動から効く（動いている session は起動し直さない）。
- `settings.instructions`（追加指示、16000 文字以内、空文字は削除と同じ）: session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動・center 再起動後の復元）に、値があれば claude へ `--append-system-prompt <値>` を足す。argv の 1 引数で渡し、shell は通さない（複数行・引用符・`$` もそのまま届く）。center の config（`center.json`）の `remoteControl.sessionInstructions` は廃止: 残っていても無視し、起動時の読み込みで `center.log` に warning を 1 行出す（値は出さない）。
- `settings.outputStyle`（claude の output style の本文、32000 文字以内、空文字は削除と同じ。`src/output-style.ts`）: session を起動するたびに、値があれば session のフォルダ（`path`）の `.claude/output-styles/bantou.md` に書き（frontmatter の `name` は center が `bantou` に差し替え、`description` / `keep-coding-instructions` など他の key は残す。frontmatter が無ければ name と description を付ける）、`--settings` の JSON に `"outputStyle":"bantou"` を足す（statusLine / hooks と同じ JSON。MCP 窓口が無い stdio でも付ける）。値が無ければファイルを消し `outputStyle` を付けない。書けない時は `center.log` に出して style 無しで起動する。session の値があれば center 共通の値は使わない（1 つしか選べないので連結しない）。2026-11-11 に足した（実測: project の `.claude/output-styles/` の style は `--settings {"outputStyle":<name>}` で選べる）。
- `settings.memory`（外部記憶の MCP endpoint `{ url: string, token?: string, agentId?: string }`、`null` で削除。設計は `docs/design/external-memory.md`）: 値があれば session を起動するたびに `--mcp-config` の `mcpServers` に `memory`（`type: "http"`、`url`、`headers: { Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}", "X-Agent-Id": <agentId か session 名> }`）を足し（`bantou-messenger` / `bantou` と並ぶ。tool は `mcp__memory__*`）、system-instructions に部品 `memory@1` を付ける。検証: `url` は http / https の絶対 URL（2048 文字以内、`user:pass@` 不可）、`token` は 4096 文字以内で空白・制御文字・非 ASCII 不可、`agentId` は `^[A-Za-z0-9_-]+$` で 64 文字以内。token は claude の環境変数 `BANTOU_MEMORY_TOKEN` だけで渡し（`BANTOU_SESSION_TOKEN` と同じ）、`--mcp-config`・argv・log・status・`session_list`・`center_info` に実値を出さない。token が無ければ Authorization を付けない。`session_settings_get` / `center_settings_get` と update の応答は token を返さず `{ url, agentId?, tokenSet }`。更新は object ごとの置き換えで、`token` 省略は今の token を引き継ぎ、空文字で消す。session の値があれば center 共通の値は使わない（`outputStyle` と同じ）。memory（mcp-config の `memory` と `memory@1`）は session_create で作った session（wrapper 経由）にだけ付き、config の `projects` を従来の `claude remote-control` で起動する rc 直起動には付かない。session の `null` は共通に戻るだけで、共通の memory を session だけ無効にする手段は無い（別 task の課題）。反映は次の起動から（`servers` のような起動し直し不要ではない）。agentId 未設定の `X-Agent-Id` は session 名なので改名で変わる（固定するなら agentId を設定）。url に秘密や `${…}` は書かない（query の秘密は ps と log に出る。`${…}` は claude が展開して memory の host へ送る。検証で拒否する）。`--mcp-config` の `${VAR}` 展開は claude の docs に明記が無く未確認（`BANTOU_SESSION_TOKEN` と同じ前提・実機未検証）。
- 外部記憶への書き込み（`src/memory-events.ts`、設計は `docs/design/external-memory.md` の「書き込み」）: `settings.memory`（共通 + session の合成後）がある session について、center が MCP client（Streamable HTTP、`Authorization: Bearer <token>`、`X-Agent-Id: <agentId か session 名>`）として memory の `event` tool を呼ぶ。LLM での抽出・要約はしない。**master-cap の記憶**（agent = session）に書くもの: 利用者の発言（hook `UserPromptSubmit` の `prompt` → `user_prompt`）、master-cap の応答（hook `Stop` の `last_assistant_message` → `assistant_message`。`StopFailure` は error 文なので使わない。transcript・pty の text は読まない）、remote の往復（`remote_send` の送信 → `task`、`cap_result` / `task_result` の受信 → `result`、`worker_report` の受信 → `report`、`worker_reply` の送信 → `reply`）。hook は center が activity 用に全 session へ既に付けているもの（`/sessions/<name>/hook`）を使い回し、memory のために hook は増えない。送信は非同期（キューと body 整形は `src/memory.ts`。Node 固有の digest（sha256）と MCP client は `src/memory-events.ts` が注入する）で、hook の処理（`onHook`）はキューに積むだけで即 return する（memory の応答を待たない）。キューは session（+ memory の url / agentId）ごとの FIFO: 順序保持、失敗は 1s から倍々で最大 60s の backoff で再試行、1000 件を超えたら古い分から捨てて log、memory が `isError`（入力検証違反）で返したものは log して捨てる。memory が落ちていても session の起動・hook・remote は今までどおり動く。log は `eventId` と理由のみ（本文・token・url は出さない）。eventId は `c1:<session>:<種別>:<部品…>`（128 文字以内。長ければ末尾を digest）: 発言は `u|a:<prompt_id か ->:<hook の発火時刻 ms>:<本文の digest8>`、task は `task:<task_id>`、result は `result:<task_id>:<本文の digest8>`（cap_result は `result:<cap_id>:cap:<ms>:<digest8>`）、report は `report:<cap_id>:<worker_id>:<server 時刻 ms>:<digest8>`、reply は `reply:<cap_id>:<worker_id>:<ms>:<digest8>`。同じ hook 呼び出し・同じ通知の再送は同じ id（memory が `duplicate` で弾く）、同じ内容の別の発言は発火時刻（と prompt_id）が違うので別の id。body は NUL を除き 65536 文字で切る（切ったら末尾に `…[truncated]`）。`at` は hook の発火時刻（report は server の時刻）で、未来すぎれば受けた時刻。session の改名で agentId 未設定の X-Agent-Id は変わる。cap の記憶（agent = cap_id）は書かない。server も書かない（`task` に memory は載せない。理由: 今の目的は master-cap の記憶で、cap の記憶は抽出 LLM の呼び出しを増やすだけ。将来 cap の記憶が要る時に足す）。center の hook 記録は呼ぶ時点の live な memory 設定を引くため、動いている session でも設定の追加・解除が次の hook から反映される（`--mcp-config` の memory は次の起動から）。
- システム埋め込み指示（`src/system-instructions.ts`、設計は `docs/design/system-instructions.md`）: master-cap の起動のたびに `--append-system-prompt` の先頭に付ける bantou 側の決まり文（今は `master-cap-role@1`: 自分では作業せず remote-cap に指示を出す運用、`master-cap-availability@1`: 常に利用者の指示を受けられる状態で働き、時間のかかる作業は remote-cap かローカルのサブエージェント / background に預ける）。利用者の追加指示とは別管理で、設定画面には出さない。部品は id と version を持ち、起動した session の status の `systemInstructions` と `center_info.systemInstructions` で分かる。部品 `memory@1`（外部記憶の `settings.memory` がある session だけに付く。起動時と判断の前に context / recall を呼ぶ。書き込みは bantou が自動で渡す）は `when` で条件付き。memory 無しの session は従来と同じ出力。`--no-chrome` は付けない（2026-11-04 に外した。Chrome 拡張の確認が出た時はターミナルから答える）。
- center 共通の設定（`center_settings_get` / `center_settings_update`）: 全 session に効く設定で、形は session の `settings` と同じ（`{ instructions?: string, addDirs?: string[], outputStyle?: string, memory?: { url, token?, agentId? }, … }`、instructions は 16000 文字以内、未知の項目は保持。`servers` は無い＝session の設定だけ。null 以外を渡すと error「servers は center 共通の設定では持てない…」で、他の項目も保存しない。`servers: null` は無害。`center-settings.json` に `servers` が残っていても読み捨て、次の保存で消える）。`outputStyle` は session に無い時だけ全 session に効く（session の値が優先。連結しない）。`addDirs` は全 session の `--add-dir` に 1 つずつ付き（共通が先）、session 自身の `addDirs` はその後ろ（重複は除く）。`instructions` は全 session の `--append-system-prompt` の値の先頭に付き、session 自身の `instructions` は空行 1 つを挟んでその後ろ（どちらも無ければ付けない）。config と同じ dir の `center-settings.json` に保存し（object 1 つ。壊れた・無いファイルは未設定として読む）、更新は保存済みの全 session に次の起動から効く（動いている session は起動し直さない）。`sessions.json` の各 session の `settings` には混ぜない。desktop の設定ダイアログ（ヘッダーの歯車）の「共通の追加指示」がこの tool で読み書きする。
- 保存: config と同じ dir の `sessions.json`（`name`, `path`, `permissionMode`, `settings`（あれば）, `createdAt`）。config の projects には書かない。center 起動時に復元して `--continue` で起動する。`--continue` で接続前に 30 秒以内に終了した場合（約 4 時間以内の記録が無い、など）は、素の起動へ fallback する（再起動回数は増やさない）。
- 新規 path の trust: **trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run `claude` in <path> first ...` で即 exit 1 する**（claude 2.1.312 で実測）。親 dir が trust 済みなら配下は通る（実測: trust 済みの repo 配下の dir で `connected`）。そのため、未 trust の path では `session_create` は `state: starting` と `lastError`（`接続前に終了: Error: Workspace not trusted...`）を返し、supervisor は再起動を繰り返して上限で `error` になる。対処は、workspace（または path の親）で一度 `claude` を起動して trust を承認しておくこと。center が claude の設定ファイルを書き換えて trust を付けることはしない（今は）。
- 同じ folder を別の `claude remote-control` が直前まで握っていると、`This folder is already served by a terminal \`claude remote-control\` on this device. Stop it first.` で約 1 分待たされて終了する（実測、直前の center を強制終了した後など）。

### 再ログイン（session の claude の認証切れ）

- 背景（2026-11-08 mac200 で実測）: claude は OAuth token を macOS の login keychain に保存・更新する。keychain がロックされると refresh を保存できず、token 切れ（約 8 時間）で全 session が `⏺ Please run /login · APIError: 401 OAuth access token has expired` になる。`claude auth status` は `loggedIn: true` のままで気付けない。
- 検知: supervisor は wrapper の text（ANSI 除去済み）を見て `RcStatus.auth` / `loginUrl` / `loginError` を更新する（`remote-control.ts` の `detectAuthEvent` / `findLoginUrl`）。文言は claude 2.1.319 のバイナリで確認: `Please run /login` → `login_required`、`Couldn't save your login` → `keychain_locked`、`Login successful` → `ok`、`Invalid code` → `loginError`。TUI の差分描画で text は空白が無く文字も一部落ちる（実測: `Could't ave yo login.IfyourMac'skeyhainislocked`）ので、空白を無視し字抜けを少し許して照合する（`fuzzyIndexOf`）。認証 URL は折返しの改行を除いて拾う。照合窓は直近 400 文字（URL は 2048 文字）で、一致したら捨てる（再描画で同じ文言が繰り返されても状態は一度だけ変わる）。
- 通知: `auth` / `loginUrl` / `loginError` が変わると `GET /events` に `{"reason":"changed","name"}` を流す。desktop はそれで `session_list` を取り直し、該当 session に「要再ログイン」/「keychain ロック中」を出す。
- `session_login`: Esc → `/login` → Enter（ログイン方法の先頭 = Claude account with subscription）を pty に打ち、`loginUrl` が付くまで待つ。`session_login_code`: コードを打ち、Enter は 300 ms 後に別送する（同じチャンクだと貼り付け扱いで Enter が落ちる。実測）。結果は `Login successful`（`ok: true`）/ `Invalid code` / `Couldn't save your login`（keychain ロック。ホストで解錠してから `session_login` からやり直す）。入力の間隔と待ち上限は `login.ts` の `DEFAULT_LOGIN_TIMINGS`。
- 認証 URL を開くのは利用者の手元: desktop（普段使いの Mac）が `loginUrl` をその Mac のブラウザで開く。center の host（別 host でもよい）ではブラウザを開かない。claude が center の host で自動起動を試みても、URL は claude の text に出るので center はそれを拾うだけで、起動の成否は流れに影響しない（無視してよい。ただし binary の文字列からの判断で、`/login` の実機・macOS では未確認）。center は claude のブラウザ起動を抑える設定を入れていない（調査と根拠: `docs/history/20261110-1658-relogin-local-browser/report.md`）。コードの入力は desktop で行い、`session_login_code` で claude に渡す。
- 認証は同じホストの全 session で共有だが、他の session が新しい token を拾い直すかは未確認。desktop の再ログイン画面から `rc_stop` → `rc_start { resume: true }` で session を再起動できる。

### remote（B）

- **原則（2026-11-04 に改訂）: remote-cap は session × server に 1 つ**（session = master-cap と remote-cap は 1 対 1）。作業が何であれ、center はその session の cap に次の指示を送る（作業ごとに cap を作らない）。記録は「session × server の cap」単位で、`remote_id` = cap_id、`session` を持つ。以下の「server ごとに 1 つ」「center ごとに固定の cap_id」はこの原則に読み替える。他の session の cap とその指示・結果は見えない・触れない。
- **session ごとの cap_id**: `c-<center の 10 桁 hex>-<session 名>`（session 名は 64 文字まで）（例 `c-0a1b2c3d4e-main`。`sessionCapId`、center-id.ts）。session 名は `[A-Za-z0-9_-]+`（`SESSION_NAME` / `OWNER_PATTERN`。cap_id の `AGENT_ID_PATTERN` と同じ）なので**変換は恒等**（エスケープ無し）。文字種外の名前は error（別の名前に寄せない）。衝突しない根拠: `c-<10 桁 hex>` は固定長で 1 center に 1 つなので、cap_id は session 名で一意。旧共有 cap の `c-<10 桁 hex>` は接尾辞が無く、どの session の cap_id とも違う。将来 session 名の文字種を広げる時は、許可外の文字を `_` + 2 桁 hex（UTF-8 のバイトごと）、`_` 自体を `_5F` に変える（今は使わない）。
- **境界**: 「他 session から見えない・触れない」を保証するのは `/mcp/session`（session ごとの使い捨て token + `X-Bantou-Session` の照合）だけ。外向け `/mcp`（center token。desktop 用）の `remote_list` / `remote_wait` / `worker_reply` / `remote_delete` は owner を自己申告でき、省略で全件。desktop は全件を取って client 側で選択中 session に絞る。
- **session を消しても cap は残る**: `session_delete` は cap の記録・server の cap・worker に触れない（通知は届かず失敗ログのみ）。同名の session を作り直すと同じ cap_id で旧 cap を引き継ぐ。不要なら `remote_delete`。
- **既知の制約**: server の FS が大文字小文字を区別しない（macOS など）と、session `Main` と `main` の cap が同じ dir になりうる。
- **旧共有 cap**: 起動時に引き継いだ `c-<center-id>` など（下記）は `session` の無い記録。新しい指示は送らない。session 向け `remote_list` は `include_shared: true` の時だけ出す。`remote_delete` / `remote_wait` / `worker_reply` は `remote_id` を明示した時だけ対象にできる（`remote_delete({ remote_id: "c-<center-id>" })`。他の session の cap は対象にならない）。
- **center の cap_id（接頭辞）**: `c-<10 桁 hex>`（session の cap_id は `c-<10 桁 hex>-<session 名>`。上の「session ごとの cap_id」）。center の状態 dir（config と同じ場所）の `center-id` ファイルに 10 桁 hex を持ち、無ければ最初の起動で乱数から作って保存する。center を再起動しても同じ値になる。選んだ理由: (1) center ごとに固定でなければ、再起動のたびに server に新しい cap が残る。(2) 乱数でなく hostname や config のパスから導くと、別 center と衝突したり、dir の移動・コピーで変わる／重なる。(3) 状態 dir はすでに `remotes.json` `sessions.json` の置き場で、center の状態と一緒に残る。`center-id` が書けない時は、その起動の間だけの id を使い（ログに出す）、再起動で変わる。記録は session × server に 1 件（server は server_id、server_id が分からない旧形式の記録は peer id。「server の識別」の節）。記録の無い session × server（最初の `remote_send`）は session の cap_id で作る。引き継いだ旧共有 cap（下記）には送らない。指示・status・`worker_reply`・`stop_cap` はその記録の cap_id へ送る。
- `remote_send`（別名 `remote_create`）: session からの依頼を、その server の cap への `task`（protocol 1.5.0）として同じ cap_id へ送る。送る前に server の `status` で cap の有無を確かめる（無ければ server が最初の `task` で作る。`created: true`）。status が error・タイムアウトなら cap の有無が分からないので送らず isError。**cap の完了（`task_result`）は待たず**、server が task を受け付けたことを確かめてから `{ remote_id, server, server_id?, peer, host?, serverName, state: "running", created, task_id, delivered: true, delivery: "observed", delivered_at, delivery_basis }` を返す。server は task に ack を返さないので、受付は status の cap が送る前から変わったこと（`last_started_at` が変わる・`queued` が増える・idle から running）で判定し、status を 1 秒ごとに取り直して最大 15 秒（定数 `ACK_TIMEOUT_MS`。環境変数 `BANTOU_REMOTE_ACK_TIMEOUT_MS` で変更）待つ。`task_result` が返った場合も受付済（`delivery_basis: "task_result"`）。server は task に ack を返さないので、`delivered: true` は「受付を観測した」の意味で（status の cap の負荷が、先行する未確認の task の分を含めて送る前から増えた・cap が現れた）、server の ack ではない。根拠は `delivery_basis`（`task_id` = 自分の task_id の worker_report が届いた、確実 / `task_result` = server が結果を返した、確実 / `status` = status の変化からの推定。cap が別の要因（worker の report 起因の resume など）で動き直した場合の偽陽性が理論上ある）。task_id で確かめられない以上 `accepted` とは名乗らず `observed`（観測）に留める。status の caps[]（AgentStatus）に task_id は無く、activity の agents[].task は prompt の先頭で task_id ではない。周期の status では pending を observed に格上げしない（後から observed になるのは `task_result` が返った時と、自分の `task_id` の `worker_report` が届いた時だけ）。受付は、先行する未確認の task（`ahead`）の分も含めて cap の負荷（実行中 + 待ち）が増えるまで認めない（同じ cap に続けて送った 2 本目が、1 本目の到着で誤って observed にならないように。曖昧な時は observed にせず delivered:false）。確認できない（server が落ちている・task が届いていない・届いたが status に変化が出ない）時は **isError** で `{ …, delivered: false, delivery: "sent" | "unsent", task_id, error }` を返す（`delivery` は messenger に送り出したかどうか）。task は pending に `sent`（送り出せなかったものは `unsent`。再送抑止の対象にしない）で残る。再送する前に `remote_list` で `delivery` を確認する。受付の確認は server ごとの直列の外で待つ。**再送**: 同じ cap_id・同じ中身の指示を、受付が未確認のまま 10 分以内（`RESEND_AFTER_MS`）に送り直しても task は送らず、前の task_id の受付確認だけやり直す（server は task_id の重複を除かず二重に実行されるため）。引数は `goal`（必須）、`deliverables?`（`{ branch?, report_path?, other? }`）、`verify?`（`{ tests?, steps? }`）、`constraints?`（文字列の配列）、`workers?`（`{ items?: [{ id?, role: implement|review|docs|test|other, scope, model?, depends_on? }] }`。items 無し = implement + review の最低 2 体）、`repo?`、`branch?`（`-` で始められない）、`server?`（server_id / host 名 / peer id のどれでも。省略時は発見した先頭。「server の識別」の節）、`worker_model?`（`remoteControl.model` と同じ形式。不正なら送らず拒否）。省略した `deliverables` / `verify` / `constraints` / `workers` は `{}` / `{}` / `[]` / `{}` で送る。`task_id` は center が採番（`t-<時刻の 36 進>-<6 桁 hex>`）し、未完了の指示にも持つ。`worker_model` の既定は config の `servers[].workerModel`（`servers[].peer` が peer の id か名前、または `servers[].name` が peer 名か `server` 引数に一致するもの）で、**送信のたびに config を読み直す**。新規の cap は「引数 ?? config」を `task` に載せ、既存の cap は引数があった時だけ載せる（server が cap の既定として記憶する。config の既定は再送しない）。記録の `worker_model` は最後に載せた値。`task` に cap のモデルの欄は無いので `model` 引数は無い（config の `servers[].model` は `cap_kick` 用）。worker ごとのモデルは `workers.items[].model`（優先順位は server の取り決めどおり: items[].model > `worker_model` > cap の既定）。
  - 同じ server への送信は center 内で直列（status の確認 → 記録 → `task` の投入）なので、同時に 2 本来ても最初の `task` は 1 本だけ。
  - cap が実行中の間の指示: center の link は同じ cap_id の `task` を直列にする（前の返信が来てから次を送る。返信待ちは cap_id で照合するので、2 本が並走して返信を取り違えることが無い）。待たされた指示は center のメモリで待ち、server 側でも cap ごとに直列に処理される。center が再起動すると、まだ送っていない指示（center のメモリで待っていたもの）は失われるが、記録は `running` のまま復元して status で追従する（下記）。
  - 取り違えの余地: cap が worker の report で再開した結果（`task_result`）は、返信待ちの `task` と同じ `task_id` ならその指示の返信として受け、別の `task_id`（過去の `task` の遅れ・重なり）は待ちに取られず、記録に反映する（待ちがある間は `state` は running のまま）。同じ `task_id` の `task_result` が重ねて届いても完了・通知は指示ごとに 1 回。本来の返信は後から届くことがある。center はどちらも cap の最新の結果として反映し、完了は「返信待ちの指示が 0」かつ cap が idle・worker 無しで判断するので、指示の完了判定や通知先は変わらない。結果の本文に、どの指示への返答かは cap の返答自体に含まれる。
- `remote_delete`: cap を閉じる。server へ `stop_cap` を送り、走行中の `claude -p` を止め（idle / failed / 実行中のどれでも可）、server 側の cap の会話（`state.json` の `session_id`）も破棄させてから、記録から外す。次の `remote_send` は同じ cap_id のまま新しい会話で始まる（cap が会話の上限を超えて落ち続けるのを、閉じて起こし直すことで抜ける）。返り値の `session_cleared`: true = 会話を破棄した / false = 破棄するものが無かった / null = 確認できない（`force` の時のみ）。server の `logs/`（生出力・`reports.jsonl`）と配下の worker の dir は消さない（server README）。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ。`remote_id` 省略時は自分の cap（複数の server にあれば `server` で絞る。無いと error）。複数の server に同じ `remote_id` がある時も `server` で指定する。**記録を消すのは `remote_delete` だけ**（center の再起動・旧形式の掃除以外で消えない。旧形式の「同じ server の余分な記録」は下記の 1 回限りの後始末）。閉じられない（server が見つからない・error 返信・会話の破棄を返さない旧版の server）時は、記録の状態によらず error で記録も消さない（消すと次の指示が server に残った同じ会話を resume して同じ失敗を繰り返すため）。`force: true` なら記録だけ消し、`session_cleared: null` と `warning`（server の cap の会話は残る）を返す。他の session の cap は `remote_id` を指定しても「未定義の remote」で消せない。消した後の指示は、server に cap が無ければ最初の `kick_cap` から作り直す。
- 履歴は持たない: 記録に残すのは server ごとの cap の state、未完了の指示 `pending`（`{ at, owner（通知先の session）, prompt（goal の先頭 200 文字）, task_id? }`。完了したら消す）、最新の `result`（8000 文字まで）/ `error` と時刻（`result_at` / `error_at`）、最新の `task_result`、直近の `worker_reports`（最大 20 件）、`activity` だけ。完了済みの指示・過去の結果・通知の成否は残さない（通知の成否は center.log）。
- `remote_list` の `task_result` / `worker_reports`: `task_result` は最新の `task_result` 本体（`{ cap_id, task_id, state: done|failed, summary, workers: [{ worker_id, role, state, branch?, commit?, tests?, report_path?, result }], review: { verdict: ok|issues|unknown, items: [{ severity, text, resolved }], rounds }, remaining, error? }`）。届くまで無い。`worker_reports` は server の `worker_report` 通知（`{ type, cap_id, task_id?, worker_id, kind: progress|ask|approve|done, text, at }`）の直近 20 件（到着順。古いものから捨てる。progress も全て積む。push するかとは無関係）で、無ければ `[]`。どちらも `remotes.json` に保存する。
- `remote_list` の `conversation` / `cap_last_error`（cap の会話の使用量と失敗の理由。判断の補助。画面に新しい表示は足さない）: `conversation` は server の `status`（周期取得）の cap から取る `{ started_at（会話の開始時刻）, tasks（この会話での run 数）, context_tokens（直近の応答時点の input + cache_creation + cache_read）, context_window, context_percent, usage_at, last_error_text? }`。claude の `result` 行から server が読んだ値で、`last_error_text` は直近の失敗の claude 自身の error 文（例: `Prompt is too long`）。`cap_last_error` は cap が failed の時の server の `last_error`（`終了コード 1: Prompt is too long` のように error 文を含む）。旧 server・status 未取得の間は無い。失敗の理由は `error` / `task_result.error` / activity の `error`（desktop の既存の failed 表示）にも同じ文が入る。master-cap はこれで、cap を閉じて起こし直す時期を判断する（時期の数値の決まりは作らない）。
- `remote_list` の `state` / `result`: cap の最新の結果（`task_result` は `summary`、`state` が failed なら `error`）。最初の `task_result`（または `cap_result`）で done / failed になり、report 起因の再開など後から届く `task_result` / `cap_result`（と `task` / `kick_cap` の error）でも `result` / `state` / `error` を最新に更新する。返信待ちの指示がある間、`cap_result` の後の判定待ちの間、または cap が done でも activity で cap か配下の worker が running / stalled の間は、`state` は running（`finishedAt` なし）で返す。`unknown` = server に届かない（`kick_cap` の送信失敗・タイムアウト）・status も取れず cap の状態が分からない。failed（`ok: false` の `cap_result`・server の `error` 返信）とは別で、次に status が取れた時（または activity が来た時）に running / done に戻る。
- `worker_report` の push: server からの `worker_report` 通知を受けたら、**cap の session**（旧共有 cap は未完了の指示の owner）へ push する（`[bantou] worker_report remote_id=… worker=… kind=… task_id=…` + 本文 2000 文字まで + ask / approve には `返答: worker_reply(worker_id="…", text)`）。**progress は既定で push しない**（`worker_reports` には積む。進捗は `remote_list` で見る）。config の `remotes.pushProgress` を `true` にすると、同じ worker（remote_id・server・worker_id）から 60 秒に 1 回まで push する。ask / approve / done は毎回。progress の push が無くても、`session_list` の remote 集計（`running` / `waitingReply`）・`GET /events` の `reason: "remote"`・activity は記録と activity 通知から作るので変わらない。未完了の指示が無くても cap の session へ push する（旧共有 cap で未完了の指示が無い時だけ owner 不明で push せず center.log に残す）。通知の送り先が無い時も push せず center.log に残す。ask / approve への返答は `worker_reply`。
- 完了通知: **cap が idle かつ worker 無し**（`task_result` / `cap_result` の受信を起点に、`state` が running / unknown でない = 返信待ちの指示が無く、最新の activity で cap が idle かつ worker に running / stalled が無い。failed も含む）になった時点で、未完了の指示を全て完了にして消し、**cap の session に 1 回**（cap は session ごとなので宛先は 1 つ。旧共有 cap は指示を送った session ごと）、その名前の messenger peer へ `push` で送る（`[bantou] remote 完了 remote_id=… state=…` + `指示:`（その session の指示の先頭 80 文字）+ `result:` 先頭 500 文字 + `error:`）。同じ session の指示が重なっても、`cap_result` が来るたびに古い指示から順に完了にはせず、idle になった時にまとめて完了にして通知する（cap の返答本文に、どの指示への結果かが含まれる前提）。送れた・送れない（peer が見つからない等）の結果は center.log に出す（再送はしない）。`session_create` の session は agent-messenger の peer として登録される（下記「master-cap の起動（wrapper）」）ので届く。同名の peer が複数並んだ時（session 再起動直後）は `registered_at` が最新のものへ送る。config の `projects`（サーバー型の `rc_*`）は peer でないので、通知は送れない（center.log）。そこは `remote_wait` で待つ。**`cap_result` を受けても即座には完了にしない**（実機で、activity で cap=running / worker=running の 10 秒後に最初の `cap_result` が来て「完了」になり、その 21ms 後の activity（cap=idle / worker=running）が無視された）。`cap_result` の後は、次の activity が来るまで（来たらその activity で判定）、または猶予 15 秒（server の activity 通知は 5 秒ごと = 3 回分。通知が 1〜2 回欠けても待てて、完了通知の遅れは 15 秒以内で済む）が過ぎるまで待ち、activity が来ないまま猶予を過ぎたら server の `status` を取って判定する（cap が idle・`queued` 0・worker に running 無し。status は worker と cap の対応を持たないので worker は server 全体で見る）。動いていれば 15 秒ごとに status で追従する。center 再起動時、未完了の指示は閉じず通知を保つ（下記）。
- `remote_wait`: `remote_id`（と `server`）の cap が上の意味で idle・worker 無しになるまで待って記録を返す。`remote_id` と `server` を省略した時は、owner（session）の cap のうち未完了の指示があるもののどれか（最初に終わったもの）。他の session の cap は `remote_id` を指定しても待てない（旧共有 cap は `remote_id` 明示で待てる）。timeout は `state: "running"` のまま。待ち中に cap が delete されたら error。
- 同じ cap に続けて送った task（`task` の送信は task_result を待たずに次を通す）は、server が cap ごとに到着順で直列に実行する。server は task_id を最後に受けた task で覚えるので、実行中の worker の `worker_report` の task_id は最後に受けた task の id になる（帰属の誤り。task_result は cap_id + task_id で照合するので取り違えない）。
- `remote_list`: `owner` が分かればその session の cap だけ（session 向けは常に自分の session。`include_shared: true` で旧共有 cap も）、分からなければ全件（旧共有 cap を含む）。`RemoteRecord` = `remote_id`（= cap_id）, `session?`（無い = 旧共有 cap）, `server`（server_id。server_id が分からない旧形式の記録は peer id）, `server_id?`, `peer?`（今の到達先。長く確認できないと消える）, `peer_seen_at?`, `serverName`, `serverHost?`（host 名）, `serverUser?`, `serverWorkspace?`, `state`, `model?`, `worker_model?`, `createdAt`, `finishedAt?`, `result?`, `result_at?`, `task_result?`, `worker_reports?`, `error?`, `error_at?`, `pending`。`remote_list` は加えて `owners`（`pending` を持つ session、古い順）、`worker_reports`（常にある。無ければ `[]`）、`reachability`、`cap_state` と `activity?` を返す。`pending` の各要素には `task_id?`、送達状態 `delivery`（`unsent` 未送信 / `sent` 送信済で到達は未確認 / `observed` 到達を観測した。旧形式の記録は `sent`）、`sent_at?`、`observed_at?`、`delivery_basis?`（`status` / `task_result`）が付く。
  - `reachability` = `{ reachable, last_ok_at, failures, last_error? }`（server 単位。同じ server の cap は同じ値）。`last_ok_at` = 最後に cap に係る応答（status の成功・activity・worker_report・task_result）が返った時刻（hello では更新しない）（center の再起動後は最初の応答まで null）。`failures` = 連続した失敗（無返信・送信失敗・発見から消えた）の回数。2 回続くと（`REACH_FAIL_THRESHOLD`）`reachable: false`。確認は 30 秒ごと（`REACH_CHECK_MS`。失敗中は `REACH_RETRY_MS` ごと）の status（`checkReachability`）。follow の hello（30 秒ごと）の失敗は再確認の要求になるだけで、成功は使わない。到達性の判定（`reachable` / unknown への遷移）は `checkReachability` 1 本に寄せる。hello（follow）・probe・announce・受付確認・`remote_send` の status の失敗は `failures` を直接数えず、再確認の要求（要求から `REACH_REQUEST_DELAY_MS`（1 秒）待って `checkReachability` を走らせ、同時に呼ばれても 1 回にまとめる）を起こすだけで、到達不能への遷移は `checkReachability` が連続して失敗した時だけ（再確認が成功すれば数えない）。加えて失敗は呼び出しの回数でなく時間で数える: server 単位で、最後に数えた失敗から `REACH_RETRY_MS`（20 秒。環境変数 `BANTOU_REMOTE_REACH_RETRY_MS`）未満の失敗は 1 回に束ねる（hello・status・probe・受付確認が同時に失敗しても 1 回。cap に係る応答（status の成功・activity・worker_report・task_result）で `failures=0` と束ねの基準もリセット。**hello の成功は到達性の判定に使わない**（`failures`・束ね窓・`last_ok_at`・再確認の要求のどれにも触れない。hello は identity の学習と follow の peer 追従にだけ使う）: hello だけ答えて status に答えない server は、cap の状態が分からないので `checkReachability` の連続 2 回の失敗で到達不能（`last_error` は「status に応答しない: …」）になる）。連続 2 回で到達不能なので、止まってから表示が変わるまで 40〜60 秒かかる。server の返した error（版の門の断りなど）は応答があったと数える。
  - `reachable: false` の間、作業中の cap（未完了の指示がある、または state が running / unknown）の `state` と `cap_state` は `unknown`（記録の中身は書き換えず、応答が戻れば元に戻る）。作業の終わった cap は server が落ちても変えない。
  - `cap_state` = `running` / `idle` / `lost` / `unknown`。activity 通知と status のうち新しい方から決める。server が cap を `lost` と通知した（activity の cap の state が `lost`）cap は `cap_state: lost`・`state: failed` で、未完了の指示は終わりとして owner へ通知する。新しい task が受け付けられる・cap が動き直すと戻る。
  - 変化は `GET /events` に `{"reason":"remote","name":<session>}` で流れる（到達不能・lost の出入りを含む。desktop は `session_list` を取り直す）。`session_list[].remote` は `{ running, waitingReply, unreachable?: [{ server, remoteId, lastOkAt }], lost?: [{ server, remoteId, at }] }`。
- 旧形式の記録（`session` の無い記録 = 共有 cap `c-<center-id>`、作業ごとの cap。`remote_id` が center の cap_id と違う・`history` 形式など）は、center の起動時に、**`session` 無しの旧共有 cap として引き継ぐ**（cap_id はそのまま。新しい指示は送らず、`remote_delete` に `remote_id` を明示して消す。以下の整理は旧共有 cap の間だけで、session の記録には触れない。未完了の指示は残し、`history` / `legacy` / record 単位の `owner` は捨てる）。結果は center.log（`旧形式の記録を server の cap として引き継ぐ`）。同じ server に複数ある時は、動いている（`running` / `unknown` / 未完了の指示あり）記録を最優先し、同順位なら最新（`createdAt` / `finishedAt` / `result_at` / `error_at` のうち最も新しい時刻）を残し（同じ server = peer id が同じ、または名前 + host が同じ。host の無い旧記録は、今の peer で同名の server が 1 つだけと確かめられた時だけその host の server とみなす。確かめられない（peer が引けない・同名の peer が複数）host 無しの記録は、他の記録と一緒にせず、stop_cap も送らずそのまま残す。次の status 成功時に host が入る）。理由: 最新だけで選ぶと、動いている旧 cap より新しい完了済みの記録が残り、動いている cap へ `stop_cap` が飛ぶため（利用者の決定「最新の 1 件を残す」からの意図した調整）。動いている記録が複数なら最新の動いている記録を残し、他（動いている記録を含む）へ `stop_cap` を送る。他は server へ `stop_cap` を送り（届かなくてもよい）、記録を消す。これは「作業ごとの cap」の後始末で、1 回限り（引き継いだ後は server ごとに 1 件なので起きない）。結果は center.log（`旧形式の remote を掃除` / `stop_cap が届かない（記録は消した）`）。旧 cap が server に残る可能性は、`stop_cap` が届かなかった場合に限る（それは受け入れる）。
- `activity`（`remote_list` の各要素）: server が protocol `bantou`（1.2.0）の `activity` 通知で送ってくる remote-cap と worker の生存・進捗。通知がまだ無い remote には `activity` キーが無い。中身は `{ at, received_ms_ago, stale, agents }`。
  - `agents`: `AgentActivity[]`（cap → worker）。`kind`, `id`, `cap_id`, `state`（`running` / `stalled` / `idle` / `done` / `failed` / `lost`）, `task`（prompt の冒頭）, `last_activity`, `last_output_at`, `silent_ms`, `started_at`, `finished_at`, `error?`。仕様は `docs/protocol.md` の「Activity notices」。
  - `silent_ms`: 通知時の値に、center が受信してからの経過を足して返す。desktop はホスト間の時計ずれを避けるため、時刻の差でなくこの値で経過を出す。
  - `received_ms_ago`: 最後の通知を受けてからの ms（center の時計）。`stale`: running / stalled の agent がいるのに 30 秒を超えて通知が来ていない（server・経路が落ちた疑い）。center は lost に書き換えず `stale` を立てるだけ（lost は server 側の事実）。
  - 保持はメモリのみ（`remotes.json` には書かない）。center 再起動後は次の通知まで空。`remote_delete` で消える。`cap_kick` で起動した cap には記録が無いので `remote_list` に出ない。同じ cap_id が複数の server にあるので、保持は通知を送ってきた server の peer id ごと。
  - 通知が来るのは、その cap に最後に命令（`kick_cap` / `task` / `worker_reply` / `stop_cap` / cap_id 付きの `status`）を送った center。server は center を peer **名**（`bantou-center`）で覚え、送る時に今の peer id へ引くので、center を再起動して peer id が変わっても届く（protocol 1.6.0。それ以前の server は peer id で覚えるので、再起動後は届かない）。center は起動時に、記録の各 cap について server へ `status`（cap_id 付き）を送って通知先を取り戻す。ログ: 状態の組が変わった時だけ `activity 受信: cap_id=<id> <id>=<state> ...`。
- 保存: メモリ + config と同じ dir の `remotes.json`。center 再起動では、`running` と未完了の指示を失敗にせず `running` のまま復元し、server の `status` で cap と worker の状態を取り直して追従する（取れなければ `unknown`。15 秒ごとに再試行）。再起動後に届く `task_result` / `cap_result`（`onLateCapReply`）は最新 `result`（`task_result`）に反映し、完了になれば owner に通知する。**前提: 再起動の前後で messenger の peer 名（center の `bantou-center`、通知先の session 名）が同じ**（通知は session の peer 名宛て、遅れた返信は `bantou-center` 宛てに戻る）。変わると通知が届かない（center.log）ので `remote_wait` / `remote_list` で確かめる。記録の無い server の cap_id は同 dir の `center-id`（記録のある server は記録の cap_id）。再起動時は、全ての記録の server へ `status`（cap_id 付き）を送って通知先を取り戻す（server がまだ見えなければ 15 秒ごとに最大 20 回再試行。状態の追従で `status` を送る記録はそれが兼ねる）。
- **server 選択**（概念: server は master-cap から見えなくてよい。今は発見ベース）: `config.servers` に依存しない。messenger の `listPeers("all", {protocol: "bantou"})` で見つかった peer の先頭（既定）。`server` 引数は server_id → peer id → host 名 → messenger の名前の順に探し、最初に一致した段で複数あれば曖昧エラー（下の「server の識別」）。見つからなければ候補付きで error。既存の `cap_kick` などは `servers[]` のまま（挙動は変えない）。`servers[]` があれば先頭の messenger client を共有し、無ければ内部の client を 1 本使う。broker に古い peer が残っていると先頭がそれになり得る（実測: broker.json を引き継いだ再起動で古い peer が先頭に来て、指示が届かず待ち続けた）。
- **owner**（呼んだ master-cap の識別）: http では header `X-Bantou-Session: <session 名>`（または URL query `?session=<名>`）があればそれ、無ければ tool 引数 `owner`。優先順は header > query > 引数。`remote_send` はどれも無ければ error。session 向け窓口（`/mcp/session`）の tool は呼び出し元 session の cap だけが対象（引数 `owner` は受けない）。外向け `remote_list` / `remote_wait` は分からなければ絞らない。stdio には header が無いので引数のみ。
  - **今は**: master-cap 側に header 付きの接続を自動で持たせる仕組みは入れていない。理由: `claude remote-control` は `--mcp-config` / `--settings` を受けず（remote-control の前の global flag は spawn した session に引き継がれない）、`~/.claude.json` の書換えはユーザー設定の変更、`.mcp.json` の配置は承認プロンプト・未 trust・token 平文の問題がある。そのため、master-cap が center に繋ぐ MCP 設定（header 付き）を用意する側（番頭など）が `X-Bantou-Session` を付けるか、master-cap が `owner` 引数を渡す。
  - owner は自己申告で、認証はしない（Bearer token は center 全体で 1 つ）。

## server の識別（server_id）

- **問題**: messenger の peer id は server が再起動・再登録するたびに変わり、名前は全 server が `bantou-server`。peer id で server を覚えると、remote の記録が旧 id に残って `unknown` になり、同じ host に 2 つ server がいても区別できなかった。
- **識別の取得**: server は `hello_result` / `status_result` に `server_id`（再起動・自己更新で不変）と `host` / `user` / `workspace` を載せる（protocol 1.7.0 で追加、現行 1.8.0 も名乗る。全て任意）。center は返信から peer id → 識別を学習する（link のメモリ）。識別が未取得の peer へは `hello` を 1 回送って取る（`identifiedPeers`）。旧 server の識別なしの返信、`hello` を知らない旧 server の error は「識別なし」として扱い再送しない。届かない peer は 60 秒後に再試行する。同じ server_id の別の peer id が現れたら、旧 peer id が発見から消えていれば識別を整理する。**同じ server_id を名乗る peer が発見に複数いる**時（server の再起動・再登録で旧 peer id が発見に残る間、または workspace / VM のコピー）は、その全員へ `hello` を送り直し、**応答した peer だけ**を残す。死んだ旧 peer は応答せず落ちるので、再起動直後でも新 peer が選ばれ、送信と追従は詰まらない。**全員が応答した時だけ**重複（本当のコピー）として、server 指定なしの `remote_send`・server_id / host 名での指定・記録からの検索を**エラー**にして送らない（エラーには候補の peer id・user・workspace を並べる）。誰も応答しなければ何も落とさず、その結果は保持しない（次の要求で再確認する。全員が一時的に無応答でも、復帰後に重複エラーが残らない）。応答があった確認結果は、同じ顔ぶれに対して 30 秒に 1 回まで（同時の要求は 1 つにまとめる）。互いの識別は捨てない（取り直しで揺れない）。peer id で指せば常に通る（応答しない旧 peer でも、明示した指定は止めない）。
- **記録**: `remotes.json` の `server` は server_id にする。`peer` は今の到達先で、確認できるたびに更新する（peer id が変わっても同じ server・同じ cap の記録のまま）。`serverHost`（host 名）/ `serverUser` / `serverWorkspace` も持つ。server_id が分からない記録（旧形式。旧 server の記録を含む）は `server` が peer id のまま。見分けは `server_id` の有無。
- **server の指定**（`remote_send` / `remote_delete` / `remote_wait` / `worker_reply` の `server`）: server_id → peer id → host 名（大文字小文字を区別しない）→ messenger の名前、の順に探し、最初に一致した段の全件を候補にする。候補が複数の server に及ぶ時（同じ host に server が 2 つなど）は**送らずにエラー**にして、候補を `host(server_id) user=… workspace=…` で並べる（server_id で指し直す）。`remote_delete` / `remote_wait` / `worker_reply` は記録（server_id / peer / host）で指せるので、server が今見えなくても指せる。
- **表示**: `remote_list` の `server_label`、`server_peers` の各 server、center.log は host 名を主にして server_id を添える。同じ host 名の server が複数ある時は user と workspace も付く。
- **旧形式の移行**（起動時の `restore`）:
  1. `server_id` の無い記録があれば、先に `remotes.json` を `remotes.json.pre-server-id.bak` へ退避する（既にあれば上書きしない。失敗しても続行）。
  2. 発見できる server に識別があり、記録の peer id が一致する（または名前 + host が一致し、かつ同じ名前 + host の peer が 1 つだけ）なら、記録を server_id に読み替える。同じ host に同名の server が 2 つある時は、名前 + host だけでは引き継がない（取り違え防止）。
  3. 対応する server が見えない・識別を返さない記録は peer id のまま残す（`unknown` を悪化させない）。その server が後で `hello` / `status` を返し、peer id 等が一致した時に引き継ぐ。
  4. 制約（厳密化はしない）: 名前 + host だけで引き継ぐ場合（同じ host・同名の live が 1 つだけ）、元の server が廃止されて別の server が動いていると、その別の workspace / user に紐づき得る。peer id が一致する場合と、server_id が分かる記録は取り違えない。
  5. 冪等（読み替え済みは何も変えない）。読み替え中は保存せず、最後に 1 回だけ保存する。発見に失敗しても起動は止めない（発見に失敗した起動では、古い到達先の整理もしない）。
- **互換と更新の順序**: center は protocol の版が**完全一致**する server にしか `task` / `status` を送らない（`gateOf`）。旧 server（protocol 1.6.0）は `hello` / `update_server` だけ通り、`task` / `status` は版違いエラーになる。旧 server の記録は peer id のまま残るだけで、新しい指示は送れない。移行は **server を 1.8.0 へ更新（follow が `update_server` で自動に指示）してから**。旧 center に新 server（1.7.0）を当てると、旧 center の follow が server を旧 pair の版へ戻す（巻き戻される）。
- **downgrade**: 非推奨。必要なら `remotes.json.pre-server-id.bak` を `remotes.json` に戻す。退避は**最初の 1 回だけ**で上書きしない（最初の退避を守る）ので、移行後に新しく作った cap の記録は失われる。
- **古い記録の整理**（`prune`。起動時と 10 分ごと。**消すのは center の記録だけ**。記録を消すために server へ stop_cap などは送らない。ただし発見した peer のうち識別が未取得のものへは、読み取りだけの `hello` を送り得る）:
  - 消す: (a) 同じ server_id・同じ cap の旧 peer id の重複記録（動いている記録、同順位なら最新を 1 件残す）。(b) `peer_seen_at` から 6 時間確認できず、今の発見にも居ない到達先（`peer` と `peer_seen_at` だけ消す）。
  - 消さない: session × server の cap の記録そのもの（`remote_delete` だけが消す）、server_id / host / user / workspace、未完了の指示、旧形式の記録。発見に失敗している間は (b) をしない。

## server の退役（server_retire）

- **問題**: 一覧に出ている server を外すのに、host に入って root で停止・削除するしかなかった。運用は protocol と center の tool で行い master-cap は ssh しない、という設計に対して、server を止める手段が無かった。protocol 1.8.0 の `retire_server` / `retire_result`（`docs/protocol.md`、server 側の動きは `packages/server/README.md` の「退役」と `docs/ops/server-install.md`）に center の tool `server_retire` を対応させた。
- **入力**: `server`（必須。server_id / host 名 / peer id。`remote_send` などと同じ解決順の `selectPeer`: server_id → peer id → host 名 → 名前。同じ段で複数に一致したらエラーで、候補を user と workspace 付きで返す。先頭を黙って退役させないよう省略は不可）、`reason?`（500 文字以内。server の log と `server.retired` に残る）。同じ host に server が 2 つある時は server_id で指す（host 名はエラー）。
- **流れ**:
  1. `selectPeer(server)` で 1 つに決める（曖昧・未発見はエラーで何も送らない）。
  2. `hello` を送り、`hello_result.protocol_version` で `supportsRetire` を判定する。**未対応（1.8.0 未満）・版不明（hello が届かない、版が載らない）は `retire_server` を送らず**、「この server は退役に未対応（protocol <版>）。host で手動で止める」のエラーにする。旧 server は `retire_server` に無返信なので、送ると「退役した」と誤認しかねないため。
  3. `server_id`（hello_result か発見の識別。無ければ送らずエラー）を付けて `retire_server` を送る。`retire_server` は版違いの server にも送れる control 扱い（`update_server` と同じ）。
  4. `retire_result` を待つ（**timeout 60 秒**。server は返信の前に実行中の cap / worker を全部止めるため `stop_cap`（30 秒）より長い）。
  5. 受信できたら、その peer を退役済みにして発見の結果から 5 分外し（server が止まっても messenger の登録が失効する約 60 秒の間、一覧に残って `unknown` になる・選ばれるのを防ぐ）、center の記録を整理する。
- **成功の判定は `retire_result` の受信だけ**。無返信・timeout・送信失敗・その他の `error`（server_id 違いなど）は退役したと見なさず、`isError` で返す（記録も消さない。`server_peers` / `server_status` で確かめる）。`error{retiring:true}` が返ったら「既に退役中」として `state: "already_retiring"` で返す（記録は整理する）。同じ server へ `retire_server` を再送すると server は同じ `retire_result` を返す（冪等）。
- **出力**: `state`（`retiring` / `already_retiring`）、識別（`server_id` / `host` / `user` / `workspace` / `peer`）、`stopped`（止めた cap / worker の数）、`exit_at`、`exit_code`（76）、`host_steps`（host で root が行う unit 削除 → user 削除 → workspace 削除。server 自身は権限が無く行えない）、`service`（systemd / launchd / none と unit 名。`detected: false` は既定名で未確認）、`records_removed` / `sessions`（center の記録から消した cap と session）、`message`。
- **記録の整理**（`RemoteManager.forgetServer`）: 退役した server の cap の記録（session × server）を center の `remotes.json` から消す。`server_id` が一致する記録、`server_id` の無い旧形式は到達先（peer id）が一致する記録が対象で、別の server の記録は peer id が同じでも消さない。**消すのは記録だけで server には何も送らない**（`prune` と同じ方針。server は止まっていく途中で、cap の停止は server が行う）。消してよい理由: 退役は取り消せず、`server.retired` が消えない限り server は戻らない。記録を残すと、peer が発見から消えた後に `unknown` のまま残り、`remote_wait` が待ち続け、`remote_send` の既定の宛先候補にも混ざる。同じ workspace で作り直した server は別の server_id になるので記録は引き継がれない。待っていた `remote_wait` は「待っていた remote が削除された」で終わり、実行中だった指示は server が止める（完了通知は出ない）。退役後の `server_peers` の行は `follow` が `error{retiring:true}`（更新の指示への拒否）を「退役中」と表示し、発見から消えた時点で消える。
- **desktop**: center 画面の server 行の「退役」ボタン（確認ダイアログ付き）がこの tool を `server` = server_id で呼ぶ。protocol 1.8.0 未満の行は無効。`packages/desktop/README.md`。

## session ごとの使う server（servers）

- 除外設定（center 全体で server を外す `servers.exclude`）は**作らない**（利用者の指示）。代わりに、session ごとに「使う server の範囲」をプロジェクト設定（`settings`、`docs/design/project-settings.md`）の `servers` に持つ。center 共通の設定（`center_settings_*`）には置けない（session の設定だけ）。
- 値: host 名か server_id の文字列の配列（50 個以内、重複は除く。host 名は英数字で始まり英数字と `. _ -`、server_id は `[A-Za-z0-9_-]{1,64}`）。server_id は完全一致、host 名は大文字小文字を区別せず、その host の server すべてに効く。同じ host の 2 台のうち 1 台だけを使うなら server_id で指定する。
- **未設定と空配列**: 未設定（`null` で削除、または項目なし）= 範囲を絞らない（全部）。**空配列 `[]` = どの server も使わない**（保存する。`addDirs` の空配列が削除と同じなのとは違う。使わない session を作れるようにするため、未設定と区別する）。
- **合成**: session の `servers` だけを見る（center 共通の設定は見ない）。無ければ全部。`servers: []` は「使わない」。**通知は範囲外の server からも受ける**（`servers` は送信先を絞る設定であり、受信は絞らない。既に起動済みの cap の worker_report / activity / cap_result は捨てない）。
- **効き方**: `remote_send` / `remote_create`（server 省略時は範囲内の先頭を宛先にする。明示指定が範囲外ならエラー）、`remote_delete` / `worker_reply`（server 省略時は範囲内の cap だけが候補、明示指定が範囲外ならエラー）。エラー文は `この session の servers に無い: <server>（session=<名>, servers=[…]）`。範囲内に使える server が無ければ `この session の servers に無い: 使える server が無い（…）`。host 名が複数の server に一致する曖昧エラーは、範囲に関わらず従来どおり。設定の更新は**次の呼び出しからすぐ効く**（`instructions` / `addDirs` と違い、起動し直し不要）。owner の無い呼び出し（desktop の `center_call`）は範囲の影響を受けない。
- **一覧**: `remote_list`（session 向け）と desktop の session 画面（RemoteActivity）に出る server は、その session の cap があるものだけ（`servers` で範囲を後から狭めても、すでにある cap は出る。消すには範囲を広げて `remote_delete`）。center 設定画面の server 一覧は center 全体の全 server を出す。
- **互換**: `servers` の無い旧形式の settings は未設定（全部）として読む。壊れた値（配列でない）も未設定として読み、全 server を止めない。

## server の版合わせ

- 組の版: `pair.server` = 組になる server の npm `bantou` の版、`pair.protocol` = このバイナリに bundle した protocol `bantou` の版。server の版は desktop のビルド（`packages/desktop/scripts/build-sidecar.ts`）が `bun build --compile --env=BANTOU_PAIR_*` で env `BANTOU_PAIR_SERVER_VERSION` を埋め込む（値はビルド時に固定され、実行時の env では変わらない）。埋め込みが無い時は作業ツリーの `packages/server/package.json`（`npm run dev` / tsx / dist 用）、それも無ければ不明（版合わせは無効で、protocol の版の門だけ効く）。単体バイナリ（`build:bin`）は埋め込まないので、`BANTOU_PAIR_SERVER_VERSION` を付けてビルドしない限り不明になる。
- 確認: 起動後（`connectAll` の後）と 30 秒ごと（更新中の server がいる間は 5 秒ごと）に、発見した server へ `hello` を送る。server の版が組と違えば `update_server {version: pair.server}` を送る（新旧は比べない）。server は peer の `summary`（`<host> <workspace>`）で同一視する（peer id は再登録で変わる）。
- 状態: `ok` / `updating`（`update.running` = 待っている cap・worker の件数）/ `unsupported`（protocol 1.3.0 未満。自動更新できず、手動で起動し直す）/ `mismatch`（server の版は組と同じなのに protocol の版が違う）/ `failed`（更新指示が断られた・server が版を取得できなかった。失敗から 5 分おいて同じ版を再指示する。publish 直後の npm 反映待ちはこれで回復する）/ `lost`（更新中のまま 15 分戻らない）/ `unknown`（hello に答えない）。
- 門: protocol の版が `pair.protocol` と違う server には、`hello` / `update_server` 以外（`task` / `worker_reply` / `kick_cap` / `stop_cap` / `status`）を送らず `error`（`code:"version_mismatch"`、`retryable:true`）を返す。版が分からない（名前宛てへのフォールバック）時は従来どおり送る。更新中の server への `task` / `kick_cap` は送らず `code:"updating"`（retryable）で断る。`remote_send` は断られたら記録を作らず isError で返すので、master-cap が後で再送できる。center は自動では再送しない。
- 更新中に server の broker が止まる構成（server の内蔵 broker に center もつなぐ）では、再起動中は接続が切れる。送信失敗で次の使用時に接続を作り直す。

## claude の解決

`remoteControl.claude` 未指定なら、center 起動時に次の順で解決する（GUI 起動の app は PATH が最小のため）。

1. `$SHELL -lc 'command -v claude'`（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り）。最終の非空行が実在する実行可能な絶対パスなら採用（`login-shell`）
2. `~/.local/bin/claude`、`/opt/homebrew/bin/claude` の順に実在・実行可能なものを採用（`fallback-path`）
3. どれも無ければ PATH 任せの `claude`（`PATH`）。警告をログに出す

`remoteControl.claude` 指定時はそのまま使う（`config`、検証しない）。結果はログと `rc_status` / `rc_list` の `claude` に出る。

## PATH の補完

GUI 起動の app（macOS の bantou.app の sidecar）は PATH が `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、bun / node / npx / gh や MCP の `npx` が見つからない。center は起動時に 1 回 PATH を合成して自身の `process.env.PATH` に入れる。session と remote-control の子プロセスはこれを継承する。macOS / Linux のみ（他 OS は変えない）。

1. `$SHELL -lc` で login shell の PATH を取る（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り、1 回だけ）。rc ファイルが余計な行を出しても、目印（`__BANTOU_PATH_BEGIN__`〜`__BANTOU_PATH_END__`）の間だけを採る。絶対パスでない要素は捨てる
2. 取れた時: login shell の PATH → 現在の PATH → 固定候補のうち存在して未掲載のもの、の順
3. 取れなかった時（失敗・タイムアウト・目印なし）: 固定候補のうち存在するもの → 現在の PATH、の順。理由はログに出す
4. 重複は先に出た方を残す。空の要素は捨てる

固定候補（存在するものだけ。この順）: macOS は `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`、`/opt/homebrew/opt/rustup/bin`（Homebrew の rustup は cargo / rustc の proxy を `~/.cargo/bin` ではなくここに置く）、`~/.bun/bin`。Linux は `~/.local/bin`、`~/.cargo/bin`、`~/.bun/bin`。

config の `env.PATH` は補完より優先する（`project.env` > `remoteControl.env` > 補完後の PATH。値はそのまま渡し、補わない）。結果の PATH と取得元（`login-shell` / `fixed-list`）は center のログに出る。

## ログ

- center 自身: stderr に `<ISO> bantou-center: <msg>`。daemon 起動時は同じ行を `logDir/center.log` にも追記する。
- 2xx 以外を返した HTTP 応答: `HTTP <method> <path> -> <status>: <理由>` を center.log に残す（query は除く。理由は応答本文の `error`、無ければ本文の先頭、それも無ければ status message）。
- remote-control の出力: `logDir/<project>.log` に stdout / stderr をそのまま追記する。

## remote-control の再起動

- `state` は `starting` で始まり、出力に `Connected` が出たら `connected`。
- 子プロセスが落ちると `restartDelayMs` 後に再起動する（`continueOnRestart` が `true` なら `--continue` 付き）。`restarts` が `maxRestarts` に達したら `error`（`lastError` は「再起動回数の上限」）。
- 引数の組み立て（claude 2.1.312 の制約）: `--continue` は `--spawn` / `--capacity` と併用するとエラー終了する（`Error: --session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.`）。そのため `spawn` が未指定または `same-dir` で `capacity` も未指定の project は `--spawn` / `--capacity` を付けず（`--spawn` の既定が `same-dir`）、再起動は `--continue` 付き。`spawn` が `worktree` / `session`、または `capacity` を指定した project は `--spawn` / `--capacity` を付け、再起動でも `--continue` は付けない（`continueOnRestart` は無視される）。
- 起動時、projects が 0 件、または autostart の project が 0 件で何も起動しない場合は、理由を 1 行ログに出す（config が読めない場合は致命エラーとして理由が出る）。
- `session_create` / 復元で起動した session も同じ supervisor で動くので、再起動・停止は上記と同じ。
- `rc_stop` は再起動予約を取り消し、SIGTERM、`stopGraceMs` 後に SIGKILL。`restarts` は 0 に戻る。停止後の `rc_start` は `--continue` なしの新規起動。
- 起動のたびに `claude remote-control` は `Enable Remote Control? (y/n)` を出して stdin の返答を待つ。`autoConsent`（既定 true）なら stdout に出た時点で `y` を 1 度送る。stdin は子の生存中ずっと開けておく（閉じると確認待ちで固まる）。
- 子プロセスの環境変数は `process.env` < `remoteControl.env` < `projects[].env` の順で合成する。合成後に `ANTHROPIC_API_KEY`（あると remote-control が失敗する）と `TMUX` を除く。この 2 つは config の `env` でも注入できない。
- center 終了時（SIGTERM / SIGINT。stdio ではさらに stdin の EOF / 切断）は全 project を停止してから exit 0。15 秒で強制終了。

## 開発

```bash
cd packages/center
npm run typecheck
npm run build
npm test          # node:test。ネットワーク・claude・実 bantou-server は不要
npm run dev -- --config <path>
```

## 単体バイナリ

`bun build --compile` で Node 無しで動く単体バイナリにする（`@agent-hand/bantou-protocol` などの依存も同梱）。先に protocol をビルドしておく（`file:../protocol` は `dist` を指す）。

```bash
(cd ../protocol && npm run build)
npm run build:bin                      # dist-bin/bantou-center（実行ホスト向け）
npm run build:bin -- --target=bun-darwin-arm64 --outfile dist-bin/bantou-center-darwin-arm64
```

- `--target`: `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` など bun の compile target。
- `--outfile`: 既定は `dist-bin/bantou-center`。`dist-bin` は git 管理外。
- 実行: `./dist-bin/bantou-center --transport http --port 7910 --config <path>`。
- バイナリ内では package.json を読めないため、MCP の server version は `0.0.0` になる。

## e2e

```bash
cd packages/center
npm run e2e
```

- stub の remote-control（確認プロンプトを出し、stdin の `y` を受けてから `Connected` を出す node スクリプト）と、本物の bantou-server（`packages/server/` を `tsx` で起動）を使う。
- `cap_kick` で claude を 1 回起動するため、claude のログインが要る。数分かかる。
- 一時ディレクトリは `E2E_ROOT`（既定は OS の tmp）の下に作り、終了時に消す。
- 確認内容: tool 一覧、`rc_start` → `connected`、stub の異常終了 → `--continue` 付き再起動、`rc_stop`、`server_list`、`cap_kick`、`server_status`、stdin EOF での自己終了。

## context 使用量

session（`session_create` で作った wrapper 経由の claude。master-cap を含む。config 由来の project は対象外）ごとに、claude のコンテキストの使用状況を center が把握し、`session_list` の `contextUsage` に載せる。`src/context-usage.ts`。

- 取得元は 2 つ。**statusLine（正本）**: center が master-cap に渡す statusLine が、claude の stdin JSON（`context_window`）を center に POST する（下記「statusLine 方式」）。**transcript（予備）**: statusLine の値が来るまで、または statusLine から使用量が取れない間に使う。以降の「対象の transcript」「値」「窓」「更新」は予備（transcript 方式）の説明。
- transcript の場所: claude の transcript（`<CLAUDE_CONFIG_DIR または ~/.claude>/projects/<cwd の英数字以外を - にした名前>/*.jsonl`）。端末の画面は解析しない。
- 対象の transcript: その dir の `*.jsonl` のうち、今回の起動時刻（`startedAt`）の 2 秒前以降に更新された最新の 1 本。起動し直すと前の値は捨てる。同じ cwd で別の claude を手で動かすと取り違え得る。
- 値: 末尾から読んだ最後の assistant message（sidechain・`<synthetic>` を除く）の usage の `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` = `usedTokens`。transcript は末尾 64KB だけ読み、該当行が無ければ 4 倍ずつ（上限 8MB）広げる。全体は読まない。
- 窓（transcript 方式）: `windowTokens` は config の `remoteControl.model` か transcript の model に `[1m]` があれば 1,000,000。それ以外は `null`（transcript の model は `[1m]` が落ちた素の名前で、素の名前から窓は決められない。`percent` も `null`、desktop はトークン数だけ出す）。`percent` は小数 1 桁。
- 更新: 5 秒ごとに transcript の mtime / size を見て、変わっていなければ読まない。値が変わった時だけ `GET /events` に `reason: "context"` を流す（desktop は `session_list` を取り直す）。古い desktop は reason を見ずに取り直すだけなので混在しても動く。
- `protocol`（`packages/protocol`）は変えない（`session_list` は center の tool で、protocol のメッセージではない）。

### statusLine 方式

- 背景: transcript の model 名は `[1m]` が落ちた素の名前で、窓（200k か 1M か）を決められなかった（`[1m]` 無しの session で 25 万 token 使えていた）。claude が statusLine コマンドの stdin に渡す JSON の `context_window.context_window_size` が窓の正本。
- center は wrapper 経由の session を起動する時、`--settings '{"statusLine":{"type":"command","command":"<center の status-line サブコマンド>"}}'` を足す。`--settings` は他の設定と併合され、`statusLine` のキーだけを渡すので他の設定（hooks・output style・permissions など）は上書きしない。**利用者の statusLine 設定（`settings.json` の `statusLine`）より center のものが優先される**ので、master-cap では利用者の statusLine は表示されない（2.1.317 で実測。user の settings.json に statusLine があっても center のコマンドが呼ばれた）。窓口が無い（stdio）時は付けない。config 由来の project（`claude remote-control` 直起動）には付けない。
- コマンドは center 自身のサブコマンド `bantou-center status-line --url <center>/sessions/<name>/status-line`。bun / node / curl に依存せず、compiled の center 1 本で動く（`/bin/sh` + `curl` は Windows に無いので採らなかった。Windows での実行・quote は未検証）。stdin の JSON を POST し、stdout には何も出さない（statusLine の表示を空にする）。失敗は stderr に 1 行出すだけで終了コードは常に 0。タイムアウト 2 秒。
- token は argv にも設定にも載せない。claude の env の `BANTOU_SESSION_TOKEN`（起動ごとの使い捨て、`--mcp-config` と同じもの）を、statusLine の子（サブコマンド）が自分で読む（statusLine の子は claude の env を継ぐ。実測）。`curl -H "Authorization: Bearer $T"` だと curl の argv に token が出て `ps` に見えるため採らない。
- `POST /sessions/<name>/status-line`: 認証は**その session の token**（`Authorization: Bearer <session token>`。外向け token・他の session の token は 401）。本文は JSON object。204。壊れた JSON・object 以外は 400（center.log に `statusLine の JSON が不正: session=<name>`）。POST 以外は 405。
- 値: `windowTokens` = `context_window_size`、`usedTokens` = `total_input_tokens`（claude 自身の式。`input + cache_creation + cache_read`、**output を含まない**。transcript 方式は最後の応答の output 分だけ多い）、`percent` = `usedTokens / windowTokens` を小数 1 桁（`used_percentage` は整数に丸められて来るため出し直す）、`model` = `model.id`。
- `used_percentage` が `null` の間（初回の API 応答前・`/compact` 直後）は使用量を持たない。その間は transcript の値を使い、窓だけ statusLine の `context_window_size` で補う。statusLine の値が取れたらそれが transcript に優先する。起動し直したら statusLine の値は捨てる。
- master-cap の端末では、statusLine を設定していなかった利用者でも、footer の `esc to interrupt` や `? for shortcuts` などの hint が消える（custom statusLine を設定した時の claude の仕様。docs 記載、実機では footer の hint 消失までは見ていない）。
- 更新: POST のたびに反映し、値（使用量・窓・percent・model）が変わった時だけ `GET /events` に `reason: "context"` を流す。claude は 300ms の debounce で呼ぶ。

## 作業状態（activity）

session（`session_create` で作った wrapper 経由の claude。config 由来の project は対象外）ごとの作業状態を `session_list` の `activity` に載せる。`src/session-activity.ts`。pty 出力の文字列解析はしない。

- `session_list` の各要素: `"activity": "working" | "needs-input" | "idle" | "unknown"`、`"activityAt": "<ISO>" | null`（最後に状態が変わった時刻。unknown は null）。既存の `state`（stopped / starting / connected / error）はそのまま。
  - `working` = turn 実行中 / `needs-input` = 利用者の入力待ち（permission の確認、AskUserQuestion、plan 承認） / `idle` = turn が終わり次の指示待ち / `unknown` = 不明（表示しない）。
  - thread の ask（status `waiting`）は desktop 側の情報で center は持たないので、`activity` には含まない（desktop が needs-input として合成する）。
- 取得元は Claude Code の hooks。center は wrapper 経由の session を起動する時、statusLine と同じ `--settings` に `hooks` を足す（利用者の hooks は置き換わらず足し合わされる。`~/.claude/settings.json` / `~/.claude.json` は触らない）。hook のコマンドは center 自身のサブコマンド `bantou-center hook --url <center>/sessions/<name>/hook`。stdin の JSON に発火時刻（`bantou_ts`）を足して POST する。token は argv にも設定にも載せず、claude の env の `BANTOU_SESSION_TOKEN` から読む。失敗しても終了コードは 0（claude を止めない）。
- `POST /sessions/<name>/hook`: 認証は**その session の token**（外向け token・他の session の token・token 無しは 401）。本文は JSON object（壊れた JSON・object 以外は 400）。204。起動中（starting / connected）の session だけ反映する。
- event → 状態:

| event | 状態 |
| --- | --- |
| SessionStart（source が compact 以外） / Stop / StopFailure / Notification `idle_prompt` | idle |
| UserPromptSubmit / PreToolUse（下記以外の tool） / PostToolUse / PostToolUseFailure / PermissionDenied | working |
| PreToolUse（AskUserQuestion・ExitPlanMode） / PermissionRequest / Notification（`permission_prompt`・`elicitation_dialog`・`elicitation_url_dialog`・`agent_needs_input`） | needs-input |

  上記以外の event・Notification は状態を変えない。Stop / StopFailure の hook だけ同期（他は `async: true`。claude が Stop 直後に終了する -p では async の hook が cancel される）。
- 古い状態を残さない: 保持はメモリのみで、起動時刻（`startedAt`）ごと。session が停止・error・起動し直しになると `unknown`（token も起動ごとに作り直すので、前の claude の遅れた hook は 401）。center 再起動直後は、次の hook まで `unknown`。発火時刻が最後に反映した event より古い hook は捨てる（到着順の入れ替わり対策）。
- 変わった時だけ `GET /events` に `reason: "activity"` を流す（受け手は `session_list` を取り直す）。
- 限界（実機の対話モードでは未確認。公式 docs の記述からの整理）: 利用者が Esc で turn を中断した時、または permission の確認を利用者が拒否した時に発火する hook は、公式 docs（https://code.claude.com/docs/en/hooks、2026-11-10 確認）に見当たらない。`PermissionDenied` は auto mode が拒否した時だけで「手動で permission ダイアログを拒否した時は動かない」と書かれ、`PostToolUseFailure` は「permission denial では発火しない」「実行中 tool のキャンセルでは発火しない」と書かれ、`Stop` は「Claude が応答を終えた時」で Esc で発火するかは書かれていない。このため出口の hook は足していない（推測で足さない）。結果として、PermissionRequest 由来の **needs-input（判断待ち）が、利用者が拒否・中断した後も残り**、画面に「判断待ち」が出続けうる（実際は判断待ちでない）。working も Esc 中断で残りうる。次の hook（UserPromptSubmit など）か idle_prompt（約 1 分の入力待ち通知）が来れば戻る想定だが、これも未確認。時間切れで消す仕組みも足していない。
- 他の未確認: background task（subagent・バックグラウンド実行）が Stop の後に動き続けて hook が来ると working に戻りうる。発火時刻が同一ミリ秒の event は到着順になる。PreToolUse / PostToolUse ごとに hook サブコマンドが 1 回起動する負荷は未計測。

### remote の反映（`remote`）

master-cap が server の remote-cap に仕事を預けて待っている間も、session の状態に反映できるよう、`session_list` の各 session に remote の集計を載せる（`remotes.ts` の `summary(session)`）。

- `"remote": { "running": number, "waitingReply": number }`。cap が無ければ `{ "running": 0, "waitingReply": 0 }`。`activity`（hook 由来）とは独立で、合成は desktop 側。
  - `running` = その session の cap（remotes の記録で `session` が一致）で、未完了の指示（`pending`）がある **server の数**（session × server で記録が 1 件なので、記録の数）。task の数ではない。
  - `waitingReply` = その session の cap の worker_report（kind `ask` / `approve`）で、worker_reply がまだ返っていない数。**動いている cap（pending あり、または `remote_list` と同じ見え方 `stateOf` が running = 返信待ち・判定待ち・cap / worker が動いている）のものだけ**数える（止まった cap の未返答が残って「判断待ち」が消えなくなるのを避ける）。
- 返答済みの印: worker_reply が server に受理されると、その cap の記録の中で、同じ `worker_id` の未返答の ask / approve の `worker_reports[].replied_at`（ISO）に時刻を入れる。`remotes.json` に保存されるので center 再起動後も保たれる。送れなかった（error）時は付けない。`remote_list` の `worker_reports` にも `replied_at` が出る。
- 解消: 同じ cap の同じ `worker_id` から、未返答の ask / approve より後に progress 以外の report（done・新しい ask / approve。protocol に failed は無いが progress 以外なら同様）が来たら、前の未返答は返答なしで解消と見なし `worker_reports[].superseded_at`（ISO）を付けて `waitingReply` に数えない（保存される。`remote_list` にも出る）。progress・別 worker・別 cap の report では解消しない。
- 通知漏れ対策: activity の通知・判定待ち（settling）・返信待ち（inflight）の変化は記録の保存を通らないことがあるので、変化点（waiters を起こす所 = wake）でも集計を再評価する。変わった時だけ流す。
- worker_reply が付ける `replied_at` は、返答を送った**時点**で返答待ちだった ask / approve だけ（送信の await 中に届いた新しい ask は返答待ちのまま）。
- 変わった時だけ `GET /events` に `reason: "remote"`（`name` = session 名）を流す（受け手は `session_list` を取り直す）。記録の保存のたびに前回通知した集計と比べるので、task 送信・task_result・worker_report・worker_reply・完了判定・remote_delete のどれで変わっても 1 回だけ流れる。progress / done の report のように集計が変わらないものでは流さない。polling は増やしていない。
- 限界: worker_reports は 1 つの cap で最新 20 件までなので、古い未返答の ask が progress 等で押し出されると数えなくなる。実際の server・desktop を繋いだ確認はしていない（unit test のみ）。

## 未決

- B の owner を master-cap の接続に自動で載せる仕組み（上記「今は」の限界）。center が master-cap を起動する時に MCP 設定を渡せる手段が `claude remote-control` に無い。
- 未 trust の path の扱い（center が trust を付ける手段）。
- remote の長期運用（`running` のまま返信が失われた時の再同期。server の `status` と突き合わせる案）。
- session 削除後に claude.ai に残る remote-control の environment / session 表示は、CLI からは消せない（確認した範囲で手段を見つけていない）。

- 認証（center ↔ server）。desktop ↔ center は Bearer token（上記）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。

## 窓口の分離

- 外向け `/mcp`: 認証は config の `token`（Bearer）。`session_*`、読み取り専用の `remote_list`、`remote_wait`、`worker_reply`（desktop の `center_call` 用。引数は `{ remote_id?, worker_id, text, server? }`）、`rc_*`、`server_*`、`worker_resume`。`remote_send` / `remote_create` / `remote_delete` / `cap_kick` は無い。
- session 向け `/mcp/session`: `remote_send` / `remote_create`（別名）/ `remote_delete` / `remote_list` / `remote_wait` / `worker_reply` だけ。認証は session の起動ごとに center が作る使い捨て token（`Authorization: Bearer <token>`）と header `X-Bantou-Session: <session 名>` の組で、token はその名前に発行されたものだけ通る。不一致・外向け token・欠落は 401。owner は header の名前で、引数では受けない。MCP session id は窓口をまたいで使えない。
- token は session の起動（再起動を含む）ごとに作り直し、停止で無効になる。master-cap には環境変数 `BANTOU_SESSION_TOKEN` で渡し、`--mcp-config` の JSON には `${BANTOU_SESSION_TOKEN}` と書く（引数に平文で残さない、ファイルも書かない）。

## master-cap の起動（wrapper）

- `session_create` の session は `bantou-pty-wrapper --cols N --rows N -- claude --remote-control <name> --permission-mode <m> --mcp-config '<JSON>' [--continue]` で起動する。wrapper は `dirname(process.execPath)/bantou-pty-wrapper`、env `BANTOU_PTY_WRAPPER` で上書き。config の `projects`（`rc_*`）は従来の `claude remote-control` のまま。supervisor は 1 つで、entry ごとに起動方式を選ぶ（再起動・`--continue`・素の起動への fallback・ログ・有効化確認への自動応答は共通）。
- `--mcp-config` の JSON には `bantou`（http、`/mcp/session`。窓口が無い時は付けない）と `bantou-messenger`（stdio、agent-messenger）が入る。`bantou-messenger` は `npx -y @unagents/messenger@0.12.2 mcp` を env `AGENT_MESSENGER_NAME=<session 名>` で起動し、session 名を messenger の peer 名にする。受信は Claude Code の inbox socket 経由で会話に現れる（pty への書き込みではない）。broker は client が env → config → UDP 発見で解決する（center は指名しない）。再起動・`--continue` でも同じ名前で登録し直す。center の子プロセスの PATH に `npx` が要る（center が起動時に PATH を補う。「PATH の補完」参照）。
- **permission（bantou 自身の MCP tool の許可）**: center は `--settings` に `permissions.allow` を足し、auto mode の分類器に止められないようにする。入れる rule は `mcp__bantou-messenger__*`（常に）、`mcp__bantou__*`（窓口がある時だけ）、`mcp__memory__*`（外部記憶がある session だけ）。書式は公式 docs（permissions の MCP 節）の `mcp__<server>__*`（server の全 tool）で、server 名は `--mcp-config` の entry 名と同じ。
  - 利用者の設定との関係: `permissions.allow` は他の scope の設定と**連結**される（公式 docs「Lists merge instead of overriding」）。利用者の allow は消えない。deny は全 scope の allow より先に評価される（公式 docs）ので、利用者が `mcp__bantou__remote_delete` などを deny していればそれが勝つ。center は deny を書かない。
  - config 由来の project（`claude remote-control` 直起動）は `--settings` も `--mcp-config` も渡さず bantou の MCP が付かないので、allow も付けない。
  - 実機で session に permission の確認が出なくなるかは未検証。
- wrapper との間は 1 行 1 JSON（wrapper の stdout: `started` / `output`（base64）/ `text`（制御文字を除いた文字列）/ `exit`、stdin: `input` / `resize` / `stop`）。session URL と接続状態は `text` の直近 16 KiB の窓に対して照合する（行単位ではない）。有効化確認への自動応答は `input`（`y\r`）。
- `--settings` で center の statusLine を渡す（引数の順は `--mcp-config` の後、`--continue` の前）。利用者の statusLine 設定より center のものが優先される（「context 使用量」の「statusLine 方式」）。
- 停止は wrapper へ `stop` を送って待ち、`stopGraceMs` 内に終わらなければ SIGKILL。

## core（出力の配信）

center プロセス内のモジュール（`src/core.ts`）。session ごとのキュー（チャンク ID は 1 からの連番、デコード後 8 MiB を超えたら古い分から捨てる、wrapper の再起動をまたいで続く）。外向け token で次を提供する。

- `GET /sessions/<name>/output`: SSE。続きは `Last-Event-ID` か `?after=<id>`。続きが残っていない / 指定なしは `event: reset` の後に積んである全部。各チャンクは `id: <id>` `event: output` `data: <base64>`。15 秒ごとに `: ka`。未知の session は 404。
- `POST /sessions/<name>/input` `{"data":"<base64>"}` → 204（実行中でなければ 409）。
- `POST /sessions/<name>/resize` `{"cols":N,"rows":N}` → 204。最後に送った側のサイズを覚え、次の wrapper 起動の初期値にする。

- `GET /events`: SSE（外向け token、イベント ID・再送なし）。接続時に `event: sessions` `data: {}`、session の追加・削除・起動時復帰・名前 / path の変更・認証状態の変化ごとに `event: sessions` `data: {"reason":"created"|"deleted"|"restored"|"updated"|"context"|"changed","name":"<name>"}`。15 秒ごとに `: ka`。`changed` = `auth` / `loginUrl` / `loginError` が変わった。受け取った側は `session_list` を取り直す。

## 添付画像

master-cap の claude は center のホストで動くので、画像は center のホストに置かれて初めて読める。desktop（sidecar でも別ホストの center でも同じ route）が貼り付け・ドロップ・添付ボタンの画像を送る。

- `POST /sessions/<name>/attachments`: 外向け token（`Authorization: Bearer`）。本文は画像のバイト列そのもの、`Content-Type` に型。session 名は `[A-Za-z0-9_-]+`（他の `/sessions/<name>/...` と同じ）。
- 受ける型は `image/png` `image/jpeg` `image/gif` `image/webp`。1 枚 20MB（20 × 1024 × 1024 バイト）まで。型は `Content-Type` と、先頭バイト（マジックナンバー）の両方が合っている時だけ通す。
- 応答は 201 `{"path":"<絶対 path>","bytes":N,"type":"image/png"}`。拒否は `{"error":"<理由>"}`: 401（token）、404（未知の session・不正な session 名）、405（POST 以外）、409（config に `workspace` が無い・同じ秒の連番が尽きた）、413（20MB 超。読まずに接続を閉じる）、415（型違い・中身が画像でない）、400（本文が空）。
- 置き場: `<workspace>/<session 名>/attachments/<yyyymmdd-HHMMSS>-<NN>.<png|jpg|gif|webp>`（時刻は center ホストのローカル時刻、`NN` は同じ秒の中の 01〜99）。dir が無ければ作る。既存のファイルは上書きしない。`workspace` は config の値（`session_create` で `path` を省いた時の親と同じ）。session を `path` 指定で作っていても、置き場は `<workspace>/<session 名>` 配下。
- ログ（`center.log`）: 保存は `添付を保存: session=<名> bytes=<N> path=<path>`、拒否は `添付を拒否: session=<名> reason=<理由>`。本文は残さない。
- 自動削除はしない。要らなくなったら手で消す: `find <workspace>/<session 名>/attachments -type f -delete`（その session の分を全部）、または 1 枚ずつ `rm <path>`。
