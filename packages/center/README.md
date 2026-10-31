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

- エンドポイントは `http://<bind>:<port>/mcp`（外向け。MCP Streamable HTTP。POST / GET / DELETE）と `/mcp/session`（master-cap 向け。下記「窓口の分離」）。pty 出力の配信は `/sessions/<name>/{output,input,resize}`（下記「core」）。それ以外は 404。
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
    { "name": "named", "peer": "my-bantou-server" }
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
| `servers[].name` | `[A-Za-z0-9_-]+` | 必須 | server 名。重複不可。tool の `server` 引数で使う |
| `servers[].peer` | string | なし | server の peer 名または id。指定すると発見せずその名前へ送る（従来の名前指定）。省略すると `list_peers`（`protocol: "bantou"`）で自動発見する |
| `servers[].timeoutMs` | 正の整数 | `2100000`（35 分） | 返信待ちの打ち切り |
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |
| `workspace` | 絶対パス | なし | `session_create` で `path` 省略時の置き場所 `<workspace>/<name>` の親。session は起動時に立てない |
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### server の発見（protocol 方式）

- center は普通の agent-messenger client として、通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）で broker につなぐ。broker の URL は指名しない（旧 `servers[].broker` / `servers[].token` は廃止。書いても無視される。token が要る場合は `AGENT_MESSENGER_TOKEN`）。server の peer は、リクエストごとに `listPeers("all", {protocol: "bantou"})` で発見する（peer id は再登録で変わるため）。複数見つかれば name が `bantou-server` のものを優先し、無ければ先頭。0 件、または 0.9 系 broker（`BROKER_UNSUPPORTED`）の時は peer 名 `bantou-server` 宛てにフォールバックする。`servers[].peer` を指定すると発見せずその名前へ送る。
- 送信は `send(to, text, "pull", {protocol: "bantou", version})`。version は発見した peer が宣言している値（名前宛ての時は `MESSENGER_PROTOCOL.version`）。
- 受信は、送信元が解決済みの peer id、meta の protocol が `bantou`、name が `bantou-server`、`servers[].peer` のいずれかなら server の返信として扱う。text 先頭の `[agent-messenger warning]` 行（version 不一致時に付く）は除いてから JSON として解釈する。
- 仕様は `../protocol/messenger/protocol.json` と `../../docs/protocol.md`。

## tools

概念は `docs/concept.md`、設計の経緯は `docs/design/center-tools.md`。`session_*` が A（番頭が使う、center 上の master-cap）、`remote_*` が B（center が master-cap に持たせる、server への指示の道具）。`rc_*` `server_*` `worker_resume` は従来の tool で、そのまま残している。窓口は 2 つに分かれる（「窓口の分離」）。外向け `/mcp` の tool は下の表のうち `remote_create` / `remote_delete`（session 向け `/mcp/session` だけ）を除いたもの。`cap_kick` は外向けからも外した。

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `session_create` | `name`, `path?`, `permissionMode?` | `SessionInfo`（下記） |
| `session_delete` | `name` | `{ name, deleted }` |
| `session_list` | なし | `SessionInfo[]` |
| `remote_create`（session 向けのみ） | `prompt`, `server?`, `repo?`, `branch?` | `{ remote_id, server, serverName, state }`（返信を待たない）。owner は header の session 名 |
| `remote_delete`（session 向けのみ） | `remote_id`, `force?` | `{ remote_id, deleted, stopped, warning? }`。自分の remote だけ |
| `remote_list` | `owner?`（外向け）。session 向けは引数なしで自分の分 | `RemoteView[]`（`RemoteRecord` + `activity?`、下記） |
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
- 返信の形は `packages/protocol` の `server.ts` と `server/README.md` を参照。

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
- `session_list`: config の project と session の全部。`source` が `config` / `session`。
- 保存: config と同じ dir の `sessions.json`（`name`, `path`, `permissionMode`, `createdAt`）。config の projects には書かない。center 起動時に復元して `--continue` で起動する。`--continue` で接続前に 30 秒以内に終了した場合（約 4 時間以内の記録が無い、など）は、素の起動へ fallback する（再起動回数は増やさない）。
- 新規 path の trust: **trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run `claude` in <path> first ...` で即 exit 1 する**（claude 2.1.312 で実測）。親 dir が trust 済みなら配下は通る（実測: trust 済みの repo 配下の dir で `connected`）。そのため、未 trust の path では `session_create` は `state: starting` と `lastError`（`接続前に終了: Error: Workspace not trusted...`）を返し、supervisor は再起動を繰り返して上限で `error` になる。対処は、workspace（または path の親）で一度 `claude` を起動して trust を承認しておくこと。center が claude の設定ファイルを書き換えて trust を付けることはしない（今は）。
- 同じ folder を別の `claude remote-control` が直前まで握っていると、`This folder is already served by a terminal \`claude remote-control\` on this device. Stop it first.` で約 1 分待たされて終了する（実測、直前の center を強制終了した後など）。

