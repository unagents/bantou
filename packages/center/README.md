# bantou-center

素のエージェント（Claude Code など）が MCP tool 経由で cap 運用できるようにする MCP server。stdio と Streamable HTTP で動く。

役割は 3 つ。

- center 上の session（master-cap）の起動・削除（`session_*`、下記「session」）。
- master-cap に持たせる remote session（remote-cap）の起動・削除（`remote_*`、下記「remote」）。
- project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰。
- リモートホストの bantou-server への指示（kick_cap / resume_worker / status）の中継。

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

- エンドポイントは `http://<bind>:<port>/mcp`（外向け。MCP Streamable HTTP。POST / GET / DELETE）と `/mcp/session`（master-cap 向け。下記「窓口の分離」）。pty 出力の配信は `/sessions/<name>/{output,input,resize,attachments}`（下記「core」「添付画像」）。statusLine の受信は `POST /sessions/<name>/status-line`（session token。下記「context 使用量」）。それ以外は 404。
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
| `remoteControl.sessionInstructions` | 文字列（16000 文字以内） | なし | master-cap への追加指示。session を起動するたび（新規・再起動・`--continue` での再開・resume 失敗後の素の起動のすべて）に、値があれば claude に `--append-system-prompt <値>` を足す。省略と空文字は無しと同じ（付けない）。argv の 1 引数で渡し、shell は通さない（複数行・引用符・`$` もそのまま届く）。config 由来の project（`claude remote-control` 直起動）には効かない。session を起動するたびに config を読み直すので、保存後に起動する session から効く（動いている session には効かない。「config の読み直し」節） |
| `remoteControl.model` | 文字列（`^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`） | なし | master-cap（`session_create` の wrapper 経由の対話型 claude）の `--model` にそのまま渡す。未指定なら付けない。config 由来の project（`claude remote-control` 直起動）には効かない |
| `servers[].name` | `[A-Za-z0-9_-]+` | 必須 | server 名。重複不可。tool の `server` 引数で使う |
| `servers[].peer` | string | なし | server の peer 名または id。指定すると発見せずその名前へ送る（従来の名前指定）。省略すると `list_peers`（`protocol: "bantou"`）で自動発見する |
| `servers[].timeoutMs` | 正の整数 | `2100000`（35 分） | 返信待ちの打ち切り |
| `servers[].model` | 文字列（`remoteControl.model` と同じ形式） | なし | この server の remote-cap（cap を作る最初の `kick_cap`）の `--model` の既定。`remote_send` の `model` 引数が優先。省略時は指定しない。`remote_send` のたびに config を読み直すので、保存後の送信から効く |
| `servers[].workerModel` | 同上 | なし | この server の remote-cap が起動する worker の既定モデル（`kick_cap` の `worker_model`）の既定。`remote_send` の `worker_model` 引数が優先。cap を作る最初の `kick_cap` にだけ載せる。省略時は指定しない。同上（送信のたびに読み直す） |
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |
| `workspace` | 絶対パス | なし | `session_create` で `path` 省略時の置き場所 `<workspace>/<name>` の親。session は起動時に立てない |
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### config の読み直し

center は wrapper 経由の session（master-cap）を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に `--config` のファイルを読み直す。center は再起動しない。動いている session には効かない。保存後に起動する session から効く。

- 読み直しで効く: `remoteControl.sessionInstructions` / `model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`（その session の起動時点の値。再起動の予約もその起動で読んだ値で決める）。
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

