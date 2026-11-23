# bantou-server

claude を headless（`claude -p`）で起動する常駐プロセス。messenger 経由で指示を受ける。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- headless 実行層。端末多重化ツールは使わない。
- messenger broker を内蔵し、peer `bantou-server` として指示を待つ。起動時に agent-messenger の protocol `bantou` の待受としても登録する（下記「protocol 登録」）。
- bantou-desktop（`../desktop/`）など任意の messenger peer からの指示を受ける。
- 実行モデルの全体は [`../../docs/architecture.md`](../../docs/architecture.md)。要約は次の通り。
  - 同一 cap（worker）への指示は直列。別の cap（worker）は並行して走る。
  - 状態は path 直下の `state.json` に残す。
  - 起動時に、前回の実行が残した孤児 claude プロセスを回収する。
  - 実行方式は差し替え口（`AgentRunner`）で抽象化。claudep 方式（Agent SDK）は interface のみで未実装。

## 起動方法

```
npx bantou --config <path>
```

- `--config` 省略時は `$BANTOU_HOME`（無ければ `$HOME`）の `config.json`。そこに無く、旧既定の `~/.config/bantou/config.json` があればそれを使う（後方互換）。
- `npx bantou --version` は package.json の版を 1 行出して exit 0。
- `npx bantou --handoff-protocol` は引き継ぎ対応版であることを示す `1` を出して exit 0（旧 supervisor が引き継ぐ前に確かめる）。内部用に `--supervise` / `--serve` もある。
- それ以外の引数は exit 2。実行時エラーは exit 1。
- SIGTERM / SIGINT で実行中の claude を止め、peer 解除・broker 停止して exit 0（5 秒で打ち切り）。
- `<workspace>/server.retired` がある workspace では起動せず exit 75（退役済み。下記「退役」）。

### launcher・supervisor と自己更新

- `npx bantou` で起動した bin は **launcher**（`bin/launcher.mjs`、凍結。node 組み込みのみ）。起動時に 1 回だけ同 package の `--supervise`（supervisor）を env `BANTOU_LAUNCHER_PID` 付きで起動し、以後は見張るだけ。SIGTERM / SIGINT は supervisor と、`server.lock` の `pid`（`launcher` が自分の時）へ 1 回ずつ中継する。supervisor の系列（更新で入れ替わる）が消えたら `<workspace>/server.exit`（`{launcher, code}`）の code で終わる（無ければ直下の supervisor の code、それも無ければ 1）。
- supervisor（`--supervise`、Nitro は読まない）は常駐本体（`--serve`）を子に 1 本だけ持つ。SIGTERM / SIGINT は子の process group へ中継する。supervisor の PID は更新で**変わる**（新版の supervisor に引き継ぐ。下記）。launcher の PID は変わらない。子だけ入れ替える従来の更新（引き継ぎ非対応の版へ）では supervisor の PID は変わらない。
- 二重起動の防止: `<workspace>/server.lock`（`{pid, version, started_at, launcher?, child?, next?}`）を supervisor が排他作成する。`pid` は supervisor 自身。生きている pid（または引き継ぎ中の `next.pid`）があれば `既に起動中 pid=...` / `引き継ぎ中 pid=...` で exit 1（launcher も exit 1）、死んだ pid なら取り直す。`--serve` は env `BANTOU_SUPERVISOR_PID` が lock の `pid`（引き継ぎの試行中は `next.pid`）と合わなければ exit 1（手起動を防ぐ）。最後の砦は broker / mcp の port bind 衝突。
- 版をまたぐ取り決めは変えない（変えるなら後方互換を保つ）: launcher と supervisor の間（config の workspace、lock の `pid` / `launcher`、`server.exit` の `{launcher, code}`、信号の中継、`BANTOU_LAUNCHER_PID`）、supervisor と子の間（`--serve`、`BANTOU_SUPERVISOR_PID`、`server.lock` / `server.ready` / `update.json`、更新時の exit 0）、supervisor 同士（`--handoff-protocol`、`--supervise`、`next` の形、`BANTOU_HANDOFF_TOKEN`）。
- 0.3.0 以前の server（launcher を持たず supervisor が最初の版のまま残る）から、この仕組みへは一度だけ手で起動し直す。0.3.0 の supervisor の下でも新版の子は動く（子だけ入れ替わる）が、supervisor は 0.3.0 のまま。

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
| `workspace` | 任意 | config.json のある dir | workspace フォルダの絶対パス。省略すると config.json のある dir が root になり、その場合 `session.env.CLAUDE_CONFIG_DIR` の既定は `<root>/.claude`（専用ユーザーの HOME を root にする構成。`../../docs/ops/server-install.md`） |
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
| `extraMcp` | 任意 | `{}` | cap / worker に追加で載せる手元の stdio MCP の道具。`{ "<name>": { "command", "args", "env", "targets" } }`（下記「追加の MCP（extraMcp）」） |

