# bantou-center

素のエージェント（Claude Code など）が MCP tool 経由で cap 運用できるようにする MCP server。stdio と Streamable HTTP で動く。

役割は 2 つ。

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

- エンドポイントは `http://<bind>:<port>/mcp`（MCP Streamable HTTP。POST / GET / DELETE）。`/mcp` 以外は 404。
- **認証は Bearer token**。`/mcp` へのリクエスト（POST / GET / DELETE すべて）は `Authorization: Bearer <config の token>` が必要で、欠落・形式違い・不一致は 401（`WWW-Authenticate: Bearer`）。比較は定時間。token が無い・12 文字未満だと http は起動しない。既定は loopback にだけ bind する。`--bind 0.0.0.0` 等で外に出しても、token を知らない相手は rc_start / cap_kick を呼べない（ただし TLS は無いので平文。信頼できる LAN だけで使う）。
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
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### server の発見（protocol 方式）

- center は普通の agent-messenger client として、通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）で broker につなぐ。broker の URL は指名しない（旧 `servers[].broker` / `servers[].token` は廃止。書いても無視される。token が要る場合は `AGENT_MESSENGER_TOKEN`）。server の peer は、リクエストごとに `listPeers("all", {protocol: "bantou"})` で発見する（peer id は再登録で変わるため）。複数見つかれば name が `bantou-server` のものを優先し、無ければ先頭。0 件、または 0.9 系 broker（`BROKER_UNSUPPORTED`）の時は peer 名 `bantou-server` 宛てにフォールバックする。`servers[].peer` を指定すると発見せずその名前へ送る。
- 送信は `send(to, text, "pull", {protocol: "bantou", version})`。version は発見した peer が宣言している値（名前宛ての時は `MESSENGER_PROTOCOL.version`）。
- 受信は、送信元が解決済みの peer id、meta の protocol が `bantou`、name が `bantou-server`、`servers[].peer` のいずれかなら server の返信として扱う。text 先頭の `[agent-messenger warning]` 行（version 不一致時に付く）は除いてから JSON として解釈する。
- 仕様は `../protocol/messenger/protocol.json` と `../../docs/protocol.md`。

## tools

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `rc_list` | なし | `RcStatus[]` |
| `rc_start` | `project` | `RcStatus`（起動済みなら現状を返す） |
| `rc_stop` | `project` | `RcStatus` |
| `rc_status` | `project` | `RcStatus` |
| `server_list` | なし | `{ name, connected, reachable, peerId, serverPeer }[]`（`reachable` は broker への接続を確保できたか、`peerId` は center 自身の peer id、`serverPeer` は直近に解決した server の送信先（peer id か名前、未解決は null）） |
| `cap_kick` | `server`, `cap_id`, `prompt`, `repo?`, `branch?`, `reason?` | bantou-server の `cap_result` / `error` 返信そのまま |
| `worker_resume` | `server`, `worker_id`, `prompt`, `repo?`, `branch?` | `worker_result` / `error` 返信そのまま |
| `server_status` | `server` | `status_result` / `error` 返信そのまま |

- `cap_id` / `worker_id` は `[A-Za-z0-9_-]+`、`prompt` は 1 文字以上、`repo` / `branch` は `-` で始められない。
- `cap_kick` / `worker_resume` / `server_status` は、返信が `error` か `ok: false` の時に `isError: true` になる。本文は返信そのまま。
- `cap_kick` / `worker_resume` は返信が来るまで待つ（claude の実行が終わるまで数分）。`timeoutMs` で打ち切り、`タイムアウト` の `error` 返信になる。
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
| `lastError` | `error` 状態の理由 |
| `startedAt` / `args` | 直近の起動時刻と引数 |
| `claude` | 起動に使う実行ファイル `{ path, source }`。`source` は `config` / `login-shell` / `fallback-path` / `PATH` |

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

- 認証（center ↔ server）。desktop ↔ center は Bearer token（上記）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。