概念は `docs/concept.md`、設計の経緯は `docs/design/center-tools.md`。`session_*` が A（番頭が使う、center 上の master-cap）、`remote_*` が B（center が master-cap に持たせる、server への指示の道具）。`rc_*` `server_*` `worker_resume` は従来の tool で、そのまま残している。窓口は 2 つに分かれる（「窓口の分離」）。外向け `/mcp` の tool は下の表のうち `remote_send` / `remote_create` / `remote_delete`（session 向け `/mcp/session` だけ）を除いたもの。`cap_kick` は外向けからも外した。

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `session_create` | `name`, `path?`, `permissionMode?` | `SessionInfo`（下記） |
| `session_delete` | `name` | `{ name, deleted }` |
| `session_list` | なし | `SessionInfo[]` |
| `remote_send`（session 向けのみ） | `prompt`, `server?`, `model?`, `worker_model?` | `{ remote_id, server, serverName, state, created, model?, worker_model?, model_ignored?, note? }`（返信を待たない）。server の remote-cap（1 つ）への次の指示。owner は header の session 名。`model` は cap を最初に作る時だけ（既存の cap なら無視して `model_ignored` と note「cap は既存なので model は無視した」を返す）。`worker_model` はこの指示で cap が起動する worker の既定（resume の `kick_cap` にも載せ、server が cap の既定として記憶する）。省略時の既定は config `servers[]` |
| `remote_create`（session 向けのみ） | 同上 | `remote_send` の互換の別名（同じ処理） |
| `remote_delete`（session 向けのみ） | `remote_id?`, `server?`, `force?` | `{ remote_id, deleted, stopped, warning? }`。cap の停止（`stop_cap`）と記録の削除。cap は共有なので他の session の指示も止まる |
| `remote_list` | `owner?`（外向け）。session 向けは引数なしで自分が指示を送った cap | `RemoteView[]`（server の cap 単位。`RemoteRecord` + `owners` + `activity?`、下記） |
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
- `session_delete`: `session_create` で作ったものだけ。remote-control を停止（SIGTERM → `stopGraceMs` 後 SIGKILL）して監視と保存から外す。path は消さない。config 由来の project は拒否。
- `session_list`: config の project と session の全部。`source` が `config` / `session`。`instructions`（真偽。その session を起動した時に `--append-system-prompt`（`sessionInstructions`）を付けたか。本文は出さない。`rc_status` の `instructions` と同じで、`rc_status` の `args` でも値は `<N 文字>` に伏せる）が付く。`contextUsage`（`{ usedTokens, windowTokens, percent, updatedAt, model? }`。`model` は statusLine 由来の時だけ。まだ分からない時は `null`）が付く。取得の仕組みは「context 使用量」。
- 保存: config と同じ dir の `sessions.json`（`name`, `path`, `permissionMode`, `createdAt`）。config の projects には書かない。center 起動時に復元して `--continue` で起動する。`--continue` で接続前に 30 秒以内に終了した場合（約 4 時間以内の記録が無い、など）は、素の起動へ fallback する（再起動回数は増やさない）。
- 新規 path の trust: **trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run `claude` in <path> first ...` で即 exit 1 する**（claude 2.1.312 で実測）。親 dir が trust 済みなら配下は通る（実測: trust 済みの repo 配下の dir で `connected`）。そのため、未 trust の path では `session_create` は `state: starting` と `lastError`（`接続前に終了: Error: Workspace not trusted...`）を返し、supervisor は再起動を繰り返して上限で `error` になる。対処は、workspace（または path の親）で一度 `claude` を起動して trust を承認しておくこと。center が claude の設定ファイルを書き換えて trust を付けることはしない（今は）。
- 同じ folder を別の `claude remote-control` が直前まで握っていると、`This folder is already served by a terminal \`claude remote-control\` on this device. Stop it first.` で約 1 分待たされて終了する（実測、直前の center を強制終了した後など）。

`SessionInfo`: `name`, `path`, `state`（`stopped` / `starting` / `connected` / `error`）, `pid`, `sessionUrl`, `startedAt`, `source`, `lastError?`。

### remote（B）

