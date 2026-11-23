# center を launchd の常駐 server にして GraphQL を持たせる設計（center は app に同梱、起動は sidecar でなく launchd）

- 作成: 2026-11-23（同日、利用者の訂正「app 同梱はする」を反映して改訂）
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の指示（原文）と、決めてある事

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

> いや、app同梱はする。（上の指示への、利用者の訂正）

決めてある事（変えない。訂正を反映した形）:

1. center は今どおり app に同梱して配る（app を入れれば center も入る。版も app と一緒）。
2. 起動は app の子の process（sidecar）ではなく、OS の常駐の仕組み（mac は launchd）で、普通の server として起動する。
3. center は GraphQL の endpoint を持つ backend の server になる。
4. client の app（desktop・web）は、frontend の app と同じく、center の GraphQL endpoint を叩いて画面を動かす。
5. app は、center の launchd の登録・更新・止め方を扱い、app を click した時の入口を持つ（2.7）。

初版（4edee56）は「app に同梱しない」を前提に書いたので、この版で、同梱・配り方・更新・app の入口の部分を書き直した（2.2・2.5・2.7・3・4・5.1・6・7 節）。GraphQL の schema（2.3）、認証の基本（2.4）、session の claude と MCP が center に残る事（2.6）は変わらない。

この設計は、上の 5 点に上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

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
bantou-center（app に同梱した binary。app が launchd に登録し、launchd が起動する普通の server）
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は center を子 process として起動も監視もしない（launchd が起動する）。center の binary は app に同梱のまま、app が launchd に登録する（2.7）。web は今の BFF の位置づけを未決 #4 で決める。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。center は「desktop と基本は一体」（`docs/concept.md` の登場者）から「app に同梱して配るが、process としては独立した server」に変わるので、`docs/concept.md` / `docs/architecture.md` / `CLAUDE.md` の「sidecar 同梱」の文の改訂が要る（4 節の段階 G）。

### 2.2 center の常駐（入れ方・起動・止め方・更新・消し方）

