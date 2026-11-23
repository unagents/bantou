# bantou-center

素のエージェント（Claude Code など）が MCP tool 経由で cap 運用できるようにする MCP server。stdio と Streamable HTTP で動く。

役割は 3 つ。

- center 上の session（master-cap）の起動・削除（`session_*`、下記「session」）。
- master-cap に持たせる remote session の起動・削除（`remote_*`、下記「remote」）。
- project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰。
- リモートホストの server への指示（worker_reply）の中継。

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

- エンドポイントは `http://<bind>:<port>/mcp`（外向け。MCP Streamable HTTP。POST / GET / DELETE）。pty 出力の配信は `/sessions/<name>/{output,input,resize,attachments}`（下記「core」「添付画像」）。statusLine の受信は `POST /sessions/<name>/status-line`、claude の hook の受信は `POST /sessions/<name>/hook`（どちらも session token。下記「context 使用量」「作業状態（activity）」）。それ以外は 404。
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
claude mcp add center -- node /path/to/packages/center/dist/cli.js --config ~/.config/bantou/center.json
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
    { "name": "named", "peer": "my-server", "model": "opus", "workerModel": "sonnet" }
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
| `logDir` | 絶対パス | config と同じ場所の `center-logs/` | remote-control の出力ログ置き場 |
| `workspace` | 絶対パス | なし | `session_create` で `path` 省略時の置き場所 `<workspace>/<name>` の親。session は起動時に立てない |
| `token` | 12 文字以上の文字列 | なし | http transport の `/mcp` が要求する Bearer token。http では必須（無い・12 文字未満だと起動せずエラー終了。Cork の MCP Server が 12 文字未満の token を拒否し、保存値が不正なら作り直すのに合わせた）。stdio では使わない。desktop は sidecar 起動時に `center.json` へ書く |

### config の読み直し

center は wrapper 経由の session（master-cap）を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に `--config` のファイルを読み直す。center は再起動しない。動いている session には効かない。保存後に起動する session から効く。

- 読み直しで効く: `remoteControl.model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`（その session の起動時点の値。再起動の予約もその起動で読んだ値で決める）。
- 起動時にしか効かない（変えるには center の再起動が要る）: `remoteControl.claude`（起動時に解決する）、`remoteControl.stopGraceMs`、`projects`、`servers`、`logDir`、`workspace`、`token`、port / bind。
- 読み直しに失敗した時（ファイル無し・JSON が壊れている・検証 NG）は、直前に読めた値（まだ読めていなければ起動時の値）で起動し、理由を `center.log` に 1 行残す: `config の読み直しに失敗。直前の値で起動: project=… <理由>`。session の起動は止めない。
- config 由来の project（`claude remote-control` 直起動）の `projects[]` の値は起動時にしか効かない。`remoteControl` の値は、その project の起動でも読み直した値になる。
- 設計: `docs/design/master-cap-session.md` 決定 16。

### server の発見（protocol 方式）

- center は普通の agent-messenger client として、通常の解決（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback）で broker につなぐ。broker の URL は指名しない（旧 `servers[].broker` / `servers[].token` は廃止。書いても無視される。token が要る場合は `AGENT_MESSENGER_TOKEN`）。server の peer は、リクエストごとに `listPeers("all", {protocol: "bantou"})` で発見する（peer id は再登録で変わるため）。`servers[].peer` を指定すると発見せずその名前へ送る。
- 送信は `send(to, text, "pull", {protocol: "bantou", version})`。version は発見した peer が宣言している値（名前宛ての時は `MESSENGER_PROTOCOL.version`）。
- 受信は、送信元が解決済みの peer id、meta の protocol が `bantou`、`servers[].peer` のいずれかなら server の返信として扱う。text 先頭の `[agent-messenger warning]` 行（version 不一致時に付く）は除いてから JSON として解釈する。
- 仕様は `../protocol/messenger/protocol.json` と `../../docs/protocol.md`。

## tools

概念は `docs/concept.md`。`session_*` が A（番頭が使う、center 上の master-cap）、`remote_*` が B（center が master-cap に持たせる、server への指示の道具）。`rc_*` `server_*` は従来の tool で、そのまま残している。外向け `/mcp` の tool は下の表のうち `remote_send` / `remote_create`（session 向け `/mcp/session` だけ）を除いたもの（`worker_reply` は両方にある。desktop は `center_call` で外向けの `worker_reply` を呼ぶ）。

出力は全て JSON 文字列を 1 つの text content に入れて返す。例外・失敗は `isError: true`（例外は `{ "error": "..." }`）。

| tool | 入力 | 出力 |
|---|---|---|
| `session_create` | `name`, `path?`, `permissionMode?`, `settings?`（プロジェクト設定。下記） | `SessionInfo`（下記） |
| `session_update` | `name`, `newName?`, `path?`（絶対パス）, `move?`（`path` 指定時のみ） | `SessionInfo`（更新後。手順と注意は下記） |
| `session_settings_get` | `name` | `{ name, settings }`（未設定・config 由来は `settings: {}`） |
| `session_settings_update` | `name`, `settings`（項目ごとにマージ。`null` で項目を削除） | `{ name, settings }`（更新後の全体） |
| `center_settings_get` | なし | `{ settings }`（center 共通の設定。`servers` は無い。未設定は `{}`） |
| `center_settings_update` | `settings`（項目ごとにマージ。`null` で項目を削除。`servers` は共通では持てず、null 以外を渡すと error） | `{ settings }`（更新後の全体。全 session の次の起動から効く） |
| `session_delete` | `name` | `{ name, deleted }` |
| `session_list` | なし | `SessionInfo[]` |
| `session_login` | `name` | `{ name, loginUrl }`。session の claude に `/login` を打ち、認証 URL が出るまで待つ（上限 15 秒）。下記「再ログイン」 |
| `session_login_code` | `name`, `code` | `{ name, ok, auth, error }`。認証コードを投入して結果を待つ（上限 30 秒）。`ok: false` は `isError` |
| `center_info` | なし | `{ workspace: string \| null, systemInstructions: [{ id, version, title }] }`（`workspace` は config の `workspace`。未設定は `null`。desktop の追加ダイアログがフォルダ欄の既定 `<workspace>/<name>` を出すのに使う。`systemInstructions` は master-cap の起動時に付けるシステム埋め込み指示の部品（条件付きの `memory@1` も含む）。項目は今後増える） |
| `remote_send`（session 向けのみ） | `server`, `model?`, `prompt` | `{ remote_id, server, model, sent: true }` |
| `remote_create`（session 向けのみ） | 同上 | `remote_send` の互換の別名（同じ処理） |
| `worker_reply` | `server`, `session_id`, `order`, `content?` | `{ server, session_id, order, sent: true }`。session 向け・外向けの両方 |
| `remote_stop`（session 向けのみ） | `server` | `{ remote_id, server, sent: true, forgotten }` |
| `remote_list` | `owner?`（外向け。無ければ全件）。session 向けは `include_out_of_scope?` | `RemoteView[]`: `remote_id`, `session`, `server`, `serverName`, `server_label`, `state`, `finishedAt?`, `model`, `createdAt`, `owners` |
| `remote_wait` | `remote_id?`（`<parent-id>@<server>`）, `server?`, `timeout_sec?`（既定 600、上限 1800）, `owner?`（外向けのみ） | `RemoteView`。timeout なら `state: "running"` のまま |
| `rc_list` | なし | `RcStatus[]` |
| `rc_start` | `project`, `resume?` | `RcStatus`（起動済みなら現状を返す。`resume: true` で `--continue`、復帰できなければ素の起動） |
| `rc_stop` | `project` | `RcStatus` |
| `rc_status` | `project` | `RcStatus` |

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
| `auth` | claude の認証状態（wrapper 経由の session のみ変わる）。`ok` / `login_required`（`Please run /login` が出た。OAuth token 切れ）/ `keychain_locked`（`/login` の保存に失敗 `Couldn't save your login`。macOS の keychain がロック）。起動ごとに `ok` に戻る |
| `loginUrl` | `/login` が表示した認証 URL。`Login successful` か次の起動まで残る |
| `loginError` | `/login` の失敗理由（`Invalid code` / `Couldn't save your login`）。`session_login` / `session_login_code` の開始と成功で消える |