- **原則: remote-cap は 1 つの server につき 1 つだけ**。作業が何であれ、center はその cap に次の指示を送る（作業ごとに cap を作らない）。記録は「server の cap」単位で、`remote_id` = cap_id。
- **cap_id**: `c-<10 桁 hex>`。center の状態 dir（config と同じ場所）の `center-id` ファイルに 10 桁 hex を持ち、無ければ最初の起動で乱数から作って保存する。center を再起動しても同じ値になる。選んだ理由: (1) center ごとに固定でなければ、再起動のたびに server に新しい cap が残る。(2) 乱数でなく hostname や config のパスから導くと、別 center と衝突したり、dir の移動・コピーで変わる／重なる。(3) 状態 dir はすでに `remotes.json` `sessions.json` の置き場で、center の状態と一緒に残る。`center-id` が書けない時は、その起動の間だけの id を使い（ログに出す）、再起動で変わる。複数の server があっても cap_id は同じで、記録は server ごとに 1 件（server は peer id、無ければ名前 + host で照合）。
- `remote_send`（別名 `remote_create`）: session からの指示を、その server の cap への「次の指示」として同じ cap_id の `kick_cap`（`reason: remote_send owner=<owner>`）で送る。送る前に server の `status` で cap の有無を確かめ、**cap が無い時だけ**最初の `kick_cap`（cap の作成）にする（`created: true`）。status が error・タイムアウトなら cap の有無が分からないので送らず isError。**返信を待たず**`{ remote_id, server, serverName, state: "running", created }` を返す。引数は `prompt`、`server?`（peer id、一致しなければ名前、省略時は発見した先頭）、`model?`、`worker_model?`（`remoteControl.model` と同じ形式。不正なら送らず拒否）。`model` の既定は config の `servers[]` の `model`、`worker_model` の既定は `workerModel`（`servers[].peer` が peer の id か名前、または `servers[].name` が peer 名か `server` 引数に一致するもの）で、**送信のたびに config を読み直す**。新規の cap は「引数 ?? config」を最初の `kick_cap` に載せる。既存の cap では `model` を無視し（返り値に `model_ignored: true` と note）、`worker_model` は引数があった時だけ resume の `kick_cap` に載せる（server が cap の既定として記憶する。config の既定は再送しない）。記録の `model` は cap を作った時の値、`worker_model` は最後に載せた値。worker ごとにモデルを変えたい時は、`prompt` の中で cap に `worker_start` の `model` を指定させる（優先順位: `worker_start` の model > その worker の前回記録 > cap の `worker_model` > 付けない）。`repo` / `branch` は受けない。
  - 同じ server への送信は center 内で直列（status の確認 → 記録 → `kick_cap` の投入）なので、同時に 2 本来ても最初の `kick_cap` は 1 本だけ。
  - cap が実行中の間の指示: center の link は同じ cap_id の `kick_cap` を直列にする（前の返信が来てから次を送る。返信待ちは cap_id で照合するので、2 本が並走して返信を取り違えることが無い）。待たされた指示は center のメモリで待ち、server 側でも cap ごとに直列に処理される。center が再起動すると、まだ送っていない指示（center のメモリで待っていたもの）は失われるが、記録は `running` のまま復元して status で追従する（下記）。
  - 取り違えの余地: cap が worker の report で再開した結果（`cap_result`）は、返信待ちがあればその指示の返信として受けられ、本来の返信は後から届く。center はどちらも cap の最新の結果として反映し、完了は「返信待ちの指示が 0」かつ cap が idle・worker 無しで判断するので、指示の完了判定や通知先は変わらない。結果の本文に、どの指示への返答かは cap の返答自体に含まれる。