- `broker` / `mcp` / `session` / `update` は省略可。書く場合はオブジェクト。
- LAN に公開するには `broker.bind`（例 `0.0.0.0`）を明示する。その場合は `broker.token` の設定を推奨する。
- 例: 204 の claudeAgent ユーザーは `"env": { "CLAUDE_CONFIG_DIR": "/home/vagrant/.claude-agent" }` を指定する。
- 旧 `session.command` は廃止。残っていると起動時にエラーになる。`session.claude` を使う。
- cap（本体と task ごとの lane）/ worker の claude（とその子の extraMcp の道具・worker が叩く npx）には、server を起動した npx が自分の起動のために入れた変数を渡さない（`server/utils/bantou/child-env.ts`）。外すのは何を実行するか・どの npm が実行したかを表す物（`npm_config_package` / `call` / `yes` / `workspace` / `workspaces` / `include_workspace_root` / `user_agent` / `npm_version` / `node_gyp` / `global_prefix` / `local_prefix`、`npm_command` / `npm_execpath` / `npm_node_execpath` / `npm_lifecycle_*` / `npm_package_*`）。残すと子の `npx -y <pkg>@<版> ...` が `npm_config_package` を `--package` として読み、`<pkg>@<版>` をコマンドとして探して失敗する。registry（scope 別を含む）・認証・proxy・userconfig・cache・prefix など取得元と取得の仕方の設定、npm_ で始まらない変数は残す。`session.env` に書いた物はそのまま渡す。server 自身の env は変えない（自動更新の npx は従来どおり）。

### 追加の MCP（extraMcp）

```json
{ "extraMcp": { "fetch": { "command": "npx", "args": ["-y", "some-mcp-package"], "env": {}, "targets": ["worker"] } } }
```

- 手元で動く stdio の道具だけ。`command`（必須・空でない文字列）、`args`（文字列の配列、既定 `[]`）、`env`（文字列値のオブジェクト、既定 `{}`）、`targets`（`"cap"` / `"worker"` の重複なし非空配列、既定は両方）。`url` / `headers` など他のキーは拒否する。鍵を要する接続はここでは扱わない（center が持つ）。
- `<name>` は英数字・`_`・`-` のみで `__` を含まない。`bantou`（server 自身の MCP）と同名は config の読込時に拒否する（既存を優先）。
- `targets` に含めた側の `logs/mcp.json` にだけ載り、その側の `--allowedTools` に `mcp__<name>` を足す。含めない側には載らない。`env` を含みうるので `mcp.json` は mode 0600 で書く。
- 設定を変えたら server の再起動で反映（次の cap / worker の起動から）。

## workspace レイアウト

`<workspace>` は config の `workspace`（省略時は config.json のある dir = root）。root 構成では config.json・`.claude` などもこの dir に同居する。

