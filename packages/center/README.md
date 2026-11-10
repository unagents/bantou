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
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |
| `workspace` | 絶対パス | なし | `session_create` で `path` 省略時の置き場所 `<workspace>/<name>` の親。session は起動時に立てない |
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### config の読み直し

center は wrapper 経由の session（master-cap）を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に `--config` のファイルを読み直す。center は再起動しない。動いている session には効かない。保存後に起動する session から効く。

- 読み直しで効く: `remoteControl.model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`（その session の起動時点の値。再起動の予約もその起動で読んだ値で決める）。
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
| `center_settings_get` | なし | `{ settings }`（center 共通の設定。未設定は `{}`） |
| `center_settings_update` | `settings`（項目ごとにマージ。`null` で項目を削除） | `{ settings }`（更新後の全体。全 session の次の起動から効く） |
| `session_delete` | `name` | `{ name, deleted }` |
| `session_list` | なし | `SessionInfo[]` |
| `center_info` | なし | `{ workspace: string \| null, systemInstructions: [{ id, version, title }] }`（`workspace` は config の `workspace`。未設定は `null`。desktop の追加ダイアログがフォルダ欄の既定 `<workspace>/<name>` を出すのに使う。`systemInstructions` は master-cap の起動時に付けるシステム埋め込み指示の部品。項目は今後増える） |
| `remote_send`（session 向けのみ） | `goal`, `deliverables?`, `verify?`, `constraints?`, `workers?`, `worker_model?`, `repo?`, `branch?`, `server?` | `{ remote_id, server, server_id?, peer, host?, serverName, state, created, task_id, worker_model? }`（返信を待たない。`server` は server_id、旧 server は peer id。`peer` は今の到達先、`host` は host 名）。呼び出し元 session の remote-cap（server ごとに 1 つ。cap_id = `c-<center-id>-<session 名>`）へ `task` を送る。owner は header の session 名。他の session の cap には届かない。`goal` だけなら `deliverables: {}` / `verify: {}` / `constraints: []` / `workers: {}`（items 無し = implement + review の最低 2 体）。`task_id` は center が採番。`worker_model` は新規の cap なら「引数 ?? config `servers[].workerModel`」、既存の cap は引数があった時だけ載せる（server が cap の既定として記憶する）。protocol の版が合わない server へは送らず isError |
| `remote_create`（session 向けのみ） | 同上 | `remote_send` の互換の別名（同じ処理） |
| `worker_reply` | `remote_id?`, `worker_id`, `text`, `server?` | `{ remote_id, server, worker_id, accepted: true }`。server の worker へ返答を送る（`worker_report` の ask / approve への回答。server が同じ `worker_id` で worker を起動し直して `text` を渡す）。`remote_id` 省略時は呼び出し元 session の cap（server が複数あれば `server` で絞る）。他の session の cap には送れない（旧共有 cap は `remote_id` で明示）。外向け（desktop）は owner を持たないので全件が対象。protocol の版が合わない server へは送らず isError。session 向け・外向けの両方 |
| `remote_delete`（session 向けのみ） | `remote_id?`, `server?`, `force?` | `{ remote_id, deleted, stopped, warning? }`。cap の停止（`stop_cap`）と記録の削除。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ（他の session の cap は見えない・触れない）。`remote_id` 省略時は自分の cap（server が複数あれば `server` で絞る） |
| `remote_list` | `owner?`（外向け。無ければ全件）。session 向けは `include_shared?`（旧共有 cap も含める）で、自分の session の cap だけ | `RemoteView[]`（server の cap 単位。`RemoteRecord` + `owners` + `worker_reports` + `activity?`、下記。`task_result?`（最新の `task_result` 本体）、`server_label`（host 名を主に server_id を添えた表示）を含む） |
| `remote_wait` | `remote_id?`, `server?`, `timeout_sec?`（既定 600、上限 1800）, `owner?`（外向けのみ） | 終わった `RemoteView`。timeout なら `state: "running"` のまま。下記「完了通知」 |
| `rc_list` | なし | `RcStatus[]` |
| `rc_start` | `project` | `RcStatus`（起動済みなら現状を返す） |
| `rc_stop` | `project` | `RcStatus` |
| `rc_status` | `project` | `RcStatus` |
| `server_peers` | `refresh?` | `{ pair: { server, protocol }, peers: FollowEntry[] }`。下記「server の版合わせ」 |
| `server_list` | なし | `{ name, connected, reachable, peerId, serverPeer }[]`（`reachable` は broker への接続を確保できたか、`peerId` は center 自身の peer id、`serverPeer` は直近に解決した server の送信先（peer id か名前、未解決は null）） |
| `worker_resume` | `server`, `worker_id`, `prompt`, `repo?`, `branch?` | `worker_result` / `error` 返信そのまま |
| `server_status` | `server` | `status_result` / `error` 返信そのまま |

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