- `remote_delete`: server へ `stop_cap`（protocol `bantou` 1.1.0）を送って走行中の `claude -p` を止め、記録から外す。`remote_id` 省略時は center の cap。複数の server に同じ `remote_id` がある時は `server` で指定する（無いと error）。止められない（server が見つからない・error 返信）時、記録が running なら error（`force: true` なら記録だけ消し、`warning` に理由）。終わった記録は警告付きで消える。cap は共有なので owner は見ない（どの session からでも消せる）。消した後の指示は、server に cap が無ければ最初の `kick_cap` から作り直す。
- 履歴は持たない: 記録に残すのは server ごとの cap の state、未完了の指示 `pending`（`{ at, owner（通知先の session）, prompt（先頭 200 文字）}`。完了したら消す）、最新の `result`（8000 文字まで）/ `error` と時刻（`result_at` / `error_at`）、`activity` だけ。完了済みの指示・過去の結果・通知の成否は残さない（通知の成否は center.log）。
- `remote_list` の `state` / `result`: cap の最新の結果。最初の `cap_result` で done / failed になり、report 起因の再開など後から届く `cap_result`（と `kick_cap` の error）でも `result` / `state` / `error` を最新に更新する。返信待ちの指示がある間、`cap_result` の後の判定待ちの間、または cap が done でも activity で cap か配下の worker が running / stalled の間は、`state` は running（`finishedAt` なし）で返す。`unknown` = server に届かない（`kick_cap` の送信失敗・タイムアウト）・status も取れず cap の状態が分からない。failed（`ok: false` の `cap_result`・server の `error` 返信）とは別で、次に status が取れた時（または activity が来た時）に running / done に戻る。
- 完了通知: **cap が idle かつ worker 無し**（`state` が running / unknown でない = 返信待ちの指示が無く、最新の activity で cap が idle かつ worker に running / stalled が無い。failed も含む）になった時点で、未完了の指示を全て完了にして消し、**指示を送った session ごとに 1 回**、その名前の messenger peer へ `push` で送る（`[bantou] remote 完了 remote_id=… state=…` + `指示:`（その session の指示の先頭 80 文字）+ `result:` 先頭 500 文字 + `error:`）。複数 session の指示が重なっても、`cap_result` が来るたびに古い指示から順に完了にはせず、idle になった時にまとめて完了にして各 owner へ通知する（cap の返答本文に、どの指示への結果かが含まれる前提）。送れた・送れない（peer が見つからない等）の結果は center.log に出す（再送はしない）。`session_create` の session は agent-messenger の peer として登録される（下記「master-cap の起動（wrapper）」）ので届く。同名の peer が複数並んだ時（session 再起動直後）は `registered_at` が最新のものへ送る。config の `projects`（サーバー型の `rc_*`）は peer でないので、通知は送れない（center.log）。そこは `remote_wait` で待つ。**`cap_result` を受けても即座には完了にしない**（実機で、activity で cap=running / worker=running の 10 秒後に最初の `cap_result` が来て「完了」になり、その 21ms 後の activity（cap=idle / worker=running）が無視された）。`cap_result` の後は、次の activity が来るまで（来たらその activity で判定）、または猶予 15 秒（server の activity 通知は 5 秒ごと = 3 回分。通知が 1〜2 回欠けても待てて、完了通知の遅れは 15 秒以内で済む）が過ぎるまで待ち、activity が来ないまま猶予を過ぎたら server の `status` を取って判定する（cap が idle・`queued` 0・worker に running 無し。status は worker と cap の対応を持たないので worker は server 全体で見る）。動いていれば 15 秒ごとに status で追従する。center 再起動時、未完了の指示は閉じず通知を保つ（下記）。
- `remote_wait`: `remote_id`（と `server`）の cap が上の意味で idle・worker 無しになるまで待って記録を返す。`remote_id` と `server` を省略した時は、owner の未完了の指示がある cap のどれか（最初に終わったもの）。どの session からでも `remote_id` で同じ cap を待てる。timeout は `state: "running"` のまま。待ち中に cap が delete されたら error。
- `remote_list`: `owner` が分かればその owner の未完了の指示がある cap だけ、分からなければ全件。`RemoteRecord` = `remote_id`（= cap_id）, `server`（最後に使った peer id）, `serverName`, `serverHost?`, `state`, `model?`, `worker_model?`, `createdAt`, `finishedAt?`, `result?`, `result_at?`, `error?`, `error_at?`, `pending`。`remote_list` は加えて `owners`（`pending` を持つ session、古い順）と `activity?` を返す。
- 旧形式の記録（作業ごとの cap。`remote_id` が center の cap_id でない `remotes.json` の記録）は一覧に出さない。center の起動時に見つけたら server へ `stop_cap` を送り（届かなくてもよい）、記録を消す。結果は center.log（`旧形式の remote を掃除` / `stop_cap が届かない（記録は消した）`）。旧 cap が server に残る可能性は、届かなかった場合に限る（それは受け入れる）。履歴を持っていた版の cap の記録は、未完了の指示だけ引き継ぎ、履歴は捨てる。
- `activity`（`remote_list` の各要素）: server が protocol `bantou`（1.2.0）の `activity` 通知で送ってくる remote-cap と worker の生存・進捗。通知がまだ無い remote には `activity` キーが無い。中身は `{ at, received_ms_ago, stale, agents }`。
  - `agents`: `AgentActivity[]`（cap → worker）。`kind`, `id`, `cap_id`, `state`（`running` / `stalled` / `idle` / `done` / `failed` / `lost`）, `task`（prompt の冒頭）, `last_activity`, `last_output_at`, `silent_ms`, `started_at`, `finished_at`, `error?`。仕様は `docs/protocol.md` の「Activity notices」。
  - `silent_ms`: 通知時の値に、center が受信してからの経過を足して返す。desktop はホスト間の時計ずれを避けるため、時刻の差でなくこの値で経過を出す。
  - `received_ms_ago`: 最後の通知を受けてからの ms（center の時計）。`stale`: running / stalled の agent がいるのに 30 秒を超えて通知が来ていない（server・経路が落ちた疑い）。center は lost に書き換えず `stale` を立てるだけ（lost は server 側の事実）。
  - 保持はメモリのみ（`remotes.json` には書かない）。center 再起動後は次の通知まで空。`remote_delete` で消える。`cap_kick` で起動した cap には記録が無いので `remote_list` に出ない。同じ cap_id が複数の server にあるので、保持は通知を送ってきた server の peer id ごと。
  - 通知が来るのは、その cap の `kick_cap` を送った center（peer id は再登録で変わるため、server が記録した旧 id 宛ては届かない）。ログ: 状態の組が変わった時だけ `activity 受信: cap_id=<id> <id>=<state> ...`。