どの案でも、既存の仕組みを土台にする: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、`--user` / `--home` で専用 user。冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | center の binary（`bantou-center` と `bantou-pty-wrapper`）は今どおり app の bundle に同梱する（`externalBin`）。**app から**launchd に登録する（2.7）。service の定義（plist）を置いて登録する。冪等にする（`install-service.sh` と同じ流儀）。登録の仕組みは未決 #14、binary の置き場は #15。 |
| 起動 | launchd が起動する。`--transport http --port --bind --config` は今の引数のまま（`packages/center/src/args.ts`）。token は config（`token`、12 文字以上、無いと起動しない `daemon.ts:212-214`）。置き場は未決 #2（LaunchAgent か LaunchDaemon）、状態 dir は未決 #9。 |
| 親の監視 | launchd が親になるので `ppid` は変わらず、`parent-watch.ts` は何もしない【推測。実測で確かめる、6 節】。service 起動の時は無効でよい。 |
| 止め方 | launchd が SIGTERM を送る。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:171-175`）。service の停止待ちはそれより長く取る（web 設計 9.1）。 |
| 更新 | center は app に同梱で、版も app と一緒（決めてある）。app の更新（updater）が新しい binary を bundle に置く。動いている center は更新されず、再起動して初めて新しい版になる。再起動の入口は 2.7.4・未決 #18。再起動で session は `--continue` で戻る（`restore()`）。 |
| 消し方 | 常駐をやめる（`bootout` + plist の削除）。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）。app の削除（cask の uninstall）で plist が残る問題は 2.7.6。 |
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
- 変更後の最小形: GraphQL の endpoint も同じ Bearer token（今の仕組みを移す）。token の生成・保存は今のまま app が持つ（登録の時に center の config に書く。再生成は config を書き直して service を再起動）。別 host の client への配り方は今の接続設定の共有（未決 #4）。
- 「launcher 鍵」: 今は desktop が sidecar を起動した事を、起動ごとの鍵で証明し、`memory`・`mcpServers` の書き込みを許す。launchd の常駐になると、鍵は center が起動する前に決まっている必要がある（center が app より先に、または app と無関係に起動し直されるため）。未決 #6（登録の時に作って保存する鍵、が推奨）。
- 取り返しのつかない操作（`retireServer`、`deleteSession`）を誰に許すか: 今は desktop だけ（web は許可 list から外す）。権限の単位は未決 #4。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| center の sidecar の spawn・監視・自動再起動・終了時の停止（`center.rs` の spawn / backoff / `Center::stop`、`lib.rs` の `RunEvent::Exit` の停止）、`bantou://center-running`、launcher 鍵を起動ごとに作る所 | **捨てる**（launchd に移る。#16・#19） |
| 同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_set_settings` の起動項目（enabled・port・bind・workspace・claudePath）、token の生成・regenerate | **残す**（center は app に同梱のまま。設定は app が持ち、launchd への登録の時に center の config へ書く。2.7） |
| launchd の登録・起動・止め方・消し方（新規） | **足す**（`launchctl` を呼ぶ Rust の command。2.7.8） |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`）、添付の中継（`attachment.rs`） | **捨てる**（webview が GraphQL を直接叩く。Rust の中継層が無くなる） |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips` / `center_ip_status`） | **残す**（今の接続設定の配り方のまま。別 host の desktop が貼る。web は持たない） |
| updater・relaunch（app 自身の更新） | **残す**。center は同梱なので、app の更新が新しい center の binary を運ぶ（運ぶだけで、動いている center は更新しない。再起動の入口は 2.7.4・#18） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える） |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するかは未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と、移行中の互換だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す（token をブラウザに出さない・Cloudflare Access 前提を維持）案と、薄い proxy にする案、ブラウザが直接叩く案 |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` の項目は不要になる）。
- 設定画面（`SettingsDialog.vue`）: 「center を起動する」の switch が「この Mac に center を常駐させる」（launchd への登録。2.7）になり、状態の表示は launchd の状態 + center の状態になる。接続先（URL・token）の入力は残り、別 host の center を指す時は常駐の操作を出さない（web と同じ `webMode` の形）。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center を起動する者（desktop の子 process → launchd。binary は app に同梱のまま）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:329` の `centerUrl`）で動く。
### 2.7 app から center の常駐を扱う（登録・起動・更新・止め方・消し方と、app の入口）

利用者の訂正: center は app に同梱し、版も app と一緒。起動は launchd。app の役割は「center の launchd の管理者」と「client」の 2 つになる。

【事実】今の関係部品:
- 同梱: `packages/desktop/src-tauri/tauri.conf.json` の `bundle.externalBin`（`binaries/bantou-center`・`binaries/bantou-pty-wrapper`）。build は `packages/desktop/scripts/build-sidecar.ts`（target triple の suffix 付きで置き、bundle 時に外れる、同 file の冒頭の注記）。
- 配り: Homebrew cask `packages/desktop/Casks/bantou.rb`（arm64 の macOS、`auto_updates true`、`app "bantou.app"`、`zap trash` は `~/Library/Application Support/jp.grrow.bantou` と `~/Library/Caches/jp.grrow.bantou`。**launchd の登録を外す stanza は無い**）。app 自身の更新は `tauri_plugin_updater`（1.6）。
- 起動の設定: `center.rs` の `CenterSettings`（enabled・port・bind・workspace・claudePath・token・remote）と `write_config` / `sidecar_args`（1.2）。

#### 2.7.1 登録（常駐させる）

- 入口: 設定画面の「この Mac に center を常駐させる」（今の「center を起動する」の switch の置き換え）、または初回の案内（#17）。
- 手順: (1) 設定から config（`center.json`）を書く（今の `write_config` の流用。`workspace`・`remoteControl.claude`・`token`）。(2) plist を書く（label・実行 file・引数 `--transport http --port --bind --config`・log の出力先・launcher 鍵（#6）・環境）。(3) launchd に登録する（`launchctl bootstrap gui/<uid>`。LaunchAgent の場合。#2）。(4) 起動して GraphQL の疎通（query）を待ち、画面に状態を出す。冪等（登録済みなら plist が同じか確かめて差があれば入れ替える）。
- 登録の仕組み（plist + `launchctl` か `SMAppService` か center の subcommand か）は未決 #14。実行 file の path は未決 #15。

#### 2.7.2 起動・再起動

- 起動は launchd（ログイン時、または登録の直後。`RunAtLoad` 相当）。app の起動・終了とは無関係。
- 異常終了からの再起動は launchd に任せる案（#16）。今 `center.rs` が持つ backoff・断念・ログ末尾の保持は app から外れる。画面の「center の状態」は `launchctl print` の結果 + GraphQL の疎通 + center のログ file の末尾にする。
- center の `parent-watch.ts`（親が変わったら終わる）は launchd の下では起動しても何もしない【推測。6 節で実測】。

#### 2.7.3 app を click した時の入口

app を開いた（click した）時、app は「この Mac の center」の状態を確かめ、状態に応じて動く。表の状態は、`launchctl print` の結果と、GraphQL の疎通・center の版の query で見分ける。

| 状態 | app の動き（案。細部は未決） |
|---|---|
| 接続先が別 host の center（`remote` に URL がある） | 常駐の操作を出さない（今の `remote` と同じ。web と同じ形）。URL に GraphQL で繋ぐだけ |
| この Mac の center が未登録 | 初回の登録の案内（#17）。承諾されるまで画面は「center が無い」を出す |
| 登録済み・稼働・版が app と同じ | そのまま GraphQL で繋ぎ、session の一覧を出す（app を開き直しても session は止まらない） |
| 登録済み・稼働・版が app と違う（app を更新した後） | 繋いで使える（#13 の互換の範囲）。画面に「center の更新（再起動）」の入口を出す（#18） |
| 登録済み・停止（落ちた・止めた） | 画面に「停止中」と「起動する」を出す（`kickstart`）。自動で起動するかは #16・#17 |
| 登録済みだが実行 file が無い・起動に失敗し続ける | 画面にその理由（`launchctl print` の状態と center のログの末尾）を出し、「再登録」を出す（app の移動・削除後に起きうる。#15） |

- 画面に出す操作（設定画面・状態の表示）: 「常駐させる / やめる」「起動 / 止める」「center を再起動して更新する」「状態とログ」。
- app を終了しても center は止まらない（#19）。

#### 2.7.4 更新（版は app と一緒）

- app の更新（`tauri_plugin_updater` → `relaunch`）は、bundle の中の center の binary も新しくする。動いている center（launchd が起動済み）は旧 binary のまま動き続ける【推測。bundle の置き換え中・後に実行 file がどうなるかは【未確認】、#15・6 節】。
- 新しい版にするには center を再起動する（`launchctl kickstart -k` か `bootout` → `bootstrap`）。入口は 2.7.3 の表の「版が違う」行（#18）。再起動で session の claude は止まり、`restore()` が `--continue` で戻す（1.6。session の中断は今と同じ）。
- 版の違いの検出: client が GraphQL で center の版を取り、app の版と比べる（#13）。server の版合わせは今の `follow.ts`（`BANTOU_PAIR_SERVER_VERSION`、app の build が埋める）のまま。

#### 2.7.5 止め方

- 画面の「止める」: `launchctl bootout`（SIGTERM。center は子の claude を止めてから終わる。待ちは `stopGraceMs` + hard exit、`daemon.ts:171-175`）。次に app の入口の「起動する」で戻す。再登録は要らない（登録は残す）案と、止めると登録も外れる案があるが、前者を案にする（#17 の一部）。
- app の終了では止めない（#19）。

#### 2.7.6 消し方

- 画面の「常駐をやめる」: `bootout` + plist の削除。状態 dir は消さない（#9）。
- app を削除した時（cask の uninstall）: 今の cask に launchd の登録を外す stanza は無い。plist だけが残って、実行 file が無い center の起動を launchd が試み続ける事になりうる。cask に `uninstall launchctl:`（label を指定）の stanza を足す案がある（cask の変更は別 task）。【未確認】の部分は 6 節で実測。

#### 2.7.7 権限

- LaunchAgent（`~/Library/LaunchAgents`）は user の domain なので管理者権限が要らない【推測】。LaunchDaemon（`/Library/LaunchDaemons`、`packages/server/scripts/install-service.sh` の mac の形）は管理者権限が要り、app からの登録に権限の確認が入る。#2 の推奨の理由の 1 つ。
- 認証・権限で止まった時は、操作と理由を画面に出す（権限を自分で広げない）。

#### 2.7.8 desktop の Rust に足す command と、捨てる command

足す（`center.rs` の spawn の置き換え。名前は仮）:

| command | 内容 |
|---|---|
| `center_service_status` | 未登録 / 稼働 / 停止 / 異常 と、plist・実行 file の有無、`launchctl print` の要約 |
| `center_service_install` | 2.7.1 の手順（冪等） |
| `center_service_start` / `center_service_stop` / `center_service_restart` | `kickstart` / `bootout` / `kickstart -k` |
| `center_service_uninstall` | 2.7.6 |
| event `bantou://center-service`（仮） | 状態が変わった時（3.3） |