`SessionInfo` は `RcStatus` の `project`（`name` として）/ `path` / `state` / `pid` / `sessionUrl` / `startedAt` / `lastError?` / `auth` / `loginUrl` / `loginError` に `source`（`config` / `session`）を足したもの。`state` は `stopped` / `starting` / `connected` / `error`。

### session（A）

- `session_create`: pty wrapper 経由の対話型 `claude --remote-control <name> --permission-mode <permissionMode> --mcp-config '<JSON>'`（再起動時は `--continue` 付き）を `path` で起動し、supervisor に動的に足す（起動の詳細は「master-cap の起動（wrapper）」）。`path` 省略時は config の `workspace` の下の `<name>`（無ければ作る）。`workspace` が無ければ `path` が必須。`permissionMode` の既定は `auto`。`name` の重複、既存 project 名との衝突、他の project / session と同じ path は拒否。接続（URL 取得）か早期終了まで最大 15 秒待って状態を返す（待ちきれなければ `starting`）。
- `session_update`: `session_create` で作ったものだけ（config 由来・未定義は `session_delete` と同じ文言で拒否）。`newName`（既存の session / project 名と重複不可）と `path`（他の session / project と重複不可、絶対パス）を変える。`newName` も `path` も実質変わらない呼び出しは拒否。手順: (1) 検証 (2) `supervisor.remove`（停止・core / token の解除） (3) `path` 指定時は、`move: true` なら今のフォルダを新しい `path` へ `fs.rename` で移動（親 dir は作る。EXDEV など失敗したら error にして何も変えない。コピーはしない）、そうでなければ新しい `path` を作るだけ（今のフォルダは残す。`move` は `path` が無ければ無視） (4) `sessions.json` の `name` / `path` を更新（`settings`・並び順はそのまま） (5) 名前を変えたら remotes の記録を付け替え (6) 新しい名前で `add` → `start(resume)` (7) `session_create` と同じ待ちで `SessionInfo` を返し、`GET /events` に `reason: "updated"`（`name` = 新しい名前）を流す。途中で失敗したら記録・フォルダの移動・remotes の付け替えを戻し、元の名前で起動し直す（best effort。失敗は center.log）。`instructions` / `addDirs` は新しい名前へ引き継ぐ。
  - **path を変えると `--continue` が効かない**: claude の会話は path ごとに保存されるため、新しい path では `--continue` が「会話が無い」で落ち、既存の fallback で素の起動（新しい会話）になる（仕様）。名前だけ変えた時は同じ path なので会話は続く。`move: true` でフォルダを移しても会話の保存先（`~/.claude/projects/<path を変換した dir>`）は移らない。
  - **別の session の remote 記録と衝突する名前は使えない**: (a) 改名後、旧名の cap_id を新しい名前の記録が持つので、旧名での `session_create` と、別の session から旧名への改名は拒否（改名した session 自身が旧名へ戻す改名は、その記録が改名元のものなので許す: pm1 → pm2 → pm1）。(b) 削除済み session の記録が残る名前への改名も拒否。許す: `session_delete` 後に**同じ名前で `session_create`** した時は、その名前の記録を続きとして引き継ぐ（旧 cap を使う。従来どおり）。
  - 名前を変えると remote-control 名・messenger の peer 名・ログ名（`<name>.log`）・statusLine の URL も新しい名前になる。旧名前宛ての messenger 通知は届かない。
