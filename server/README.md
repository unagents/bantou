# bantou-server

claude を headless（`claude -p`）で起動する常駐プロセス。messenger 経由で指示を受ける。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- headless 実行層。端末多重化ツールは使わない。
- messenger broker を内蔵し、peer `bantou-server` として指示を待つ。
- bantou-desktop（`../desktop/`）など任意の messenger peer からの指示を受ける。
- 実行モデルの全体は [`../docs/architecture.md`](../docs/architecture.md)。要約は次の通り。
  - `kick_cap` で cap を起動する。初回は `claude -p --session-id <uuid>`、2 回目以降は `--resume <uuid>`。
  - cap ごとに path（`<workspace>/caps/<cap_id>`）を持つ。worker も同様（`workers/<worker_id>`）。
  - 同一 cap（worker）への指示は直列。別の cap（worker）は並行して走る。
  - 状態は path 直下の `state.json` に残す。
  - 起動時に、前回の実行が残した孤児 claude プロセスを回収する。
  - 実行方式は差し替え口（`AgentRunner`）で抽象化。claudep 方式（Agent SDK）は interface のみで未実装。

## 起動方法

```
npx bantou --config <path>
```

- `--config` 省略時は `~/.config/bantou/config.json`。
- それ以外の引数は exit 2。実行時エラーは exit 1。
- SIGTERM / SIGINT で実行中の claude を止め、peer 解除・broker 停止して exit 0（5 秒で打ち切り）。

## config.json

```json
{
  "workspace": "/path/to/workspace",
  "broker": { "port": 7901, "bind": "127.0.0.1", "discovery": "on", "token": "" },
  "session": {
    "claude": "claude",
    "permissionMode": "auto",
    "timeoutMs": 1800000,
    "maxRetries": 1,
    "allowedTools": [],
    "disallowedTools": [],
    "extraArgs": [],
    "env": {}
  }
}
```

| キー | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `workspace` | 必須 | - | workspace フォルダの絶対パス |
| `broker.port` | 任意 | `7901` | broker の HTTP port。0..65535 の整数。0 はランダム |
| `broker.bind` | 任意 | `127.0.0.1` | broker の bind アドレス |
| `broker.discovery` | 任意 | `"on"` | UDP discovery の応答。`"on"` か `"off"` |
| `broker.token` | 任意 | `""` | Bearer token。空は認証なし |
| `session.claude` | 任意 | `claude` | claude 実行ファイル |
| `session.permissionMode` | 任意 | `auto` | `--permission-mode`。`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `session.timeoutMs` | 任意 | `1800000`（30 分） | 1 回の実行の打ち切り時間。正の整数。超えたら SIGKILL |
| `session.maxRetries` | 任意 | `1` | タイムアウト・起動失敗時の再試行回数。0 以上の整数 |
| `session.allowedTools` | 任意 | `[]` | 空でなければ `--allowedTools` に渡す。文字列の配列 |
| `session.disallowedTools` | 任意 | `[]` | 空でなければ `--disallowedTools` に渡す。文字列の配列 |
| `session.extraArgs` | 任意 | `[]` | `--` の前にそのまま付ける追加引数。文字列の配列 |
| `session.env` | 任意 | `{}` | spawn する claude に追加で渡す環境変数。文字列値のオブジェクト。bantou-server 自身の環境変数に上書きで合成する |

- `broker` と `session` は省略可。書く場合はオブジェクト。
- LAN に公開するには `broker.bind`（例 `0.0.0.0`）を明示する。その場合は `broker.token` の設定を推奨する。
- 例: 204 の claudeAgent ユーザーは `"env": { "CLAUDE_CONFIG_DIR": "/home/vagrant/.claude-agent" }` を指定する。
- 旧 `session.command` は廃止。残っていると起動時にエラーになる。`session.claude` を使う。

## workspace レイアウト

```
<workspace>/
  broker.json                        broker の状態ファイル
  caps/<cap-id>/                     cap の path（claude の cwd）
    state.json                       状態
    logs/<session_id>.jsonl          claude の生出力（stream-json）
  workers/<worker-id>/               worker の path。構成は cap と同じ