捨てる: `center.rs` の spawn・backoff・断念・終了時の停止、`bantou://center-running`（3.3）。残す: `center_get_settings` / `center_set_settings`（登録に使う項目）、`center_regenerate_token`、`center_snippet.rs` 一式（3.1）。

#### 2.7.9 app の無い host（web 用の Linux の host など）

app が無いので、この 2.7 の入口は使えない。center の `service` subcommand（#14 の案 C）で登録する形は共有できる。配り方は未決 #20。
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
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | 接続先（URL・token）は client のローカル。「この Mac の center の常駐」の項目（enabled・port・bind・workspace・claudePath）は app が持ち、登録の時に center の config へ書く（`write_config` の流用）。分け方は未決 #9 |
| `center_status`（center.rs） | `centerStatus` | app の Rust の `center_service_status`（launchd の状態: 未登録 / 稼働 / 停止 / 異常、2.7.8）+ GraphQL の query `centerStatus`（center 自身の状態）。子 process の restart 回数・bindFailed は意味が変わる（launchd の状態になる。#16） |
| `center_regenerate_token` | `centerRegenerateToken` | 残す（app が config の token を書き直し、service を再起動する。#4） |
| `center_local_ips` / `center_ip_status` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | 残す（接続設定を別 host の desktop に配る機能は今のまま。`center_parse_connect` は client のローカル処理） |
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
| `bantou://center-running`（`center.rs`、sidecar を spawn した時） | desktop の Rust | `bantou://center-service`（仮。service の登録・起動・停止の操作の後、または状態が変わった時に Rust が出す。画面は疎通が戻るまで再試行する、`useSessionRefresh.ts` の `refreshUntilReachable` を契機に使う） |
| `bantou://os-wake` / `bantou://os-network-changed`（`os_events.rs`、web は browser が作る） | OS | client のローカルのまま（GraphQL の subscription の再接続の契機に使う） |
| `bantou://sessions-changed`（`useBoard.ts`） | Rust / client のローカル | client のローカルのまま（Cork task 側。未決 #8） |
| `bantou://threads-changed` / `bantou://pings-changed` / `bantou://agent` | `thread.rs` / `broker.rs` / `agent.rs` | 変わらない（未決 #8） |
| `menu:check-for-updates`（`menu.rs`） | desktop の menu | 変わらない（client の更新） |