- `session_delete`: `session_create` で作ったものだけ。remote-control を停止（SIGTERM → `stopGraceMs` 後 SIGKILL）して監視と保存から外す。path は消さない。config 由来の project は拒否。
- `session_list`: config の project と session の全部。`source` が `config` / `session`。`instructions`（真偽。その session を起動した時に `--append-system-prompt`（session の `instructions`）を付けたか。本文は出さない。`rc_status` の `instructions` と同じで、`rc_status` の `args` でも値は `<N 文字>` に伏せる）が付く。`contextUsage`（`{ usedTokens, windowTokens, percent, updatedAt, model? }`。`model` は statusLine 由来の時だけ。まだ分からない時は `null`）が付く。取得の仕組みは「context 使用量」。
- プロジェクト設定（`settings`、設計は `docs/design/project-settings.md`）: session ごとの設定。`{ instructions?: string, addDirs?: string[], outputStyle?: string, servers?: string[], … }`。外部記憶は含まれない（下記「外部記憶の設定」）。`servers` は下記「session ごとの使う server（servers）」。`addDirs` は master-cap が参照してよいフォルダ（center のホスト上の絶対パス、20 個以内、重複は除く）で、起動のたびに 1 つずつ `claude --add-dir <path>` で渡す（空配列は削除と同じ）。`session_create` の `settings` で作成時に渡し、`session_settings_get` で読み、`session_settings_update` でマージ更新する（`settings` に書いた項目だけ変わる・省略した項目は変わらない・`null` で項目を削除・未知の項目は保持して返す）。`sessions.json` の各 session の `settings` に保存する。config 由来の project は更新できない（get は `{}`）。更新は次の起動から効く（動いている session は起動し直さない）。
- `settings.instructions`（追加指示、16000 文字以内、空文字は削除と同じ）: session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動・center 再起動後の復元）に、値があれば claude へ `--append-system-prompt <値>` を足す。argv の 1 引数で渡し、shell は通さない（複数行・引用符・`$` もそのまま届く）。center の config（`center.json`）の `remoteControl.sessionInstructions` は廃止: 残っていても無視し、起動時の読み込みで `center.log` に warning を 1 行出す（値は出さない）。
- `settings.outputStyle`（claude の output style の本文、32000 文字以内、空文字は削除と同じ。`src/output-style.ts`）: session を起動するたびに、値があれば session のフォルダ（`path`）の `.claude/output-styles/bantou.md` に書き（frontmatter の `name` は center が `bantou` に差し替え、`description` / `keep-coding-instructions` など他の key は残す。frontmatter が無ければ name と description を付ける）、`--settings` の JSON に `"outputStyle":"bantou"` を足す（statusLine / hooks と同じ JSON。MCP 窓口が無い stdio でも付ける）。値が無ければファイルを消し `outputStyle` を付けない。書けない時は `center.log` に出して style 無しで起動する。session の値があれば center 共通の値は使わない（1 つしか選べないので連結しない）。2026-11-11 に足した（実測: project の `.claude/output-styles/` の style は `--settings {"outputStyle":<name>}` で選べる）。
- **外部記憶（memory）と追加の MCP の server（mcpServers）は center を起動した所だけが読み書きする**: 起動元は、desktop が sidecar を起動する時に渡す鍵（環境変数 `BANTOU_CENTER_LAUNCHER_KEY`。起動ごとの乱数）を header `X-Bantou-Launcher` に付けて `/mcp` を呼んだ MCP session（`src/launcher.ts`。比較は定時間。center は起動の最初に鍵を env から消し、login shell・claude の解決・session などどの子 process にも渡さない。desktop は sidecar が止まった時・自分で落ちた時に鍵を送るのをやめる）と、stdio の起動元。起動元は `session_create` の `settings`・`session_settings_update`・`center_settings_update` で `memory` / `mcpServers` を書け、`session_settings_get` / `center_settings_get` と update の応答で読める（`center_settings_get` / `center_settings_update` / `center_info` の `launcher: true`）。起動元でない呼び出し元（別 host の center に繋いでいる desktop・web・鍵の無い他の MCP client）は、含めると（`null` も）error「…center を起動した所…でだけ変えられる…」を返して他の項目も保存せず、読みの応答から 2 つを除く（`launcher: false`）。旧設定の項目（`mcp`・`mcpConnections`・`mcpSecrets`・`coordinator`）は誰からも受けない。master-cap の session 向け窓口 `/mcp/session` には設定の tool 自体が無い。置き場は普通の設定（下記「外部記憶の設定」「追加の MCP の server」）。
- 外部記憶（設定の `memory`。設計は `docs/design/external-memory.md`）: 普通の MCP の設定（Claude Code の mcp.json の `mcpServers` の値）1 件。例 `{ "type": "http", "url": "https://memory.example/mcp", "headers": { "Authorization": "Bearer <値>" } }`。stdio・sse なども書ける。値があれば session を起動するたびに `--mcp-config` の `mcpServers` に `memory` として足し（`bantou-messenger` / `bantou` と並ぶ。tool は `mcp__memory__*`）、system-instructions に部品 `memory@1` を付ける。url の server で `X-Agent-Id` を書いていなければ session 名を足す。書いた項目はそのまま渡すが、`headers` と `env` の値（`${…}` を含まない物）は `${BANTOU_MEMORY_SECRET_n}` の参照に置き換えて実値は claude の環境変数だけで渡す（claude が展開するので server へ届く値は書いた値と同じ。argv・log・status・`session_list` に値を出さないため）。session の値があれば center 共通の値は使わない（`outputStyle` と同じ。項目ごとの合成はしない）。memory（mcp-config の `memory` と `memory@1`）は session_create で作った session（wrapper 経由）にだけ付き、config の `projects` を従来の `claude remote-control` で起動する rc 直起動には付かない。反映は次の起動から。旧形式 `{ url, token?, agentId? }` は `{ type: "http", url, headers: { Authorization: "Bearer <token>", "X-Agent-Id": <agentId> } }` として読む（起動時に設定も書き換える）。
- 外部記憶への書き込み（`src/memory-events.ts`、設計は `docs/design/external-memory.md` の「書き込み」）: 外部記憶の設定（session の値か共通の値）がある session について、center が MCP client（Streamable HTTP。設定の `headers` をそのまま付ける（`${VAR}` は center の環境変数で展開）。`X-Agent-Id` は設定の値か session 名）として memory の `event` tool を呼ぶ。center が書けるのは `type: "http"` の外部記憶だけ（stdio・sse などは session の道具としてだけ載り、center からの書き込みはしない。log に 1 度出す）。LLM での抽出・要約はしない。**master-cap の記憶**（agent = session）に書くもの: 利用者の発言（hook `UserPromptSubmit` の `prompt` → `user_prompt`）、master-cap の応答（hook `Stop` の `last_assistant_message` → `assistant_message`。`StopFailure` は error 文なので使わない。transcript・pty の text は読まない）。hook は center が activity 用に全 session へ既に付けているもの（`/sessions/<name>/hook`）を使い回し、memory のために hook は増えない。送信は非同期（キューと body 整形は `src/memory.ts`。Node 固有の digest（sha256）と MCP client は `src/memory-events.ts` が注入する）で、hook の処理（`onHook`）はキューに積むだけで即 return する（memory の応答を待たない）。キューは session（+ memory の url / agentId）ごとの FIFO: 順序保持、失敗は 1s から倍々で最大 60s の backoff で再試行、1000 件を超えたら古い分から捨てて log、memory が `isError`（入力検証違反）で返したものは log して捨てる。memory が落ちていても session の起動・hook・remote は今までどおり動く。log は `eventId` と理由のみ（本文・token・url は出さない）。eventId は `c1:<session>:<種別>:<部品…>`（128 文字以内。長ければ末尾を digest）: 発言は `u|a:<prompt_id か ->:<hook の発火時刻 ms>:<本文の digest8>`。同じ hook 呼び出し・同じ通知の再送は同じ id（memory が `duplicate` で弾く）、同じ内容の別の発言は発火時刻（と prompt_id）が違うので別の id。body は NUL を除き 65536 文字で切る（切ったら末尾に `…[truncated]`）。`at` は hook の発火時刻で、未来すぎれば受けた時刻。session の改名で agentId 未設定の X-Agent-Id は変わる。cap の記憶（agent = cap_id）は書かない。server も書かない（理由: 今の目的は master-cap の記憶で、cap の記憶は抽出 LLM の呼び出しを増やすだけ。将来 cap の記憶が要る時に足す）。center の hook 記録は呼ぶ時点の live な memory 設定を引くため、動いている session でも設定の追加・解除が次の hook から反映される（`--mcp-config` の memory は次の起動から）。
- システム埋め込み指示（`src/system-instructions.ts`、設計は `docs/design/system-instructions.md`）: master-cap の起動のたびに `--append-system-prompt` の先頭に付ける bantou 側の決まり文（今は `master-cap-role@1`: 自分では作業せず cap に指示を出す運用、`master-cap-availability@1`: 常に利用者の指示を受けられる状態で働き、時間のかかる作業は cap かローカルのサブエージェント / background に預ける）。利用者の追加指示とは別管理で、設定画面には出さない。部品は id と version を持ち、起動した session の status の `systemInstructions` と `center_info.systemInstructions` で分かる。部品 `memory@1`（外部記憶の設定がある session だけに付く。起動時と判断の前に context / recall を呼ぶ。書き込みは bantou が自動で渡す）は `when` で条件付き。memory 無しの session は従来と同じ出力。`--no-chrome` は付けない（2026-11-04 に外した。Chrome 拡張の確認が出た時はターミナルから答える）。
- center 共通の設定（`center_settings_get` / `center_settings_update`）: 全 session に効く設定で、形は session の `settings` と同じ（`{ instructions?: string, addDirs?: string[], outputStyle?: string, … }`、instructions は 16000 文字以内、未知の項目は保持。`servers` は無い＝session の設定だけ。null 以外を渡すと error「servers は center 共通の設定では持てない…」で、他の項目も保存しない。`servers: null` は無害。`center-settings.json` に `servers` が残っていても読み捨て、次の保存で消える）。`outputStyle` は session に無い時だけ全 session に効く（session の値が優先。連結しない）。`addDirs` は全 session の `--add-dir` に 1 つずつ付き（共通が先）、session 自身の `addDirs` はその後ろ（重複は除く）。`instructions` は全 session の `--append-system-prompt` の値の先頭に付き、session 自身の `instructions` は空行 1 つを挟んでその後ろ（どちらも無ければ付けない）。config と同じ dir の `center-settings.json` に保存し（object 1 つ。壊れた・無いファイルは未設定として読む）、更新は保存済みの全 session に次の起動から効く（動いている session は起動し直さない）。`sessions.json` の各 session の `settings` には混ぜない。desktop の設定ダイアログ（ヘッダーの歯車）の「共通の追加指示」がこの tool で読み書きする。
- 保存: config と同じ dir の `sessions.json`（`name`, `path`, `permissionMode`, `settings`（あれば）, `createdAt`）。config の projects には書かない。center 起動時に復元して `--continue` で起動する。`--continue` で接続前に 30 秒以内に終了した場合（約 4 時間以内の記録が無い、など）は、素の起動へ fallback する（再起動回数は増やさない）。
- 新規 path の trust: **trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run `claude` in <path> first ...` で即 exit 1 する**（claude 2.1.312 で実測）。親 dir が trust 済みなら配下は通る（実測: trust 済みの repo 配下の dir で `connected`）。そのため、未 trust の path では `session_create` は `state: starting` と `lastError`（`接続前に終了: Error: Workspace not trusted...`）を返し、supervisor は再起動を繰り返して上限で `error` になる。対処は、workspace（または path の親）で一度 `claude` を起動して trust を承認しておくこと。center が claude の設定ファイルを書き換えて trust を付けることはしない（今は）。
- 同じ folder を別の `claude remote-control` が直前まで握っていると、`This folder is already served by a terminal \`claude remote-control\` on this device. Stop it first.` で約 1 分待たされて終了する（実測、直前の center を強制終了した後など）。

### 再ログイン（session の claude の認証切れ）

