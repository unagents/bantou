# center を GraphQL の backend server にする設計（desktop の sidecar をやめる）

- 作成: 2026-11-23
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の指示（原文）と、決めてある事

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

決めてある事（変えない）:

1. center は desktop の app に同梱しない。OS の常駐の仕組み（mac は launchd）で、普通の server として起動する。
2. center は GraphQL の endpoint を持つ backend の server になる。
3. client の app（desktop・web）は、frontend の app と同じく、center の GraphQL endpoint を叩いて画面を動かす。

この設計は、上の 3 点に上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

## 1. 今の形

### 1.1 全体

```
desktop (Tauri 2 + Nuxt 4)                          web (Nuxt SPA + Nitro BFF)
 ├ Nuxt 画面 = packages/ui の layer を extends        ├ 同じ ui layer
 ├ ~/tauri = src/tauri/ (Tauri invoke / listen)       ├ ~/tauri = app/tauri/ (POST /api/rpc/<cmd> + SSE)
 └ Rust (src-tauri) ── MCP client ──┐                  └ Nitro ── packages/center-client ──┐
        │ sidecar として子で起動     │ Streamable HTTP /mcp (Bearer)                       │ 同じ /mcp
        ▼                           ▼                                                      ▼
   bantou-center（bun --compile の単体 binary）  ←──────────────────────────────────────────┘
    ├ http: /mcp  /mcp/session  /events(SSE)  /sessions/<n>/{output,input,resize,attachments}  /sessions/<n>/{status-line,hook}
    ├ session の claude（pty-wrapper 経由の対話型 `claude --remote-control`）と、その pty 出力の queue（core）
    ├ MCP の server（/mcp 外向け、/mcp/session = master-cap 向け、coordinator-mcp = 子 process）
    └ server-link（agent-messenger の protocol `bantou`）→ remote の bantou-server
```

### 1.2 center が desktop の sidecar として起動する仕組み

- 【事実】center の実体は `packages/center`（TypeScript、MCP server）。`bun build --compile` で単体 binary にし、`packages/desktop/scripts/build-sidecar.ts` が `packages/desktop/src-tauri/binaries/bantou-center` と `bantou-pty-wrapper` に置く（`packages/desktop/src-tauri/tauri.conf.json` の `bundle.externalBin`、`beforeBuildCommand` が `bun run build:sidecar && bun run generate`）。dmg（Homebrew cask `packages/desktop/Casks/bantou.rb`）に同梱される。
- 【事実】起動は Rust 側 `packages/desktop/src-tauri/src/center.rs`。設定（`enabled`・`port`・`bind`・`workspace`・`claudePath`・`token`・`remote`、`center.rs:60-104`）を store に持ち、`setup` の `center::autostart`（`packages/desktop/src-tauri/src/lib.rs`）が `enabled` なら `tauri_plugin_shell` の sidecar として spawn する（`center.rs:544-550`）。引数は `--transport http --port <n> --bind <addr> --config ~/.local/share/bantou/center.json`（`sidecar_args`、`center.rs:189`）。config は起動のたびに設定から書き直す（`write_config`、`center.rs:223`。`projects` は空、`workspace` だけ渡す）。状態 dir は config の置き場 `~/.local/share/bantou/`（`config_path`、`center.rs:202-204`。center 側は `dirname(config)` = `stateDir`、`packages/center/src/daemon.ts:153`）で、`sessions.json`・`center-settings.json`・`remotes.json`・`handoffs/`・`center-id`・`coordinator-mcp.json` などがある（`daemon.ts:172-230`）。
- 【事実】監視・再起動も desktop が持つ。異常終了は 2 秒から倍々で再起動、失敗が続けば断念、安定すれば戻す（`center.rs:44-55,233-290`）。ログの末尾を `center_status` で画面に出す（`center.rs:37,451`）。停止は SIGTERM を先に送り、center が子の claude を止めるのを待ってから SIGKILL（`center.rs:38-43,654`）。desktop の終了（`RunEvent::Exit`）で center を止める（`lib.rs` 末尾）。
- 【事実】center 側は「親が死んだら止まる」作りで、2 秒ごとに `ppid` を見て、起動時から変わったら shutdown する（`packages/center/src/parent-watch.ts`、`daemon.ts:335`）。つまり今の center の寿命は desktop の寿命に結びついている。
- 【事実】起動元の見分け: desktop は起動ごとの乱数の鍵を env `BANTOU_CENTER_LAUNCHER_KEY` で渡し、自分の sidecar に繋ぐ時だけ header `X-Bantou-Launcher` を付ける。center は MCP の initialize でそれを比べ、一致した接続だけが外部記憶 `memory` と追加の MCP `mcpServers` を読み書きできる（`packages/center/src/launcher.ts`、`packages/center-client/src/tool-policy.ts` の `CENTER_ONLY_KEYS`）。web・別 host の desktop は token が合っていても書けない。

### 1.3 desktop（Tauri・Rust）と center のつなぎ方

- 【事実】transport は MCP（center の Streamable HTTP `/mcp`、`Authorization: Bearer <token>`）。Rust 側の MCP client が `packages/desktop/src-tauri/src/center_mcp.rs`。webview は Tauri command の `center_call` / `center_connection` 経由でだけ center に触れる（`docs/architecture.md`「desktop ↔ center」）。接続先は設定 `remote` があればその center、無ければ sidecar（`center_mcp.rs` の接続先の決め方。`enabled` が真の間は貼った `remote` より sidecar が優先）。
- 【事実】center → desktop の通知は center の `GET /events`（SSE）。Rust 側 `packages/desktop/src-tauri/src/center_events.rs` が購読し、Tauri event `center-sessions-changed`・`center-session-message` として webview に流す（`center_events.rs:18-20,103-106`）。center 側の event の型は `packages/center/src/events.ts`（`SessionsEvent` の `reason`: created / deleted / restored / updated / context / activity / remote / changed / sleep / restarted、`SessionMessage` = turn の終わりの最後の応答）。
- 【事実】session の一覧は Rust 側の `SessionCache`（`packages/desktop/src-tauri/src/session.rs`）が center の `session_list` を持ち、`list_sessions` / `refresh_sessions` で返す（`rev` が大きい方が勝つ、`packages/ui/types/index.ts` の `SessionList`）。
- 【事実】端末は Rust 側 `packages/desktop/src-tauri/src/terminal.rs` が center の `GET /sessions/<n>/output`（SSE、`Last-Event-ID` / `after`）を購読して Tauri event `session-output` / `session-output-status` に写し、`session_input` / `session_resize` は `POST /sessions/<n>/input|resize`。添付は `packages/desktop/src-tauri/src/attachment.rs` が `POST /sessions/<n>/attachments`（`packages/center/src/http.ts:32` の `CORE_PATH`）。
- 【事実】接続設定の共有（token 入りの URL を別 host の desktop に貼る）は `center_snippet.rs`（`center_connect_snippets` / `center_parse_connect` / `center_local_ips`、`center_ip_status`）。center は常に全アドレス（`0.0.0.0`）で待ち受け、Bearer だけで守る（TLS 無し）。`docs/architecture.md`「desktop ↔ center（確定）」。
- 【事実】desktop には center と無関係の OS 側の部品もある: workspace（`workspace.rs`。window ごとの folder、`bantou <path>` の CLI、履歴、folder 選択）、updater（`tauri_plugin_updater`）、OS の sleep 復帰・network 変化の event（`os_events.rs`）、menu（`menu.rs`）、`security.rs`、Cork の task md を読む `task.rs` / `frontmatter.rs`、旧 broker 経由の `thread.rs` / `broker.rs` / `agent.rs`。