### 3.4 `Platform`（`packages/desktop/src/tauri/platform.ts`、8 個）

`checkForUpdate` / `downloadAndInstall` / `relaunch`（app の更新。残す）、`openExternal`（残す）、`onFilesDropped`（残す）、`log`（残す）、`watchDir`（Cork の md 用。残す）、`currentWindow`（残す）。center に関わる物は無い。`centerSidecar` の項目は「この shell が center の常駐を管理できる」の意味に変わって残る（desktop は true、web は false。設定画面の `webMode` の分岐の根拠）。

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
| C | center の常駐化: center の `service` subcommand（plist の生成・登録・解除。#14）と、desktop の Rust の service 管理の command（2.7.8）、設定画面・app の入口（2.7.3）、状態 dir の引き継ぎ（#9）。同梱 binary はそのまま bundle に入れ、launchd がそれを起動する（#15）。desktop の sidecar（`center.rs` の spawn）は残したまま、「sidecar で起動」と「launchd で常駐」を設定で切り替えられる状態にする（同じ port を同時に使わない） | desktop は sidecar の center にも launchd の center にも繋げる。launchd の center が実機で session を回せる（6 節の実測） | 設定を sidecar に戻す |
| D | desktop から sidecar の spawn を外す: `center.rs` の spawn・監視・backoff・終了時の停止、`center_events.rs` / `center_mcp.rs` / `session.rs` の cache / `terminal.rs` / `attachment.rs` の中継、`center_snippet.rs` の起動側を消す。**binary の同梱（`externalBin`・`build-sidecar.ts`）は残す**（launchd が bundle の center を起動する）。設定画面を「接続先 + この Mac の center の常駐の操作」にする | desktop は launchd の center に繋ぐ client + service の管理者になる。app の終了・更新が center を止めない | D の前の release に戻せる |
| E | launcher 鍵の保存方式の変更（#6 の A: 起動ごとの鍵 → 登録の時に作る鍵）と、`/mcp` の残し方（#5）の整理 | `memory` / `mcpServers` の読み書きが新しい鍵で動く | 鍵の方式を旧に戻す |
| F | 更新の入口（#18）: app の更新後に center の版の違いを検出して、再起動の入口を出す。`follow.ts` の server の版合わせ（`BANTOU_PAIR_SERVER_VERSION`）は app の build が埋める今のまま | app を更新すれば center も同じ版に揃う（再起動は #18 の入口） | 手動の再起動に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`・`CLAUDE.md` の Map（「center は desktop に sidecar 同梱」→「center は app に同梱し、launchd の常駐として起動」）・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に center の常駐の手順書を足す。ほかの設計書の「sidecar」の記述の読み替え | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・認証・subscription）は、段階 C の service 化と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は desktop の Rust と center の `service` subcommand）。
- A の中でも、query 群（session・remote・server・rc の読み取り）、mutation 群（session の操作・設定・login・retire）、subscription（`sessionsChanged`・`sessionMessage`・`terminalOutput`・`centerStatus`）は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。
- C は 3 つに分けられる: C1 = center の `service` subcommand（plist の生成・登録・解除。#14）、C2 = desktop の Rust の service 管理の command（2.7.8。`center.rs` の spawn と併存する間は同じ port を使えないので、切替の設定を持つ）、C3 = 画面（設定画面・app の入口・版の違いの表示）。C2 は C1 の入口が固まってから。C3 は C2 の command の形が決まれば並行できる。
- B は A の schema に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- D は B と C の完了後。E・F は D と並行できるが、E は未決 #6 の決定後。
- G（docs）は各段の完了ごとに、その段の分だけ。
- G（docs）は各段の完了ごとに、その段の分だけ。