- 背景（2026-11-08 mac200 で実測）: claude は OAuth token を macOS の login keychain に保存・更新する。keychain がロックされると refresh を保存できず、token 切れ（約 8 時間）で全 session が `⏺ Please run /login · APIError: 401 OAuth access token has expired` になる。`claude auth status` は `loggedIn: true` のままで気付けない。
- 検知: supervisor は wrapper の text（ANSI 除去済み）を見て `RcStatus.auth` / `loginUrl` / `loginError` を更新する（`remote-control.ts` の `detectAuthEvent` / `findLoginUrl`）。文言は claude 2.1.319 のバイナリで確認: `Please run /login` → `login_required`、`Couldn't save your login` → `keychain_locked`、`Login successful` → `ok`、`Invalid code` → `loginError`。TUI の差分描画で text は空白が無く文字も一部落ちる（実測: `Could't ave yo login.IfyourMac'skeyhainislocked`）ので、空白を無視し字抜けを少し許して照合する（`fuzzyIndexOf`）。認証 URL は折返しの改行を除いて拾う。照合窓は直近 400 文字（URL は 2048 文字）で、一致したら捨てる（再描画で同じ文言が繰り返されても状態は一度だけ変わる）。
- 通知: `auth` / `loginUrl` / `loginError` が変わると `GET /events` に `{"reason":"changed","name"}` を流す。desktop はそれで `session_list` を取り直し、該当 session に「要再ログイン」/「keychain ロック中」を出す。
- `session_login`: Esc → `/login` → Enter（ログイン方法の先頭 = Claude account with subscription）を pty に打ち、`loginUrl` が付くまで待つ。`session_login_code`: コードを打ち、Enter は 300 ms 後に別送する（同じチャンクだと貼り付け扱いで Enter が落ちる。実測）。結果は `Login successful`（`ok: true`）/ `Invalid code` / `Couldn't save your login`（keychain ロック。ホストで解錠してから `session_login` からやり直す）。入力の間隔と待ち上限は `login.ts` の `DEFAULT_LOGIN_TIMINGS`。
- 認証 URL を開くのは利用者の手元: desktop（普段使いの Mac）が `loginUrl` をその Mac のブラウザで開く。center の host（別 host でもよい）ではブラウザを開かない。claude が center の host で自動起動を試みても、URL は claude の text に出るので center はそれを拾うだけで、起動の成否は流れに影響しない（無視してよい。ただし binary の文字列からの判断で、`/login` の実機・macOS では未確認）。center は claude のブラウザ起動を抑える設定を入れていない（調査と根拠: `docs/history/20261110-1658-relogin-local-browser/report.md`）。コードの入力は desktop で行い、`session_login_code` で claude に渡す。
- 認証は同じホストの全 session で共有だが、他の session が新しい token を拾い直すかは未確認。desktop の再ログイン画面から `rc_stop` → `rc_start { resume: true }` で session を再起動できる。

### remote（B）

- **原則（2026-11-04 に改訂）: cap は session × server に 1 つ**（session = master-cap と cap は 1 対 1）。作業が何であれ、center はその session の cap に次の指示を送る（作業ごとに cap を作らない）。記録は「session × server の cap」単位で、`remote_id` = cap_id、`session` を持つ。以下の「server ごとに 1 つ」「center ごとに固定の cap_id」はこの原則に読み替える。他の session の cap とその指示・結果は見えない・触れない。
- **境界**: 「他 session から見えない・触れない」を保証するのは `/mcp/session`（session ごとの使い捨て token + `X-Bantou-Session` の照合）だけ。外向け `/mcp`（center token。desktop 用）の `remote_list` / `remote_wait` / `worker_reply` は owner を自己申告でき、省略で全件。desktop は全件を取って client 側で選択中 session に絞る。
- **session を消しても cap は残る**: `session_delete` は cap の記録・server の cap・worker に触れない（通知は届かず失敗ログのみ）。同名の session を作り直すと同じ cap_id で旧 cap を引き継ぐ。
- **既知の制約**: server の FS が大文字小文字を区別しない（macOS など）と、session `Main` と `main` の cap が同じ dir になりうる。
- `remote_wait`: `remote_id`（と `server`）の cap が上の意味で idle・worker 無しになるまで待って記録を返す。`remote_id` と `server` を省略した時は、owner（session）の cap のうち未完了の指示があるもののどれか（最初に終わったもの）。他の session の cap は `remote_id` を指定しても待てない。timeout は `state: "running"` のまま。待ち中に cap が delete されたら error。
- **owner**（呼んだ master-cap の識別）: http では header `X-Bantou-Session: <session 名>`（または URL query `?session=<名>`）があればそれ、無ければ tool 引数 `owner`。優先順は header > query > 引数。`remote_send` はどれも無ければ error。session 向け窓口（`/mcp/session`）の tool は呼び出し元 session の cap だけが対象（引数 `owner` は受けない）。外向け `remote_list` / `remote_wait` は分からなければ絞らない。stdio には header が無いので引数のみ。
  - **今は**: master-cap 側に header 付きの接続を自動で持たせる仕組みは入れていない。理由: `claude remote-control` は `--mcp-config` / `--settings` を受けず（remote-control の前の global flag は spawn した session に引き継がれない）、`~/.claude.json` の書換えはユーザー設定の変更、`.mcp.json` の配置は承認プロンプト・未 trust・token 平文の問題がある。そのため、master-cap が center に繋ぐ MCP 設定（header 付き）を用意する側（番頭など）が `X-Bantou-Session` を付けるか、master-cap が `owner` 引数を渡す。
  - owner は自己申告で、認証はしない（Bearer token は center 全体で 1 つ）。

## session ごとの使う server（servers）

- 除外設定（center 全体で server を外す `servers.exclude`）は**作らない**（利用者の指示）。代わりに、session ごとに「使う server の範囲」をプロジェクト設定（`settings`、`docs/design/project-settings.md`）の `servers` に持つ。center 共通の設定（`center_settings_*`）には置けない（session の設定だけ）。
- 値: server の名前の文字列の配列（50 個以内、重複は除く）。
- **未設定と空配列**: 未設定（`null` で削除、または項目なし）= 範囲を絞らない（全部）。**空配列 `[]` = どの server も使わない**（保存する。`addDirs` の空配列が削除と同じなのとは違う。使わない session を作れるようにするため、未設定と区別する）。
- **合成**: session の `servers` だけを見る（center 共通の設定は見ない）。無ければ全部。`servers: []` は「使わない」。- **効き方**: `remote_send` / `remote_create`（server 省略時は範囲内の先頭を宛先にする。明示指定が範囲外ならエラー）、`worker_reply`（server 省略時は範囲内の cap だけが候補、明示指定が範囲外ならエラー）。エラー文は `この session の servers に無い: <server>（session=<名>, servers=[…]）`。範囲内に使える server が無ければ `この session の servers に無い: 使える server が無い（…）`。設定の更新は**次の呼び出しからすぐ効く**（`instructions` / `addDirs` と違い、起動し直し不要）。owner の無い呼び出し（desktop の `center_call`）は範囲の影響を受けない。
- **置き場**: session の `servers` は center の状態 dir の `sessions.json` の各 session の `settings.servers` にある（`session_settings_get` / `session_settings_update`、desktop の session 設定ダイアログで読み書きする）。center 共通の `center-settings.json` には持たない。**config の `servers[]`（`config.json` の server の接続・`model` / `workerModel` の設定）とは別物**で、名前が同じだけ。
- **master-cap への知らせ**: 起動時は指示文の部品 `master-cap-role` に「使う server の範囲」の節を出す（範囲の指定がある時だけ。範囲が変わったら部品の version を上げる）。範囲を変えた時（`session_settings_update`）は、その session の master-cap へ messenger の push で新旧の範囲を知らせる（指示文への反映は次の起動）。`remote_list` は範囲の指定がある時、配列の先頭に `{ scope: { servers, out_of_scope_caps, note } }` を 1 件足す。`remote_send` / `worker_reply` / `remote_stop` / `remote_list` の道具の説明にも範囲を書く。
- **一覧**: `remote_list`（session 向け）は、範囲の指定がある時、範囲外の server の cap を**既定で出さない**（`include_out_of_scope: true` で出す。他の session の cap はどちらでも出ない）。`task_status` と外向けの `remote_list`（`/mcp`）は範囲で絞らない。desktop の session 画面は今までどおり。center 設定画面の server 一覧は center 全体の全 server を出す。
- **server が見つからない時**: 候補は範囲内の server だけ（`server が見つからない: <指定>（範囲内の候補: …）`）。範囲が 1 つなら `remote_send` は `server` を省ける。
- **互換**: `servers` の無い旧形式の settings は未設定（全部）として読む。壊れた値（配列でない）も未設定として読み、全 server を止めない。