`SessionInfo`: `name`, `path`, `state`（`stopped` / `starting` / `connected` / `error`）, `pid`, `sessionUrl`, `startedAt`, `source`, `lastError?`。

### remote（B）

- `remote_create`: center が `remote_id`（= server 上の cap_id、`r-<hex10>`）を採番し、発見した server に `kick_cap`（`reason: remote_create owner=<owner>`）を送る。**返信を待たず**`{ remote_id, server, serverName, state: "running" }` を返す。返信（`cap_result` / `error`）が来たら記録の `state` を `done` / `failed` にし、`result`（結果本文、8000 文字まで）と `error` を入れる。
- `remote_delete`: server へ `stop_cap`（protocol `bantou` 1.1.0）を送って走行中の `claude -p` を止め、記録から外す。止められない（server が見つからない・error 返信）時、記録が `running` なら error（`force: true` なら記録だけ消し、`warning` に理由）。終わった記録は警告付きで消える。別の owner の remote は消せない。
- `remote_list`: `owner` が分かればその owner の分だけ、分からなければ全件。`RemoteRecord` = `remote_id`, `owner`, `server`（作成時の peer id）, `serverName`, `state`, `createdAt`, `finishedAt?`, `result?`, `error?`。
- `activity`（`remote_list` の各要素）: server が protocol `bantou`（1.2.0）の `activity` 通知で送ってくる remote-cap と worker の生存・進捗。通知がまだ無い remote には `activity` キーが無い。中身は `{ at, received_ms_ago, stale, agents }`。
  - `agents`: `AgentActivity[]`（cap → worker）。`kind`, `id`, `cap_id`, `state`（`running` / `stalled` / `idle` / `done` / `failed` / `lost`）, `task`（prompt の冒頭）, `last_activity`, `last_output_at`, `silent_ms`, `started_at`, `finished_at`, `error?`。仕様は `docs/protocol.md` の「Activity notices」。
  - `silent_ms`: 通知時の値に、center が受信してからの経過を足して返す。desktop はホスト間の時計ずれを避けるため、時刻の差でなくこの値で経過を出す。
  - `received_ms_ago`: 最後の通知を受けてからの ms（center の時計）。`stale`: running / stalled の agent がいるのに 30 秒を超えて通知が来ていない（server・経路が落ちた疑い）。center は lost に書き換えず `stale` を立てるだけ（lost は server 側の事実）。
  - 保持はメモリのみ（`remotes.json` には書かない）。center 再起動後は次の通知まで空。`remote_delete` で消える。`cap_kick` で起動した cap には記録が無いので `remote_list` に出ない。
  - 通知が来るのは、その remote の `kick_cap` を送った center（peer id は再登録で変わるため、server が記録した旧 id 宛ては届かない）。ログ: 状態の組が変わった時だけ `activity 受信: cap_id=<id> <id>=<state> ...`。