## 5. 進行中の別変更との関係

`git fetch` して差分を読んだ（読むだけ。これらの branch は変えていない）。

### 5.1 `feat/app-restart-check`（app の再起動の後の状況の確認）

- 内容: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、`packages/center/src/restart-check.ts`、`packages/center/test/restart-check.test.ts`）と `origin/feat/app-restart-check-sessions`（`packages/center/src/sessions.ts` の `restore()` に `onRestoreStart` / `onRestoreFail`）。center が起動し直した session の最初の入力（`SessionStart` の後）で「app が再起動した」事を知らせ、状況の確認を促す。検出は `restore()` の中（`supervisor.start(name, { resume: true })` の直前に印を付ける）。
- この設計との関係: 実装は center の中の物で、GraphQL 化・service 化とは別の file（`restart-check.ts`・`sessions.ts` の restore・`daemon.ts` の配線）。**衝突は少ない**。
- 意味が変わる点: その設計は「center は desktop の sidecar なので、app の再起動 = center の process の起動」（1.1 の【推測】）に立つ。center が launchd の常駐になると、**app（client）を終了・再起動しても center は再起動しない**ので `restore()` は走らず、session も起動し直されない。`restore()` が走るのは center の起動の時だけ（host の起動、launchd の再起動、異常終了からの復帰、app の更新後に center を再起動した時（#18））。center は app に同梱されるので、利用者から見た「app を更新した」は、center の再起動（#18 の入口で行う）と結びつく。つまり「app の再起動の最初の 1 回」は「center の起動の最初の 1 回」に読み替わる。
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
- desktop: center の service が止まっている時に「繋がらない」を画面に出して、戻れば自動で再接続する。
- app の入口（2.7.3）: 登録なし・登録済みで稼働・登録済みで停止・稼働中で版が違う・binary が無い、の各状態で app を開き、各々の振る舞いが表のとおりになる。
- app から: 登録（`bootstrap`）→ 疎通 → 止める（`bootout`）→ 起動（`kickstart`）→ 常駐をやめる（plist 削除）の一巡が、管理者権限なしで通る。冪等（2 回登録しても壊れない）。
- app の更新（updater が bundle を置き換える）の最中・直後に、動いている center が落ちない・launchd の plist の path が有効なまま（#15）。更新後の最初の起動で center の版の違いが検出される。
- app を終了（Cmd+Q）しても center と session が動き続ける。app を開き直すと繋がる。
- cask の uninstall（`zap trash` だけで、launchd の登録を外す stanza は今無い）の後に、plist だけが残って center が起動し続けない（または起動に失敗し続けない）事。

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
- 推奨: 単位は A（center 1 つ = 1 service。`docs/concept.md` の原則 6「session ごとに重い仕組みを抱えさせない」と、web 設計 6.4 の「1 host に center を複数立てない」に沿う）。種別は A（LaunchAgent）。理由: (1) app の click だけで登録できる（user の domain なので管理者権限が要らない【推測】。LaunchDaemon は `/Library` に置くので管理者権限が要り、app からの登録に権限の確認が入る）。(2) `claude` の認証が login keychain にあり（`docs/handoff.md` の Lessons）、user の login の domain の方が keychain に届く【推測。未確認】。LaunchAgent は user が login していないと起動しない（host の再起動後に自動ログインが要る）という制約があり、これが許されない運用なら B（その場合 app からの登録の形が変わる）。web backend は別の service（web 設計 9.1）のまま。