### 1.4 web 版・center-client・packages/ui の `~/tauri` の層

- 【事実】`packages/ui` は Nuxt 4 の layer（`packages/desktop/nuxt.config.ts` の `extends: ["../ui"]`）。Tauri の package に依存せず、`~/tauri`（利用側 project の `src/tauri/` または `app/tauri/` に解決される）の `getTransport()`（`invoke` / `listen`）と `getPlatform()` だけを見る（`CLAUDE.md`「役割分離ルール」、`packages/ui/api/*.ts`）。
- 【事実】desktop の `~/tauri` は `packages/desktop/src/tauri/{transport,platform,index}.ts`（Tauri の `invoke` / `listen`、updater・relaunch・shell open・file drop・log・fs watch・window）。
- 【事実】web の `~/tauri` は `packages/web/app/tauri/{transport,platform,session-watch,index}.ts`。command は `POST /api/rpc/<cmd>`、event は `GET /api/events`（SSE）、端末は `GET /api/sessions/<n>/output`（EventSource）と `POST …/input|resize|attachments`（`packages/web/app/tauri/transport.ts`）。command 名・event 名・payload の型は desktop と同じ。
- 【事実】web の backend（Nitro、`packages/web/server/`）は `packages/center-client` を持つ BFF。`packages/center-client/src/commands.ts` が「desktop の Rust command と同じ名前・同じ args・同じ結果」の表（`createCommands`）を持ち、center の MCP tool に翻訳する。center の token は backend が持ちブラウザに出さない。許可する center tool は絞る（`packages/center-client/src/tool-policy.ts` の `WEB_ALLOWED_TOOLS`。`session_delete`・`server_retire` は web に出さない）。守りは Cloudflare Access（`packages/web/server/plugins/00.guard.ts`、`packages/web/server/utils/guard/`）。
- 【事実】web の `Platform.centerSidecar` は false（`packages/web/app/tauri/platform.ts`）。設定画面は「自分で center を起動する」項目を出さず、接続先 center の url と token だけを持つ（`packages/ui/components/SettingsDialog.vue` の `webMode`）。
- 【推測】`center-client` の command 表は、そのまま GraphQL の resolver の素材になる（同じ許可・同じ検査・同じ変換）。移行の入口はここ（4 節）。

### 1.5 center が session の claude（pty）と MCP を持つ所

- 【事実】session の実体は、center が `pty-wrapper`（`packages/pty-wrapper`、Rust）経由で動かす対話型 `claude --remote-control <名前>`（`packages/center/src/wrapper.ts`、`remote-control.ts`、`docs/design/master-cap-session.md`）。出力は center の `core`（`packages/center/src/core.ts`）が session ごとに queue（上限は `CORE_QUEUE_MAX_BYTES`）で持ち、購読者へ配る。入力・サイズ変更は wrapper へ渡る（最後にサイズを送った側が勝つ）。
- 【事実】session の claude には MCP が 2 系統付く: `/mcp/session`（master-cap 向け。`session_resession` など。session token で認証、`packages/center/src/session-auth.ts`、`mcp-session.ts`）と、`/mcp`（外向け。token）。加えて center の設定の `memory`・`mcpServers` が全 session の `--mcp-config` に足される（`docs/design/external-memory.md`、`packages/center/src/mcp-source.ts`）。hook / statusLine は `POST /sessions/<n>/hook|status-line`（session token）で center に届く（`http.ts:30-31`）。
- 【事実】center の MCP tool は `packages/center/src/tools.ts` に `registerTool` が 34 箇所ある（同名を含む。名前は下記）。session 系（`session_create` `session_delete` `session_sleep` `session_wake` `session_update` `session_settings_get/update` `session_list` `session_login` `session_login_code` `session_resession`）、center 系（`center_settings_get/update` `center_info`）、remote 系（`remote_list` `remote_send` `remote_create` `remote_delete` `remote_wait` `task_status` `worker_reply` `worker_resume`）、rc 系（`rc_list` `rc_start` `rc_stop` `rc_status`）、server 系（`server_list` `server_peers` `server_status` `server_retire`）。
- 【事実】center → remote の経路は agent-messenger の protocol `bantou`（`packages/center/src/server-link.ts`、`docs/protocol.md`）。desktop・web はこれに関わらない。

### 1.6 app の更新で center が上がる流れ

- 【事実】app の更新は `tauri_plugin_updater`（`packages/desktop/src-tauri/tauri.conf.json` の `plugins.updater`、endpoint は GitHub Releases の `latest.json`）。`packages/ui/composables/useUpdater.ts` が `checkForUpdate` → `downloadAndInstall` → `relaunch` を呼ぶ（desktop の `platform.ts`）。center は同じ bundle の中の binary なので、app を更新して relaunch すると新しい center が sidecar として起動する（`RunEvent::Exit` で古い center は止まる）。
- 【事実】center が組にする server の版は、build 時に center へ埋め込む（`build-sidecar.ts` の `--env=BANTOU_PAIR_SERVER_VERSION`）。center は発見した server に `hello` を送って版を確かめ、違えば `update_server` で組の版を指示する（`packages/center/src/follow.ts`、`docs/architecture.md` の server の項 13）。
- 【事実】center が止まると session の claude も止まる（SIGTERM で子を止める。次の起動で `restore()` が `--continue` で戻す、`packages/center/src/sessions.ts` の `restore`、`daemon.ts:354`）。今は「app の再起動 = center の再起動 = 全 session の再起動」になっている（`origin/feat/app-restart-check` の設計 1.1 も同じ読み）。

### 1.7 今の形の問題（この設計が解く事）

- center の寿命が app の寿命に結びつく（app を閉じる・更新する・落ちるたびに全 session が止まり戻る）。
- center を置く場所が「desktop のある mac」に引きずられ、別 host の center に繋ぐ時は貼り付けた接続設定・launcher 鍵・`enabled` の優先順位という二重の仕組みがある（`docs/architecture.md`、web 設計 6.5）。
- 画面の操作の入口が 3 つに分かれている（Tauri command 43 個 + center の MCP tool を `center_call` で直接 + web の `/api/rpc/<cmd>`）。`center-client` が Rust の command を TypeScript で写している（二重実装。`packages/center-client/src/commands.ts` の冒頭の注記）。