- 保存: メモリ + config と同じ dir の `remotes.json`。center 再起動では、`running` と未完了の指示を失敗にせず `running` のまま復元し、server の `status` で cap と worker の状態を取り直して追従する（取れなければ `unknown`。15 秒ごとに再試行）。再起動後に届く `cap_result`（`onLateCapReply`）は最新 `result` に反映し、完了になれば owner に通知する。**前提: 再起動の前後で messenger の peer 名（center の `bantou-center`、通知先の session 名）が同じ**（通知は session の peer 名宛て、遅れた返信は `bantou-center` 宛てに戻る）。変わると通知が届かない（center.log）ので `remote_wait` / `remote_list` で確かめる。cap_id は同 dir の `center-id`。
- **server 選択**（概念: server は master-cap から見えなくてよい。今は発見ベース）: `config.servers` に依存しない。messenger の `listPeers("all", {protocol: "bantou"})` で見つかった peer の先頭（既定）。`server` 引数は peer id、一致しなければ name。見つからなければ候補付きで error。既存の `cap_kick` などは `servers[]` のまま（挙動は変えない）。`servers[]` があれば先頭の messenger client を共有し、無ければ内部の client を 1 本使う。broker に古い peer が残っていると先頭がそれになり得る（実測: broker.json を引き継いだ再起動で古い peer が先頭に来て、指示が届かず待ち続けた）。
- **owner**（呼んだ master-cap の識別）: http では header `X-Bantou-Session: <session 名>`（または URL query `?session=<名>`）があればそれ、無ければ tool 引数 `owner`。優先順は header > query > 引数。`remote_send` はどれも無ければ error。`remote_delete` は owner を見ない（cap は共有）。`remote_list` は分からなければ絞らない。stdio には header が無いので引数のみ。
  - **今は**: master-cap 側に header 付きの接続を自動で持たせる仕組みは入れていない。理由: `claude remote-control` は `--mcp-config` / `--settings` を受けず（remote-control の前の global flag は spawn した session に引き継がれない）、`~/.claude.json` の書換えはユーザー設定の変更、`.mcp.json` の配置は承認プロンプト・未 trust・token 平文の問題がある。そのため、master-cap が center に繋ぐ MCP 設定（header 付き）を用意する側（番頭など）が `X-Bantou-Session` を付けるか、master-cap が `owner` 引数を渡す。
  - owner は自己申告で、認証はしない（Bearer token は center 全体で 1 つ）。

## server の版合わせ

- 組の版: `pair.server` = 組になる server の npm `bantou` の版、`pair.protocol` = このバイナリに bundle した protocol `bantou` の版。server の版は desktop のビルド（`packages/desktop/scripts/build-sidecar.ts`）が `bun build --compile --env=BANTOU_PAIR_*` で env `BANTOU_PAIR_SERVER_VERSION` を埋め込む（値はビルド時に固定され、実行時の env では変わらない）。埋め込みが無い時は作業ツリーの `packages/server/package.json`（`npm run dev` / tsx / dist 用）、それも無ければ不明（版合わせは無効で、protocol の版の門だけ効く）。単体バイナリ（`build:bin`）は埋め込まないので、`BANTOU_PAIR_SERVER_VERSION` を付けてビルドしない限り不明になる。
- 確認: 起動後（`connectAll` の後）と 30 秒ごと（更新中の server がいる間は 5 秒ごと）に、発見した server へ `hello` を送る。server の版が組と違えば `update_server {version: pair.server}` を送る（新旧は比べない）。server は peer の `summary`（`<host> <workspace>`）で同一視する（peer id は再登録で変わる）。
- 状態: `ok` / `updating`（`update.running` = 待っている cap・worker の件数）/ `unsupported`（protocol 1.3.0 未満。自動更新できず、手動で起動し直す）/ `mismatch`（server の版は組と同じなのに protocol の版が違う）/ `failed`（更新指示が断られた。同じ版は center が再起動するまで再指示しない）/ `lost`（更新中のまま 15 分戻らない）/ `unknown`（hello に答えない）。
- 門: protocol の版が `pair.protocol` と違う server には、`hello` / `update_server` 以外（`kick_cap` / `stop_cap` / `status`）を送らず `error`（`code:"version_mismatch"`、`retryable:true`）を返す。版が分からない（名前宛てへのフォールバック）時は従来どおり送る。更新中の server への `kick_cap` は送らず `code:"updating"`（retryable）で断る。`remote_send` は断られたら記録を作らず isError で返すので、master-cap が後で再送できる。center は自動では再送しない。
- 更新中に server の broker が止まる構成（server の内蔵 broker に center もつなぐ）では、再起動中は接続が切れる。送信失敗で次の使用時に接続を作り直す。

