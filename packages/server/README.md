# bantou-server

center からの指示で worker（`claude -p`）を起こし、並べ、起こし直し、止める常駐プロセス。protocol「bantou」v2 の server。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- 宛先は center と server だけ。cap は worker を気にしない。worker を起こす・並べる・起こし直す・止めるのは server の責務。
- messenger broker を内蔵し、agent-messenger に名前（下記「名前」）で登録する。起動時に protocol `bantou` の待受としても登録する。
- center → server の指示は protocol `bantou` の message（`meta.protocol = "bantou"`）だけ。server → cap の返しは、ふつうの agent-messenger の message（`meta.protocol` は付けない）。worker の動きは ws。
- worker は server の `/mcp`（HTTP）から bash（`rm` のみ）の道具を受ける。

## 起動方法

```
npx bantou --config <path> [--name-prefix <英小文字・数字 1〜16 文字>]
```

- `--config` 省略時は `$BANTOU_HOME`（無ければ `$HOME`）の `config.json`。そこに無く、旧既定の `~/.config/bantou/config.json` があればそれを使う。
- `--name-prefix` は名前の prefix。config の `namePrefix` と同じ項目で、option が優先する。
- `npx bantou --version` は package.json の版を 1 行出して exit 0。内部用に `--supervise` / `--serve` / `--handoff-protocol` もある。
- それ以外の引数は exit 2。実行時エラーは exit 1。機械の ID が読めない・同じ名前が既に在る時も、起動しない。
- SIGTERM / SIGINT で実行中の claude を止め、protocol 解除・broker 停止して exit 0（5 秒で打ち切り）。

### launcher・supervisor

- `npx bantou` で起動した bin は launcher（`bin/launcher.mjs`）。同 package の `--supervise`（supervisor）を起動して見張る。supervisor は常駐本体（`--serve`）を子に 1 本だけ持つ。
- 二重起動の防止は `<workspace>/server.lock`。常駐本体は起動できたら `<workspace>/server.ready`（`{pid, version}`）を書く。
- supervisor と launcher の更新・引き継ぎ・退役の仕組み（`update.json`、`server.retired` など）は、版をまたぐ取り決めとして残してある。v2 の server は更新の指示も退役の指示も持たず、`update.json` を書かない。`<workspace>/server.retired` が在る workspace は起動せず exit 75。

## 名前

- agent-messenger に登録する名前は `[<prefix>-]bantou-server-<key>`。
- `key` は `sha256("bantou-name/v1:" + 機械の ID を小文字にして前後の空白を除いた物)` の hex の先頭 10 桁。
- 機械の ID は macOS が `ioreg -rd1 -c IOPlatformExpertDevice` の `IOPlatformUUID`、Linux が `/etc/machine-id`（無ければ `/var/lib/dbus/machine-id`）。読めなければ起動しない。
- 同じ名前で登録して error が返ったら起動しない（別の名前にしない）。
- server は、protocol の message を送ってきた名前に返す。

## config.json