**#3 center 単独の更新の経路（app の更新とは別に center だけ更新するか）**
- 決めてある事: center は app に同梱し、版も app と一緒（app を更新すれば center も新しくなる）。更新後の center の再起動の入口は #18。
- 案 A: app の更新だけが center の配り方（center 単独の更新の経路を作らない）。
- 案 B: A に加えて、center 単独の更新（GitHub Releases の binary を center が自分で取り替える）を足す。
- 推奨: A（利用者の指示は「app 同梱」。版が app と一緒でなくなる経路を足さない）。`follow.ts` の server の版合わせ（`BANTOU_PAIR_SERVER_VERSION`、app の build が埋める）は今のまま使える。

**#4 認証の形と、web の BFF**
- 案 A: 今と同じ 1 本の Bearer token。token は center が持つ。client は URL + token を貼る。web は BFF が token を持つ（今のまま）。
- 案 B: A に、client ごとの token（発行・失効）を足す。取り返しのつかない操作（`retireServer`・`deleteSession`）は権限を分ける。
- 案 C: A に TLS（center が終端、または前段の reverse proxy）を足す。
- web の形: (a) BFF を残す（token をブラウザに出さない。GraphQL を中継する）、(b) 薄い proxy にする、(c) ブラウザが center を直接叩く（token がブラウザに出る）。
- 推奨: 認証は A（利用者の決めてある事に新しい仕組みを足さない。今の desktop・web と同じ強さ）。web は (a)（Cloudflare Access の守りと token を隠す設計が既にある。`packages/web/server/`）。B・C は実運用で必要になった時に別の決定にする。token の生成と配り方は今のまま app が持つ（app が登録の時に token を作って center の config に書き、設定画面の接続設定で配る。「再生成」は config を書き直して service を再起動する）。別 host の desktop・web は貼り付けた URL と token で繋ぐ。