## 2. 変えた後の形

### 2.1 全体

```
client（desktop / web / 将来のスマホ）  = 同じ Nuxt 画面（packages/ui）
   │   GraphQL over HTTP（query・mutation）+ subscription
   ▼
bantou-center（launchd が起動する普通の server）
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は center を起動も監視も同梱もしない。web は今の BFF の位置づけを未決 #4 で決める。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。center は「desktop と基本は一体」（`docs/concept.md` の登場者）から「独立した server」に変わるので、`docs/concept.md` / `docs/architecture.md` の該当文の改訂が要る（5・4 節の段階 G）。

### 2.2 center の常駐（入れ方・起動・止め方・更新・消し方）

どの案でも、既存の仕組みを土台にする: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、`--user` / `--home` で専用 user。冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | center の binary（`bantou-center` と `bantou-pty-wrapper`）を desktop の bundle から出して単独の配布物にする。入れる場所・配り方は未決 #3。service の定義（plist）を置いて登録する。冪等にする（`install-service.sh` と同じ流儀）。 |
| 起動 | launchd が起動する。`--transport http --port --bind --config` は今の引数のまま（`packages/center/src/args.ts`）。token は config（`token`、12 文字以上、無いと起動しない `daemon.ts:212-214`）。置き場は未決 #2（LaunchAgent か LaunchDaemon）、状態 dir は未決 #9。 |
| 親の監視 | launchd が親になるので `ppid` は変わらず、`parent-watch.ts` は何もしない【推測。実測で確かめる、6 節】。service 起動の時は無効でよい。 |
| 止め方 | launchd が SIGTERM を送る。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:171-175`）。service の停止待ちはそれより長く取る（web 設計 9.1）。 |
| 更新 | 配り方は未決 #3。center を入れ替えて再起動する。再起動で session は `--continue` で戻る（`restore()`）。app（client）の更新とは切り離す（5 節の「app の再起動」の意味が変わる）。 |
| 消し方 | service の登録を外し、binary を消す。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）【案。細部は未決 #3】。 |
| ログ | 今は desktop が `center_status` に末尾を出す（`center.rs`）。service 化後は center のログ file（`logDir`、`packages/center/src/log.ts`）と launchd の stdout / stderr 設定。画面の「center の状態」は GraphQL で返す（3 節）。 |
| Linux | systemd user unit（web 設計 9.1 の例）。Windows の center は対象にするか未決 #10。 |

- `claude` の解決・PATH: service は login shell を通らない（`packages/center/src/path-env.ts`・`claude-path.ts` は login shell から PATH を引く作りで、無ければ固定の候補→config の `remoteControl.claude`）。service 化後の `claude` の探索は【未確認】。実測（6 節）。
- 【事実】`claude` の認証は center を動かす OS user の設定 dir 配下で、mac は login keychain に保存される（`docs/handoff.md` の Lessons: keychain が locked だと refresh token を保存できず 401 になった事例）。LaunchAgent（user の login の domain）と LaunchDaemon（system の domain）で keychain に届くかは【未確認】。未決 #2 の判断材料で、実測する。

### 2.3 GraphQL schema の輪郭

置き場は center の http server（今の `/mcp` と同じ port・同じ認証。path は `/graphql`【案】）。型は `packages/ui/types/index.ts`（今の画面が使う型）を土台にする。以下は輪郭で、field の細部は実装の task で決める。

**Query**

| 名前 | 返す物（今の画面が使う型） | 今の元 |
|---|---|---|
| `sessions` | `SessionList`（`sessions[]`、`reachable`、`reason`）。`Session` = name / state / sessionUrl / source / lastError / path / contextUsage / instructions / activity / activityAt / background / remote / auth / loginUrl / loginError / sleeping | MCP `session_list`、`list_sessions`・`refresh_sessions` |
| `session(name)` | 1 session | 同上 |
| `sessionSettings(name)` | `ProjectSettings`（instructions / addDirs / outputStyle / servers。`memory` / `mcpServers` は権限が要る、未決 #6） | `session_settings_get` |
| `centerSettings` | center 共通の設定（`CenterCommonSettings` + `launcher` 相当の権限の印） | `center_settings_get` |
| `centerInfo` | workspace（`session_path_hints` の素） | `center_info` |
| `remotes` | `CenterRemoteRecord[]`（state・未完了の指示・最新の result / error・`task_result`・`worker_reports`・activity） | `remote_list` |
| `servers` | `CenterServerInfo[]`（server の一覧と版・follow 状態） | `server_list` |
| `serverPeers(refresh)` | `CenterServerPeers`（版の突き合わせ） | `server_peers` |
| `rcStatus` | `CenterRcStatus[]` | `rc_list` |
| `terminalOutput(session, after)` | 端末の出力の取り直し（`after` 以降のチャンク）。通常は subscription を使う | `GET /sessions/<n>/output?after=` |

**Mutation**

| 名前 | 内容 | 今の元 |
|---|---|---|
| `createSession(name, path?, settings?)` | session を作る（`Session` を返す） | `session_create` |
| `updateSession(name, newName?, path?, move?)` | 改名・path の変更 | `session_update` |
| `sleepSession(name)` / `wakeSession(name)` | スリープ・起こす。`sleepSession` は「受理して即返す」形（5 節） | `session_sleep` / `session_wake` |
| `updateSessionSettings(name, settings)` | project 設定の更新（`null` で項目を消す） | `session_settings_update` |
| `updateCenterSettings(settings)` | center 共通の設定 | `center_settings_update` |
| `deleteSession(name)` | 今の desktop の UI は使っていない（web も許可していない）。出すかは未決 #5 | `session_delete` |
| `startSessionLogin(name)` / `submitSessionLoginCode(name, code)` | session の claude の再ログイン | `session_login` / `session_login_code` |
| `restartSession(name)` | 再起動（今は `rc_stop` → `rc_start(resume)` の 2 手、`packages/ui/api/center.ts:118-121`）。1 つの操作にする案 | `rc_stop` + `rc_start` |
| `replyWorker(remoteId, server, workerId, text)` | worker への返答 | `worker_reply` |
| `retireServer(serverId)` | server の退役（取り返しがつかない。web には出さない扱いを引き継ぐ。権限は未決 #4・#6） | `server_retire` |
| `terminalInput(session, dataB64)` / `terminalResize(session, cols, rows)` | 端末の入力・サイズ | `POST /sessions/<n>/input|resize` |
| `attachToSession(session, …)` | 画像の添付。bytes を GraphQL に載せるか、既存の HTTP route を残すかは未決 #7 | `POST /sessions/<n>/attachments` |