```json
{
  "workspace": "/path/to/workspace",
  "namePrefix": "dev",
  "broker": { "port": 7901, "bind": "127.0.0.1", "discovery": "on", "token": "" },
  "mcp": { "port": 7902, "bind": "127.0.0.1" },
  "session": {
    "claude": "claude",
    "permissionMode": "auto",
    "timeoutMs": 1800000,
    "maxParallel": 3,
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
| `workspace` | 任意 | config.json のある dir | workspace の絶対パス。省略すると config.json のある dir が root になり、`session.env.CLAUDE_CONFIG_DIR` の既定は `<root>/.claude` |
| `namePrefix` | 任意 | 無し | 名前の prefix（英小文字・数字 1〜16 文字）。起動 option `--name-prefix` が優先 |
| `broker.port` | 任意 | `7901` | broker の HTTP port。0..65535 の整数。0 はランダム |
| `broker.bind` | 任意 | `127.0.0.1` | broker の bind アドレス |
| `broker.discovery` | 任意 | `"on"` | UDP discovery の応答。`"on"` か `"off"` |
| `broker.token` | 任意 | `""` | Bearer token。空は認証なし |
| `mcp.port` | 任意 | `7902` | `/mcp` の HTTP port。0..65535 の整数 |
| `mcp.bind` | 任意 | `127.0.0.1` | `/mcp` の bind アドレス |
| `session.claude` | 任意 | `claude` | claude 実行ファイル |
| `session.permissionMode` | 任意 | `auto` | `--permission-mode`。`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `session.timeoutMs` | 任意 | `1800000`（30 分） | 1 回の実行の打ち切り時間。正の整数 |
| `session.maxParallel` | 任意 | CPU 数 − 1（最低 1） | 同時に動かす worker の数。1 以上の整数。reply の起こし直しも数える |
| `session.allowedTools` | 任意 | `[]` | 空でなければ `--allowedTools` に渡す |
| `session.disallowedTools` | 任意 | `[]` | 空でなければ `--disallowedTools` に渡す |
| `session.extraArgs` | 任意 | `[]` | `--` の前にそのまま付ける追加引数 |
| `session.capBashSandbox` | 任意 | `false` | claude の Bash sandbox。`false` は `--settings {"sandbox":{"enabled":false}}` を付けて切る |
| `session.env` | 任意 | `{}` | spawn する claude に追加で渡す環境変数（文字列値） |
| `extraMcp` | 任意 | `{}` | worker に追加で載せる手元の stdio MCP の道具。`{ "<name>": { "command", "args", "env", "targets" } }` |

- LAN に公開するには `broker.bind`（例 `0.0.0.0`）を明示する。その場合は `broker.token` の設定を推奨する（loopback 以外に bind して token が空だと、起動直後に警告を log に出す）。
- 旧 `session.command` は廃止。残っていると起動時にエラーになる。`session.claude` を使う。
- worker の claude には、server を起動した npx が自分の起動のために入れた変数を渡さない（`server/utils/bantou/child-env.ts`）。`session.env` に書いた物はそのまま渡す。
- `extraMcp` の `<name>` は英数字・`_`・`-` のみで `__` を含まない。`bantou`（server 自身の MCP）と同名は拒否する。`url` / `headers` など stdio 以外のキーは拒否する。

## 負荷管理

- 同時に動かす worker は `session.maxParallel` 本まで。
- 負荷平均（1 分）が CPU 数を超えている間は、空きが在っても新しく起こさない。
- launch は来た順に queue。空きが在ればすぐ起こし、worker が終わるたびに先頭を 1 本起こす。
- reply の起こし直しも同じ上限を数える。queue では新しい launch より先。
- stop は queue で待っている物も外す。

## center → server（protocol `bantou`）

本文は JSON 1 つ。`meta = {protocol:"bantou", version}`。guard に通らない物は無視する（log に `無視:`）。

| 指示 | 本文 | 動き |
|---|---|---|
| launch | `{callType:"invoke", order:"launch", "parent-id", model, prompt, ws}` | worker を起こす。返事は無い。断らない（空きが無ければ queue で待たせる） |
| stop | `{callType:"invoke", order:"stop", "parent-id"}` | parent-id の cap が launch した作業を全部止める（動いている worker と queue で待っている物） |
| reply | `{callType:"reply", order:"answer"\|"approve"\|"reject", "session-id", content?}` | session-id の worker を `--resume` で起こし直す。answer は content を prompt として渡す。approve / reject は、その旨を固定の短い文で渡す |
| status | `{callType:"status", order:"server-info"}` | 答えは server の版だけ。送ってきた名前に `{protocol:"bantou", callType:"status", order:"server-info", version:"<npm bantou の版>"}` を返す（meta 付き） |
| exec | `callType:"exec"` | callType として受け付けるが order は未定義。受けたら何もしない |

## worker