### session（A）

- `session_create`: pty wrapper 経由の対話型 `claude --remote-control <name> --permission-mode <permissionMode> --mcp-config '<JSON>'`（再起動時は `--continue` 付き）を `path` で起動し、supervisor に動的に足す（起動の詳細は「master-cap の起動（wrapper）」）。`path` 省略時は config の `workspace` の下の `<name>`（無ければ作る）。`workspace` が無ければ `path` が必須。`permissionMode` の既定は `auto`。`name` の重複、既存 project 名との衝突、他の project / session と同じ path は拒否。接続（URL 取得）か早期終了まで最大 15 秒待って状態を返す（待ちきれなければ `starting`）。
- `session_update`: `session_create` で作ったものだけ（config 由来・未定義は `session_delete` と同じ文言で拒否）。`newName`（既存の session / project 名と重複不可）と `path`（他の session / project と重複不可、絶対パス）を変える。`newName` も `path` も実質変わらない呼び出しは拒否。手順: (1) 検証 (2) `supervisor.remove`（停止・core / token の解除） (3) `path` 指定時は、`move: true` なら今のフォルダを新しい `path` へ `fs.rename` で移動（親 dir は作る。EXDEV など失敗したら error にして何も変えない。コピーはしない）、そうでなければ新しい `path` を作るだけ（今のフォルダは残す。`move` は `path` が無ければ無視） (4) `sessions.json` の `name` / `path` を更新（`settings`・並び順はそのまま） (5) 名前を変えたら remotes の記録を付け替え (6) 新しい名前で `add` → `start(resume)` (7) `session_create` と同じ待ちで `SessionInfo` を返し、`GET /events` に `reason: "updated"`（`name` = 新しい名前）を流す。途中で失敗したら記録・フォルダの移動・remotes の付け替えを戻し、元の名前で起動し直す（best effort。失敗は center.log）。`instructions` / `addDirs` は新しい名前へ引き継ぐ。
  - **path を変えると `--continue` が効かない**: claude の会話は path ごとに保存されるため、新しい path では `--continue` が「会話が無い」で落ち、既存の fallback で素の起動（新しい会話）になる（仕様）。名前だけ変えた時は同じ path なので会話は続く。`move: true` でフォルダを移しても会話の保存先（`~/.claude/projects/<path を変換した dir>`）は移らない。
  - **cap_id は変わらない**: remote の記録（`session` と未完了の指示の `owner`）だけ新しい名前へ付け替える。cap_id は `c-<center-id>-<旧名前>` のままで、server 上の cap をそのまま使う（以後の `remote_send` も記録の cap_id を使う）。
  - **別の session の remote 記録と衝突する名前は使えない**（`remote_delete` で記録を消せば使える）: (a) 改名後、旧名の cap_id を新しい名前の記録が持つので、旧名での `session_create` と、別の session から旧名への改名は拒否（改名した session 自身が旧名へ戻す改名は、その記録が改名元のものなので許す: pm1 → pm2 → pm1）。(b) 削除済み session の記録が残る名前への改名も拒否。許す: `session_delete` 後に**同じ名前で `session_create`** した時は、その名前の記録を続きとして引き継ぐ（旧 cap を使う。従来どおり）。
  - 名前を変えると remote-control 名・messenger の peer 名・ログ名（`<name>.log`）・statusLine の URL も新しい名前になる。旧名前宛ての messenger 通知は届かない。
