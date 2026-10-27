# bantou-center

素のエージェント（Claude Code など）が MCP tool 経由で cap 運用できるようにする MCP server。stdio で動く。

役割は 2 つ。

- project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰。
- リモートホストの bantou-server への指示（kick_cap / resume_worker / status）の中継。

desktop が裏で起動する予定（アプリ設定で on/off）。現時点では単体で `claude mcp add` して使う。

## 起動

```bash
npx bantou-center --config ~/.config/bantou/center.json
```

`--config` の既定は `~/.config/bantou/center.json`。不正な引数は usage を stderr に出して exit 2。

Claude Code への登録例:

```bash
claude mcp add bantou-center -- node /path/to/packages/center/dist/cli.js --config ~/.config/bantou/center.json
```

stdout は MCP の通信路。ログは全て stderr に出る。

## config

```json
{
  "projects": [
    { "name": "bantou", "path": "/home/me/work/bantou", "spawn": "same-dir", "permissionMode": "auto", "capacity": 4, "autostart": true }
  ],
  "remoteControl": { "claude": "claude", "continueOnRestart": true, "restartDelayMs": 5000, "maxRestarts": 5, "stopGraceMs": 5000 },
  "servers": [
    { "name": "linux204", "broker": "http://192.168.1.204:7901", "token": "secret", "timeoutMs": 2100000 }
  ],
  "logDir": "/home/me/.config/bantou/center-logs"
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
| `remoteControl.claude` | string | `claude` | claude 実行ファイル |
| `remoteControl.continueOnRestart` | boolean | `true` | 再起動時に `--continue` を付ける |
| `remoteControl.autoConsent` | boolean | `true` | 起動時の確認プロンプト（`Enable Remote Control? (y/n)`）に自動で `y` を返す |
| `remoteControl.restartDelayMs` | 0 以上の整数 | `5000` | 異常終了から再起動までの待ち |
| `remoteControl.maxRestarts` | 0 以上の整数 | `5` | 再起動回数の上限 |
| `remoteControl.stopGraceMs` | 0 以上の整数 | `5000` | SIGTERM から SIGKILL までの猶予 |
| `servers[].name` | `[A-Za-z0-9_-]+` | 必須 | server 名。重複不可。tool の `server` 引数で使う |
| `servers[].broker` | http URL | 必須 | bantou-server の内蔵 messenger broker（https 不可。末尾 `/` は除かれる。到達不能でも他の broker へは接続しない） |
| `servers[].token` | string | なし | broker の token |
| `servers[].timeoutMs` | 正の整数 | `2100000`（35 分） | 返信待ちの打ち切り |
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |

## tools

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `rc_list` | なし | `RcStatus[]` |
| `rc_start` | `project` | `RcStatus`（起動済みなら現状を返す） |
| `rc_stop` | `project` | `RcStatus` |
| `rc_status` | `project` | `RcStatus` |
| `server_list` | なし | `{ name, broker, connected, reachable, peerId }[]`（`peerId` はその broker 上の center 自身の peer id） |
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

## ログ

- center 自身: stderr に `<ISO> bantou-center: <msg>`。
- remote-control の出力: `logDir/<project>.log` に stdout / stderr をそのまま追記する。

## remote-control の再起動

- `state` は `starting` で始まり、出力に `Connected` が出たら `connected`。
- 子プロセスが落ちると `restartDelayMs` 後に再起動する（`continueOnRestart` が `true` なら `--continue` 付き）。`restarts` が `maxRestarts` に達したら `error`（`lastError` は「再起動回数の上限」）。
- `rc_stop` は再起動予約を取り消し、SIGTERM、`stopGraceMs` 後に SIGKILL。`restarts` は 0 に戻る。停止後の `rc_start` は `--continue` なしの新規起動。
- 起動のたびに `claude remote-control` は `Enable Remote Control? (y/n)` を出して stdin の返答を待つ。`autoConsent`（既定 true）なら stdout に出た時点で `y` を 1 度送る。stdin は子の生存中ずっと開けておく（閉じると確認待ちで固まる）。
- 子プロセスの環境変数から `ANTHROPIC_API_KEY`（あると remote-control が失敗する）と `TMUX` を除く。
- center 終了時（SIGTERM / SIGINT / stdin の EOF）は全 project を停止してから exit 0。15 秒で強制終了。

## 開発

```bash
cd packages/center
npm run typecheck
npm run build
npm test          # node:test。ネットワーク・claude・実 bantou-server は不要
npm run dev -- --config <path>
```

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

- desktop ↔ center の transport（MCP の Streamable HTTP が候補）。現状は stdio のみ。
- 認証（desktop ↔ center、center ↔ server）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。