- 起こし方: `claude -p --output-format stream-json --verbose --json-schema <schema> ...`。新規は `--session-id`、起こし直しは `--resume`。cwd は `<workspace>/workers/<worker_id>/`。
- schema: `{ lastType: "message"|"report", status: "ask"|"request_approve"（message の時）|"success"|"failed"（report の時）, content: string }`。全部必須。
- 最後の `result` の `structured_output` と `session_id` を使う。process が落ちて最後の出力が無い時、または組が不正な時は server が `failed` を付ける。
- worker の MCP 設定は server が付ける（`logs/mcp.json`、`--mcp-config`）。道具は bash（`rm` のみ）だけ。`--allowedTools mcp__bantou__bash` を付ける。
  - `bash` の `rm`: 自分の path 配下だけ。絶対パス・`~`・`..`・path そのもの・`state.json`・`logs/` は拒否（symlink は辿らない）。dir は `recursive: true` の時だけ消す。
- `TMPDIR` は `<path>/tmp`（mode 700、起動のたびに無ければ作る）。

## server → cap（ふつうの agent-messenger の message）

宛先は parent-id の名前、delivery は push。`meta.protocol` は付けない。

```json
{ "session-id": "<worker の session の id>", "status": "ask", "content": "<文>" }
{ "status": "success", "content": "<文>" }
```

- message（返事が要る。`status` は `ask` | `request_approve`）は `session-id` を付ける。返事は center が reply で送る。
- report（返事は要らない。`status` は `success` | `failed`）に `session-id` は無い。
- `session-id` は最後の result から取る。state.json からは引かない。

## worker の動き（ws）

- worker の session ごとに tracker（stdout を読む物）が付き、launch の `ws` に書く。
- 間隔（5 秒）ごとに、その間に出力が在った時だけ 1 行書く: `{ "parent-id": "<cap の名前>", "at": "<ISO 8601>" }`。無音の間は書かない。
- state の判定・要約・agent ごとのまとめは作らない。
- `ws` は token 入りの URL（`?token=...`）でありうる。log と error 文言では query・fragment・userinfo を伏せる（`ws://host/path?***`）。reply の起こし直しに要るので、`state.json` には生の値を持つ。

## workspace レイアウト

```
<workspace>/
  config.json                        root 構成の config（`workspace` 省略時）
  server.log / server.lock / server.ready / server.exit  常駐の記録
  broker.json                        broker の状態ファイル
  workers/<worker-id>/               worker の path（claude の cwd。`w-<hex10>`）
    state.json                       帳簿（worker_id・session_id・parent_id・ws・model・開始と終了の時刻）
    logs/claude.jsonl                claude の生出力（stream-json）
    logs/mcp.json                    `--mcp-config`（実行ごとに上書き）
    logs/system-prompt.md            `--append-system-prompt-file`（実行ごとに上書き）
    tmp/                             claude の `TMPDIR`
```

## 起動時の孤児回収

- 前回の server が残した `claude -p`（argv に worker の `--session-id <sid>` か `--resume <sid>` を含む）を、指示を受け付ける前に SIGKILL で止める。
- 止めた worker の cap へは、`failed` の report（ふつうの message）を送る。

## ログ

標準出力に 1 行 1 件（`<ISO> bantou: <msg>`）。指示受信は prompt の先頭 80 文字だけを出し、`ws` は token を伏せる。

## 開発

依存は `@unagents/messenger-broker` / `@unagents/messenger-client`（0.10.0）と、monorepo の workspace `packages/protocol` の `@agent-hand/bantou-protocol`。repo root で `bun install` し、`packages/protocol` を先にビルドする。

```
bun install                                  # repo root
(cd packages/protocol && npm run build)
cd packages/server
npm run typecheck
npm run build
npm test                                     # test/stand-in.test.ts は終わらないので除外して回す
npm run dev -- --config <path>
```

- server は Nuxt 4（Nitro のみ、UI なし、preset `node-listener`）。実装は `server/utils/bantou/`（Nitro 非依存の純 TS）と `server/plugins/01.bantou.ts`（起動・signal・exit）。
- test は `node --import tsx --test`。unit test は claude もネットワークも使わない。

## 関連資料

- [`../../docs/architecture.md`](../../docs/architecture.md)
- [`../../docs/protocol.md`](../../docs/protocol.md)
- [`../desktop/README.md`](../desktop/README.md)
