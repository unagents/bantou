# bantou-server

tmux 上に claude session を起動する常駐プロセス。messenger 経由で指示を受ける。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- messenger broker を内蔵し、peer `bantou-server` として指示を待つ。
- bantou-desktop（`../desktop/`）など任意の messenger peer からの指示を受ける。
- 指示は 2 種。session の起動（`launch_session`）と一覧（`list_sessions`）。
- remote cap（オーケストレーター）の起動（`src/cap.ts`）は未実装のスタブ。

## 起動方法

```
npx bantou --config <path>
```

- `--config` 省略時は `~/.config/bantou/config.json`。
- それ以外の引数は exit 2。実行時エラーは exit 1。
- SIGTERM / SIGINT で peer 解除・broker 停止して exit 0（5 秒で打ち切り）。

## config.json

```json
{
  "workspace": "/path/to/workspace",
  "broker": { "port": 7901, "bind": "0.0.0.0", "discovery": "on", "token": "" },
  "session": { "command": "claude --permission-mode auto" }
}
```

| キー | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `workspace` | 必須 | - | workspace フォルダの絶対パス |
| `broker.port` | 任意 | `7901` | broker の HTTP port。0..65535 の整数。0 はランダム |
| `broker.bind` | 任意 | `0.0.0.0` | broker の bind アドレス |
| `broker.discovery` | 任意 | `"on"` | UDP discovery の応答。`"on"` か `"off"` |
| `broker.token` | 任意 | `""` | Bearer token。空は認証なし |
| `session.command` | 任意 | `claude --permission-mode auto` | tmux に渡す起動コマンド（shell 経由） |

`broker` と `session` は省略可。書く場合はオブジェクト。

## workspace レイアウト

```
<workspace>/
  repos/        repo の展開先（session の cwd は既定で repos/<name>）
  broker.json   broker の状態ファイル
```

起動時に `<workspace>/` と `<workspace>/repos/` が無ければ作る。

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
| `launch_session` | repo 取得（任意）→ tmux session 起動 |
| `list_sessions` | tmux session 一覧 |

`launch_session`（`name` 以外は任意）:

```json
{ "bantou": 1, "type": "launch_session", "name": "s1", "repo": "https://github.com/o/r.git", "branch": "main", "cwd": "r/sub" }
```

- `name`: tmux session 名。`[A-Za-z0-9_-]+`。
- `repo`: git URL。`-` で始まる値は拒否（`branch` と `cwd` も同様）。指定時は `<workspace>/repos/<name>` へ clone。既にあれば fetch のみ。
- `branch`: `git clone --branch` に渡す。
- `cwd`: `repos/` からの相対。既定は `<name>`。`repos/` 外は拒否。無ければ作る。
- 同名の tmux session があるとエラー。

`list_sessions`:

```json
{ "bantou": 1, "type": "list_sessions" }
```

## 返信

指示の送信元 peer へ JSON で返す。

```json
{ "bantou": 1, "type": "session_launched", "ok": true, "name": "s1", "tmux": "s1", "cwd": "/ws/repos/s1" }
{ "bantou": 1, "type": "sessions", "ok": true, "sessions": [{ "name": "s1", "windows": 1, "created": "2026-10-28T05:00:00.000Z", "attached": false }] }
{ "bantou": 1, "type": "error", "ok": false, "message": "tmux session \"s1\" は既に存在する", "command": "launch_session" }
```

## 送り方

- 任意の messenger peer から `send_message` で `bantou-server` 宛てに送る。
- CLI の `send` は `from_id` が `cli` で peer ではないため、返信を受け取れない（サーバーは「返信失敗」をログに出して続行する）。
- 指示でないメッセージ（非 JSON、他の JSON）は無視し、ログに `無視:` を出す。ping も無視する。
- 指示は 1 件ずつ直列に処理する。

## ログ

標準出力に 1 行 1 件。

```
2026-10-28T05:00:00.000Z bantou: 指示受信: type=launch_session from=...
```

起動 / broker 起動 / peer 登録 / 指示受信 / tmux 作成 / 返信 / エラー / 終了処理 が出る。

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

dev / test は `node --import tsx` を使う。Node >=22 のみで動き、bun を要しない。unit test は tmux もネットワークも使わない。

## e2e

```
npm run e2e
```

- 要: host に tmux と claude。`E2E_ROOT` で一時ディレクトリの親を変えられる（既定は OS の tmp）。
- server を実起動し、`launch_session` → claude の起動画面確認 → `list_sessions` → 重複 launch のエラー → 非コマンドの無視、を検証する。
- 後始末: tmux session、messenger client、server プロセス（SIGTERM、exit 0 と port 解放も確認）、一時ディレクトリ。
- 成功時は `E2E OK` と主要ログを出す。失敗時は理由を出して exit 1。

## 関連資料

- [`../docs/protocol.md`](../docs/protocol.md)
- [`../docs/guardrail.md`](../docs/guardrail.md)
- [`../desktop/README.md`](../desktop/README.md)