**Subscription**

| 名前 | 内容 | 今の元 |
|---|---|---|
| `sessionsChanged` | `SessionsEvent`（reason + name）。client は取り直す（今の使い方）か、差分を直接受ける【案】 | center `/events`、`center-sessions-changed` |
| `sessionMessage` | turn の終わりの最後の応答（session / text / at） | `/events` の `session-message`、`center-session-message` |
| `terminalOutput(session, after)` | `{ id, data(base64) }` / `reset` / `status`（`end` を含む）。切れたら `after` で続きから | `GET /sessions/<n>/output`、`session-output` / `session-output-status` |
| `remotesChanged` | 画面が `remote_list` を取り直す契機（今は `SessionsEvent.reason = remote` と activity で足りているか確かめる【未確認】） | 同上 |
| `centerStatus` | center 自身の状態（版・稼働・認証の要否など。今 desktop が子 process の状態を `center_status` で出している所の置き換え） | `center_status`（Rust） |

- 型の規則: 今の `Session` の `null` は「古い center が送らない」の意味を含む（`packages/ui/types/index.ts` の注記）。center と client が同じ release で動く前提になるので、その互換の扱い（client が新しく center が古い時の振る舞い）を決める必要がある（段階 B の完了条件、4 節）。
- GraphQL が公開しない物: master-cap 向けの `/mcp/session`（`session_resession` など）、hook / status-line の受け口（session token）、server-link。session の claude が使う物は GraphQL に出さない。

### 2.4 認証

- 今: center の `/mcp` は `Authorization: Bearer <token>`（定時間比較、欠落・不一致は 401）。token は desktop が生成して center の config に書く。web は BFF が token を持ち、前段の Cloudflare Access が守る。待ち受けは `0.0.0.0` で TLS 無し（`docs/architecture.md`）。
- 変更後の最小形: GraphQL の endpoint も同じ Bearer token（今の仕組みを移す）。token の生成・保存は center の側（desktop が生成して渡す形をやめる。center の config / 初回の生成）。token の配り方（client が知る方法）は未決 #4。
- 「launcher 鍵」の置き換え: 今は desktop が sidecar を起動した事を鍵で証明し、`memory`・`mcpServers` の書き込みを許す。center が独立すると「起動した所」が無いので、書き込みの権限の持ち方が要る。未決 #6。
- 取り返しのつかない操作（`retireServer`、`deleteSession`）を誰に許すか: 今は desktop だけ（web は許可 list から外す）。権限の単位は未決 #4。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| center の sidecar 起動・監視（`center.rs`）、同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_status` / `center_set_settings` の起動項目（enabled・port・bind・workspace・claudePath）、token の生成・regenerate、launcher 鍵 | **捨てる**（center が自分で持つ。接続先の設定だけが client に残る） |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`）、添付の中継（`attachment.rs`） | **捨てる**（webview が GraphQL を直接叩く。Rust の中継層が無くなる） |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips` / `center_ip_status`） | 接続先 URL + token を貼る入力だけ残す案。snippet を「出す」側は center に移す（center の host で出す）かは未決 #4 |
| updater・relaunch（app 自身の更新） | **残す**（client の更新は center と切り離す） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える） |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するかは未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と、移行中の互換だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す（token をブラウザに出さない・Cloudflare Access 前提を維持）案と、薄い proxy にする案、ブラウザが直接叩く案 |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` の項目は不要になる）。
- 設定画面（`SettingsDialog.vue`）: 「center を起動する」の switch・port・IP・状態・token の再生成が消え、「接続先（URL・token）」と「center の状態の表示」になる（`webMode` の分岐が全 client の形になる）。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center を起動する者（desktop → launchd）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:329` の `centerUrl`）で動く。

## 3. 今の機能との対応表

### 3.1 Tauri command（`packages/desktop/src-tauri/src/lib.rs` の `generate_handler!` 43 個。ui が呼ぶのは 41 個）

| 今の command（所在） | ui の呼び出し | 変更後 |
|---|---|---|
| `list_sessions` / `refresh_sessions`（session.rs） | `listSessions` / `refreshSessions`（`packages/ui/api/sessions.ts`） | query `sessions` |
| `create_session` | `createSession` | mutation `createSession` |
| `session_update` | `updateSession` | mutation `updateSession` |
| `session_sleep` / `session_wake` | `sleepSession` / `wakeSession` | mutation `sleepSession` / `wakeSession` |
| `session_path_hints` | `sessionPathHints`（`canPick` は client の `Platform` が決める） | query `centerInfo`（workspace）+ client 側の `canPick` |
| `session_get_settings` / `session_update_settings` | `getSessionSettings` / `updateSessionSettings` | query `sessionSettings` / mutation `updateSessionSettings` |
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | 接続先の設定は client のローカル（URL・token）。起動の項目（enabled・port・bind・workspace・claudePath）は center の設定（`centerSettings` / `updateCenterSettings` か config）。分け方は未決 #9 |
| `center_status`（center.rs） | `centerStatus` | subscription / query `centerStatus`（center の状態）。子 process の restart 回数・bindFailed は意味が変わる（launchd の状態になる） |
| `center_regenerate_token` | `centerRegenerateToken` | center 側の操作（mutation か CLI。未決 #4） |
| `center_local_ips` / `center_ip_status` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | 接続設定の入出力。`center_parse_connect` は client のローカル処理。他は center の host の情報なので query（未決 #4） |
| `center_call`（center_mcp.rs） | `centerCall` / `centerTool` / `centerToolStrict`（12 個の tool、3.2） | 3.2 の各 query / mutation に分ける。汎用の `center_call` は無くす |
| `center_connection`（center_mcp.rs） | `centerConnection` | client のローカルの接続状態（GraphQL の疎通。`CenterConnection`） |
| `session_output_start` / `session_output_stop`（terminal.rs） | `sessionOutputStart` / `sessionOutputStop`（`packages/ui/api/terminal.ts`） | subscription `terminalOutput` の開始・解除 |
| `session_input` / `session_resize` | `sessionInput` / `sessionResize` | mutation `terminalInput` / `terminalResize` |
| `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`（attachment.rs） | `sessionAttachBytes` / `sessionAttachPaths` / `sessionAttachPick`（`packages/ui/api/attachment.ts`） | `attachToSession`（未決 #7）。`paths` / `pick` は desktop の OS 側（folder 選択・file のパス）で、読んだ bytes を送る形になる（center が別 host だと client の path は center から読めない。今の desktop は読んで POST している【未確認：`attachment.rs` の細部】） |
| `pick_directory` / `set_workspace_directory` / `get_workspace_directory` / `list_workspace_history`（workspace.rs） | `pickDirectory` ほか（`packages/ui/api/workspace.ts`） | **変わらない**（desktop の window の folder。center と無関係の OS 機能） |
| `list_tasks` / `get_statuses`（task.rs） | `listTasks` / `getStatuses`（`useBoard.ts`） | **変わらない**（Cork の task md。未決 #8） |
| `list_threads` / `get_thread`（thread.rs） | `listThreads` / `getThread` | **変わらない**（未決 #8） |
| `broker_connect` / `broker_status` / `list_pings`（broker.rs） | `brokerConnect` / `brokerStatus` / `listPings`（`desktop/src/pages/index.vue`） | **変わらない**（未決 #8） |
| `agent_open` / `agent_close` / `agent_say` / `agent_answer`（agent.rs） | `agentOpen` ほか（`ThreadModal.vue`） | **変わらない**（未決 #8） |
| `create_task` / `update_task_status`（task.rs） | ui は呼んでいない（`docs/handoff.md` の Open） | 触らない |