## claude の解決

`remoteControl.claude` 未指定なら、center 起動時に次の順で解決する（GUI 起動の app は PATH が最小のため）。

1. `$SHELL -lc 'command -v claude'`（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り）。最終の非空行が実在する実行可能な絶対パスなら採用（`login-shell`）
2. `~/.local/bin/claude`、`/opt/homebrew/bin/claude` の順に実在・実行可能なものを採用（`fallback-path`）
3. どれも無ければ PATH 任せの `claude`（`PATH`）。警告をログに出す

`remoteControl.claude` 指定時はそのまま使う（`config`、検証しない）。結果はログと `rc_status` / `rc_list` の `claude` に出る。

## PATH の補完

GUI 起動の app（macOS の bantou.app の sidecar）は PATH が `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、bun / node / npx / gh や MCP の `npx` が見つからない。center は起動時に 1 回 PATH を合成して自身の `process.env.PATH` に入れる。session と remote-control の子プロセスはこれを継承する。macOS / Linux のみ（他 OS は変えない）。

1. `$SHELL -lc` で login shell の PATH を取る（`SHELL` 未設定は `/bin/sh`、5 秒で打ち切り、1 回だけ）。rc ファイルが余計な行を出しても、目印（`__BANTOU_PATH_BEGIN__`〜`__BANTOU_PATH_END__`）の間だけを採る。絶対パスでない要素は捨てる
2. 取れた時: login shell の PATH → 現在の PATH → 固定候補のうち存在して未掲載のもの、の順
3. 取れなかった時（失敗・タイムアウト・目印なし）: 固定候補のうち存在するもの → 現在の PATH、の順。理由はログに出す
4. 重複は先に出た方を残す。空の要素は捨てる

固定候補（存在するものだけ。この順）: macOS は `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`、`/opt/homebrew/opt/rustup/bin`（Homebrew の rustup は cargo / rustc の proxy を `~/.cargo/bin` ではなくここに置く）、`~/.bun/bin`。Linux は `~/.local/bin`、`~/.cargo/bin`、`~/.bun/bin`。

config の `env.PATH` は補完より優先する（`project.env` > `remoteControl.env` > 補完後の PATH。値はそのまま渡し、補わない）。結果の PATH と取得元（`login-shell` / `fixed-list`）は center のログに出る。

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

## 外部記憶の設定

外部記憶（memory）は普通の設定の項目 `memory` に、普通の MCP の設定（Claude Code の mcp.json の `mcpServers` の値）1 件で持つ。追加の MCP の server（下）とは別の項目（一覧に混ぜない）。

- **全 session 共通**: center 共通の設定（状態 dir の `center-settings.json`）の `memory`。
- **session ごと**: その session の設定（`sessions.json` の、その session の `settings.memory`）。あれば共通の値は使わない。config の `projects` 由来の session（`sessions.json` に記録が無い）の値は、center 共通の設定の `projectMemory`（session 名 → 設定）に持つ（`bantou-center memory --session` と移行と file の直接の編集で書く。設定の更新（MCP）では書けず、起動元以外の読みには出ない）。
- 書ける項目は MCP の server と同じ（type・url・headers（`Authorization: Bearer <値>` などそのまま）・stdio の command・args・env など）。claude が起動できない形（stdio の command 無し・url の type の url 無し・args が文字列の配列でない等）だけ断る。
- **設定する所**: center を起動した所。desktop の sidecar の center なら、その desktop の設定の画面（歯車の「全 session 共通の設定」と、session の歯車のプロジェクト設定）の「外部記憶」欄に JSON で書く（`{ "mcpServers": { "<名前>": {...} } }` の 1 件を貼ってもよい）。別 host の center に繋いでいる desktop と web には欄が出ず、書けない。center を動かしている host で上の file を直接書いてもよい（center は呼び出しの度に file を読むので再起動は要らない。center の保存は file の今の値に重ねて書くので、直接の書き換えを巻き戻さない）。
- 次に起動する session から効く（動いている session の `--mcp-config` は変わらない。center からの書き込み先は次の hook から変わる）。

```bash
bantou-center memory get   [--config <path>] [--session <name>]
bantou-center memory set   [--config <path>] [--session <name>] (--json-stdin | --json-file <path>)
bantou-center memory set   [--config <path>] [--session <name>] --url <url> [--agent-id <id>] [--token-stdin | --token-file <path> | --clear-token]
bantou-center memory unset [--config <path>] [--session <name>]
```

- CLI は上の 2 つの file の `memory` を書く（`--session` を省略すると共通、付けると session_create で作ったその session か、config の projects 由来の session（`projectMemory`）。どちらにも無い名前は断る）。書く直前に file を読み直し、その項目だけを変えて一時 file → rename で書く（center の保存と重なっても他の記録を巻き戻さない）。`--json-*` は MCP の server の設定 1 件（`{ "mcpServers": { "<名前>": {...} } }` の 1 件も可）。`--url` の形は `{ type: "http", url, headers: { Authorization: "Bearer <token>", "X-Agent-Id": <id> } }` を書く（token は引数に書けない。`--token-stdin` か `--token-file`。指定が無ければ今の `Authorization` を残し、`--clear-token` で消す）。`get` は設定を JSON で出す。
- **desktop 同梱の center を使う人**: 同梱の center の状態 dir は `~/.local/share/bantou/` なので、CLI には `--config ~/.local/share/bantou/center.json` を付ける（通常は設定の画面で足りる）。
- **旧設定からの移行**（起動時に自動。冪等）: `memory-settings.json`（0.1.56 までの `bantou-center memory` が書いた `{ url, token, agentId }`）は、設定に `memory` が無い範囲（共通・session）へ `{ type: "http", url, headers: { Authorization: "Bearer <token>", "X-Agent-Id": <agentId> } }` として移し、保存できたら `memory-settings.json.migrated` に退ける（設定にある物が勝つ。config の projects 由来の session の値は共通の設定の `projectMemory` へ移す。どちらでもない session の値は移さず、file にはその分だけを残し（移せた分は file から除くので、画面などで消した値が次の起動で戻らない）、その session にだけ file の値を使い続け、名前を log に出す）。設定の `memory` に残っていた旧形式も同じ形に書き換える。保存できなければ file を残し、その起動の間は file の値も使う（次の起動でやり直す）。値は log に出さない。

## 追加の MCP の server（設定の `mcpServers`）

session の起動の `--mcp-config` に、bantou 自身の MCP のほかに**追加の MCP の server**を載せられる。書き方は Claude Code の mcp.json の `mcpServers` と同じ（名前 → 設定）。

- **全 session 共通**: center 共通の設定（状態 dir の `center-settings.json`）の `mcpServers`。全 session の起動に載る。
- **session ごと**: その session の設定（状態 dir の `sessions.json` の、その session の `settings.mcpServers`）。その session の起動にだけ載る。共通と同じ名前を書くとその session ではそれで置き換え（項目を混ぜない）、`null` を書くと共通の server をその session では外す。
- **設定する所**: center を起動した所。desktop の sidecar の center なら、その desktop の設定の画面（「全 session 共通の設定」と session の歯車のプロジェクト設定）の「追加の MCP の server」欄に `{ "mcpServers": { ... } }` を書く（mcp.json から貼れる）。保存は 1 回で、開き直すと書いた値（header の値も）がそのまま出る。別 host の center に繋いでいる desktop と web には欄が出ず、書けない（center も断る。上記「起動元」）。center を動かしている host で上の 2 つの file を直接書いてもよい（center は呼び出しの度に file を読むので再起動は要らず、次に起動する session から載る。動いている session の `--mcp-config` は変わらない。center の保存は file の今の値に重ねて書くので、直接の書き換えを巻き戻さない。ただし取り込みから保存（一時 file → rename）までのごく短い間に file を書き換えると、その書き換えは失われる）。file が壊れて読めない間は割り当て無し（何も載せない）。**障害時の挙動**: `center-settings.json` が消えると共通の server は空になり、`sessions.json` が壊れて読めない間は全 session の割り当て（統括の道具を含む）が外れる（直せば次の呼び出しから戻る）。

```jsonc
// center-settings.json（全 session 共通）
{
  "mcpServers": {
    "tools": { "command": "npx", "args": ["-y", "@example/tools-mcp"], "env": { "TOOLS_KEY": "<値>" } },
    "web": { "type": "http", "url": "https://tools.example/mcp", "headers": { "Authorization": "Bearer <値>" } }
  }
}
// sessions.json の session の settings（その session だけ）
{ "settings": { "mcpServers": { "web": null, "bantou-coordinator": { "type": "http", "url": "http://127.0.0.1:7911/mcp", "headers": { "Authorization": "Bearer <coordinator-mcp.json の key>" } } } } }
```

- **書ける項目**: Claude Code の mcp.json に書ける物すべて。stdio（`type` 無しか `"stdio"`。`command`・`args`・`env`）、http / sse など（`type`・`url`・`headers`）、他の項目も書いたまま claude に渡す。断るのは claude が起動できない形（stdio の `command` 無し、url の type の `url` 無し、`args` が文字列の配列でない、`env` / `headers` の値が文字列でない）と、名前が英数字と `_` `-` 以外・center が組み立てる名前（`bantou`・`bantou-messenger`・`memory`。外部記憶は設定の `memory` に書く）・共通の設定の `null` だけ（誤りの文に値は出さない）。
- **値の渡し方**: `headers` と `env` の値（`${…}` を含まない物）は、`--mcp-config` には `${BANTOU_MCP_SECRET_n}` の参照を書き、実値はその session の claude の環境変数にだけ渡す（claude が起動時に展開するので、server へ届く値は書いた値と同じ。argv（ps）・status・log に値を出さないため）。`${…}` を含む値は利用者が環境変数を指したものとしてそのまま渡す。他の session の server の値はその session の環境に入らない。載せた server には `permissions.allow` の `mcp__<名前>__*` を足す。
- **統括の道具（`session_brief`・`coordinator_session_create`）を session に足す**: 独立した MCP の server（http。`bantou-center coordinator-mcp`）が出す。その server を設定に書いた session だけで使える。書き方は他の MCP の server と同じ普通の 1 項目（`type: "http"`・`url`・`headers`）を、その session の設定の `mcpServers` に書く（上の `bantou-coordinator`。名前は自由）。claude の側の道具名は `mcp__<書いた名前>__session_brief` と `mcp__<書いた名前>__coordinator_session_create`。
  - **起動と port**: center が http で待ち受ける時に子 process として起動する（center が止まれば止まり、落ちたら間を置いて再起動する。stdio の center では起動しない）。待ち受けは `127.0.0.1`。状態 dir の `coordinator-mcp.json`（mode 0600。`{ "port": <初回に選んだ空き port>, "key": "<乱数>" }`）に初回だけ作り、以後は変わらない（url が起動のたびに変わらない。同じ host の 2 台目の center は別の port を選ぶ）。port を変える時はこの file の `port` を書き換えて center を再起動し、設定の項目の `url` も合わせる。port が使われていて起動できない時は log に出て再起動を試す。
  - **書く 1 項目の取り方**: `bantou-center coordinator-mcp show`（`--state-dir` で状態 dir を指定）が `{ "bantou-coordinator": { "type": "http", "url": "http://127.0.0.1:7911/mcp", "headers": { "Authorization": "Bearer <key>" } } }` を出す。これを貼る。key は書いていない session には渡らない。
  - **呼び手の確認**: 設定の `headers` の `Authorization: Bearer <key>` を server が定時間で照合する。無い・違う呼び手は 401（道具の一覧も出ない）。`Host` は自分宛だけ、`/mcp` の POST だけ受ける。key は center の token・session の token とは別物。
  - **center への経路**: server は center の外向けの窓口 `/mcp` を center の token（子の環境変数で渡す。argv・log・設定に出ない）で呼び、`session_list` と `session_create` だけを使う（`path` は渡さないので作業 dir は center の workspace の下だけ）。
  - 外す時は、その項目を設定から消す（または session の設定で `null`）。次に起動する session から道具が出ない。key が漏れた時は `coordinator-mcp.json` を消して center を再起動すると作り直されるので、設定の項目の `headers` も書き換える。
- **旧設定の書き方は無い**: 0.1.57 までの `{ "transport": "builtin", "builtin": "coordinator" }` と、`auth.env` を持つ `{ "transport": "http", … }` は設定に書けない（断る）。center が起動時に、設定にある物を普通の書き方へ移す（下の「旧設定からの移行」）。旧来の `bantou-center mcp secret set` の鍵（`auth.secret`）は `${BANTOU_MCP_SECRET_n}` で渡す。center の環境の `BANTOU_MCP_KEY_*` はどの session の子にも継承させない。claude に直接渡せない設定（`toolPrefix`・`tools.allow`・`role`）の旧形式の接続は載せない（log に名前と理由）。session の設定の旧形式の上書き（`{ "url": … }` など、type も command も無い物）は項目ごとに共通に重なる。
- **旧設定からの移行**（起動時に自動。冪等）: 旧 `center-settings.json` の `coordinator.session` は、その session の設定の `mcpServers` の `bantou-coordinator`（上の普通の 1 項目）に移して旧項目を消す。設定にある `{ "transport": "builtin", "builtin": "coordinator" }` も同じ 1 項目へ、`auth.env` を持つ `{ "transport": "http", … }` は `{ "type": "http", "url", "headers" }` へ書き換える（鍵は center の環境の `auth.env` の値を、`auth.header` / `auth.format` の形で `headers` に書く）。移せない物（`toolPrefix`・`tools`・`role` を持つ、環境変数が無い、統括の server の設定が無い 等）は書き換えず、log に `移行失敗: …`（名前と理由だけ。値は出さない）を出す。`mcp-connections.json`（下の CLI が書いていた file）の内容は、共通は `center-settings.json`、session ごとはその session の設定へ追記して（同じ名前が設定にあれば設定が勝つ）、file を `mcp-connections.json.migrated` に退ける。session が `session_create` で作った物の中に無い（config 由来・削除済み）等で移せない物は、旧設定を残して log に `移行失敗: …` を出し、次の起動で再度試す。

## MCP の接続の CLI（`bantou-center mcp`）

旧設定の CLI。接続・鍵・試す結果を扱う。**接続と割り当ての正本は上の普通の設定**（`mcpServers`）で、この CLI の `set` / `unset` が書く `mcp-connections.json` は旧設定（center の起動時に普通の設定へ移される）。統括の口（`bantou-coordinator`）の割り当てはこの CLI では書けない。`mcp secret`・`mcp test`・`mcp list` はこれからも使える（`list` は普通の MCP の設定の server を名前と type だけで出す）。この CLI の file は画面（desktop・web）と MCP からは読み書きできない（設定の更新に `mcp` などの項目が来ると断る）。

保存先は center の状態 dir（`--config` の dir）。`mcp-connections.json`（旧設定。秘密を含まない）、`mcp-secrets.json`（鍵。別 file）、`mcp-status.json`（最後に試した結果。秘密を含まない）。どれも mode 0600、状態 dir は新しく作る時 0700。書くのは `bantou-center mcp` だけ（一時 file → rename）。

```bash
bantou-center mcp list  [--config <path>] [--session <name>]
bantou-center mcp get   <名前> [--config <path>] [--session <name>]
bantou-center mcp set   <名前> [--config <path>] [--session <name>] [--url <url>] [--auth-header <名前>] [--auth-format <形>] [--secret <鍵の名前>] [--no-auth]
        [--header <名前>=<値>]... [--clear-headers] [--identity-header <名前>] [--identity <値>] [--no-identity]
        [--tool-prefix <前置き> | --no-tool-prefix] [--allow <道具>]... [--deny <道具>]... [--clear-tools]
        [--role memory | --no-role] [--expose-memory-write | --no-expose-memory-write] [--timeout-ms <n>] [--allow-plain-http] [--off]