```

- 起動時に `<workspace>/caps` と `<workspace>/workers` が無ければ作る。
- `cap_id` / `worker_id` は `[A-Za-z0-9_-]+`。
- `repo` を指定した指示では、path を git repo として扱う。path が無ければ clone、`.git` があれば fetch、`.git` が無い既存 path はエラー。clone 後は `.git/info/exclude` に `state.json` と `logs/` を追記する。
- 既存の `.git` がある場合は `fetch` だけ行う。`repo` / `branch` の違いは検知しない。
- `repo` 無しなら path を作るだけ。

## 内蔵 broker と peer

- 起動時に broker を `broker.port` / `broker.bind` で立てる。discovery と token は config の通り。
- 前回異常終了で残った自分の peer（name `bantou-server`、同一 host）は起動時に解除する。
- 自分は loopback（bind が全 IF の時）経由で接続し、peer `bantou-server` として登録する。
- summary は `<host> <workspace>`。
- loopback 以外に bind して token が空だと、起動直後に `警告: token 無しで ...` をログに出す。

## 指示

任意の messenger peer が `bantou-server` 宛てに JSON 1 つをテキストで送る。

| type | 内容 |
|---|---|
| `kick_cap` | cap を起動する（初回は新規 session、以降は resume） |
| `status` | cap / worker の状態一覧 |

`kick_cap`（`cap_id` と `prompt` 以外は任意）:

```json
{ "bantou": 1, "type": "kick_cap", "cap_id": "cap-a", "repo": "https://github.com/o/r.git", "branch": "main", "prompt": "Review the open issues.", "reason": "desktop から手動起動" }
```

- `cap_id`: cap の識別子。`caps/<cap_id>` が path になる。
- `repo` / `branch`: path の git 取得に使う。`-` で始まる値は拒否。
- `prompt`: claude に渡す指示。
- `reason`: 起動理由。ログ用で、claude には渡さない。

`status`:

```json
{ "bantou": 1, "type": "status" }
```

## 返信

指示の送信元 peer へ JSON で返す。

```json
{ "bantou": 1, "type": "cap_result", "cap_id": "cap-a", "session_id": "0b6f...-uuid", "ok": true, "result_text": "kicked" }
{ "bantou": 1, "type": "status_result", "ok": true, "caps": [{ "kind": "cap", "id": "cap-a", "path": "/ws/caps/cap-a", "session_id": "0b6f...-uuid", "state": "idle", "last_started_at": "2026-10-28T05:00:00.000Z", "last_finished_at": "2026-10-28T05:01:10.000Z", "retries": 0, "queued": 0 }], "workers": [] }
{ "bantou": 1, "type": "error", "ok": false, "message": "git clone 失敗: ...", "command": "kick_cap" }
```

- `cap_result` は claude の実行が終わってから返る。数分かかることがある。
- 実行が失敗しても `cap_result` で返る（`ok: false` と `error`）。
- `error` は実行に入る前の失敗（git 失敗、state が `running` / `error` で起動できない、state 破損など）。
- `cap_id` / `worker_id` が不正（`[A-Za-z0-9_-]+` でない）な指示は `error` を返さず、指示でないメッセージとして無視する（ログに `無視:`）。
- `status_result` の `state` は `idle` / `running` / `failed` / `error`。`queued` は待ち行列の件数。state.json が壊れていれば `error`。

## state.json

```json
{
  "session_id": "0b6f...-uuid",
  "state": "idle",
  "last_started_at": "2026-10-28T05:00:00.000Z",
  "last_finished_at": "2026-10-28T05:01:10.000Z",
  "retries": 0
}
```

- `state`: `idle`（待機）/ `running`（実行中）/ `failed`（直近の実行が失敗）/ `error`（孤児回収で判定できなかった時など）。
- `last_error`: 失敗の理由。成功時は無い。
- `retries`: 直近の実行で使った再試行回数。
- `error` の agent は起動しない（`state=error のため起動しない`）。解除は手動で、state.json を削除するか内容を直す。
- 書き込みは tmp ファイルへ書いて rename する。

## retry と session 消失

- 再試行の対象はタイムアウトと claude の起動失敗。`session.maxRetries` 回まで。
- 新規 session（`--session-id`）の再試行は、新しい session_id で行う。作成済みか不明な id を再利用しないため。
- 継続（`--resume`）で `No conversation found with session ID` が出たら、新しい session_id で新規実行に切り替える。1 回だけで、再試行回数には数えない。
- それ以外の失敗（非ゼロ終了、成功として読めない応答）は再試行せず `failed`。

## 起動時の孤児回収

- `state.json` が `running` の cap / worker を対象にする。前回 server が落ちた時の残りに当たる。
- `ps` から argv に `--session-id <sid>` か `--resume <sid>` を含むプロセスを探す。
  - 見つかれば SIGKILL して消えるのを確認し、`failed`（`起動時に孤児プロセスを回収`）にする。
  - 見つからなければ `failed`（`前回の実行が終了しないまま server が落ちた`）にする。
  - `ps` が使えなければ `error` にする。
- 結果は `孤児回収: killed=<n> failed=<n> error=<n>` でログに出す。
- 終了時（SIGTERM / SIGINT）は実行中の claude を SIGKILL し、`failed`（`server 終了により中断`）にする。

## 送り方

- 任意の messenger peer から `send_message` で `bantou-server` 宛てに送る。
- CLI の `send` は `from_id` が `cli` で peer ではないため、返信を受け取れない（サーバーは「返信失敗」をログに出して続行する）。
- 指示でないメッセージ（非 JSON、他の JSON）は無視し、ログに `無視:` を出す。ping も無視する。
- 指示は受信ごとに処理を始め、完了したら返信する。同一 id の指示は順番待ち、別 id は並行。`status` は実行中でも即答する。

## ログ

標準出力に 1 行 1 件。

```
2026-10-28T05:00:00.000Z bantou: 指示受信: type=kick_cap from=... cap_id=cap-a prompt=Review the open issues.
```

起動 / 孤児回収 / broker 起動 / peer 登録 / 指示受信 / claude 起動 / claude 終了 / 再試行 / 返信 / エラー / 終了処理 が出る。

- `指示受信` は prompt の先頭 80 文字だけを出す。repo URL の userinfo は伏せる。
- claude の生出力は `logs/<session_id>.jsonl` に追記する。1 回の実行ごとに `# <ISO> mode=<mode> session=<id>` の見出し行が付く。