### 3.2 center の MCP tool を `centerTool` / `centerCall` で直接呼んでいる物（12 個）

| tool | 呼ぶ所 | 変更後 |
|---|---|---|
| `remote_list` | `RemoteActivity.vue:23` | query `remotes` |
| `worker_reply` | `RemoteActivity.vue:98` | mutation `replyWorker` |
| `server_peers`（`refresh` あり） | `CenterDialog.vue:41`、`ProjectSettingsFields.vue:52` | query `serverPeers` |
| `server_list` | `CenterDialog.vue:62` | query `servers` |
| `rc_list` | `CenterDialog.vue:61` | query `rcStatus` |
| `rc_start` / `rc_stop`（`sessionRestart`） | `packages/ui/api/center.ts:118-121` | mutation `restartSession`（または 2 つの mutation） |
| `center_settings_get` / `center_settings_update` | `packages/ui/api/center.ts:33-37` | query `centerSettings` / mutation `updateCenterSettings` |
| `server_retire` | `packages/ui/api/center.ts:100` | mutation `retireServer` |
| `session_login` / `session_login_code` | `packages/ui/api/center.ts:103-110` | mutation `startSessionLogin` / `submitSessionLoginCode` |

### 3.3 event（ui の `listen` 12 個）

| event | 出所 | 変更後 |
|---|---|---|
| `center-sessions-changed`（`center_events.rs`） | center `/events` | subscription `sessionsChanged` |
| `center-session-message`（同上） | center `/events` | subscription `sessionMessage` |
| `session-output` / `session-output-status`（`terminal.rs`） | center `/sessions/<n>/output` | subscription `terminalOutput` |
| `bantou://center-running`（`center.rs`、sidecar を spawn した時） | desktop の Rust | 無くす（center は常駐。client は疎通が戻るまで再試行する、`useSessionRefresh.ts` の `refreshUntilReachable` を接続の再確立の契機に置き換える） |
| `bantou://os-wake` / `bantou://os-network-changed`（`os_events.rs`、web は browser が作る） | OS | client のローカルのまま（GraphQL の subscription の再接続の契機に使う） |
| `bantou://sessions-changed`（`useBoard.ts`） | Rust / client のローカル | client のローカルのまま（Cork task 側。未決 #8） |
| `bantou://threads-changed` / `bantou://pings-changed` / `bantou://agent` | `thread.rs` / `broker.rs` / `agent.rs` | 変わらない（未決 #8） |
| `menu:check-for-updates`（`menu.rs`） | desktop の menu | 変わらない（client の更新） |

### 3.4 `Platform`（`packages/desktop/src/tauri/platform.ts`、8 個）

`checkForUpdate` / `downloadAndInstall` / `relaunch`（app の更新。残す）、`openExternal`（残す）、`onFilesDropped`（残す）、`log`（残す）、`watchDir`（Cork の md 用。残す）、`currentWindow`（残す）。center に関わる物は無い。`centerSidecar` の項目は不要になる。

### 3.5 center が HTTP で直接公開している物（GraphQL への置き換え）

`/mcp`（外向け MCP。未決 #5）、`/mcp/session`（master-cap 向け。残す）、`/events`（SSE。subscription に置き換え）、`/sessions/<n>/output|input|resize`（subscription / mutation に置き換え）、`/sessions/<n>/attachments`（未決 #7）、`/sessions/<n>/status-line|hook`（session 向け。残す）。`packages/center/src/http.ts:15-32`。

### 3.6 網羅性の確かめ（grep で数えた結果）

ui・desktop・web の画面側の呼び出しを grep で数え、3.1〜3.4 の行と突き合わせた。

- Tauri command: `generate_handler!` に 43 個（workspace 4 / task 4 / thread 2 / broker 3 / agent 4 / session 9 / center 5 / center_snippet 3 / center_mcp 2 / terminal 4 / attachment 3）。ui の `invoke("…")` が名指しする物は 41 個（`create_task`・`update_task_status` の 2 個は呼ばれていない）。3.1 の表は 43 個全部を含む。
- `centerTool` / `centerToolStrict` / `centerCall` の tool 名: `remote_list` `worker_reply` `server_peers` `server_list` `rc_list` `rc_start` `rc_stop` `center_settings_get` `center_settings_update` `server_retire` `session_login` `session_login_code` の 12 個。3.2 の表に全部ある。
- `listen` する event 名: 12 個（`center-sessions-changed` `center-session-message` `session-output` `session-output-status` `bantou://center-running` `bantou://os-wake` `bantou://os-network-changed` `bantou://sessions-changed` `bantou://threads-changed` `bantou://pings-changed` `bantou://agent` `menu:check-for-updates`）。3.3 の表に全部ある。
- web の `~/tauri`（`packages/web/app/tauri/transport.ts`）が受ける command は desktop と同じ名前（`POST /api/rpc/<cmd>`）。`packages/center-client/src/commands.ts` の表がその実装で、3.1 の center 系・session 系と一致する。
- center の MCP tool（`tools.ts`）のうち、画面が使うのは 3.2 の 12 個と、web の backend が内部で使う `session_list` `session_create` `session_update` `session_sleep` `session_wake` `session_settings_get/update` `center_info`（`tool-policy.ts` の `WEB_ALLOWED_TOOLS`）。残り（`session_delete` `session_resession` `remote_send` `remote_create` `remote_delete` `remote_wait` `task_status` `worker_resume` `rc_status` `server_status`）は画面から呼ばれていない。master-cap（`/mcp` を使う素のエージェント）の道具として残す（未決 #5）。

## 4. 移行の段取り（段階に分ける。各段で動く物が残る）

前提: 各段の終わりに、desktop も web も今の画面が動く。center は MCP（`/mcp`・`/events`・`/sessions/*`）を最後の段まで残す（GraphQL を足すだけで消さない）。