**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。

**#6 launcher 鍵（`memory`・`mcpServers` の書き込み権）の扱い**
- 前提の変化: center は app に同梱され、app が launchd に登録する。つまり app は今も「center を起動した所」であり続けられる（登録した app が、center に渡す鍵の持ち主）。
- 案 A: 今の launcher 鍵の仕組みを残す。ただし鍵は起動のたびに変わる乱数（今は sidecar の起動ごと、`packages/center/src/launcher.ts`）でなく、**登録の時に app が作って保存する鍵**（0600 の file か plist の環境変数）にする。center は鍵を env から取り出して消す（`takeLauncherKey`）。app は自分の center に繋ぐ時だけ header を付ける。別 host の center に繋ぐ desktop・web は今どおり書けない。
- 案 B: center の host の CLI（`bantou-center memory` / `bantou-center mcp`、`packages/center/src/cli.ts`・`memory-settings.ts`・`mcp-cli.ts`）だけで書く。GraphQL は読み取りだけ。
- 案 C: admin 権限の token を別に持ち、繋いだ client だけが GraphQL で書ける。
- 推奨: A（権限の仕組みを新しく足さない。今の画面の体験が変わらない）。鍵の保存先の守り（同じ user の他の process から読めるか）は【未確認】で、実装の task が確かめる。A が守れなければ B。

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

**#10 Windows**
- 案 A: center の同梱と常駐は mac の app だけを対象にする（今の cask は arm64 の macOS だけ、`packages/desktop/Casks/bantou.rb` の `depends_on`）。Windows の app は client としてだけ使い、center には GraphQL で繋ぐ。
- 案 B: Windows の center の常駐（Windows service）も扱う。
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
**#14 app から center の launchd の登録をする仕組み**
- 案 A: Rust（desktop の `src-tauri`）が plist を書き、`launchctl`（`bootstrap` / `bootout` / `kickstart` / `print`）を呼ぶ。今の `center.rs` が `kill(1)` を `std::process::Command` で呼ぶのと同じ流儀。
- 案 B: macOS の `SMAppService`（Login Items の登録。app の bundle 内の plist を OS が管理）。
- 案 C: center の subcommand（`bantou-center service install` など）が登録し、app はそれを呼ぶだけにする（Linux の host でも同じ入口を使える）。
- 推奨: C を土台に、app は A の形で呼ぶ（app が `bantou-center service …` を子 process として 1 回実行する）。理由: 登録の知識が center の binary 側に 1 つにまとまり、app の無い host（未決 #20）でも同じ手順を使える。`SMAppService` の要否（署名・OS の版の条件、`depends_on macos: :sequoia` の cask の範囲）は【未確認】で、plist + `launchctl` で足りなければ B。