## claude の解決

`remoteControl.claude` 未指定なら、center 起動時に次の順で解決する（GUI 起動の app は PATH が最小のため）。

1. `$SHELL -lc 'command -v claude'`（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り）。最終の非空行が実在する実行可能な絶対パスなら採用（`login-shell`）
2. `~/.local/bin/claude`、`/opt/homebrew/bin/claude` の順に実在・実行可能なものを採用（`fallback-path`）
3. どれも無ければ PATH 任せの `claude`（`PATH`）。警告をログに出す

`remoteControl.claude` 指定時はそのまま使う（`config`、検証しない）。結果はログと `rc_status` / `rc_list` の `claude` に出る。

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

## 未決

- B の owner を master-cap の接続に自動で載せる仕組み（上記「今は」の限界）。center が master-cap を起動する時に MCP 設定を渡せる手段が `claude remote-control` に無い。
- 未 trust の path の扱い（center が trust を付ける手段）。
- remote の長期運用（`running` のまま返信が失われた時の再同期。server の `status` と突き合わせる案）。
- session 削除後に claude.ai に残る remote-control の environment / session 表示は、CLI からは消せない（確認した範囲で手段を見つけていない）。

- 認証（center ↔ server）。desktop ↔ center は Bearer token（上記）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。

## 窓口の分離

- 外向け `/mcp`: 認証は config の `token`（Bearer）。`session_*`、読み取り専用の `remote_list`、`remote_wait`、`rc_*`、`server_*`、`worker_resume`。`remote_send` / `remote_create` / `remote_delete` / `cap_kick` は無い。
- session 向け `/mcp/session`: `remote_send` / `remote_create`（別名）/ `remote_delete` / `remote_list` / `remote_wait` だけ。認証は session の起動ごとに center が作る使い捨て token（`Authorization: Bearer <token>`）と header `X-Bantou-Session: <session 名>` の組で、token はその名前に発行されたものだけ通る。不一致・外向け token・欠落は 401。owner は header の名前で、引数では受けない。MCP session id は窓口をまたいで使えない。
- token は session の起動（再起動を含む）ごとに作り直し、停止で無効になる。master-cap には環境変数 `BANTOU_SESSION_TOKEN` で渡し、`--mcp-config` の JSON には `${BANTOU_SESSION_TOKEN}` と書く（引数に平文で残さない、ファイルも書かない）。

## master-cap の起動（wrapper）