| 段 | 内容 | この段の終わりに動く物 | 戻し方 |
|---|---|---|---|
| A | center に GraphQL の endpoint を足す（`/graphql`）。resolver は `packages/center-client/src/commands.ts` の表と center の中の関数を使う（query / mutation / subscription は 2.3）。認証は `/mcp` と同じ Bearer。GraphQL server の部品は未決 #1 | 今の desktop・web は無変更で動く（`/mcp` を使い続ける）。GraphQL は curl / test で確かめる | endpoint を足しただけ。外せば元に戻る |
| B | `packages/ui/api/*.ts` を GraphQL client に差し替える。web の `~/tauri` の transport を GraphQL にする（BFF の形は未決 #4）。desktop の `src/tauri/transport.ts` は、center 系の command を GraphQL へ、native 系（workspace・updater・Cork）だけ Tauri に残す。subscription は `terminalOutput`・`sessionsChanged`・`sessionMessage` | web が GraphQL で動く。desktop は「center 系は GraphQL / native 系は Tauri」の混在で動く（sidecar の center にも別 host の center にも GraphQL で繋がる） | 差し替えを feature flag か branch 単位にすれば戻せる。center 側は無変更 |
| C | center の service 化: 配布物（binary + wrapper）の切り出しと、launchd の plist・install / uninstall・状態 dir の引き継ぎ（未決 #2・#3・#9）。desktop の sidecar は残したまま、別に service として center を動かせる状態にする | desktop は「sidecar の center」にも「service の center」にも繋げる。service の center が実機で session を回せる（6 節の実測） | service を外せば sidecar に戻る |
| D | desktop から sidecar を外す: `center.rs`・`center_mcp.rs`・`center_events.rs`・`session.rs` の cache・`terminal.rs`・`attachment.rs` の中継・`center_snippet.rs` の起動側・launcher 鍵・`externalBin`・`build-sidecar.ts` を消す。設定画面を「接続先 + center の状態」にする。dmg から center が消える | desktop は service の center に繋ぐ client だけになる。app の更新が center に触らない | D の前の release に戻せる |
| E | 権限（未決 #6）の置き換え（launcher 鍵 → 新しい権限の持ち方）と、`/mcp` の残し方（未決 #5）の整理 | `memory` / `mcpServers` の読み書きが新しい権限で動く | 権限の方式を旧に戻す |
| F | 更新の配り（未決 #3）の自動化。center の更新と server の版合わせ（`follow.ts` の `BANTOU_PAIR_SERVER_VERSION`）を、desktop の build に依らない形にする | center が独立して更新・再起動する | 手動の更新に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`・`CLAUDE.md` の Map・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に center の設置の手順書を足す。ほかの設計書の「desktop の sidecar」の記述（`docs/design/master-cap-session.md` など）の読み替え | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・認証・subscription）は、段階 C の service 化（plist・install・配布物）と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は `packages/server/scripts` に似た設置の script と配布の build）。
- A の中でも、query 群（session・remote・server・rc の読み取り）、mutation 群（session の操作・設定・login・retire）、subscription（`sessionsChanged`・`sessionMessage`・`terminalOutput`・`centerStatus`）は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。
- B は A の schema に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- D は B と C の完了後。E・F は D と並行できるが、E は未決 #6 の決定後。
- G（docs）は各段の完了ごとに、その段の分だけ。

## 5. 進行中の別変更との関係

`git fetch` して差分を読んだ（読むだけ。これらの branch は変えていない）。

### 5.1 `feat/app-restart-check`（app の再起動の後の状況の確認）

- 内容: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、`packages/center/src/restart-check.ts`、`packages/center/test/restart-check.test.ts`）と `origin/feat/app-restart-check-sessions`（`packages/center/src/sessions.ts` の `restore()` に `onRestoreStart` / `onRestoreFail`）。center が起動し直した session の最初の入力（`SessionStart` の後）で「app が再起動した」事を知らせ、状況の確認を促す。検出は `restore()` の中（`supervisor.start(name, { resume: true })` の直前に印を付ける）。
- この設計との関係: 実装は center の中の物で、GraphQL 化・service 化とは別の file（`restart-check.ts`・`sessions.ts` の restore・`daemon.ts` の配線）。**衝突は少ない**。
- 意味が変わる点: その設計は「center は desktop の sidecar なので、app の再起動 = center の process の起動」（1.1 の【推測】）に立つ。center が app から離れると、**app（client）を再起動しても center は再起動しない**ので `restore()` は走らず、session も起動し直されない。`restore()` が走るのは center の起動（host の起動、launchd の再起動、center の更新、center の異常終了からの復帰）の時だけになる。つまり「app の再起動の最初の 1 回」は「center の起動の最初の 1 回」に読み替わる。
- 整合の案（利用者の判断。未決 #11）: (A) 実装は変えず、意味を「center が起動し直した時」に読み替える（文面の「app が再起動した」を「center が再起動した」に直す）。(B) さらに「client が繋ぎ直した時」にも確認を送る（これは別の仕様になり、現在の指示「app が再起動された時の最初の 1 回」から外れる。足すなら利用者が決める）。推奨は A。

### 5.2 `feat/sleep-resession`（スリープを起動しないリセッションに）

- 内容: `origin/feat/sleep-resession`（`docs/design/sleep-resession.md`、`packages/ui/composables/sleepButton.ts`・`sessionStatus.ts` の `sleepBlock`、`packages/ui/api/sessions.ts` の注記、`packages/desktop/src/pages/index.vue`、`packages/desktop/e2e/session-sleep.spec.ts`）。眠らせる = 引継ぎを書かせて保存してから止める。起こす = 新しい会話で引継ぎを渡す。`session_sleep` は「受理して即返す」（その設計の U3 = A、拒否は同期で返す）。ボタンは作業中・needs-input・remote の未完了・未返答・動いていない時は押せない（`sleepBlock`）。
- この設計との関係:
  - 【事実】この branch は `packages/ui` を触る（`sessionStatus.ts` の `sleepBlock`、`sleepButton.ts`、`useBoard.ts`、`useSessionBoard.ts`、`api/sessions.ts`）。段階 B（`packages/ui/api/*.ts` の差し替え）と同じ file を触るので、**B の前に merge する**か、B の worker が最新の develop に追従する。
  - GraphQL の `Session` 型は、`sleepBlock` が読む field（`state`・`activity`・`background`・`remote.waitingReply`・`remote.running`・`sleeping`）を落とさずに持つ。`sleepBlock` は client の純関数のまま使える（center に判断を移さない。center の `check` は拒否を同期で返すので二重の守り）。
  - `sleepSession` の mutation は「受理して即返す」に合わせ、返り値を「眠った後の `Session`」にしない（眠りは後で `sessionsChanged`（reason `sleep`）で届く）。拒否（作業中など）は mutation の error / payload の理由で返す。今の `session_sleep` は `Session` を返す（`center-client` の `commands.ts`）ので、返り値の形が変わる所は両設計で 1 回だけ合わせる。
  - `restore()`・`wake` の振る舞いは center の中の変更で、GraphQL の形には影響しない。スリープ中の session を center の起動で起こさない点も変わらない。