bantou-center mcp unset <名前> [--config <path>] [--session <name>]
bantou-center mcp secret set <鍵の名前> (--stdin | --file <path>) [--config <path>]
bantou-center mcp secret unset <鍵の名前> | secret list
bantou-center mcp test  <名前> [--config <path>] [--session <name>] [--json]
```

- 名前は `[a-z0-9][a-z0-9_-]{0,31}`。`bantou`・`bantou-messenger`・`mcp`・`conn` は予約。`--session` を省くと全 session 共通、付けると項目ごとの上書き（`--off` はその session では付けない）。
- 鍵は引数に書けない（`--value` などは値を出さずに断る）。`printf %s "$KEY" | bantou-center mcp secret set relay --stdin`。接続は `--secret <鍵の名前>`（省略時は接続の名前）で鍵を指し、複数の接続で 1 本を共有できる。`list` / `get` は鍵の値を出さず、設定済みか（rev）だけ出す。
- 検証: url は http / https の絶対 URL（空白・`${`・`user:pass@`・鍵らしい query 名は不可。鍵を付ける接続で `http:` の公の host は `--allow-plain-http` が要る）、`--auth-format` は `{secret}` をちょうど 1 つ、固定の header は 10 個まで（鍵らしい名前・鍵や識別と同じ名前は不可）、役割 `memory` は合成後に 1 つまで。不正なら exit 2 で何も書かない。
- `test` は `initialize` → `tools/list` で道具の一覧が取れるかを確かめ（道具は呼ばない）、分類（`ok` / `unreachable` / `timeout` / `auth` / `not-found` / `protocol` / `config-error`）・HTTP status・道具の数・session に見える名前を出して `mcp-status.json` に残す。終了 code は 0 = 取れた、1 = 取れない、2 = 使い方の誤り。command を動かした host から接続する。
- center が動いている間に変えてよい。同梱の center を使う人は `memory` と同じく `--config ~/.local/share/bantou/center.json` を付ける。

## 開発

```bash
cd packages/center
npm run typecheck
npm run build
npm test          # node:test。ネットワーク・claude・実 server は不要
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

- stub の remote-control（確認プロンプトを出し、stdin の `y` を受けてから `Connected` を出す node スクリプト）と、本物の server（`packages/server/` を `tsx` で起動）を使う。
- 一時ディレクトリは `E2E_ROOT`（既定は OS の tmp）の下に作り、終了時に消す。
- 確認内容: tool 一覧、`rc_start` → `connected`、stub の異常終了 → `--continue` 付き再起動、`rc_stop`、`server_list`、stdin EOF での自己終了。

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

## 作業状態（activity）

session（`session_create` で作った wrapper 経由の claude。config 由来の project は対象外）ごとの作業状態を `session_list` の `activity` に載せる。`src/session-activity.ts`。pty 出力の文字列解析はしない。

- `session_list` の各要素: `"activity": "working" | "needs-input" | "idle" | "unknown"`、`"activityAt": "<ISO>" | null`（最後に状態が変わった時刻。unknown は null）。既存の `state`（stopped / starting / connected / error）はそのまま。
  - cap（claude 本体）の状態。`working` = 本体が turn を実行中で利用者の入力に反応できない / `needs-input` = 利用者の返答待ち（permission の確認、AskUserQuestion、plan 承認） / `idle` = 待機（作業の進行の有無に左右されない。subagent や background が動いていても idle） / `unknown` = 不明（表示しない）。
  - `"background": { "subagents": n, "tasks": n }`: cap 本体とは別の軸。session の中で続いている subagent（`SubagentStart` ～ `SubagentStop`）と background の実行（shell / monitor / workflow など）の数。`activity` が idle でも 0 でなければ作業は進行中。取得元は `Stop` の `background_tasks`（公式: 「今 in-flight の task」の配列。`type` = shell / subagent / monitor / workflow / teammate …）と `SubagentStart` / `SubagentStop`。数え方: subagent の数の正本は、最後に届いた `background_tasks`（`Stop` と `SubagentStop` の payload。公式: 親 session 全体の in-flight）。`SubagentStart` / `SubagentStop` は agent_id 単位の補助で、snapshot より後の分だけを足す（snapshot が届くたびに空にする）。`SubagentStop` の payload に `background_tasks` が無い（古い）時だけ、その agent_id の `SubagentStart` を見ていた場合に限って 1 つ減らす。だから、Start の無い `SubagentStop`（内部 agent: prompt suggestions・`/btw`）は、動いている他の subagent の数を減らさない。`SubagentStart` だけで `SubagentStop` が来ない物（resume・teammate の message 処理）は、次の `Stop` / `SubagentStop` の snapshot で消える。snapshot に、いま終わった subagent 自身が（`id` が `agent_id` と違う形で）残る場合は、次の snapshot まで 1 つ多く数えうる。hook の設定は claude の起動時に `--settings` で渡す（`remote-control.ts`）ので、center を更新しても動いたままの session には `SubagentStart` / `SubagentStop` が来ない。その間も `Stop` の `background_tasks` は届くので、turn の終わりごとに作業進行中は分かる（turn の間に始まって終わった subagent は見えない。session を再起動すれば全 event が揃う）。
  subagent の中の hook（`agent_id` 付きの `PreToolUse` / `PostToolUse`）は cap 本体の状態を変えない（本体が待機の間に subagent が動いても cap は idle のまま）。subagent の許可待ち（`PermissionRequest`）だけは needs-input。
  - thread の ask（status `waiting`）は desktop 側の情報で center は持たないので、`activity` には含まない（desktop が needs-input として合成する）。
- 取得元は Claude Code の hooks。center は wrapper 経由の session を起動する時、statusLine と同じ `--settings` に `hooks` を足す（利用者の hooks は置き換わらず足し合わされる。`~/.claude/settings.json` / `~/.claude.json` は触らない）。hook のコマンドは center 自身のサブコマンド `bantou-center hook --url <center>/sessions/<name>/hook`。stdin の JSON に発火時刻（`bantou_ts`）を足して POST する。token は argv にも設定にも載せず、claude の env の `BANTOU_SESSION_TOKEN` から読む。失敗しても終了コードは 0（claude を止めない）。
- `POST /sessions/<name>/hook`: 認証は**その session の token**（外向け token・他の session の token・token 無しは 401）。本文は JSON object（壊れた JSON・object 以外は 400）。204。起動中（starting / connected）の session だけ反映する。
- event → 状態:

| event | 状態 |
| --- | --- |
| SessionStart（source が compact 以外） / Stop / StopFailure / Notification `idle_prompt` | idle（SessionStart では background も 0 に戻す。Stop は `background_tasks` で background を数え直す） |
| UserPromptSubmit / PreToolUse（下記以外の tool） / PostToolUse / PostToolUseFailure / PermissionDenied | working |
| PreToolUse（AskUserQuestion・ExitPlanMode） / PermissionRequest / Notification（`permission_prompt`・`elicitation_dialog`・`elicitation_url_dialog`・`agent_needs_input`） | needs-input |

  上記以外の event・Notification は状態を変えない。Stop / StopFailure の hook だけ同期（他は `async: true`。claude が Stop 直後に終了する -p では async の hook が cancel される）。
- 古い状態を残さない: 保持はメモリのみで、起動時刻（`startedAt`）ごと。session が停止・error・起動し直しになると `unknown`（token も起動ごとに作り直すので、前の claude の遅れた hook は 401）。center 再起動直後は、次の hook まで `unknown`。発火時刻が最後に反映した event より古い hook は捨てる（到着順の入れ替わり対策）。
- 変わった時だけ `GET /events` に `reason: "activity"` を流す（受け手は `session_list` を取り直す）。
- 限界（実機の対話モードでは未確認。公式 docs の記述からの整理）: 利用者が Esc で turn を中断した時、または permission の確認を利用者が拒否した時に発火する hook は、公式 docs（https://code.claude.com/docs/en/hooks、2026-11-10 確認）に見当たらない。`PermissionDenied` は auto mode が拒否した時だけで「手動で permission ダイアログを拒否した時は動かない」と書かれ、`PostToolUseFailure` は「permission denial では発火しない」「実行中 tool のキャンセルでは発火しない」と書かれ、`Stop` は「Claude が応答を終えた時」で Esc で発火するかは書かれていない。このため出口の hook は足していない（推測で足さない）。結果として、PermissionRequest 由来の **needs-input（判断待ち）が、利用者が拒否・中断した後も残り**、画面に「判断待ち」が出続けうる（実際は判断待ちでない）。working も Esc 中断で残りうる。次の hook（UserPromptSubmit など）か idle_prompt（約 1 分の入力待ち通知）が来れば戻る想定だが、これも未確認。時間切れで消す仕組みも足していない。
- background の限界: background の shell が終わっても、claude が起きて turn が走り次の `Stop` が来るまで `background.tasks` は減らない（完了時に単独で発火する公式の hook を使っていないため）。subagent の `SubagentStop` を取りこぼしても次の `Stop` で数え直す。
- 他の未確認: 発火時刻が同一ミリ秒の event は到着順になる。発火時刻が同一ミリ秒の event は到着順になる。PreToolUse / PostToolUse ごとに hook サブコマンドが 1 回起動する負荷は未計測。

## 未決

- B の owner を master-cap の接続に自動で載せる仕組み（上記「今は」の限界）。center が master-cap を起動する時に MCP 設定を渡せる手段が `claude remote-control` に無い。
- 未 trust の path の扱い（center が trust を付ける手段）。
- remote の長期運用（`running` のまま返信が失われた時の再同期。server の `status` と突き合わせる案）。
- session 削除後に claude.ai に残る remote-control の environment / session 表示は、CLI からは消せない（確認した範囲で手段を見つけていない）。

- 認証（center ↔ server）。desktop ↔ center は Bearer token（上記）。
- desktop からの起動と接続先の切り替え。
- 本物の `claude remote-control` での運用確認（出力形式の変化、`Connected` の検出、`--continue` の挙動）。e2e は stub のみ。

## master-cap の起動（wrapper）

- `session_create` の session は `bantou-pty-wrapper --cols N --rows N -- claude --remote-control <name> --permission-mode <m> --mcp-config '<JSON>' [--continue]` で起動する。wrapper は `dirname(process.execPath)/bantou-pty-wrapper`、env `BANTOU_PTY_WRAPPER` で上書き。config の `projects`（`rc_*`）は従来の `claude remote-control` のまま。supervisor は 1 つで、entry ごとに起動方式を選ぶ（再起動・`--continue`・素の起動への fallback・ログ・有効化確認への自動応答は共通）。
- `--mcp-config` の JSON には `bantou`（http、`/mcp/session`。窓口が無い時は付けない）と `bantou-messenger`（stdio、agent-messenger）が入る。`bantou-messenger` は `npx -y @unagents/messenger@0.12.2 mcp` を env `AGENT_MESSENGER_NAME=<session 名>-cap` で起動し、`<session 名>-cap` を messenger の peer 名にする（`claude --remote-control` の名前も同じ。project 名が `-cap` で終わる時は重ねない。内部の識別子（key・cap_id・log・memory の agent ID・X-Bantou-Session）は session 名のまま）。受信は Claude Code の inbox socket 経由で会話に現れる（pty への書き込みではない）。broker は client が env → config → UDP 発見で解決する（center は指名しない）。再起動・`--continue` でも同じ名前で登録し直す。center の子プロセスの PATH に `npx` が要る（center が起動時に PATH を補う。「PATH の補完」参照）。
- **permission（bantou 自身の MCP tool の許可）**: center は `--settings` に `permissions.allow` を足し、auto mode の分類器に止められないようにする。入れる rule は `mcp__bantou-messenger__*`（常に）、`mcp__bantou__*`（窓口がある時だけ）、`mcp__memory__*`（外部記憶がある session だけ）。書式は公式 docs（permissions の MCP 節）の `mcp__<server>__*`（server の全 tool）で、server 名は `--mcp-config` の entry 名と同じ。
  - 利用者の設定との関係: `permissions.allow` は他の scope の設定と**連結**される（公式 docs「Lists merge instead of overriding」）。利用者の allow は消えない。deny は全 scope の allow より先に評価される（公式 docs）ので、利用者が `mcp__bantou__remote_stop` などを deny していればそれが勝つ。center は deny を書かない。
  - config 由来の project（`claude remote-control` 直起動）は `--settings` も `--mcp-config` も渡さず bantou の MCP が付かないので、allow も付けない。
  - 実機で session に permission の確認が出なくなるかは未検証。
- wrapper との間は 1 行 1 JSON（wrapper の stdout: `started` / `output`（base64）/ `text`（制御文字を除いた文字列）/ `exit`、stdin: `input` / `resize` / `stop`）。session URL と接続状態は `text` の直近 16 KiB の窓に対して照合する（行単位ではない）。有効化確認への自動応答は `input`（`y\r`）。
- `--settings` で center の statusLine を渡す（引数の順は `--mcp-config` の後、`--continue` の前）。利用者の statusLine 設定より center のものが優先される（「context 使用量」の「statusLine 方式」）。
- 停止は wrapper へ `stop` を送って待ち、`stopGraceMs` 内に終わらなければ SIGKILL。

## core（出力の配信）

center プロセス内のモジュール（`src/core.ts`）。session ごとのキュー（チャンク ID は 1 からの連番、デコード後 8 MiB を超えたら古い分から捨てる、wrapper の再起動をまたいで続く）。外向け token で次を提供する。

- `GET /sessions/<name>/output`: SSE。続きは `Last-Event-ID` か `?after=<id>`。続きが残っていない / 指定なしは `event: reset` の後に積んである全部。各チャンクは `id: <id>` `event: output` `data: <base64>`。15 秒ごとに `: ka`。未知の session は 404。
- `POST /sessions/<name>/input` `{"data":"<base64>"}` → 204（実行中でなければ 409）。
- `POST /sessions/<name>/resize` `{"cols":N,"rows":N}` → 204。最後に送った側のサイズを覚え、次の wrapper 起動の初期値にする。

- `GET /events`: SSE（外向け token、イベント ID・再送なし）。接続時に `event: sessions` `data: {}`、session の追加・削除・起動時復帰・名前 / path の変更・認証状態の変化ごとに `event: sessions` `data: {"reason":"created"|"deleted"|"restored"|"updated"|"context"|"changed","name":"<name>"}`。15 秒ごとに `: ka`。`changed` = `auth` / `loginUrl` / `loginError` が変わった。受け取った側は `session_list` を取り直す。

## 添付画像

master-cap の claude は center のホストで動くので、画像は center のホストに置かれて初めて読める。desktop（sidecar でも別ホストの center でも同じ route）が貼り付け・ドロップ・添付ボタンの画像を送る。

- `POST /sessions/<name>/attachments`: 外向け token（`Authorization: Bearer`）。本文は画像のバイト列そのもの、`Content-Type` に型。session 名は `[A-Za-z0-9_-]+`（他の `/sessions/<name>/...` と同じ）。
- 受ける型は `image/png` `image/jpeg` `image/gif` `image/webp`。1 枚 20MB（20 × 1024 × 1024 バイト）まで。型は `Content-Type` と、先頭バイト（マジックナンバー）の両方が合っている時だけ通す。
- 応答は 201 `{"path":"<絶対 path>","bytes":N,"type":"image/png"}`。拒否は `{"error":"<理由>"}`: 401（token）、404（未知の session・不正な session 名）、405（POST 以外）、409（config に `workspace` が無い・同じ秒の連番が尽きた）、413（20MB 超。読まずに接続を閉じる）、415（型違い・中身が画像でない）、400（本文が空）。
- 置き場: `<workspace>/<session 名>/attachments/<yyyymmdd-HHMMSS>-<NN>.<png|jpg|gif|webp>`（時刻は center ホストのローカル時刻、`NN` は同じ秒の中の 01〜99）。dir が無ければ作る。既存のファイルは上書きしない。`workspace` は config の値（`session_create` で `path` を省いた時の親と同じ）。session を `path` 指定で作っていても、置き場は `<workspace>/<session 名>` 配下。
- ログ（`center.log`）: 保存は `添付を保存: session=<名> bytes=<N> path=<path>`、拒否は `添付を拒否: session=<名> reason=<理由>`。本文は残さない。
- 自動削除はしない。要らなくなったら手で消す: `find <workspace>/<session 名>/attachments -type f -delete`（その session の分を全部）、または 1 枚ずつ `rm <path>`。