- 保存: メモリ + config と同じ dir の `remotes.json`。center 再起動で返信を受け取れなくなった `running` は復元時に `failed`（server 側は続行している可能性）にする。center 終了時に返信待ちだったものも `failed`（`center 終了`）。
- **server 選択**（概念: server は master-cap から見えなくてよい。今は発見ベース）: `config.servers` に依存しない。messenger の `listPeers("all", {protocol: "bantou"})` で見つかった peer の先頭（既定）。`server` 引数は peer id、一致しなければ name。見つからなければ候補付きで error。既存の `cap_kick` などは `servers[]` のまま（挙動は変えない）。`servers[]` があれば先頭の messenger client を共有し、無ければ内部の client を 1 本使う。broker に古い peer が残っていると先頭がそれになり得る（実測: broker.json を引き継いだ再起動で古い peer が先頭に来て、指示が届かず待ち続けた）。
- **owner**（呼んだ master-cap の識別）: http では header `X-Bantou-Session: <session 名>`（または URL query `?session=<名>`）があればそれ、無ければ tool 引数 `owner`。優先順は header > query > 引数。`remote_create` はどれも無ければ error。`remote_delete` は owner が分かる時だけ記録の owner と照合する。`remote_list` は分からなければ絞らない。stdio には header が無いので引数のみ。
  - **今は**: master-cap 側に header 付きの接続を自動で持たせる仕組みは入れていない。理由: `claude remote-control` は `--mcp-config` / `--settings` を受けず（remote-control の前の global flag は spawn した session に引き継がれない）、`~/.claude.json` の書換えはユーザー設定の変更、`.mcp.json` の配置は承認プロンプト・未 trust・token 平文の問題がある。そのため、master-cap が center に繋ぐ MCP 設定（header 付き）を用意する側（番頭など）が `X-Bantou-Session` を付けるか、master-cap が `owner` 引数を渡す。
  - owner は自己申告で、認証はしない（Bearer token は center 全体で 1 つ）。

## server の版合わせ

- 組の版: `pair.server` = 組になる server の npm `bantou` の版、`pair.protocol` = このバイナリに bundle した protocol `bantou` の版。server の版は desktop のビルド（`desktop/scripts/build-sidecar.ts`）が `bun build --compile --env=BANTOU_PAIR_*` で env `BANTOU_PAIR_SERVER_VERSION` を埋め込む（値はビルド時に固定され、実行時の env では変わらない）。埋め込みが無い時は作業ツリーの `server/package.json`（`npm run dev` / tsx / dist 用）、それも無ければ不明（版合わせは無効で、protocol の版の門だけ効く）。単体バイナリ（`build:bin`）は埋め込まないので、`BANTOU_PAIR_SERVER_VERSION` を付けてビルドしない限り不明になる。
- 確認: 起動後（`connectAll` の後）と 30 秒ごと（更新中の server がいる間は 5 秒ごと）に、発見した server へ `hello` を送る。server の版が組と違えば `update_server {version: pair.server}` を送る（新旧は比べない）。server は peer の `summary`（`<host> <workspace>`）で同一視する（peer id は再登録で変わる）。
- 状態: `ok` / `updating`（`update.running` = 待っている cap・worker の件数）/ `unsupported`（protocol 1.3.0 未満。自動更新できず、手動で起動し直す）/ `mismatch`（server の版は組と同じなのに protocol の版が違う）/ `failed`（更新指示が断られた。同じ版は center が再起動するまで再指示しない）/ `lost`（更新中のまま 15 分戻らない）/ `unknown`（hello に答えない）。
- 門: protocol の版が `pair.protocol` と違う server には、`hello` / `update_server` 以外（`kick_cap` / `stop_cap` / `status`）を送らず `error`（`code:"version_mismatch"`、`retryable:true`）を返す。版が分からない（名前宛てへのフォールバック）時は従来どおり送る。更新中の server への `kick_cap` は送らず `code:"updating"`（retryable）で断る。`remote_create` は断られたら記録を作らず isError で返すので、master-cap が後で再送できる。center は自動では再送しない。
- 更新中に server の broker が止まる構成（server の内蔵 broker に center もつなぐ）では、再起動中は接続が切れる。送信失敗で次の使用時に接続を作り直す。

## claude の解決

`remoteControl.claude` 未指定なら、center 起動時に次の順で解決する（GUI 起動の app は PATH が最小のため）。

1. `$SHELL -lc 'command -v claude'`（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り）。最終の非空行が実在する実行可能な絶対パスなら採用（`login-shell`）
2. `~/.local/bin/claude`、`/opt/homebrew/bin/claude` の順に実在・実行可能なものを採用（`fallback-path`）
3. どれも無ければ PATH 任せの `claude`（`PATH`）。警告をログに出す

`remoteControl.claude` 指定時はそのまま使う（`config`、検証しない）。結果はログと `rc_status` / `rc_list` の `claude` に出る。