- 衝突: center 側（`sessions.ts`・`resession.ts`・`daemon.ts`・`tools.ts`）は `app-restart-check` と同じ file を触ると、その設計の 6 節に書いてある。GraphQL の resolver は `tools.ts` の関数でなく `SessionManager` の API を呼ぶ形にすると、`tools.ts` の変更の影響を受けにくい【案】。

### 5.3 リセッション（`docs/design/resession.md`）

- `session_resession` は session 自身が `/mcp/session` で呼ぶ tool で、GraphQL には出さない（2.3）。center の中の動き（引継ぎの保存、`Stop` の後の再起動、最初の入力）は、center が独立しても同じ。
- 区切りの行は center の core の出力 queue に積まれ、`terminalOutput` の subscription でそのまま届く（`reset` は出力 queue が session の再起動をまたいで残る事と合わせて、`resession.md` 2.5 の前提を変えない）。
- 引継ぎの保存先 file は center の host にある（`handoffs/` は状態 dir の下、`daemon.ts:218`）。状態 dir の置き場が service 化で変わると（未決 #9）、`handoffs/` と未取り出しの引継ぎも一緒に移す必要がある。

## 6. test と実測の観点

code は書かないので、ここは実装の task が足す test と、実機で測る事の一覧。

**test（実装が足す）**

- schema: query / mutation / subscription が 3.1〜3.3 の表の全項目を持つ（表を test の入力にして、漏れを機械的に検出する）。
- 認証: Bearer の欠落・不一致は 401、定時間比較（`packages/center/test/` の既存の `/mcp` の認証 test と同じ形）。launcher 鍵の置き換え後（未決 #6）、`memory` / `mcpServers` は権限が無い接続で書けない（今の `CENTER_ONLY_KEYS` の test の移植）。
- 互換: GraphQL の `Session` が `packages/ui/types/index.ts` の `Session` と同じ形で返る（`center-client` の `parseSession` と同じ検査）。
- subscription: 端末の `after` での続き・`reset`・`end`、接続が切れた後の再接続、`sessionsChanged` の reason が既存の 10 種を全部運ぶ（`packages/center/src/events.ts`）。
- client: `packages/ui` の既存の test（`packages/ui/test/`）と e2e（`packages/desktop/e2e/*.spec.ts` は Tauri の IPC を mock して画面を動かす。`packages/web/e2e/`）が、transport の差し替え後も通る。mock の層を GraphQL に置き換える（`packages/desktop/e2e/mock/`）。
- center の既存 test（`packages/center/test/*.test.ts`）は全部通ったまま（GraphQL は足すだけの段階 A）。

**実測（mac の実機。値は測って書く。この設計では決めない）**

- launchd で center を起動し、`claude` が見つかり、認証が通る（LaunchAgent / LaunchDaemon の差。keychain が locked でも 401 にならないか。`docs/handoff.md` の Lessons）。
- `parent-watch.ts` が launchd の下で何もしない事（ppid が変わらない）。
- host の再起動・login の前後・center の kill・launchd による再起動で、session が `--continue` で戻る事（`restore()`）と、停止にかかる時間（`stopGraceMs` と service の停止待ちの関係）。
- GraphQL server の部品（未決 #1）が `bun build --compile` の単体 binary で動く事。今は `@modelcontextprotocol/sdk` と zod が compile で遅延初期化に包まれて落ちた事がある（`packages/center/src/cli.ts` の冒頭の注記）。同種の問題が GraphQL の部品で出ないか。
- 端末の subscription の実測: 出力が多い時の遅延・切断・再接続の後の続き。web の Cloudflare 経由（SSE / WebSocket が通る条件。web 設計 8.5）。
- 認証: 別 host の client（LAN・Tailscale）から繋げる事。平文の token（`0.0.0.0` の待ち受け）が今と同じ範囲に収まる事。
- 更新: center を入れ替えて再起動した時の session の中断の長さと、`follow.ts` の server の版合わせ。
- desktop: sidecar を外した版が、center の service が止まっている時に「繋がらない」を画面に出して、戻れば自動で再接続する。

## 7. 未決（番号つき。各案と推奨）

**#1 GraphQL server の部品**
- 案 A: `graphql-yoga`（fetch API ベース。subscription は SSE、必要なら WebSocket を足せる）+ `graphql-js`（schema は code-first か SDL）。
- 案 B: Apollo Server（HTTP の query / mutation）+ `graphql-ws`（WebSocket の subscription）。
- 案 C: 手書きの薄い実装（`graphql-js` だけ + 自前の SSE）。
- 推奨: A。理由: center は今 `node:http` で `/events` を SSE で出しており（`packages/center/src/http.ts`）、同じ transport の考えで subscription を載せられる。web の Cloudflare 経由で SSE は通る前提の設計がある（web 設計 8.5）。WebSocket は不要にできる【推測】。ただし `bun build --compile` で動く事は【未確認】（6 節の実測）。動かなければ B か C に切り替える。schema を code-first にするか SDL にするかは実装の task が決める。

**#2 常駐の単位と、launchd の種別**
- 案 A: center 1 つを 1 つの service にする。mac は LaunchAgent（user の login の domain。`~/Library/LaunchAgents`）。
- 案 B: center 1 つを LaunchDaemon（`/Library/LaunchDaemons`、`UserName` 付き）にする（`packages/server/scripts/install-service.sh` の mac と同じ形）。
- 案 C: 複数（center と web backend を同じ service にまとめる、または session ごと）。
- 推奨: 単位は A（center 1 つ = 1 service。`docs/concept.md` の原則 6「session ごとに重い仕組みを抱えさせない」と、web 設計 6.4 の「1 host に center を複数立てない」に沿う）。種別は A（LaunchAgent）を第一候補にして実測で決める。理由: `claude` の認証が login keychain にあり（`docs/handoff.md` の Lessons）、user の login の domain の方が keychain に届く【推測。未確認】。LaunchAgent は user が login していないと起動しない（host の再起動後に自動ログインが要る）という制約があり、これが許されない運用なら B。web backend は別の service（web 設計 9.1）のまま。