## 開発

依存は `@unagents/messenger-broker` / `@unagents/messenger-client`（0.9.0、npmjs）と、`file:../packages/protocol` 経由の `@agent-hand/bantou-protocol`。
`../packages/protocol` を先にビルドする。npm publish はプロトコル package の公開まで保留している。

```
(cd ../packages/protocol && npm run build)
npm install
npm run typecheck
npm run build
npm test
npm run dev -- --config <path>
```

- server は Nuxt 4（Nitro のみ、UI なし、preset `node-listener`）。`npm run build`（`nuxt build`）が `.output/server/index.mjs` を作り、`bin/bantou.mjs` がそれを import して起動する（Nitro は listen しない）。
- 実装は `server/utils/bantou/`（Nitro 非依存の純 TS）と `server/plugins/01.bantou.ts`（起動・signal・exit）。
- `--config` は `bin/bantou.mjs` が解釈し、パスだけを `NUXT_BANTOU_CONFIG_PATH`（runtimeConfig `bantou.configPath`）へ渡す。config の中身は env に載せない。
- `npm pack` は `prepack` で build し、`bin` と `.output` を同梱する。runtime 依存は `.output/server/node_modules` に含まれる。
- test は `node --import tsx --test`。Node >=22 のみで動き、bun を要しない。unit test は claude もネットワークも使わない。

## e2e

```
npm run e2e
```

- 要: host に claude。claude を実際に 2 回起動するため数分かかる。claude のログイン（claudeAgent）を使う。
- `E2E_ROOT` で一時ディレクトリの親を変えられる（既定は OS の tmp）。
- 検証内容: `kick_cap`（新規）→ `kick_cap`（resume、同じ session_id）→ `status` → 非コマンドの無視。
- 後始末: messenger client、server プロセス（SIGTERM、exit 0 と port 解放も確認）、一時ディレクトリ。
- 成功時は `E2E OK` と主要ログを出す。失敗時は理由を出して exit 1。

## 関連資料

- [`../docs/architecture.md`](../docs/architecture.md)
- [`../docs/protocol.md`](../docs/protocol.md)
- [`../docs/guardrail.md`](../docs/guardrail.md)
- [`../desktop/README.md`](../desktop/README.md)