**#15 center の binary の置き場（launchd が起動する path）**
- 案 A: app の bundle の中の binary を直接指す（`bantou.app/Contents/MacOS/bantou-center` 【推測。Tauri の `externalBin` は target triple を外して bundle の実行 file の隣に置く（`build-sidecar.ts:7-9` の注記）。実際の場所は【未確認】】）。
- 案 B: 登録の時に固定の場所（例: `~/Library/Application Support/jp.grrow.bantou/` の下）へ binary を写し、plist はそこを指す。app の更新と center の更新を別の操作にできる。
- 案 C: 固定の場所に symlink を置き、symlink が bundle 内を指す。
- 推奨: A。理由: 「app を更新すれば center の版も揃う」（決めてある）が最も単純に成り立つ。ただし app の更新（updater が bundle を置き換える）の最中・直後に、動いている center の実行 file がどうなるか、plist の path が有効なままかは【未確認】で、6 節で実測する。問題があれば B（写す場所の更新は app が行う）。

**#16 center が落ちた時の再起動の持ち主（launchd の `KeepAlive` など）**
- 案 A: launchd に任せる（異常終了だけ再起動する設定。値は実測して決める）。今 `center.rs` が持つ backoff・断念・ログ末尾の保持（`center.rs:44-55,233-290,451`）は app から外す。
- 案 B: launchd は起動だけ。再起動は app が見て行う（今と同じ。app が閉じていると再起動されない）。
- 推奨: A（center の寿命を app から切り離す、が趣旨）。断念の仕組みを launchd 側にどう持たせるか（再起動が連続した時の振る舞い）は【未確認】。app は launchd の状態（`launchctl print`）と GraphQL の疎通を画面に出す。

**#17 初回の登録（app を初めて開いた時）**
- 案 A: 自動で登録する（app を入れて開けば center が常駐する。今の `enabled` の既定と同じ体験）。
- 案 B: 確認の画面（「この Mac に center を常駐させる」）を出し、承諾で登録する。
- 案 C: 設定画面の switch だけ（利用者が入れる）。
- 推奨: B（launchd への登録は OS の設定に残る変更で、利用者に見える形にする。登録は 1 回の click）。今 `enabled` が `false` の既定かは【未確認】（`center.rs` の `CenterSettings` の既定値を実装の task が確かめる）。

**#18 app の更新後の center の更新（再起動）の入口**
- 案 A: app が更新後の最初の起動で、center の版（GraphQL の query）と app の版を比べ、違えば「center を再起動して更新する」を画面に出す（利用者が click。session は `--continue` で戻る、1.6）。
- 案 B: 自動で再起動する。
- 案 C: 次に center が起動し直される時（host の再起動など）まで待つ。
- 推奨: A（session の中断を利用者が選べる。利用者が決めていない待ちの仕組みを足さない）。版が違う間は画面に出し、動作は止めない（#13 の互換の範囲で動く）。

**#19 app を終了した時の center**
- 案 A: 止めない（常駐が趣旨）。
- 案 B: 止める（今の `RunEvent::Exit` と同じ）。
- 案 C: 設定で選ぶ。
- 推奨: A。止めたい時は画面の「center を止める」（`bootout`）か、「常駐をやめる」を使う。今の `lib.rs` の終了処理の `Center::stop()` は外す。

**#20 app の無い host の center の入れ方（web 用の Linux の host など）**
- 案 A: center の単独の配布物と `bantou-center service install`（#14 の案 C）で入れる。配り方は別の決定。
- 案 B: app 同梱の center だけを対象にし、app の無い host は今の手順（ソースから起動する。web 設計 6.1）のまま。
- 推奨: B（この設計の範囲は「app 同梱の center」。app の無い host の配布は利用者がまだ決めていない）。ただし center の `service install` を #14 の C で作れば、A に進める余地が残る。
## 8. 次にやる事（推奨の順）

1. 未決 #2・#4・#6・#7 と、新しい #14〜#20（app からの登録の仕組み・binary の置き場・初回の登録・更新後の center の再起動）の決定（schema と常駐の形に効く）。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A の worker を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。
3. 並行して段階 C の実測（launchd で center が `claude` の認証を通すか。app の bundle 内の binary を launchd が起動できるか）を行う。結果で #2・#14・#15 が決まる。