- `session_delete`: `session_create` で作ったものだけ。remote-control を停止（SIGTERM → `stopGraceMs` 後 SIGKILL）して監視と保存から外す。path は消さない。config 由来の project は拒否。
- `session_list`: config の project と session の全部。`source` が `config` / `session`。`instructions`（真偽。その session を起動した時に `--append-system-prompt`（session の `instructions`）を付けたか。本文は出さない。`rc_status` の `instructions` と同じで、`rc_status` の `args` でも値は `<N 文字>` に伏せる）が付く。`contextUsage`（`{ usedTokens, windowTokens, percent, updatedAt, model? }`。`model` は statusLine 由来の時だけ。まだ分からない時は `null`）が付く。取得の仕組みは「context 使用量」。
- プロジェクト設定（`settings`、設計は `docs/design/project-settings.md`）: session ごとの設定。`{ instructions?: string, addDirs?: string[], … }`。`addDirs` は master-cap が参照してよいフォルダ（center のホスト上の絶対パス、20 個以内、重複は除く）で、起動のたびに 1 つずつ `claude --add-dir <path>` で渡す（空配列は削除と同じ）。`session_create` の `settings` で作成時に渡し、`session_settings_get` で読み、`session_settings_update` でマージ更新する（`settings` に書いた項目だけ変わる・省略した項目は変わらない・`null` で項目を削除・未知の項目は保持して返す）。`sessions.json` の各 session の `settings` に保存する。config 由来の project は更新できない（get は `{}`）。更新は次の起動から効く（動いている session は起動し直さない）。
- `settings.instructions`（追加指示、16000 文字以内、空文字は削除と同じ）: session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動・center 再起動後の復元）に、値があれば claude へ `--append-system-prompt <値>` を足す。argv の 1 引数で渡し、shell は通さない（複数行・引用符・`$` もそのまま届く）。center の config（`center.json`）の `remoteControl.sessionInstructions` は廃止: 残っていても無視し、起動時の読み込みで `center.log` に warning を 1 行出す（値は出さない）。
- システム埋め込み指示（`src/system-instructions.ts`、設計は `docs/design/system-instructions.md`）: master-cap の起動のたびに `--append-system-prompt` の先頭に付ける bantou 側の決まり文（今は `master-cap-role@1`: 自分では作業せず remote-cap に指示を出す運用）。利用者の追加指示とは別管理で、設定画面には出さない。部品は id と version を持ち、起動した session の status の `systemInstructions` と `center_info.systemInstructions` で分かる。`--no-chrome` は付けない（2026-11-04 に外した。Chrome 拡張の確認が出た時はターミナルから答える）。
- center 共通の設定（`center_settings_get` / `center_settings_update`）: 全 session に効く設定で、形は session の `settings` と同じ（`{ instructions?: string, addDirs?: string[], … }`、instructions は 16000 文字以内、未知の項目は保持）。`addDirs` は全 session の `--add-dir` に 1 つずつ付き（共通が先）、session 自身の `addDirs` はその後ろ（重複は除く）。`instructions` は全 session の `--append-system-prompt` の値の先頭に付き、session 自身の `instructions` は空行 1 つを挟んでその後ろ（どちらも無ければ付けない）。config と同じ dir の `center-settings.json` に保存し（object 1 つ。壊れた・無いファイルは未設定として読む）、更新は保存済みの全 session に次の起動から効く（動いている session は起動し直さない）。`sessions.json` の各 session の `settings` には混ぜない。desktop の設定ダイアログ（ヘッダーの歯車）の「共通の追加指示」がこの tool で読み書きする。
- 保存: config と同じ dir の `sessions.json`（`name`, `path`, `permissionMode`, `settings`（あれば）, `createdAt`）。config の projects には書かない。center 起動時に復元して `--continue` で起動する。`--continue` で接続前に 30 秒以内に終了した場合（約 4 時間以内の記録が無い、など）は、素の起動へ fallback する（再起動回数は増やさない）。
- 新規 path の trust: **trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run `claude` in <path> first ...` で即 exit 1 する**（claude 2.1.312 で実測）。親 dir が trust 済みなら配下は通る（実測: trust 済みの repo 配下の dir で `connected`）。そのため、未 trust の path では `session_create` は `state: starting` と `lastError`（`接続前に終了: Error: Workspace not trusted...`）を返し、supervisor は再起動を繰り返して上限で `error` になる。対処は、workspace（または path の親）で一度 `claude` を起動して trust を承認しておくこと。center が claude の設定ファイルを書き換えて trust を付けることはしない（今は）。
- 同じ folder を別の `claude remote-control` が直前まで握っていると、`This folder is already served by a terminal \`claude remote-control\` on this device. Stop it first.` で約 1 分待たされて終了する（実測、直前の center を強制終了した後など）。