```
<workspace>/
  config.json                        root 構成の config（`workspace` 省略時。明示指定の構成では別の場所）
  server.log / server.lock / server.ready / server.exit / update.json  常駐の記録と更新の状態
  broker.json                        broker の状態ファイル
  workers/<worker-id>/               worker の path。構成は cap と同じ
```

- 起動時に `<workspace>/caps` と `<workspace>/workers` が無ければ作る。
- `cap_id` / `worker_id` は `[A-Za-z0-9_-]+`。
- `repo` を指定した指示では、path を git repo として扱う。path が無ければ clone、`.git` があれば fetch、`.git` が無い既存 path はエラー。clone 後は `.git/info/exclude` に `state.json`・`logs/`・`tmp/` を追記する。
- 既存の `.git` がある場合は `fetch` だけ行う。`repo` / `branch` の違いは検知しない。

## 内蔵 broker と peer

- 起動時に broker を `broker.port` / `broker.bind` で立てる。discovery と token は config の通り。
- server 自身の messenger client は、自前 broker の URL を指名せず、agent-messenger の通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）でつないだ broker に peer `bantou-server` として登録する。LAN の常設 broker があればそれで動き、自前 broker には依存しない。どの broker にどの段階でつないだかは、ログの `messenger: ... broker=... (..., via ...)` に出る。
- 前回異常終了で残った自分の peer の解除は行わない（つないだ broker が heartbeat 切れの peer を自分で掃除する）。

## protocol 登録

- 接続後に `setProtocol(<protocol dir>)` で bantou protocol（name `bantou`、version は `packages/protocol/messenger/protocol.json` の通り）を登録する。ログ: `protocol 登録: bantou@1.2.0 hash=...`。終了時に `unsetProtocol`（`protocol 解除`）。
- protocol dir は npm package の `protocol/`（`scripts/copy-protocol.mjs` が `../protocol/messenger/` をコピー。build / dev / e2e / prepack の先頭で実行、`packages/server/protocol` は git 管理外）。`bin/bantou.mjs` が `NUXT_BANTOU_PROTOCOL_DIR`（runtimeConfig `bantou.protocolDir`）に設定する。
- 登録に失敗しても致命にしない。ログに出して従来の名前待受（peer `bantou-server`）で続ける。
- 受信 message の `meta.protocol` が `bantou` なら処理、meta 無しは旧形式として処理、他 protocol は無視（`無視(他 protocol)`）。返信は送信元の peer id へ `meta: {protocol: "bantou", version}` 付きで返す（report 起因の `cap_result` も同じ）。
- center は `list_peers`（`protocol: "bantou"`）で server を発見できる。
- summary は `<host> <workspace>`。
- loopback 以外に bind して token が空だと、起動直後に `警告: token 無しで ...` をログに出す。

## worker 報告（MCP）

- Nitro の `/mcp`（Streamable HTTP、stateless、JSON 応答）。listener は `mcp.bind` / `mcp.port` で server が自前で立てる（preset `node-listener` は listen しないため）。起動ログ `mcp 起動: url=http://<host>:<port>/mcp` に実 URL が出る。
## bash（MCP）