- `session_create` の session は `bantou-pty-wrapper --cols N --rows N -- claude --remote-control <name> --permission-mode <m> --mcp-config '<JSON>' [--continue]` で起動する。wrapper は `dirname(process.execPath)/bantou-pty-wrapper`、env `BANTOU_PTY_WRAPPER` で上書き。config の `projects`（`rc_*`）は従来の `claude remote-control` のまま。supervisor は 1 つで、entry ごとに起動方式を選ぶ（再起動・`--continue`・素の起動への fallback・ログ・有効化確認への自動応答は共通）。
- `--mcp-config` の JSON には `bantou`（http、`/mcp/session`。窓口が無い時は付けない）と `bantou-messenger`（stdio、agent-messenger）が入る。`bantou-messenger` は `npx -y @unagents/messenger@0.12.0 mcp` を env `AGENT_MESSENGER_NAME=<session 名>` で起動し、session 名を messenger の peer 名にする。受信は Claude Code の inbox socket 経由で会話に現れる（pty への書き込みではない）。broker は client が env → config → UDP 発見で解決する（center は指名しない）。再起動・`--continue` でも同じ名前で登録し直す。center の子プロセスの PATH に `npx` が要る。
- wrapper との間は 1 行 1 JSON（wrapper の stdout: `started` / `output`（base64）/ `text`（制御文字を除いた文字列）/ `exit`、stdin: `input` / `resize` / `stop`）。session URL と接続状態は `text` の直近 16 KiB の窓に対して照合する（行単位ではない）。有効化確認への自動応答は `input`（`y\r`）。
- `--settings` で center の statusLine を渡す（引数の順は `--mcp-config` の後、`--continue` の前）。利用者の statusLine 設定より center のものが優先される（「context 使用量」の「statusLine 方式」）。
- 停止は wrapper へ `stop` を送って待ち、`stopGraceMs` 内に終わらなければ SIGKILL。

## core（出力の配信）

center プロセス内のモジュール（`src/core.ts`）。session ごとのキュー（チャンク ID は 1 からの連番、デコード後 8 MiB を超えたら古い分から捨てる、wrapper の再起動をまたいで続く）。外向け token で次を提供する。

- `GET /sessions/<name>/output`: SSE。続きは `Last-Event-ID` か `?after=<id>`。続きが残っていない / 指定なしは `event: reset` の後に積んである全部。各チャンクは `id: <id>` `event: output` `data: <base64>`。15 秒ごとに `: ka`。未知の session は 404。
- `POST /sessions/<name>/input` `{"data":"<base64>"}` → 204（実行中でなければ 409）。
- `POST /sessions/<name>/resize` `{"cols":N,"rows":N}` → 204。最後に送った側のサイズを覚え、次の wrapper 起動の初期値にする。

- `GET /events`: SSE（外向け token、イベント ID・再送なし）。接続時に `event: sessions` `data: {}`、session の追加・削除・起動時復帰ごとに `event: sessions` `data: {"reason":"created"|"deleted"|"restored"|"context","name":"<name>"}`。15 秒ごとに `: ka`。受け取った側は `session_list` を取り直す。

## 添付画像

master-cap の claude は center のホストで動くので、画像は center のホストに置かれて初めて読める。desktop（sidecar でも別ホストの center でも同じ route）が貼り付け・ドロップ・添付ボタンの画像を送る。

- `POST /sessions/<name>/attachments`: 外向け token（`Authorization: Bearer`）。本文は画像のバイト列そのもの、`Content-Type` に型。session 名は `[A-Za-z0-9_-]+`（他の `/sessions/<name>/...` と同じ）。
- 受ける型は `image/png` `image/jpeg` `image/gif` `image/webp`。1 枚 20MB（20 × 1024 × 1024 バイト）まで。型は `Content-Type` と、先頭バイト（マジックナンバー）の両方が合っている時だけ通す。
- 応答は 201 `{"path":"<絶対 path>","bytes":N,"type":"image/png"}`。拒否は `{"error":"<理由>"}`: 401（token）、404（未知の session・不正な session 名）、405（POST 以外）、409（config に `workspace` が無い・同じ秒の連番が尽きた）、413（20MB 超。読まずに接続を閉じる）、415（型違い・中身が画像でない）、400（本文が空）。
- 置き場: `<workspace>/<session 名>/attachments/<yyyymmdd-HHMMSS>-<NN>.<png|jpg|gif|webp>`（時刻は center ホストのローカル時刻、`NN` は同じ秒の中の 01〜99）。dir が無ければ作る。既存のファイルは上書きしない。`workspace` は config の値（`session_create` で `path` を省いた時の親と同じ）。session を `path` 指定で作っていても、置き場は `<workspace>/<session 名>` 配下。
- ログ（`center.log`）: 保存は `添付を保存: session=<名> bytes=<N> path=<path>`、拒否は `添付を拒否: session=<名> reason=<理由>`。本文は残さない。
- 自動削除はしない。要らなくなったら手で消す: `find <workspace>/<session 名>/attachments -type f -delete`（その session の分を全部）、または 1 枚ずつ `rm <path>`。