`SessionInfo`: `name`, `path`, `state`（`stopped` / `starting` / `connected` / `error`）, `pid`, `sessionUrl`, `startedAt`, `source`, `lastError?`。

### remote（B）

- **原則（2026-11-04 に改訂）: remote-cap は session × server に 1 つ**（session = master-cap と remote-cap は 1 対 1）。作業が何であれ、center はその session の cap に次の指示を送る（作業ごとに cap を作らない）。記録は「session × server の cap」単位で、`remote_id` = cap_id、`session` を持つ。以下の「server ごとに 1 つ」「center ごとに固定の cap_id」はこの原則に読み替える。他の session の cap とその指示・結果は見えない・触れない。
- **session ごとの cap_id**: `c-<center の 10 桁 hex>-<session 名>`（session 名は 64 文字まで）（例 `c-0a1b2c3d4e-main`。`sessionCapId`、center-id.ts）。session 名は `[A-Za-z0-9_-]+`（`SESSION_NAME` / `OWNER_PATTERN`。cap_id の `AGENT_ID_PATTERN` と同じ）なので**変換は恒等**（エスケープ無し）。文字種外の名前は error（別の名前に寄せない）。衝突しない根拠: `c-<10 桁 hex>` は固定長で 1 center に 1 つなので、cap_id は session 名で一意。旧共有 cap の `c-<10 桁 hex>` は接尾辞が無く、どの session の cap_id とも違う。将来 session 名の文字種を広げる時は、許可外の文字を `_` + 2 桁 hex（UTF-8 のバイトごと）、`_` 自体を `_5F` に変える（今は使わない）。
- **境界**: 「他 session から見えない・触れない」を保証するのは `/mcp/session`（session ごとの使い捨て token + `X-Bantou-Session` の照合）だけ。外向け `/mcp`（center token。desktop 用）の `remote_list` / `remote_wait` / `worker_reply` / `remote_delete` は owner を自己申告でき、省略で全件。desktop は全件を取って client 側で選択中 session に絞る。
- **session を消しても cap は残る**: `session_delete` は cap の記録・server の cap・worker に触れない（通知は届かず失敗ログのみ）。同名の session を作り直すと同じ cap_id で旧 cap を引き継ぐ。不要なら `remote_delete`。
- **既知の制約**: server の FS が大文字小文字を区別しない（macOS など）と、session `Main` と `main` の cap が同じ dir になりうる。
- **旧共有 cap**: 起動時に引き継いだ `c-<center-id>` など（下記）は `session` の無い記録。新しい指示は送らない。session 向け `remote_list` は `include_shared: true` の時だけ出す。`remote_delete` / `remote_wait` / `worker_reply` は `remote_id` を明示した時だけ対象にできる（`remote_delete({ remote_id: "c-<center-id>" })`。他の session の cap は対象にならない）。
- **center の cap_id（接頭辞）**: `c-<10 桁 hex>`（session の cap_id は `c-<10 桁 hex>-<session 名>`。上の「session ごとの cap_id」）。center の状態 dir（config と同じ場所）の `center-id` ファイルに 10 桁 hex を持ち、無ければ最初の起動で乱数から作って保存する。center を再起動しても同じ値になる。選んだ理由: (1) center ごとに固定でなければ、再起動のたびに server に新しい cap が残る。(2) 乱数でなく hostname や config のパスから導くと、別 center と衝突したり、dir の移動・コピーで変わる／重なる。(3) 状態 dir はすでに `remotes.json` `sessions.json` の置き場で、center の状態と一緒に残る。`center-id` が書けない時は、その起動の間だけの id を使い（ログに出す）、再起動で変わる。記録は session × server に 1 件（server は server_id、server_id が分からない旧形式の記録は peer id。「server の識別」の節）。記録の無い session × server（最初の `remote_send`）は session の cap_id で作る。引き継いだ旧共有 cap（下記）には送らない。指示・status・`worker_reply`・`stop_cap` はその記録の cap_id へ送る。
- `remote_send`（別名 `remote_create`）: session からの依頼を、その server の cap への `task`（protocol 1.5.0）として同じ cap_id へ送る。送る前に server の `status` で cap の有無を確かめる（無ければ server が最初の `task` で作る。`created: true`）。status が error・タイムアウトなら cap の有無が分からないので送らず isError。**返信（`task_result`）を待たず**`{ remote_id, server, server_id?, peer, host?, serverName, state: "running", created, task_id }` を返す。引数は `goal`（必須）、`deliverables?`（`{ branch?, report_path?, other? }`）、`verify?`（`{ tests?, steps? }`）、`constraints?`（文字列の配列）、`workers?`（`{ items?: [{ id?, role: implement|review|docs|test|other, scope, model?, depends_on? }] }`。items 無し = implement + review の最低 2 体）、`repo?`、`branch?`（`-` で始められない）、`server?`（server_id / host 名 / peer id のどれでも。省略時は発見した先頭。「server の識別」の節）、`worker_model?`（`remoteControl.model` と同じ形式。不正なら送らず拒否）。省略した `deliverables` / `verify` / `constraints` / `workers` は `{}` / `{}` / `[]` / `{}` で送る。`task_id` は center が採番（`t-<時刻の 36 進>-<6 桁 hex>`）し、未完了の指示にも持つ。`worker_model` の既定は config の `servers[].workerModel`（`servers[].peer` が peer の id か名前、または `servers[].name` が peer 名か `server` 引数に一致するもの）で、**送信のたびに config を読み直す**。新規の cap は「引数 ?? config」を `task` に載せ、既存の cap は引数があった時だけ載せる（server が cap の既定として記憶する。config の既定は再送しない）。記録の `worker_model` は最後に載せた値。`task` に cap のモデルの欄は無いので `model` 引数は無い（config の `servers[].model` は `cap_kick` 用）。worker ごとのモデルは `workers.items[].model`（優先順位は server の取り決めどおり: items[].model > `worker_model` > cap の既定）。
  - 同じ server への送信は center 内で直列（status の確認 → 記録 → `task` の投入）なので、同時に 2 本来ても最初の `task` は 1 本だけ。
  - cap が実行中の間の指示: center の link は同じ cap_id の `task` を直列にする（前の返信が来てから次を送る。返信待ちは cap_id で照合するので、2 本が並走して返信を取り違えることが無い）。待たされた指示は center のメモリで待ち、server 側でも cap ごとに直列に処理される。center が再起動すると、まだ送っていない指示（center のメモリで待っていたもの）は失われるが、記録は `running` のまま復元して status で追従する（下記）。
  - 取り違えの余地: cap が worker の report で再開した結果（`task_result`）は、返信待ちの `task` と同じ `task_id` ならその指示の返信として受け、別の `task_id`（過去の `task` の遅れ・重なり）は待ちに取られず、記録に反映する（待ちがある間は `state` は running のまま）。同じ `task_id` の `task_result` が重ねて届いても完了・通知は指示ごとに 1 回。本来の返信は後から届くことがある。center はどちらも cap の最新の結果として反映し、完了は「返信待ちの指示が 0」かつ cap が idle・worker 無しで判断するので、指示の完了判定や通知先は変わらない。結果の本文に、どの指示への返答かは cap の返答自体に含まれる。