## ログ

- center 自身: stderr に `<ISO> bantou-center: <msg>`。
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

- stub の remote-control（確認プロンプトを出し、stdin の `y` を受けてから `Connected` を出す node スクリプト）と、本物の bantou-server（`server/` を `tsx` で起動）を使う。
- `cap_kick` で claude を 1 回起動するため、claude のログインが要る。数分かかる。
- 一時ディレクトリは `E2E_ROOT`（既定は OS の tmp）の下に作り、終了時に消す。
- 確認内容: tool 一覧、`rc_start` → `connected`、stub の異常終了 → `--continue` 付き再起動、`rc_stop`、`server_list`、`cap_kick`、`server_status`、stdin EOF での自己終了。

## 未決

- B の owner を master-cap の接続に自動で載せる仕組み（上記「今は」の限界）。center が master-cap を起動する時に MCP 設定を渡せる手段が `claude remote-control` に無い。
- 未 trust の path の扱い（center が trust を付ける手段）。
- remote の長期運用（`running` のまま返信が失われた時の再同期。server の `status` と突き合わせる案）。
- session 削除後に claude.ai に残る remote-control の environment / session 表示は、CLI からは消せない（確認した範囲で手段を見つけていない）。

- 認証（center ↔ server）。desktop ↔ center は Bearer token（上記）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。

## 窓口の分離

- 外向け `/mcp`: 認証は config の `token`（Bearer）。`session_*`、読み取り専用の `remote_list`、`rc_*`、`server_*`、`worker_resume`。`remote_create` / `remote_delete` / `cap_kick` は無い。
- session 向け `/mcp/session`: `remote_create` / `remote_delete` / `remote_list` だけ。認証は session の起動ごとに center が作る使い捨て token（`Authorization: Bearer <token>`）と header `X-Bantou-Session: <session 名>` の組で、token はその名前に発行されたものだけ通る。不一致・外向け token・欠落は 401。owner は header の名前で、引数では受けない。MCP session id は窓口をまたいで使えない。
- token は session の起動（再起動を含む）ごとに作り直し、停止で無効になる。master-cap には環境変数 `BANTOU_SESSION_TOKEN` で渡し、`--mcp-config` の JSON には `${BANTOU_SESSION_TOKEN}` と書く（引数に平文で残さない、ファイルも書かない）。

## master-cap の起動（wrapper）

- `session_create` の session は `bantou-pty-wrapper --cols N --rows N -- claude --remote-control <name> --permission-mode <m> --mcp-config '<JSON>' [--continue]` で起動する。wrapper は `dirname(process.execPath)/bantou-pty-wrapper`、env `BANTOU_PTY_WRAPPER` で上書き。config の `projects`（`rc_*`）は従来の `claude remote-control` のまま。supervisor は 1 つで、entry ごとに起動方式を選ぶ（再起動・`--continue`・素の起動への fallback・ログ・有効化確認への自動応答は共通）。
- wrapper との間は 1 行 1 JSON（wrapper の stdout: `started` / `output`（base64）/ `text`（制御文字を除いた文字列）/ `exit`、stdin: `input` / `resize` / `stop`）。session URL と接続状態は `text` の直近 16 KiB の窓に対して照合する（行単位ではない）。有効化確認への自動応答は `input`（`y\r`）。
- 停止は wrapper へ `stop` を送って待ち、`stopGraceMs` 内に終わらなければ SIGKILL。

## core（出力の配信）

center プロセス内のモジュール（`src/core.ts`）。session ごとのキュー（チャンク ID は 1 からの連番、デコード後 8 MiB を超えたら古い分から捨てる、wrapper の再起動をまたいで続く）。外向け token で次を提供する。

- `GET /sessions/<name>/output`: SSE。続きは `Last-Event-ID` か `?after=<id>`。続きが残っていない / 指定なしは `event: reset` の後に積んである全部。各チャンクは `id: <id>` `event: output` `data: <base64>`。15 秒ごとに `: ka`。未知の session は 404。
- `POST /sessions/<name>/input` `{"data":"<base64>"}` → 204（実行中でなければ 409）。
- `POST /sessions/<name>/resize` `{"cols":N,"rows":N}` → 204。最後に送った側のサイズを覚え、次の wrapper 起動の初期値にする。