**#3 center の配り方と更新の配り方（入れ方・更新・消し方）**
- 案 A: Homebrew で配る（別の formula か、今の cask と別の物。`unagents/homebrew-tap`）。更新は `brew upgrade`。service の登録は center の subcommand（`bantou-center service install` のような物）か `brew services`。
- 案 B: GitHub Releases に center の binary を置き、center 自身が更新する（新しい binary を取って入れ替え、自分で終わって launchd に起動し直させる）。
- 案 C: desktop の app が center の更新を GraphQL の mutation で指示する（app と center の版を組にする。今の `BANTOU_PAIR_SERVER_VERSION` の考えの延長）。
- 推奨: 最初は A（配布が既存の流儀、`CLAUDE.md` の publish 方針の延長。更新は人が `brew upgrade` する）。B は段階 F で足す。C は center が自分を更新する権限の問題があるので推奨しない。更新で session が中断される事（1.6）は変わらないので、更新を「cap が空の時に行う」運用（web 設計 9.3）は手順書に書く（自動で待つ仕組みを足すかは別の決定）。消し方は「service の登録を外す・binary を消す・状態 dir は残す」を既定にする案。

**#4 認証の形と、web の BFF**
- 案 A: 今と同じ 1 本の Bearer token。token は center が持つ。client は URL + token を貼る。web は BFF が token を持つ（今のまま）。
- 案 B: A に、client ごとの token（発行・失効）を足す。取り返しのつかない操作（`retireServer`・`deleteSession`）は権限を分ける。
- 案 C: A に TLS（center が終端、または前段の reverse proxy）を足す。
- web の形: (a) BFF を残す（token をブラウザに出さない。GraphQL を中継する）、(b) 薄い proxy にする、(c) ブラウザが center を直接叩く（token がブラウザに出る）。
- 推奨: 認証は A（利用者の決めてある事に新しい仕組みを足さない。今の desktop・web と同じ強さ）。web は (a)（Cloudflare Access の守りと token を隠す設計が既にある。`packages/web/server/`）。B・C は実運用で必要になった時に別の決定にする。token の生成と配り方（client に渡す方法）は center の host で行い（center が生成し、画面に出す物は center の host の CLI / 設定にする案）、desktop の「token を生成して渡す」仕組みは無くなる。

**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。

**#6 launcher 鍵（`memory`・`mcpServers` の書き込み権）の置き換え**
- 案 A: center の host で動かす CLI（`bantou-center memory` / `bantou-center mcp`、`packages/center/src/cli.ts`・`memory-settings.ts`・`mcp-cli.ts` に既にある）だけで書く。GraphQL からは読み取りだけ（値の秘密は伏せる、今の `mcp-secrets.ts` の扱い）。
- 案 B: admin 権限の token を別に持ち、それで繋いだ client だけが GraphQL で書ける。
- 案 C: desktop の画面で書ける今の体験を保つため、client の token に書き込みの scope を持たせる。
- 推奨: A を最初の形にする（権限の仕組みを新しく足さない。CLI は既にある）。画面から書きたい要望があれば、B を別の決定にする。desktop の設定画面の「外部記憶」「追加の MCP」の編集は、A の間は「center の host で設定する」案内になる（利用者の画面の体験が変わる点なので、決定を要する）。

**#7 端末の入出力と添付を GraphQL に載せる範囲**
- 案 A: 出力は subscription、入力・サイズは mutation、添付の画像（bytes）は既存の HTTP route `POST /sessions/<n>/attachments` を残す。
- 案 B: 全部 GraphQL（添付は GraphQL multipart upload か base64 の mutation）。
- 案 C: 端末の出力・入力も既存の HTTP route を残し、GraphQL は一覧と操作だけ。
- 推奨: A。理由: 出力は `id` / `after` / `reset` の再開付きの stream で、今の SSE の振る舞い（`Last-Event-ID`）を subscription で再現できる【未確認】。画像の bytes は GraphQL に載せにくい。C は「画面が使う物は GraphQL で漏れなく」の方針から外れる。

**#8 Cork の task・旧 broker・thread・agent（desktop ローカル）の扱い**
- 案 A: この設計では触らず、desktop ローカルの機能として残す。
- 案 B: center に移して GraphQL に出す。
- 案 C: 廃止する。
- 推奨: A（利用者の指示は center の起動の仕組みで、これらは center と無関係。`docs/handoff.md` の Open にも、使われていない command がある）。web がこれらを出していない（web 設計の判断 5）のと同じ扱い。廃止の可否は別の決定。

**#9 状態 dir の置き場と、設定の分け方（接続先 / center の起動項目）**
- 案 A: 今 desktop が使う `~/.local/share/bantou/` をそのまま使う（`sessions.json`・`remotes.json`・`handoffs/`・`center-id` が引き継がれ、session・remote-cap の記録が残る）。
- 案 B: service 用の新しい場所（`~/.config/bantou/` など。`packages/center/README.md` の既定）に作り直す。
- 推奨: A。理由: 移行で session と cap の記録が消えない。`center-id`（cap_id の素、`docs/architecture.md`）が変わると cap の記録の対応が崩れる。設定の分け方は、`CenterSettings` の起動項目（enabled・port・bind・workspace・claudePath・token）は center の config へ、`remote`（接続先 URL・token）は client のローカルの設定へ、とする案を推奨する。

**#10 Windows（desktop の client は動くが center は mac / Linux の host）**
- 案 A: center は mac（launchd）と Linux（systemd）だけを対象にし、Windows は client としてだけ使う。
- 案 B: Windows の center の常駐も扱う。
- 推奨: A（利用者の指示は launchd。`pty-wrapper` と `claude` の Windows 対応は今の repo に根拠が無い【未確認】）。

**#11 「app の再起動の後の状況の確認」の意味（5.1）**
- 案 A: center が起動し直した時（host 起動・launchd 再起動・更新・異常終了からの復帰）に読み替える。実装は変えない。
- 案 B: A に加えて、client（desktop）が繋ぎ直した時にも確認を送る。
- 案 C: 確認を止める。
- 推奨: A。

**#12 center の更新で session が中断される事（1.6）**
- 案 A: 今と同じ（更新の再起動で session は `--continue` で戻る。人が空いている時にやる）。
- 案 B: center が更新の前に session の状態を見て、作業中なら待つ。
- 推奨: A（利用者が決めていない待ちの仕組みを足さない）。B は更新の自動化（段階 F）の時に別の決定にする。

**#13 版の互換（client と center の版が違う時）**
- 案 A: GraphQL の field の追加だけを許し（古い client は新しい field を無視）、削除・型の変更は client と center を同じ release で出す。client は center の版を query で取り、組が合わない時は画面に出す。
- 案 B: schema に版を持たせ、複数の版を同時に提供する。
- 推奨: A（今の `Session` の `null` = 古い center の扱いと同じ考え）。

## 8. 次にやる事（推奨の順）

1. 未決 #1・#2・#3・#4・#6・#7 の決定（schema と配布の形に効く）。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A の worker を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。
3. 並行して段階 C の実測（launchd で center が `claude` の認証を通すか）を行う。結果で #2 の種別が決まる。
