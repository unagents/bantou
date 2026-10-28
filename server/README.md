# bantou-server

claude を headless（`claude -p`）で起動する常駐プロセス。messenger 経由で指示を受ける。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- headless 実行層。端末多重化ツールは使わない。
- messenger broker を内蔵し、peer `bantou-server` として指示を待つ。起動時に agent-messenger の protocol `bantou` の待受としても登録する（下記「protocol 登録」）。
- worker からの報告の受け口として MCP（HTTP）の `/mcp` を持つ（下記「worker 報告（MCP）」）。
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
  "mcp": { "port": 7902, "bind": "127.0.0.1" },
  "session": {
    "claude": "claude",
    "permissionMode": "auto",
    "timeoutMs": 1800000,
    "maxRetries": 1,
    "allowedTools": [],
    "disallowedTools": [],
    "extraArgs": [],
    "capBashSandbox": false,
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
| `mcp.port` | 任意 | `7902` | `/mcp` の HTTP port。0..65535 の整数。0 はランダム（e2e 専用。worker は起動時に URL を受け取り cap より長く生きるため、通常は固定 port） |
| `mcp.bind` | 任意 | `127.0.0.1` | `/mcp` の bind アドレス |
| `session.claude` | 任意 | `claude` | claude 実行ファイル |
| `session.permissionMode` | 任意 | `auto` | `--permission-mode`。`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `session.timeoutMs` | 任意 | `1800000`（30 分） | 1 回の実行の打ち切り時間。正の整数。超えたら SIGKILL |
| `session.maxRetries` | 任意 | `1` | タイムアウト・起動失敗時の再試行回数。0 以上の整数 |
| `session.allowedTools` | 任意 | `[]` | 空でなければ `--allowedTools` に渡す。文字列の配列 |
| `session.disallowedTools` | 任意 | `[]` | 空でなければ `--disallowedTools` に渡す。文字列の配列 |
| `session.extraArgs` | 任意 | `[]` | `--` の前にそのまま付ける追加引数。文字列の配列。`--settings` の後ろに並ぶため、同じ指定が重なれば extraArgs が後勝ち |
| `session.capBashSandbox` | 任意 | `false` | cap の `claude -p` の Bash sandbox。`false` は `--settings {"sandbox":{"enabled":false}}` を付けて切る（新規・resume とも）。`true` は付けず claude の設定のまま（sandbox が有効だと worker が cap の終了で消える）。真偽値 |
| `session.env` | 任意 | `{}` | spawn する claude に追加で渡す環境変数。文字列値のオブジェクト。bantou-server 自身の環境変数に上書きで合成する |

- `broker` / `mcp` / `session` は省略可。書く場合はオブジェクト。
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
    logs/center.json                 この cap を依頼した center（messenger の peer id）
    logs/reports.jsonl               worker から受けた report の記録（1 行 1 件）
  workers/<worker-id>/               worker の path。構成は cap と同じ
```

- 起動時に `<workspace>/caps` と `<workspace>/workers` が無ければ作る。
- `cap_id` / `worker_id` は `[A-Za-z0-9_-]+`。
- `repo` を指定した指示では、path を git repo として扱う。path が無ければ clone、`.git` があれば fetch、`.git` が無い既存 path はエラー。clone 後は `.git/info/exclude` に `state.json` と `logs/` を追記する。
- 既存の `.git` がある場合は `fetch` だけ行う。`repo` / `branch` の違いは検知しない。
- `repo` 無しなら path を作るだけ。

## 内蔵 broker と peer

- 起動時に broker を `broker.port` / `broker.bind` で立てる。discovery と token は config の通り。
- server 自身の messenger client は、自前 broker の URL を指名せず、agent-messenger の通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）でつないだ broker に peer `bantou-server` として登録する。LAN の常設 broker があればそれで動き、自前 broker には依存しない。どの broker にどの段階でつないだかは、ログの `messenger: ... broker=... (..., via ...)` に出る。
- 前回異常終了で残った自分の peer の解除は行わない（つないだ broker が heartbeat 切れの peer を自分で掃除する）。

## protocol 登録

- 接続後に `setProtocol(<protocol dir>)` で bantou protocol（name `bantou`、version は `packages/protocol/messenger/protocol.json` の通り）を登録する。ログ: `protocol 登録: bantou@1.1.0 hash=...`。終了時に `unsetProtocol`（`protocol 解除`）。
- protocol dir は npm package の `protocol/`（`scripts/copy-protocol.mjs` が `../packages/protocol/messenger/` をコピー。build / dev / e2e / prepack の先頭で実行、`server/protocol` は git 管理外）。`bin/bantou.mjs` が `NUXT_BANTOU_PROTOCOL_DIR`（runtimeConfig `bantou.protocolDir`）に設定する。
- 登録に失敗しても致命にしない。ログに出して従来の名前待受（peer `bantou-server`）で続ける。
- 受信 message の `meta.protocol` が `bantou` なら処理、meta 無しは旧形式として処理、他 protocol は無視（`無視(他 protocol)`）。返信は送信元の peer id へ `meta: {protocol: "bantou", version}` 付きで返す（report 起因の `cap_result` も同じ）。
- center は `list_peers`（`protocol: "bantou"`）で server を発見できる。
- summary は `<host> <workspace>`。
- loopback 以外に bind して token が空だと、起動直後に `警告: token 無しで ...` をログに出す。

## worker 報告（MCP）

- Nitro の `/mcp`（Streamable HTTP、stateless、JSON 応答）。listener は `mcp.bind` / `mcp.port` で server が自前で立てる（preset `node-listener` は listen しないため）。起動ログ `mcp 起動: url=http://<host>:<port>/mcp` に実 URL が出る。
- tool は `report` 1 つ。引数は `kind`（`progress` / `ask` / `approve` / `done`）と `text`（1..20000 文字）。
- 送信元は header `x-bantou-cap-id` / `x-bantou-worker-id` で判定する（token は使わない。認証は全体で後回し）。
- tool は記録して queue に積んだ時点で `accepted` を返す。worker はそこでターンを終える。不正な id・存在しない cap・終了中は `isError` で返す。
- 受けた report は `logs/reports.jsonl` に追記し、該当 cap の queue に積んで `--resume` で起動する。prompt は `worker <id> から <kind>: <text>` と、worker へ返す時の MCP 情報（URL・header 名）。実行中の cap には、終わってから渡す。
- cap の結果（stdout の result）は、`kick_cap` の送信元 center へ `cap_result` で返す。report 起因の resume の結果も同じ。center は cap ごとに `logs/center.json` へ保存する（再起動後も復元）。resume が失敗した時は `error`（`command: "kick_cap"`、`cap_id`）を返す。
- worker の MCP 設定（cap が `claude -p` に渡す `--mcp-config`。resume のたびに渡す）:

```json
{"mcpServers":{"bantou":{"type":"http","url":"http://127.0.0.1:7902/mcp","headers":{"x-bantou-cap-id":"cap-a","x-bantou-worker-id":"w1"}}}}
```

- 併せて `--strict-mcp-config --allowedTools mcp__bantou__report` を付ける。`--allowedTools` / `--mcp-config` は可変長引数なので、prompt はそれらより前に置く。
- cap の `claude -p` の Bash sandbox は既定で切る（`session.capBashSandbox: false`）。claude の sandbox が有効だと、cap の Bash が起動した子（worker）は setsid しても cap の終了で消える（204 の user settings は `sandbox.enabled: true`）。実測は `docs/history/20261028-1600-server-nuxt-flow/report.md`。`--settings` の値は user settings より優先される。sandbox を残したい環境は `capBashSandbox: true`（その場合 worker の生存は保証されない）。worker 自体は server が起動しない（cap の責務）。

## 指示

任意の messenger peer が `bantou-server` 宛てに JSON 1 つをテキストで送る。

| type | 内容 |
|---|---|
| `kick_cap` | cap を起動する（初回は新規 session、以降は resume） |
| `stop_cap` | 実行中の cap（`claude -p`）を止める |
| `status` | cap / worker の状態一覧 |

`kick_cap`（`cap_id` と `prompt` 以外は任意）:

```json
{ "bantou": 1, "type": "kick_cap", "cap_id": "cap-a", "repo": "https://github.com/o/r.git", "branch": "main", "prompt": "Review the open issues.", "reason": "desktop から手動起動" }
```

- `cap_id`: cap の識別子。`caps/<cap_id>` が path になる。
- `repo` / `branch`: path の git 取得に使う。`-` で始まる値は拒否。
- `prompt`: claude に渡す指示。
- `reason`: 起動理由。ログ用で、claude には渡さない。

`stop_cap`（protocol `bantou` 1.1.0 で追加）:

```json
{ "bantou": 1, "type": "stop_cap", "cap_id": "cap-a" }
```

- 走っている `claude -p` を process group ごと SIGTERM し、3 秒以内に終わらなければ SIGKILL する。子は `detached`（setsid）で起動しているので、cap の Bash が起動した孫もこの group にいる限り止まる。
- 中断された `kick_cap` は `cap_result`（`ok: false`, `error: "stop_cap により停止"`、再試行しない）で返り、state は `failed`。
- その cap に待っている指示（直列待ち）も、実行されずに同じ `cap_result` で返る。spawn 前（git 準備中）に届いた stop も、claude を起動せずに中断する。
- 実行も待ちも無ければ `stopped: false` の `stop_result`。cap の dir と state.json は消さない（state の削除はしない）。
- 限界: 孫が setsid などで別 group に出ていれば止まらない（`capBashSandbox` の注記と同じ事情で、worker の生存は cap の責務）。stop 要求は inflight の間だけ有効で、全ての指示が片付くと消える（その間に届いた新しい指示も中断される）。

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

- `stop_result`: `{ "bantou": 1, "type": "stop_result", "ok": true, "cap_id": "cap-a", "stopped": true }`。stop_cap の失敗（`cap_id` が不正でない限り通常は無い）は `error`（`command: "stop_cap"`, `cap_id` 付き）。
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
- 終了時（SIGTERM / SIGINT）は実行中の claude を process group ごと SIGKILL し、`failed`（`server 終了により中断`）にする。

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

起動 / 孤児回収 / broker 起動 / mcp 起動 / peer 登録 / report 受信 / 指示受信 / claude 起動 / claude 終了 / 再試行 / 返信 / エラー / 終了処理 が出る。

- `指示受信` は prompt の先頭 80 文字だけを出す。repo URL の userinfo は伏せる。
- claude の生出力は `logs/<session_id>.jsonl` に追記する。1 回の実行ごとに `# <ISO> mode=<mode> session=<id>` の見出し行が付く。

## 開発

依存は `@unagents/messenger-broker` / `@unagents/messenger-client`（0.10.0、npmjs）と、`file:../packages/protocol` 経由の `@agent-hand/bantou-protocol`。
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

- 要: host に claude。claude を実際に複数回起動するため数分かかる。claude のログイン（claudeAgent）を使う。
- `E2E_ROOT` で一時ディレクトリの親を変えられる（既定は OS の tmp）。`E2E_CLAUDE_CONFIG_DIR` で `CLAUDE_CONFIG_DIR` を渡す。`E2E_MODEL` で `--model` を指定する（worker の model は未指定なら `sonnet`）。cap の Bash sandbox は server の既定（`session.capBashSandbox: false`）で切れる。probe-survival は `E2E_CAP_BASH_SANDBOX=1` で sandbox 有効のまま計測する。
- 内蔵 broker は 127.0.0.1 / discovery off の空き port（スクリプトが先に決める）、`/mcp` は port 0。server の messenger client はその broker へ向けるため、テスト専用に env（`AGENT_MESSENGER_HOST` / `PORT` / `DISCOVERY=off`）で上書きする。server・cap・worker に本番 broker を使わせない（`AGENT_MESSENGER_*` / `CLAUDE_CODE_MESSAGING_*` を除去、cap と worker は `--strict-mcp-config`）。
- 検証内容: protocol 登録（`protocol 登録` ログ）→ center 相当の client が `listPeers("all", {protocol: "bantou"})` で発見 → meta 付きで送り、返信（`cap_result` / `status_result` / report 起因の `cap_result`）に meta が付くことを確認 → `kick_cap`（新規）→ `kick_cap`（resume、同じ session_id）→ worker 報告（cap が worker を `setsid claude -p` で起動 → worker が `report` done → server が受信 → cap が resume → 結果が送信元へ返る。worker と cap の `system/init` の `mcp_servers` も確認）→ `status` → meta 無しの旧形式 `status` も受ける → 他 protocol の meta は無視 → 非コマンドの無視 → 終了時の `protocol 解除`。
- 失敗時は一時ディレクトリを残し、パスを `E2E_DIR=` に出す。
- `npx tsx scripts/probe-survival.ts`（`E2E_*` は同じ）: cap が起動したプロセスが cap の終了後も残るかを `kick_cap` 経由で計測する。`PROBE_SIGTERM=1` で server の SIGTERM 経路も測る。
- 後始末: messenger client、server プロセス（SIGTERM、exit 0 と port 解放も確認）、一時ディレクトリ。
- 成功時は `E2E OK` と主要ログを出す。失敗時は理由を出して exit 1。

## 関連資料

- [`../docs/architecture.md`](../docs/architecture.md)
- [`../docs/protocol.md`](../docs/protocol.md)
- [`../docs/guardrail.md`](../docs/guardrail.md)
- [`../desktop/README.md`](../desktop/README.md)