| tool | 入力 | 返り値 |
|---|---|---|
| `bash` | `action`（今は `rm` のみ）、`paths`（1..100 件、各 1024 文字まで）、`recursive?` | `{"removed":["..."],"skipped":[{"path":"...","reason":"..."}]}` |
- `bash`（cap と worker の両方に載る。cap / worker の起動時に `--allowedTools mcp__bantou__bash` も付く）: Bash の `rm -rf` が permission 分類器に止まる問題を、範囲を server が保証する tool で避ける。任意のシェル文字列は受けず、`action` は handler 表（今は `rm`）で引く。未知の `action` と引数の形の不正（件数・長さ・型）だけ `isError`。全部拒否でも `isError` にせず `skipped` に理由を返す。
  - 範囲: 呼び出し元の自分の path 配下だけ（worker は `workers/<worker_id>/`、cap は `caps/<cap_id>/` と、`logs/owner.json` の `cap_id` が自分の worker は `worker:<id>/<path>` で指す）。`paths` は自分の path からの相対。
  - 拒否: 絶対パス・`~`・`..`・バックスラッシュ・NUL、path そのもの（`.` や空）、`state.json` と `logs/`（`./`・末尾 `/`・大文字小文字違いも。symlink を解決した後も判定）、realpath が範囲外のもの、他の cap の worker、worker から `worker:` 接頭辞。
  - symlink は辿らず link 自体を消す。親が範囲外を指す symlink は拒否。dir は `recursive: true` の時だけ消し、再帰削除でも symlink は辿らない。削除の直前に lstat と親の realpath を取り直す（検査の後で変わっていたら消さない）。
  - 前提（認証）: 呼び出し元は header `x-bantou-cap-id` / `x-bantou-worker-id` だけで識別し、認証は無い（MCP の認証は全体で後回し。`worker_start` / `worker_stop` も同じ前提）。127.0.0.1 の `/mcp` に curl できる worker が `cap_id` を偽ると、その cap の path と配下 worker の path を `bash` の `rm` で消せる。偽装でも `logs/` と `state.json` は消せない（範囲の判定で常に拒否）。将来 MCP に起動ごとの token を入れる時は `bash` も対象にする。
  - `TMPDIR`: 起動のたび（resume でも）に `<path>/tmp` を無ければ mode 700 で作り（在れば何もしない。symlink・file なら消して作り直す）、claude の env `TMPDIR` に渡す（`session.env` では上書きできない）。`tmp` は `bash` の `rm` の範囲内。

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
- 結果は `孤児回収: killed=<n> failed=<n> error=<n>` でログに出す。回収した running は activity で lost として登録し、center へ通知する（worker の持ち主は `owner.json`）。
- 終了時（SIGTERM / SIGINT）は実行中の claude を process group ごと SIGKILL し、`failed`（`server 終了により中断`）にする。

## ログ

標準出力に 1 行 1 件。

起動 / 孤児回収 / worker 掃除 / broker 起動 / mcp 起動 / peer 登録 / worker_start / worker_stop / report 受信 / activity 通知 / 指示受信 / claude 起動 / claude 終了 / 再試行 / 返信 / エラー / 終了処理 が出る。

- `指示受信` は prompt の先頭 80 文字だけを出す。repo URL の userinfo は伏せる。
- claude の生出力は `logs/<session_id>.jsonl` に追記する。1 回の実行ごとに `# <ISO> mode=<mode> session=<id>` の見出し行が付く。

## 開発

依存は `@unagents/messenger-broker` / `@unagents/messenger-client`（0.10.0、npmjs）と、monorepo の workspace `packages/protocol` の `@agent-hand/bantou-protocol`（devDependencies `^0.2.0`、bun の workspace がリンクする）。
repo root で `bun install` し、`packages/protocol` を先にビルドする（`npm install` は使わない。root の `node_modules` は bun のもの）。npm publish はプロトコル package の公開まで保留している。

```
bun install                                  # repo root
(cd packages/protocol && npm run build)
cd packages/server
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
- 失敗時は一時ディレクトリを残し、パスを `E2E_DIR=` に出す。
- 後始末: messenger client、server プロセス（SIGTERM、exit 0 と port 解放も確認）、一時ディレクトリ。
- 成功時は `E2E OK` と主要ログを出す。失敗時は理由を出して exit 1。

## 外部記憶

server は外部記憶（memory）へ書かない。理由: 今の目的は master-cap の記憶で、cap の記憶は抽出 LLM の呼び出しを増やすだけ。将来 cap の記憶が要る時に足す。master-cap の記憶は center が書く（`docs/design/external-memory.md`）。

## 関連資料

- [`../../docs/architecture.md`](../../docs/architecture.md)
- [`../../docs/protocol.md`](../../docs/protocol.md)
- [`../desktop/README.md`](../desktop/README.md)