- `remote_delete`: server へ `stop_cap`（protocol `bantou` 1.1.0）を送って走行中の `claude -p` を止め、記録から外す。対象は呼び出し元 session の cap と、`remote_id` で明示した旧共有 cap だけ。`remote_id` 省略時は自分の cap（複数の server にあれば `server` で絞る。無いと error）。複数の server に同じ `remote_id` がある時も `server` で指定する。**記録を消すのは `remote_delete` だけ**（center の再起動・旧形式の掃除以外で消えない。旧形式の「同じ server の余分な記録」は下記の 1 回限りの後始末）。止められない（server が見つからない・error 返信）時、記録が running なら error（`force: true` なら記録だけ消し、`warning` に理由）。終わった記録は警告付きで消える。他の session の cap は `remote_id` を指定しても「未定義の remote」で消せない。消した後の指示は、server に cap が無ければ最初の `kick_cap` から作り直す。
- 履歴は持たない: 記録に残すのは server ごとの cap の state、未完了の指示 `pending`（`{ at, owner（通知先の session）, prompt（goal の先頭 200 文字）, task_id? }`。完了したら消す）、最新の `result`（8000 文字まで）/ `error` と時刻（`result_at` / `error_at`）、最新の `task_result`、直近の `worker_reports`（最大 20 件）、`activity` だけ。完了済みの指示・過去の結果・通知の成否は残さない（通知の成否は center.log）。
- `remote_list` の `task_result` / `worker_reports`: `task_result` は最新の `task_result` 本体（`{ cap_id, task_id, state: done|failed, summary, workers: [{ worker_id, role, state, branch?, commit?, tests?, report_path?, result }], review: { verdict: ok|issues|unknown, items: [{ severity, text, resolved }], rounds }, remaining, error? }`）。届くまで無い。`worker_reports` は server の `worker_report` 通知（`{ type, cap_id, task_id?, worker_id, kind: progress|ask|approve|done, text, at }`）の直近 20 件（到着順。古いものから捨てる。progress も間引かず全て積む）で、無ければ `[]`。どちらも `remotes.json` に保存する。
- `remote_list` の `state` / `result`: cap の最新の結果（`task_result` は `summary`、`state` が failed なら `error`）。最初の `task_result`（または `cap_result`）で done / failed になり、report 起因の再開など後から届く `task_result` / `cap_result`（と `task` / `kick_cap` の error）でも `result` / `state` / `error` を最新に更新する。返信待ちの指示がある間、`cap_result` の後の判定待ちの間、または cap が done でも activity で cap か配下の worker が running / stalled の間は、`state` は running（`finishedAt` なし）で返す。`unknown` = server に届かない（`kick_cap` の送信失敗・タイムアウト）・status も取れず cap の状態が分からない。failed（`ok: false` の `cap_result`・server の `error` 返信）とは別で、次に status が取れた時（または activity が来た時）に running / done に戻る。
- `worker_report` の push: server からの `worker_report` 通知を受けたら、**cap の session**（旧共有 cap は未完了の指示の owner）へ push する（`[bantou] worker_report remote_id=… worker=… kind=… task_id=…` + 本文 2000 文字まで + ask / approve には `返答: worker_reply(worker_id="…", text)`）。**progress は同じ worker（remote_id・server・worker_id）から 60 秒に 1 回まで**（間引いた分も `worker_reports` には積む）、ask / approve / done は毎回。未完了の指示が無くても cap の session へ push する（旧共有 cap で未完了の指示が無い時だけ owner 不明で push せず center.log に残す）。通知の送り先が無い時も push せず center.log に残す。ask / approve への返答は `worker_reply`。
- 完了通知: **cap が idle かつ worker 無し**（`task_result` / `cap_result` の受信を起点に、`state` が running / unknown でない = 返信待ちの指示が無く、最新の activity で cap が idle かつ worker に running / stalled が無い。failed も含む）になった時点で、未完了の指示を全て完了にして消し、**cap の session に 1 回**（cap は session ごとなので宛先は 1 つ。旧共有 cap は指示を送った session ごと）、その名前の messenger peer へ `push` で送る（`[bantou] remote 完了 remote_id=… state=…` + `指示:`（その session の指示の先頭 80 文字）+ `result:` 先頭 500 文字 + `error:`）。同じ session の指示が重なっても、`cap_result` が来るたびに古い指示から順に完了にはせず、idle になった時にまとめて完了にして通知する（cap の返答本文に、どの指示への結果かが含まれる前提）。送れた・送れない（peer が見つからない等）の結果は center.log に出す（再送はしない）。`session_create` の session は agent-messenger の peer として登録される（下記「master-cap の起動（wrapper）」）ので届く。同名の peer が複数並んだ時（session 再起動直後）は `registered_at` が最新のものへ送る。config の `projects`（サーバー型の `rc_*`）は peer でないので、通知は送れない（center.log）。そこは `remote_wait` で待つ。**`cap_result` を受けても即座には完了にしない**（実機で、activity で cap=running / worker=running の 10 秒後に最初の `cap_result` が来て「完了」になり、その 21ms 後の activity（cap=idle / worker=running）が無視された）。`cap_result` の後は、次の activity が来るまで（来たらその activity で判定）、または猶予 15 秒（server の activity 通知は 5 秒ごと = 3 回分。通知が 1〜2 回欠けても待てて、完了通知の遅れは 15 秒以内で済む）が過ぎるまで待ち、activity が来ないまま猶予を過ぎたら server の `status` を取って判定する（cap が idle・`queued` 0・worker に running 無し。status は worker と cap の対応を持たないので worker は server 全体で見る）。動いていれば 15 秒ごとに status で追従する。center 再起動時、未完了の指示は閉じず通知を保つ（下記）。
- `remote_wait`: `remote_id`（と `server`）の cap が上の意味で idle・worker 無しになるまで待って記録を返す。`remote_id` と `server` を省略した時は、owner（session）の cap のうち未完了の指示があるもののどれか（最初に終わったもの）。他の session の cap は `remote_id` を指定しても待てない（旧共有 cap は `remote_id` 明示で待てる）。timeout は `state: "running"` のまま。待ち中に cap が delete されたら error。
- `remote_list`: `owner` が分かればその session の cap だけ（session 向けは常に自分の session。`include_shared: true` で旧共有 cap も）、分からなければ全件（旧共有 cap を含む）。`RemoteRecord` = `remote_id`（= cap_id）, `session?`（無い = 旧共有 cap）, `server`（server_id。server_id が分からない旧形式の記録は peer id）, `server_id?`, `peer?`（今の到達先。長く確認できないと消える）, `peer_seen_at?`, `serverName`, `serverHost?`（host 名）, `serverUser?`, `serverWorkspace?`, `state`, `model?`, `worker_model?`, `createdAt`, `finishedAt?`, `result?`, `result_at?`, `task_result?`, `worker_reports?`, `error?`, `error_at?`, `pending`。`remote_list` は加えて `owners`（`pending` を持つ session、古い順）、`worker_reports`（常にある。無ければ `[]`）と `activity?` を返す。`pending` の各要素には `task_id?` が付く。
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
- **識別の取得**: server は `hello_result` / `status_result` に `server_id`（再起動・自己更新で不変）と `host` / `user` / `workspace` を載せる（protocol 1.7.0、全て任意）。center は返信から peer id → 識別を学習する（link のメモリ）。識別が未取得の peer へは `hello` を 1 回送って取る（`identifiedPeers`）。旧 server の識別なしの返信、`hello` を知らない旧 server の error は「識別なし」として扱い再送しない。届かない peer は 60 秒後に再試行する。同じ server_id の別の peer id が現れたら、旧 peer id が発見から消えていれば識別を整理する。**同じ server_id を名乗る peer が発見に複数いる**時（server の再起動・再登録で旧 peer id が発見に残る間、または workspace / VM のコピー）は、その全員へ `hello` を送り直し、**応答した peer だけ**を残す。死んだ旧 peer は応答せず落ちるので、再起動直後でも新 peer が選ばれ、送信と追従は詰まらない。**全員が応答した時だけ**重複（本当のコピー）として、server 指定なしの `remote_send`・server_id / host 名での指定・記録からの検索を**エラー**にして送らない（エラーには候補の peer id・user・workspace を並べる）。誰も応答しなければ何も落とさない。生存確認は同じ顔ぶれに対して 30 秒に 1 回まで（同時の要求は 1 つにまとめる）。互いの識別は捨てない（取り直しで揺れない）。peer id で指せば常に通る（応答しない旧 peer でも、明示した指定は止めない）。