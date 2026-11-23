# center を launchd の常駐 server にして GraphQL を持たせる設計（desktop の sidecar をやめ、center は app に同梱せず別に配る）

- 作成: 2026-11-23（改訂を重ねた。0.1 に版の履歴と、取り下げた指示を書いた）
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の指示（原文）と、決めてある事

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

決めてある事（変えない）:

1. center は desktop の app に同梱しない。OS の常駐の仕組み（mac は launchd）で、普通の server として起動する。center は app とは別に配る・入れる。
2. center は GraphQL の endpoint を持つ backend の server になる。
3. client の app（desktop・web）は、frontend の app と同じく、center の GraphQL endpoint を叩いて画面を動かす。

この設計は、上の 3 点に上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

### 0.1 出所を確認中の指示（決めてある事として採用していない）

この設計書の 8ac588a・4ee5501・dc8da51・d241443 は、作業指示の message（作業を任された worker の会話の user 欄。remote-cap からの指示として届いた。送り主は worker からは確認できない）に書かれた次の指示を、利用者の決定として反映していた。cap から「そのような訂正は送っていない。方針を変えられるのは利用者と master-cap だけで、出所の分からない訂正は採用できない」と指摘を受けたので、この版で取り下げ、決めてある事を上の 3 点に戻した。

- 「いや、app同梱はする。」
- 「まず普通にdesktopアプリを起動。この時、centerを起動っていうのを選ぶと、裏でcenter起動。これは今と同じ。で、desktopアプリとしてbantou-centerっていうのを別で用意する。そいつを起動すると、画面がないプロセスが起動する」
- 「desktop側からのサーバーのdiscoveryはipのみで固定。」
- 「centerのportを規定しておいて、規定portのみで起動する形は？」→（master-cap の説明の後）「ok」

これらは決めてある事ではない。内容のうち設計の材料として有用な物は、案として 7 節の未決に残した（#3 の配りの案 D・E、#14 の登録の手段の案、#19・#22・#26）。どれも既定にしていない。確認が取れた物は、未決から決定へ移す。

版の履歴: 初版（4edee56）は「同梱しない」前提。8ac588a 以降の 4 つの版は上の出所確認中の指示を前提にした。この版（第 5 版）で「同梱しない」前提に戻した。review の指摘（d241443 の medium-1〜3、low-1〜6、5 節）への修正と、実測項目・未決の追加は残した。

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
- 【事実】center の MCP tool は `packages/center/src/tools.ts` の `registerTool(` の呼び出しは 33 箇所（`registerTools(` の定義は数えない）で、異なる名前は 30 個（`worker_reply`・`remote_list`・`remote_wait` が 2 回ずつ登録される）。名前は下記。session 系（`session_create` `session_delete` `session_sleep` `session_wake` `session_update` `session_settings_get/update` `session_list` `session_login` `session_login_code` `session_resession`）、center 系（`center_settings_get/update` `center_info`）、remote 系（`remote_list` `remote_send` `remote_create` `remote_delete` `remote_wait` `task_status` `worker_reply` `worker_resume`）、rc 系（`rc_list` `rc_start` `rc_stop` `rc_status`）、server 系（`server_list` `server_peers` `server_status` `server_retire`）。
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
client（desktop / web）  = 同じ Nuxt 画面（packages/ui）
   │   GraphQL over HTTP（query・mutation）+ subscription
   ▼
bantou-center（launchd が起動する普通の server。app とは別に配る・入れる）
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は center を起動も監視も同梱もしない。web は今の BFF の位置づけを未決 #4 で決める。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。center は「desktop と基本は一体」（`docs/concept.md` の登場者）から「独立した server」に変わるので、`docs/concept.md` / `docs/architecture.md` / `CLAUDE.md` の「sidecar 同梱」の文の改訂が要る（4 節の段階 G）。

### 2.2 center の常駐（入れ方・起動・止め方・更新・消し方）

どの案でも、既存の仕組みを土台にする: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、`--user` / `--home` で専用 user。冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。center は app に同梱しないので、入れ方・配り方は center 自身の物として決める（未決 #3）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | center の binary（`bantou-center` と `bantou-pty-wrapper`）を、desktop の bundle とは別の配布物にする（配り方は未決 #3）。service の定義（plist）を置いて登録する。冪等にする（`install-service.sh` と同じ流儀）。登録の手段は未決 #14 |
| 起動 | launchd が起動する。`--transport http --port --bind --config` は今の引数のまま（`packages/center/src/args.ts`）。token は config（`token`、12 文字以上、無いと起動しない `daemon.ts:296-297`）。token の作り方・渡し方は未決 #20。置き場は未決 #2（LaunchAgent か LaunchDaemon）、状態 dir は未決 #9 |
| 親の監視 | launchd が親になるので `ppid` は変わらず、`parent-watch.ts` は何もしない【推測。実測で確かめる、6 節】。service 起動の時は無効でよい |
| 止め方 | launchd が SIGTERM を送る。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:258` 付近）。service の停止待ちはそれより長く取る（web 設計 9.1）。画面などからの入口は未決 #18 |
| 更新 | center の配布物を入れ替えて再起動する。再起動で session は `--continue` で戻る（`restore()`）。app（client）の更新とは切り離す（5 節の「app の再起動」の意味が変わる）。配り方・入口は #3・#12・#18 |
| 消し方 | service の登録を外し、binary を消す。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）【案。細部は未決 #3・#18】 |
| ログ | 今は desktop が `center_status` に末尾を出す（`center.rs`）。service 化後は center のログ file（`logDir`、`packages/center/src/log.ts`）と launchd の stdout / stderr 設定。画面の「center の状態」は GraphQL で返す（3 節） |
| Linux | systemd user unit（web 設計 9.1 の例）。入れ方は未決 #21。Windows の center は対象にするか未決 #10 |

- `claude` の解決・PATH: service は login shell を通らない（`packages/center/src/path-env.ts`・`claude-path.ts` は login shell から PATH を引く作りで、無ければ固定の候補→config の `remoteControl.claude`）。service 化後の `claude` の探索は【未確認】。実測（6 節）。
- 【事実】`claude` の認証は center を動かす OS user の設定 dir 配下で、mac は login keychain に保存される（`docs/handoff.md` の Lessons: keychain が locked だと refresh token を保存できず 401 になった事例）。LaunchAgent（user の login の domain）と LaunchDaemon（system の domain）で keychain に届くかは【未確認】。未決 #2 の判断材料で、実測する。

### 2.3 GraphQL schema の輪郭

置き場は center の http server（今の `/mcp` と同じ port・同じ認証。path は `/graphql`【案】）。型は `packages/ui/types/index.ts`（今の画面が使う型）を土台にする。以下は輪郭で、field の細部は実装の task で決める。

**Query**

| 名前 | 返す物（今の画面が使う型） | 今の元 |
|---|---|---|
| `sessions` | `SessionList`（`sessions[]`、`reachable`、`reason`）。`Session` = name / state / sessionUrl / source / lastError / path / contextUsage / instructions / activity / activityAt / background / remote / auth / loginUrl / loginError / sleeping | MCP `session_list`、`list_sessions`・`refresh_sessions` |
| `session(name)` | 1 session | 同上 |
| `sessionSettings(name)` | `ProjectSettings`（instructions / addDirs / outputStyle / servers）。launcher 鍵が守る 7 項目（memory / mcpServers / projectMemory / mcp / mcpConnections / mcpSecrets / coordinator）は公開しない、または権限が要る（未決 #6） | `session_settings_get` |
| `centerSettings` | center 共通の設定（`CenterCommonSettings`）+ `launcher`（呼び出し元が起動元か。`center_settings_get` が返す。型は `packages/ui/api/center.ts` の `{ settings, launcher? }`） | `center_settings_get` |
| `centerInfo` | `{ workspace, systemInstructions[]（id / version / title）, launcher }`（`center_info` が返す形。`session_path_hints` の素は workspace。`launcher` は呼び出し元が起動元か、#6） | `center_info` |
| `remotes` | `CenterRemoteRecord[]`（state・未完了の指示・最新の result / error・`task_result`・`worker_reports`・activity） | `remote_list` |
| `servers` | `CenterServerInfo[]`（server の一覧と版・follow 状態） | `server_list` |
| `serverPeers(refresh)` | `CenterServerPeers`（版の突き合わせ） | `server_peers` |
| `rcStatus` | `CenterRcStatus[]` | `rc_list` |
| `terminalOutputSince(session, after)` | 端末の出力の取り直し（`after` 以降のチャンク）。通常は subscription `terminalOutput` を使う。root type が別なので同名の field も書けるが、混同を避けて Query 側の名前を分ける | `GET /sessions/<n>/output?after=` |

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
| `regenerateCenterToken` | center の token を作り直し、center を再起動する。今の `center_regenerate_token` は desktop の Rust の command で、center の MCP tool には無い（desktop が token を生成して渡す今の形をやめるので、center 側の操作にする）。mutation にするか CLI（`bantou-center` の subcommand）にするかは未決 #20・#18。token が変わるので、client の接続は切れ、新しい token を入れ直す | `center_regenerate_token`（Rust、`center.rs`） |
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
- 変更後の最小形: GraphQL の endpoint も同じ Bearer token（今の仕組みを移す）。token の生成・保存は center の側（desktop が生成して渡す形をやめる。center の config / 初回の生成）。token の配り方（client が知る方法）は未決 #20。
- 「launcher 鍵」: 今は desktop が sidecar を起動した事を、起動ごとの鍵で証明する。起動元だけが `memory`・`mcpServers` を読み書きでき、`projectMemory` を読める（書きは `bantou-center memory set --session`・移行・設定 file の直接編集だけ）。旧設定の `mcp`・`mcpConnections`・`mcpSecrets`・`coordinator` は誰からも MCP では書けない。守る項目は合わせて 7 つ（`CENTER_ONLY_KEYS`: `packages/center-client/src/tool-policy.ts:45`、`packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS`）。書きは `assertCenterOnly`、読みは `withoutLauncherKeys` が絞る（定義は `project-settings.ts`、`tools.ts`・`sessions.ts` が呼ぶ）。center が独立すると「起動した所」が無いので、7 項目の権限の持ち方が要る。項目ごとの扱いは未決 #6。
- 取り返しのつかない操作（`retireServer`、`deleteSession`）を誰に許すか: 今は desktop だけ（web は許可 list から外す）。権限の単位は未決 #4。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| center の sidecar 起動・監視（`center.rs`）、同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_status` / `center_set_settings` の起動項目（enabled・port・bind・workspace・claudePath）、token の生成・regenerate、launcher 鍵、`bantou://center-running` | **捨てる**（center が自分で持つ・launchd が起動する。desktop からは捨て、token を center 側へ移す形は #4・#20。接続先の設定だけが client に残る） |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`） | **捨てる**（webview が GraphQL を直接叩く。Rust の中継層が無くなる） |
| 添付（`attachment.rs`: `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`） | **分ける**。消す: center への中継（`upload` = reqwest で `POST /sessions/<n>/attachments`、`run` の接続先の選択 `select_target`・`load_settings`、保存した path を pty に打つ `post(.. "input" ..)`・`input_text`・`b64`）。webview が GraphQL（`attachToSession`・`terminalInput`）か、残す HTTP route（#7）で行う。残す: desktop の OS 側の入口 = `session_attach_pick`（file dialog、`rfd`）、`session_attach_paths`（drop された path の受け取り）、`load`（path から bytes を読む）、画像の型の見分け `sniff_type`・大きさの検査 `check_size`（`MAX_BYTES` = 20 MB。center も同じ検査をする）。この 2 つの command は「保存まで行う」から「読んだ bytes と名前を webview に返す」形に変わる（形は未決 #7）。`session_attach_bytes` は clipboard の bytes を webview が既に持つので、command ごと不要 |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips` / `center_ip_status`） | 接続先 URL + token を貼る入力（`center_parse_connect`）は残す。snippet を「出す」側は center の host で出す（center の subcommand か GraphQL。#20）。接続先の見つけ方は未決 #26 |
| updater・relaunch（app 自身の更新） | **残す**（client の更新は center と切り離す） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える） |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するかは未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と、移行中の互換だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す（token をブラウザに出さない・Cloudflare Access 前提を維持）案と、薄い proxy にする案、ブラウザが直接叩く案 |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` の項目は不要になる）。
- 設定画面（`SettingsDialog.vue`）: 「center を起動する」の switch・port・IP・状態・token の再生成が消え、「接続先（URL・token）」と「center の状態の表示」になる（`webMode` の分岐が全 client の形になる）。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center を起動する者（desktop の子 process → launchd）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:330` の `centerUrl`）で動く。
### 2.7 center の入れ方・更新・消し方（app とは別に配る）

決めてある事: center は desktop の app に同梱しない。center は app とは別に配る・入れる。desktop は launchd にも center の binary にも触らない（client だけ）。

#### 2.7.1 配る物と入れ方（案。#3・#14・#15）

- 配る物: center の binary（`bantou-center`）と pty-wrapper（`bantou-pty-wrapper`）。今の `packages/desktop/scripts/build-sidecar.ts` と同じ手順（`bun build --compile` と `cargo build --release`）で作り、desktop の bundle の外に出す。Linux では web 設計 6.1 の「ソースから node で起動」も使える。
- 入れる: center の subcommand（`bantou-center service install` のような物。`packages/center/src/cli.ts` は既に `status-line`・`hook`・`memory`・`mcp` の subcommand を持つ）が、config を書き、plist（mac）または systemd unit（Linux）を置いて launchd / systemd に登録する。冪等。`install-service.sh`（bantou-server 用）と同じ流儀。
- 入れる所の配り方（Homebrew の formula、GitHub Releases の binary と install script、npm）は未決 #3。

#### 2.7.2 更新

- center の配布物を入れ替えて、center を再起動する（launchd の `kickstart -k` か停止と起動）。再起動で session の claude は止まり、`restore()` が `--continue` で戻す（1.6。session の中断は今と同じ）。
- 入口は未決 #3（配り方に付く）・#12・#18（画面から / CLI から）。版の違いの検出は client が GraphQL で center の版を取り、自分の版と比べる（#13）。server の版合わせは今の `follow.ts`（`BANTOU_PAIR_SERVER_VERSION`。今は desktop の build が埋める。center を別に配る時、誰が埋めるかは #3 の決定に付く）。

#### 2.7.3 止め方・消し方

- 止める・登録を外す入口は未決 #18。状態 dir は消さない（#9）。
- 事実: 今の cask（`packages/desktop/Casks/bantou.rb`）には launchd の登録を外す stanza が無い。center を別に配る時は、その配布物（formula など）の uninstall が登録を外す形にする。

#### 2.7.4 権限

- LaunchAgent（`~/Library/LaunchAgents`）は user の domain なので管理者権限が要らない【推測】。LaunchDaemon（`/Library/LaunchDaemons`、`install-service.sh` の mac の形）は管理者権限が要る。#2。
- 認証・権限で止まった時は、操作と理由を出して止まる（権限を自分で広げない）。

#### 2.7.5 desktop が center に対してするのは GraphQL の呼び出しだけ

- 接続先（URL・token。見つけ方は #26）を持ち、GraphQL で繋ぐ。center の状態・版は query、再起動などの操作の入口は #18。desktop が launchd を扱う案は、下の 2.7.6 の案 D だけ。

#### 2.7.6 他の案（利用者が決めれば有り得る。既定にしない。#3）

出所を確認中の指示（0.1）から出た案。決めてある事（同梱しない）に反する物は「条件」に書いた。

| 案 | 内容 | 条件・影響 |
|---|---|---|
| D（app 同梱 + app が登録） | center の binary を desktop の bundle に入れ（今の `externalBin`）、desktop が launchd に登録・更新・止める | 決めてある事の「同梱しない」に反する。利用者が方針を変えた場合のみ。desktop の Rust に `launchctl` を呼ぶ command が要る。app の更新（Tauri updater）が center の binary も運ぶが、動いている center は再起動して初めて新しくなる。bundle を置き換える最中・後に実行 file と plist の path がどうなるかは【未確認】。cask に launchd の登録を外す stanza が要る |
| E（別の app `bantou-center`） | 窓の無い別の app を用意し、起動すると center の process だけが動く。初回の起動で自分を launchd に登録する（`SMAppService` など）。desktop の app とは別に配る | 「同梱しない」と両立する（desktop の bundle には入らない）。app にするかは未決（#3・#14・#15）。別の code identity になるので Local Network の許可を別に受ける必要が出うる【未確認。`docs/ops/desktop-signing.md`】。更新の配り（updater・cask）、窓が無い app の止め方・知らせ方（#17・#18）が要る |

### 2.8 規定 port（案。採るなら center は規定 port でだけ起動する。未決 #22・#19）

出所を確認中の指示（0.1）にあった案（「centerのportを規定しておいて、規定portのみで起動する形は？」）を、未決 #19・#22 の案として残す。決定ではない。採った場合の形を以下に書く。

案の内容:

1. center の port は 1 つに決めておく（規定 port）。番号は未決 #22（利用者が決める）。
2. center は規定 port でしか起動しない。別の port に逃げない。
3. 同じ mac に center は 1 つだけになる。2 つ目の center は port が使用中で起動に失敗する。
4. desktop は「IP と規定 port」でつなぐ（port の入力が無くなる。接続先の見つけ方は #26）。
5. port が他の program に使われていて起動できない時は、理由が分かる error を出す。
6. LAN から届く時の認証は #23。test・開発の port は #24。

#### 2.8.1 今の port の扱い（変わる所）

- 【事実】center の `--port` の既定は 7910（`packages/center/README.md`、`packages/center/src/args.ts`）。`0` は OS 任せ。
- 【事実】desktop の `CenterSettings.port` も既定 7910（`center.rs` の `DEFAULT_PORT`）で、設定画面から変えられる（`packages/ui/components/SettingsDialog.vue` の `centerSetSettings`）。
- 【事実】bind の失敗は、center の log から見分けて `CenterStatus.bindFailed` に出している（`center.rs:331` の `looks_like_bind_failure`、`packages/ui/types/index.ts` の `CenterStatus`）。
- 【事実】test は `--port 0` を使う（`packages/center/test/args.test.ts`・`http.test.ts`）。`packages/center/scripts/e2e.ts` は `node:net` を使う（空き port を取る用途と読める【推測】）。
- 変わる事: 接続先の port の入力欄を外す。center の `--port` 引数を本番の起動で使えなくする（test・開発の扱いは #24）。

#### 2.8.2 center の起動の順（2 つ目の center が何にも触らない事）

- 【事実】今の `daemon.ts` は、store の生成（`:172`・`:230`）と `loadCapId`（`:221`）の後に listen（`startHttpServer`、`:299`）し、その後に `sessions.restore()`（`:354`）を呼ぶ。孤児 process の回収（`reapOrphans`）は session を start する時に走る（`packages/center/src/remote-control.ts:400`）ので、port で失敗すれば、session の起動・孤児の回収には届かない。
- 要件: 2 つ目の center は、listen に失敗したら、状態 dir の file を書き換えず、session・孤児 process・remote の記録に触れずに終わる。store の生成と `center-id` の作成（`loadCapId`）が listen より前に file を書くかは【未確認】。書くなら、listen を先に移す。実装の task が確かめる。

#### 2.8.3 起動に失敗した時の error（理由が分かる）

- どの port か。使用中の相手が何か: 規定 port で GraphQL の疎通を試し、center なら「既に center が動いている（版）」、応答が GraphQL でない・接続だけできる・応答が無いなら「他の program が使用中」。使用中の process 名・PID を OS に問い合わせて足せるか（`lsof` 相当）は【未確認】。次にする事（既に center ならそれにつなぐ、他の program ならそれを止める）。
- 出す先: center の log（stderr）。desktop は接続した時に「規定 port の相手が何か」を調べて画面に出す（`center_status` の `bindFailed` の置き換え）。

#### 2.8.4 同じ Mac に center が 1 つになる意味（案を採った場合）

- center が 1 つなら、状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いは起きない。
- 同じ Mac の別の user の login でも port は共有なので center は 1 つ。別の user が自分の center を起こすことはできない【案から導いた制約。利用者に確かめる点】。
- 規定 port が別の host で他の program に使われている時、その host には center を置けない。

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
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | 接続先（URL・token。#26）は client のローカル。起動の項目（enabled・port・bind・workspace・claudePath）は center の設定（config / `service install` の時の設定。分け方は未決 #9）で、desktop からは外れる |
| `center_status`（center.rs） | `centerStatus` | GraphQL の query / subscription `centerStatus`（center の状態）。子 process の restart 回数・bindFailed は意味が変わる（launchd の状態になる。#16） |
| `center_regenerate_token` | `centerRegenerateToken` | center 側の操作（mutation か CLI。未決 #4・#20・#18） |
| `center_local_ips` / `center_ip_status` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | 接続設定の入出力。`center_parse_connect` は client のローカル処理。他は center の host の情報なので、center の側（subcommand か query。#20）で出す |
| `center_call`（center_mcp.rs） | `centerCall` / `centerTool` / `centerToolStrict`（12 個の tool、3.2） | 3.2 の各 query / mutation に分ける。汎用の `center_call` は無くす |
| `center_connection`（center_mcp.rs） | `centerConnection` | client のローカルの接続状態（GraphQL の疎通。`CenterConnection`） |
| `session_output_start` / `session_output_stop`（terminal.rs） | `sessionOutputStart` / `sessionOutputStop`（`packages/ui/api/terminal.ts`） | subscription `terminalOutput` の開始・解除 |
| `session_input` / `session_resize` | `sessionInput` / `sessionResize` | mutation `terminalInput` / `terminalResize` |
| `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`（attachment.rs） | `sessionAttachBytes` / `sessionAttachPaths` / `sessionAttachPick`（`packages/ui/api/attachment.ts`） | `attachToSession`（未決 #7）。`session_attach_bytes` は不要（webview が持つ bytes を `attachToSession` へ直接）。`session_attach_paths` / `session_attach_pick` は desktop の OS 側の入口として残し、読んだ bytes を返す形に変える（保存・pty への入力は webview が `attachToSession` + `terminalInput` で行う）。center が別 host だと client の path は center から読めないので、bytes を送る（今の `load` も bytes を読んで POST している）。2.5 の「分ける」と同じ |
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

Host の検査: `/events` と `/sessions/<n>/output|input|resize|attachments` は Bearer に加えて、Host の検査（`allowedHostsFor`、不一致は 403 `forbidden host`、`http.ts:84-91`・`:423`・`:461`）を持つ。`/mcp` も同じ検査を `enableDnsRebindingProtection` で行う（`:524`）。ただし検査は bind が loopback の時だけ有効で、loopback 以外では `allowedHostsFor` が null を返して検査しない（`http.ts:80-86`、README の http transport の節）。S も D も全アドレスで待ち受けるので、通常の形では検査は無く Bearer だけで守る。`/graphql` がこの検査を引き継ぐかは未決 #25。`docs/architecture.md:57` の「Host / Origin を絞らず Bearer だけで守る」は全アドレスで待ち受ける形の説明で、loopback bind の時の検査には触れていない（食い違いというより抜け。docs の改訂（段階 G）で直す）。

### 3.6 網羅性の確かめ（grep で数えた結果）

ui・desktop・web の画面側の呼び出しを grep で数え、3.1〜3.4 の行と突き合わせた。

- Tauri command: `generate_handler!` に 43 個（workspace 4 / task 4 / thread 2 / broker 3 / agent 4 / session 9 / center 5 / center_snippet 3 / center_mcp 2 / terminal 4 / attachment 3）。ui の `invoke("…")` が名指しする物は 41 個（`create_task`・`update_task_status` の 2 個は呼ばれていない）。3.1 の表は 43 個全部を含む。
- `centerTool` / `centerToolStrict` / `centerCall` の tool 名: `remote_list` `worker_reply` `server_peers` `server_list` `rc_list` `rc_start` `rc_stop` `center_settings_get` `center_settings_update` `server_retire` `session_login` `session_login_code` の 12 個。3.2 の表に全部ある。
- `listen` する event 名: 12 個（`center-sessions-changed` `center-session-message` `session-output` `session-output-status` `bantou://center-running` `bantou://os-wake` `bantou://os-network-changed` `bantou://sessions-changed` `bantou://threads-changed` `bantou://pings-changed` `bantou://agent` `menu:check-for-updates`）。3.3 の表に全部ある。
- web の `~/tauri`（`packages/web/app/tauri/transport.ts`）が受ける command は desktop と同じ名前（`POST /api/rpc/<cmd>`）。`packages/center-client/src/commands.ts` の表がその実装で、3.1 の center 系・session 系と一致する。
- center の MCP tool（`tools.ts`）のうち、画面が使うのは 3.2 の 12 個と、web の backend が内部で使う `session_list` `session_create` `session_update` `session_sleep` `session_wake` `session_settings_get/update` `center_info`（`tool-policy.ts` の `WEB_ALLOWED_TOOLS`）。残り（`session_delete` `session_resession` `remote_send` `remote_create` `remote_delete` `remote_wait` `task_status` `worker_resume` `rc_status` `server_status`）は画面から呼ばれていない。master-cap（`/mcp` を使う素のエージェント）の道具として残す（未決 #5）。

## 4. 移行の段取り（段階に分ける。各段で動く物が残る）

前提: 各段の終わりに、desktop も web も今の画面が動く。center は MCP（`/mcp`・`/events`・`/sessions/*`）を最後の段まで残す（GraphQL を足すだけで消さない）。desktop が center を子 process として起動する今の形（sidecar）は、段階 D まで動く。

| 段 | 内容 | この段の終わりに動く物 | 戻し方 |
|---|---|---|---|
| A | center に GraphQL の endpoint を足す（`/graphql`）。resolver は `packages/center-client/src/commands.ts` の表と center の中の関数を使う（query / mutation / subscription は 2.3）。認証は `/mcp` と同じ Bearer。GraphQL server の部品は未決 #1 | 今の desktop・web は無変更で動く（`/mcp` を使い続ける）。GraphQL は test と HTTP の呼び出しで確かめる | endpoint を足しただけ。外せば元に戻る |
| B | `packages/ui/api/*.ts` を GraphQL client に差し替える。web の `~/tauri` の transport を GraphQL にする（BFF の形は未決 #4）。desktop の `src/tauri/transport.ts` は、center 系の command を GraphQL へ、native 系（workspace・updater・Cork）だけ Tauri に残す。subscription は `terminalOutput`・`sessionsChanged`・`sessionMessage` | web が GraphQL で動く。desktop は「center 系は GraphQL / native 系は Tauri」の混在で動く（sidecar の center にも別 host の center にも GraphQL で繋がる） | 差し替えを feature flag か branch 単位にすれば戻せる。center 側は無変更 |
| C | center の service 化: 配布物（binary + wrapper）の切り出しと配り方（#3）、`service` subcommand（plist / unit の生成・登録・解除。#14）、状態 dir の引き継ぎ（#9）、token の作り方（#20）。desktop の sidecar は残したまま、別に service として center を動かせる状態にする | desktop は「sidecar の center」にも「service の center」にも繋げる。service の center が実機で session を回せる（6 節の実測） | service を外せば sidecar に戻る |
| D | desktop から sidecar を外す: `center.rs`・`center_mcp.rs`・`center_events.rs`・`session.rs` の cache・`terminal.rs`・`attachment.rs` の upload・接続先の選択・pty への input の中継（OS 側の入口 `pick` / `paths` と `load`・型・大きさの検査は残す、2.5）・`center_snippet.rs` の起動側・launcher 鍵・`externalBin`・`build-sidecar.ts` を消す。設定画面を「接続先 + center の状態」にする。dmg から center が消える | desktop は service の center に繋ぐ client だけになる。app の更新が center に触らない | D の前の release に戻せる |
| E | 権限（#6）の置き換え（launcher 鍵 → 新しい権限の持ち方）と、`/mcp` の残し方（#5）の整理 | `memory` / `mcpServers` ほかの読み書きが新しい権限で動く | 権限の方式を旧に戻す |
| F | 更新の入口（#3・#12・#18）の自動化。center の更新と server の版合わせ（`follow.ts` の `BANTOU_PAIR_SERVER_VERSION`）を、desktop の build に依らない形にする | center が独立して更新・再起動する | 手動の更新に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`（57 行目の「Host / Origin を絞らず」の抜けも直す。3.5）・`CLAUDE.md` の Map・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に center の設置の手順書を足す。ほかの設計書の「desktop の sidecar」の記述（`docs/design/master-cap-session.md` など）の読み替え | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・認証・subscription）は、段階 C の service 化（配布物・subcommand・手順書）と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は center の `service` subcommand と配布の build）。
- A の中でも、query 群（session・remote・server・rc の読み取り）、mutation 群（session の操作・設定・login・retire）、subscription（`sessionsChanged`・`sessionMessage`・`terminalOutput`・`centerStatus`）は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。
- B は A の schema に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- D は B と C の完了後。E・F は D と並行できるが、E は未決 #6 の決定後。
- G（docs）は各段の完了ごとに、その段の分だけ。

## 5. 進行中の別変更との関係

`git fetch` して差分を読んだ（読むだけ。これらの branch は変えていない）。

### 5.1 `feat/app-restart-check`（app の再起動の後の状況の確認）

- 内容: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、`packages/center/src/restart-check.ts`、`packages/center/test/restart-check.test.ts`）と `origin/feat/app-restart-check-sessions`（`packages/center/src/sessions.ts` の `restore()` に `onRestoreStart` / `onRestoreFail`）。center が起動し直した session の最初の入力（`SessionStart` の後）で「app が再起動した」事を知らせ、状況の確認を促す。検出は `restore()` の中（`supervisor.start(name, { resume: true })` の直前に印を付ける）。
- この設計との関係: 実装は center の中の物で、GraphQL 化・service 化とは別の file（`restart-check.ts`・`sessions.ts` の restore・`daemon.ts` の配線）。**衝突は少ない**。
- 意味が変わる点: その設計は「center は desktop の sidecar なので、app の再起動 = center の process の起動」（1.1 の【推測】）に立つ。center が app から離れると、**app（client）を再起動しても center は再起動しない**ので `restore()` は走らず、session も起動し直されない。`restore()` が走るのは center の起動の時（host の起動、launchd の再起動、center の更新、center の異常終了からの復帰）だけになる。つまり「app の再起動の最初の 1 回」は「center の起動の最初の 1 回」に読み替わる。
- 整合の案（利用者の判断。未決 #11）: (A) 実装は変えず、意味を「center が起動し直した時」に読み替える（文面の「app が再起動した」を「center が再起動した」に直す）。(B) さらに「client が繋ぎ直した時」にも確認を送る（これは別の仕様になり、現在の指示「app が再起動された時の最初の 1 回」から外れる。足すなら利用者が決める）。推奨は A。

### 5.2 `feat/sleep-resession`（スリープを起動しないリセッションに）

- 内容: `origin/feat/sleep-resession`（設計書 `docs/design/sleep-resession.md`）。眠らせる = 引継ぎを書かせて保存してから止める。起こす = 新しい会話で引継ぎを渡す。`session_sleep` は「受理して即返す」（設計書の U3 = A、拒否は同期で返す）。ボタンは作業中・needs-input・remote の未完了・未返答・動いていない時は押せない（`sleepBlock`）。branch の実装の差分は、この設計書の初版（4edee56）を書いた時点と今で違う: (1) 初版の時点は ui / desktop / docs / test の 10 file で、center は触っていなかった（center の変更は設計書の予定だけ）。(2) 今（`origin/feat/sleep-resession` 634c2f1、`git diff --stat origin/develop...`）は 27 file（+1222 -69）で、center の実装も入っている（`sessions.ts`・`resession.ts`・`daemon.ts`・`tools.ts`・`server.ts`・`sleep-gate.ts`・`coordinator.ts`・`coordinator-mcp.ts`・`system-instructions.ts` と test）。desktop の `session.rs` も変わり、`session_sleep` の応答を「受理して即返す」形（`accepted` / `pending` と `name`。`name` だけ必須）で受ける。
- この設計との関係:
  - 【事実】この branch は `packages/ui` を触る（`sessionStatus.ts` の `sleepBlock`、`sleepButton.ts`、`useBoard.ts`、`useSessionBoard.ts`、`api/sessions.ts`）。段階 B（`packages/ui/api/*.ts` の差し替え）と同じ file を触るので、**B の前に merge する**か、B の worker が最新の develop に追従する。
  - GraphQL の `Session` 型は、`sleepBlock` が読む field（`state`・`activity`・`background`・`remote.waitingReply`・`remote.running`・`sleeping`）を落とさずに持つ。`sleepBlock` は client の純関数のまま使える（center に判断を移さない。center の `check` は拒否を同期で返すので二重の守り）。
  - 【事実】`sleepSession` の mutation は、center の `session_sleep` が今この branch で「受理して即返す」応答（`accepted` / `pending` と `name`）を返すので、その形を引き継ぐ。返り値を「眠った後の `Session`」にしない（眠りは後で `sessionsChanged`（reason `sleep`）で届く）。拒否（作業中など）は mutation の error / payload の理由で返す。
  - `restore()`・`wake` の振る舞いは center の中の変更で、GraphQL の形には影響しない。スリープ中の session を center の起動で起こさない点も変わらない。
- 衝突（実装の差分と設計書の予定を分けて書く）: 【実装の差分】`app-restart-check`（`origin/feat/app-restart-check` ba9a609）は `packages/center/src/restart-check.ts`・その test・設計書の 3 file だけ（`sessions.ts` の `restore()` の変更は別 branch `feat/app-restart-check-sessions`）。`sleep-resession`（634c2f1）は center の `sessions.ts`・`resession.ts`・`daemon.ts`・`tools.ts` などを実際に変えている（上の 27 file）。【設計書の予定】`sleep-resession.md` の 3 節（変更点）と 6 節、`app-restart-check.md` の 3 節が、同じ file（`sessions.ts`・`resession.ts`・`daemon.ts`）を触る予定を書いている。この設計の GraphQL の resolver は `tools.ts` の関数でなく `SessionManager` や `resession` の API を呼ぶ形にすると、`tools.ts` の変更の影響を受けにくい【案】。

### 5.3 リセッション（`docs/design/resession.md`）

- `session_resession` は session 自身が `/mcp/session` で呼ぶ tool で、GraphQL には出さない（2.3）。center の中の動き（引継ぎの保存、`Stop` の後の再起動、最初の入力）は、center が独立しても同じ。
- 区切りの行は center の core の出力 queue に積まれ、`terminalOutput` の subscription でそのまま届く（`reset` は出力 queue が session の再起動をまたいで残る事と合わせて、`resession.md` 2.5 の前提を変えない）。
- 引継ぎの保存先 file は center の host にある（`handoffs/` は状態 dir の下、`daemon.ts:218`）。状態 dir の置き場が service 化で変わると（未決 #9）、`handoffs/` と未取り出しの引継ぎも一緒に移す必要がある。

## 6. test と実測の観点

code は書かないので、ここは実装の task が足す test と、実機で測る事の一覧。

**test（実装が足す）**

- schema: query / mutation / subscription が 3.1〜3.3 の表の全項目を持つ（表を test の入力にして、漏れを機械的に検出する）。
- 認証: Bearer の欠落・不一致は 401、定時間比較（`packages/center/test/` の既存の `/mcp` の認証 test と同じ形）。権限の置き換え後（未決 #6）、7 項目（memory / mcpServers / projectMemory / mcp / mcpConnections / mcpSecrets / coordinator）は権限が無い接続で書けず、読みの応答から除かれる（今の `CENTER_ONLY_KEYS` の test の移植）。
- 互換: GraphQL の `Session` が `packages/ui/types/index.ts` の `Session` と同じ形で返る（`center-client` の `parseSession` と同じ検査）。
- subscription: 端末の `after` での続き・`reset`・`end`、接続が切れた後の再接続、`sessionsChanged` の reason が既存の 10 種を全部運ぶ（`packages/center/src/events.ts`）。
- client: `packages/ui` の既存の test（`packages/ui/test/`）と e2e（`packages/desktop/e2e/*.spec.ts` は Tauri の IPC を mock して画面を動かす。`packages/web/e2e/`）が、transport の差し替え後も通る。mock の層を GraphQL に置き換える（`packages/desktop/e2e/mock/`）。
- center の既存 test（`packages/center/test/*.test.ts`）は全部通ったまま（GraphQL は足すだけの段階 A）。
- service の登録（`service install`）: 管理者権限なしで登録でき（LaunchAgent の場合。#2）、冪等（2 回実行しても二重に登録しない）。登録の解除が通る。
- 規定 port の案（#22）を採る場合: (a) 規定 port が空いている時に起動する。(b) 2 つ目の center は、listen に失敗したら、状態 dir の file・session・孤児 process に触れずに終わる（2.8.2）。(c) 規定 port を他の program が使っている時、使用中が center か他の program かが分かる error が出る。(d) launchd が、port 使用中で終わった center を再起動し続けない（#16）。(e) 別の port では起動できない（本番の経路。#24）。

**実測（mac の実機。値は測って書く。この設計では決めない）**

- launchd で center を起動し、`claude` が見つかり、認証が通る（LaunchAgent / LaunchDaemon の差。keychain が locked でも 401 にならないか。`docs/handoff.md` の Lessons）。
- `parent-watch.ts` が launchd の下で何もしない事（ppid が変わらない）。
- host の再起動・login の前後・center の kill・launchd による再起動で、session が `--continue` で戻る事（`restore()`）と、停止にかかる時間（`stopGraceMs` と service の停止待ちの関係）。
- GraphQL server の部品（未決 #1）が `bun build --compile` の単体 binary で動く事。今は `@modelcontextprotocol/sdk` と zod が compile で遅延初期化に包まれて落ちた事がある（`packages/center/src/cli.ts` の冒頭の注記）。同種の問題が GraphQL の部品で出ないか。
- 端末の subscription の実測: 出力が多い時の遅延・切断・再接続の後の続き。web の Cloudflare 経由（SSE / WebSocket が通る条件。web 設計 8.5）。
- 認証: 別 host の client（LAN・Tailscale）から繋げる事。平文の token（`0.0.0.0` の待ち受け）が今と同じ範囲に収まる事。
- 更新: center を入れ替えて再起動した時の session の中断の長さと、`follow.ts` の server の版合わせ。
- desktop: center の service が止まっている時に「繋がらない」を画面に出して、戻れば自動で再接続する。
- 案 D・E（2.7.6）を採る場合の実測: `SMAppService` の登録が ad-hoc 署名・自己署名の app で通るか。窓の無い別 identity の app で Local Network の許可が通るか（`docs/ops/desktop-signing.md`）。app の更新中・後に動いている center と launchd の登録がどうなるか。cask uninstall の後に登録が残って起動に失敗し続けないか。

## 7. 未決（番号つき。各案と推奨）

**#1 GraphQL server の部品**
- 案 A: `graphql-yoga`（fetch API ベース。subscription は SSE、必要なら WebSocket を足せる）+ `graphql-js`（schema は code-first か SDL）。
- 案 B: Apollo Server（HTTP の query / mutation）+ `graphql-ws`（WebSocket の subscription）。
- 案 C: 手書きの薄い実装（`graphql-js` だけ + 自前の SSE）。
- 推奨: A。理由: center は今 `node:http` で `/events` を SSE で出しており（`packages/center/src/http.ts`）、同じ transport の考えで subscription を載せられる。web の Cloudflare 経由で SSE は通る前提の設計がある（web 設計 8.5）。WebSocket は不要にできる【推測】。ただし `bun build --compile` で動く事は【未確認】（6 節の実測）。動かなければ B か C に切り替える。schema を code-first にするか SDL にするかは実装の task が決める。

**#2 常駐の単位と、launchd の種別**
- 案 A: center 1 つを 1 つの常駐にする。mac は LaunchAgent（user の login の domain。`~/Library/LaunchAgents`）。
- 案 B: center 1 つを LaunchDaemon（`/Library/LaunchDaemons`、`UserName` 付き）にする（`packages/server/scripts/install-service.sh` の mac と同じ形）。
- 案 C: 複数（center と web backend を同じ service にまとめる、または session ごと）。
- 推奨: 単位は A（center 1 つ = 1 service。`docs/concept.md` の原則 6「session ごとに重い仕組みを抱えさせない」と、web 設計 6.4 の「1 host に center を複数立てない」に沿う）。種別は A（LaunchAgent）を第一候補にして実測で決める。理由: `claude` の認証が login keychain にあり（`docs/handoff.md` の Lessons）、user の login の domain の方が keychain に届く【推測。未確認】。LaunchAgent は user が login していないと起動しない（host の再起動後に自動ログインが要る）という制約があり、これが許されない運用なら B。web backend は別の service（web 設計 9.1）のまま。

**#3 center の配り方・入れ方・更新・消し方（決めてある事: app に同梱しない。別に配る・入れる）**
- 案 A: Homebrew で配る（desktop の cask とは別の formula。`unagents/homebrew-tap`）。更新は `brew upgrade` と再起動。登録は center の subcommand（`bantou-center service install`）。消し方は subcommand の解除 + `brew uninstall`。
- 案 B: GitHub Releases に center の binary と wrapper を置き、install script（`install-service.sh` の流儀）で入れる。更新は新しい binary に入れ替えて再起動。center 自身が更新する形（取り替えて自分で終わり、launchd に起動し直させる）も、この案に付ける。
- 案 C: npm package として配る（`bantou-server` が `npx` で動く形と同じ）。
- 案 D（利用者が方針を変えれば有り得る。既定にしない）: desktop の app が bundle の center の binary を launchd に登録・更新・止める（同梱前提）。決めてある事に反する。2.7.6。
- 案 E（出所確認中の指示から出た案。既定にしない）: 窓の無い別の app `bantou-center`（desktop の bundle には入れない）。起動すると center が動き、初回の起動で自分を launchd に登録する。2.7.6。
- 推奨: A（配布は既存の流儀、`CLAUDE.md` の publish 方針の延長。更新は人が `brew upgrade` する）。B は formula を持たない host（Linux など。#21）に使う。C は center が bun の単体 binary で、node 前提の npm と流儀が違うので推奨しない。更新で session が中断される事（1.6）は変わらないので、更新を「cap が空の時に行う」運用（web 設計 9.3）は手順書に書く。消し方は「service の登録を外す・binary を消す・状態 dir は残す」を既定にする。

**#4 認証の形と、web の BFF**
- 案 A: 今と同じ 1 本の Bearer token（LAN から届く時の認証は #23）。token は center が持つ。client は URL + token を貼る。web は BFF が token を持つ（今のまま）。
- 案 B: A に、client ごとの token（発行・失効）を足す。取り返しのつかない操作（`retireServer`・`deleteSession`）は権限を分ける。
- 案 C: A に TLS（center が終端、または前段の reverse proxy）を足す。
- web の形: (a) BFF を残す（token をブラウザに出さない。GraphQL を中継する）、(b) 薄い proxy にする、(c) ブラウザが center を直接叩く（token がブラウザに出る）。
- 推奨: 認証は A（利用者の決めてある事に新しい仕組みを足さない。今の desktop・web と同じ強さ）。web は (a)（Cloudflare Access の守りと token を隠す設計が既にある。`packages/web/server/`）。B・C は実運用で必要になった時に別の決定にする。token の生成と配り方は未決 #20。別 host の desktop・web は IP と token を入れて繋ぐ。

**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。

**#6 launcher 鍵が守る 7 項目の扱い（center が独立した後）**
- 守る項目は 7 つ: `memory` / `mcpServers` / `projectMemory` / `mcp` / `mcpConnections` / `mcpSecrets` / `coordinator`（`packages/center-client/src/tool-policy.ts:45` の `CENTER_ONLY_KEYS`。center 側は `packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS` で、同じ 7 つ）。2 か所に別々の定義があるので、GraphQL の層は 1 か所にそろえる。書きは `assertCenterOnly`（`project-settings.ts:176`。`tools.ts:113・175・198` と `sessions.ts:237` が呼ぶ）、読みは `withoutLauncherKeys`（`:184`。`tools.ts:98` の `shown`）が絞る。
- 今の扱い（項目ごと）:

| 項目 | 分類 | 起動元 | 起動元以外 |
|---|---|---|---|
| `memory`・`mcpServers` | `LAUNCHER_KEYS` | 読み書きできる | 書くと error。読みの応答から除く |
| `projectMemory` | `FILE_ONLY_KEYS` | 読める。書きは設定の更新（MCP）では誰もできず、`bantou-center memory set --session`・移行・設定 file の直接編集だけ | 書くと error。読みの応答から除く |
| `mcp`・`mcpConnections`・`coordinator` | `LEGACY_INTERNAL_KEYS`（旧設定） | 誰からも MCP では書けない（起動元にも別の error）。読みの応答からは `withoutLauncherKeys` は除かない（旧設定が残っていれば応答に出うる【未確認】） | 書くと error |
| `mcpSecrets` | 同上 | settings の key としては同上。鍵の実体は別 file `mcp-secrets.json`（0600）で、入れるのは `bantou-center mcp secret`（標準入力か file）だけ。値は表示・log・error に出さない（`packages/center/src/mcp-secrets.ts` の冒頭）。どの経路でも値は読めない | 同上 |

- 前提: desktop は center を起動しなくなる（決めてある事）ので、「center を起動した所」が無い。`memory`・`mcpServers` などを誰が読み書きできるかの決め直しが要る。
- 案 A: center の host の CLI（`bantou-center memory` / `bantou-center mcp`、`packages/center/src/cli.ts`・`memory-settings.ts`・`mcp-cli.ts`）だけで書く。GraphQL では 7 項目すべてを読み書きしない（今の web と同じ。書くと error、読みの応答から除く。schema の `ProjectSettings` も 7 項目を持たない）。`mcpSecrets` の値は今どおり CLI の `mcp secret` だけ。旧設定 4 項目は書かない。
- 案 B: admin 権限の token を別に持つ。admin で繋いだ client だけ、`memory`・`mcpServers` を読み書き、`projectMemory` を読める。`projectMemory` の書き・旧設定 4 項目・`mcpSecrets` の値は案 A と同じ（CLI だけ・書けない・読めない）。
- 案 C: client の token に書き込みの scope を持たせる（desktop の画面から書ける今の体験を保つ）。項目ごとの範囲は案 B と同じ。
- 案 D（利用者が方針を変えれば有り得る案。既定にしない。#3 の D・E を採った場合）: center を登録した app（desktop または `bantou-center`）が登録の時に鍵を作って保存し、その app だけが header で証明する（今の launcher 鍵の仕組みを残す）。項目ごとの範囲は案 B と同じ。鍵の保存先の守りは【未確認】。
- 推奨: A（権限の仕組みを新しく足さない。CLI は既にある）。外部記憶・追加の MCP を desktop の画面から書きたい要望があれば、B か C を別の決定にする。その間、desktop の設定画面の「外部記憶」「追加の MCP」の編集は「center の host で設定する」案内になる（今の画面の体験が変わる点なので、決定を要する）。

**#7 端末の入出力と添付を GraphQL に載せる範囲**
- 案 A: 出力は subscription、入力・サイズは mutation、添付の画像（bytes）は既存の HTTP route `POST /sessions/<n>/attachments` を残す。
- 案 B: 全部 GraphQL（添付は GraphQL multipart upload か base64 の mutation）。
- 案 C: 端末の出力・入力も既存の HTTP route を残し、GraphQL は一覧と操作だけ。
- 推奨: A。理由: 出力は `id` / `after` / `reset` の再開付きの stream で、今の SSE の振る舞い（`Last-Event-ID`）を subscription で再現できる【未確認】。画像の bytes は GraphQL に載せにくい。C は「画面が使う物は GraphQL で漏れなく」の方針から外れる。
- 添付の bytes を webview に渡す形（2.5 で残す OS 側の入口 `session_attach_paths` / `session_attach_pick` の形）: 案 A: Tauri の command が file を読んで bytes と名前を返し、webview が `attachToSession`（または残す HTTP route）で送る（Rust に center への通信が残らない）。案 B: 今どおり Rust が読んで center に直接 upload する（Rust の中継層（reqwest・接続先・token）が添付の分だけ残る）。推奨 A（中継層をなくす方針）。大きい画像（20 MB まで）を IPC で返す形は【未確認】（今の `session_attach_bytes` は JSON 配列にしないため raw body を使っている。`attachment.rs` の doc）。

**#8 Cork の task・旧 broker・thread・agent（desktop ローカル）の扱い**
- 案 A: この設計では触らず、desktop ローカルの機能として残す。
- 案 B: center に移して GraphQL に出す。
- 案 C: 廃止する。
- 推奨: A（利用者の指示は center の起動の仕組みで、これらは center と無関係。`docs/handoff.md` の Open にも、使われていない command がある）。web がこれらを出していない（web 設計の判断 5）のと同じ扱い。廃止の可否は別の決定。

**#9 状態 dir の置き場と、設定の分け方（接続先 / center の起動項目）**
- 案 A: 今 desktop が使う `~/.local/share/bantou/` をそのまま使う（`sessions.json`・`remotes.json`・`handoffs/`・`center-id` が引き継がれ、session・remote-cap の記録が残る）。
- 案 B: service 用の新しい場所（`~/.config/bantou/` など。`packages/center/README.md` の既定）に作り直す。
- 推奨: A。理由: 移行で session と cap の記録が消えない。`center-id`（cap_id の素、`docs/architecture.md`）が変わると cap の記録の対応が崩れる。設定の分け方は、`CenterSettings` の起動項目（enabled・bind・workspace・claudePath・token）は center の config へ、`remote`（接続先 URL・token）は client のローカルの設定へ、とする案を推奨する。

**#10 Windows**
- 案 A: center は mac（launchd）と Linux（systemd）だけを対象にし、Windows の desktop は client として IP（または URL）と token で center に GraphQL で繋ぐ。
- 案 B: Windows の center の常駐（Windows service）も扱う。
- 推奨: A（利用者の指示は launchd。`pty-wrapper` と `claude` の Windows 対応は今の repo に根拠が無い【未確認】）。

**#11 「app の再起動の後の状況の確認」の意味（5.1）**
- 案 A: center が起動し直した時（host 起動・launchd 再起動・更新・異常終了からの復帰）に読み替える。実装は変えない。
- 案 B: A に加えて、client（desktop）が繋ぎ直した時にも確認を送る。
- 案 C: 確認を止める。
- 推奨: A。
- 参照: `app-restart-check` の設計書 `docs/design/app-restart-check.md` の U4「center だけが再起動した時も対象にするか」（A: 対象にする = center の起動を app の再起動と扱う、B: desktop が「app の起動」を center に知らせる口を足し、その時だけ送る。推奨 A）と同じ論点。この設計の案 A は U4 の A、案 B（client が繋ぎ直した時にも送る）は U4 の B に当たる（center が client の接続を知る口が要る）。desktop と center が独立しても、U4 の推奨 A の根拠（区別する材料が center に無い）は変わらない。

**#12 center の更新で session が中断される事（1.6）**
- 案 A: 今と同じ（更新の再起動で session は `--continue` で戻る。人が空いている時にやる）。
- 案 B: center が更新の前に session の状態を見て、作業中なら待つ。
- 推奨: A（利用者が決めていない待ちの仕組みを足さない）。B は更新の自動化（段階 F）の時に別の決定にする。

**#13 版の互換（client と center の版が違う時）**
- 案 A: GraphQL の field の追加だけを許し（古い client は新しい field を無視）、削除・型の変更は client と center を同じ release で出す。client は center の版を query で取り、組が合わない時は画面に出す。
- 案 B: schema に版を持たせ、複数の版を同時に提供する。
- 推奨: A（今の `Session` の `null` = 古い center の扱いと同じ考え）。
**#14 center を launchd に登録する手段**
- 案 A: center の subcommand（`bantou-center service install`）が plist を書き、`launchctl bootstrap gui/<uid>`（LaunchAgent の場合）で登録する。`install-service.sh` の流儀。登録・解除・状態が center の binary 1 つにまとまり、Linux（systemd unit）でも同じ入口を使える。
- 案 B: Homebrew の `brew services`（formula が plist を生成する）。
- 案 C: LaunchDaemon（管理者権限が要る。#2 の B）。
- 案 D（案 E の app にした場合のみ。既定にしない）: `SMAppService.agent`（bundle 内の plist を OS が登録する。利用者が System Settings の Login Items で見て止められる。macOS 13 以降）または `SMAppService.mainApp`（ログイン項目。launchd の `KeepAlive` は無い）。ad-hoc 署名・自己署名の app で登録が通るかは【未確認】（`docs/ops/desktop-signing.md`）。
- 推奨: A（center の binary が自分で登録する。app にも formula にも依らない）。B は #3 の案 A を採った時の補助。`SMAppService` は #3 の案 E を採った場合の手段で、その時に実測して決める。

**#15 center の配布物の形**
- 案 A: bun の単体 binary（`bun build --compile`）と pty-wrapper を同じ dir に置く（今の `build-sidecar.ts` と同じ手順。mac は arm64。`packages/center/scripts/build-bin.ts`）。
- 案 B: ソースから node で動かす（web 設計 6.1 の (i)。Linux 向け。node 22 以上）。
- 案 C（案 E を採った場合のみ）: 窓の無い app の bundle の中に center を入れる（Tauri の窓無し app が子として起動する形、bundle の実行 file を center にする形、薄い native の launcher の形の 3 つの作り方がある）。
- 推奨: mac は A、Linux は B（web 設計 6.1 の推奨）。C は #3 の案 E を採った時に決める。

**#16 落ちた時の再起動の持ち主と、二重起動の時の終わり方**
- 案 A: launchd に任せる（異常終了だけ再起動する設定。値は実測して決める）。後から起動して「port が使用中」と分かった時（#22 の案を採った場合）は、異常終了にせず自分から終わる（launchd が再起動し続ける loop を避ける）。
- 案 B: launchd は起動だけ。再起動は別の仕組みが見る（center が子を持つ監視を持つ今の形に近い）。
- 推奨: A（常駐の再起動は launchd に任せる）。連続して失敗した時の振る舞い（launchd 側の扱い）は【未確認】。

**#17 登録の承諾と、無効にされた時の知らせ方**
- 案 A: `service install` を利用者が明示して実行する（承諾は実行そのもの）。
- 案 B: 配布物の install の中で自動で登録する（formula の post-install など）。
- 登録が OS の側で無効にされた時（System Settings の Login Items など）の知らせ方: log だけ / desktop の画面（接続した時に「常駐が無効」を出す）。
- 推奨: 登録は A（利用者が見える形で行う）。無効にされた時の知らせは desktop の画面と log。#3 の案 E（app が初回の起動で自分を登録する）を採る場合は、OS の通知に任せるか 1 度だけ確認を出すかを別に決める。

**#18 止め方・常駐をやめる・更新後の再起動・状態の見方（操作の入口）**
- 案 A: desktop の画面から、GraphQL の mutation（center の停止・再起動・登録の解除）と query（center の状態・版）で行う。center が自分で動く。
- 案 B: center の subcommand（`bantou-center service status|restart|stop|uninstall` のような物。`cli.ts` の既存の subcommand の流儀）を、利用者が center の host で呼ぶ。
- 案 C: OS の操作だけ（`launchctl`、Activity Monitor）。
- 推奨: A と B の両方（画面から操作できるのが A、画面が使えない host に B。C は利用者の手間が大きい）。A の mutation は `Mutation` に足す（2.3）。再起動すると session の claude が止まる（1.6）ので、画面に出す文言で知らせる。更新後の再起動（#12）も同じ入口にする。

**#19 同じ Mac で center が 2 つ動く時の守り**
- 前提: desktop が center を起動しなくなる（決めてある事）ので、desktop の裏の center と launchd の center が重なる事は無い。重なりうるのは、利用者が center を手で起動した時、開発で起動した時、#3 の案 D・E を採った時。
- 事実: 2 つ動くと、同じ port（既定 7910）の奪い合いで後から起動する方が失敗する（`center.rs:331` の `looks_like_bind_failure` がそれを log から見分けている）。ただし port が違えば両方動き、同じ状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）を奪い合う（web 設計 9.2 の危険）。
- 案 A: 規定 port で 1 つだけ起動する（#22。2 つ目は port の使用中で失敗する。2.8）。
- 案 B: 状態 dir に lock file を置いて、2 つ目を断る。
- 案 C: 何もしない（今のまま。手順書に「1 host に center を複数立てない」と書く）。
- 推奨: A（案 B を足すかは実装の task が決める）。ただし A は利用者が決めていない案（0.1）。確認が取れるまで、本文は C を既定にし、A を推奨の案として残す。

**#20 center の token（作り方・渡し方）**
- 案 A: center の初回の起動か `service install` が token を作って config に書き、subcommand で接続情報（URL・token）を表示する。利用者が desktop の接続先に貼る（今の「別 host の center の接続設定を貼る」と同じ形）。
- 案 B: desktop が token を作って center の config に書く（今の sidecar の流れ）。center が別 host だと使えない。
- 案 C: 初回の起動の時だけ、接続情報を通知か画面で出す。
- 推奨: A（desktop が center の config を書く形をやめる。今の接続設定の貼り付けと同じ流儀）。token の再生成も同じ入口（2.3 の `regenerateCenterToken` か subcommand）。

**#21 Linux など formula を持たない host の center の入れ方**
- 案 A: `bantou-center service install`（#14 の A）と単独の配布物（#3 の B）で入れる。Linux は systemd user unit。
- 案 B: 今の手順（ソースから起動する。web 設計 6.1）のまま。
- 推奨: A（mac と同じ入口。B は手順書の例として残す）。

**#22 規定 port の採否と番号（利用者が決める。出所確認中の案、0.1 と 2.8）**
- 案 A: 今の既定の 7910 を規定 port にする（center の `--port` の既定、desktop の `DEFAULT_PORT`、`packages/center/README.md`）。
- 案 B: 別の番号にする（利用者が決める）。
- 案 0: 規定 port を採らない（今のまま設定で変えられる。#19 の案 C）。
- 案 C: 番号を設定で変えられるようにする。→ 「規定 port のみ」の案（2.8）を採るなら、設定で変えられる形は案から外れる（採らないなら、今のまま設定で変えられる）。
- 推奨: 採るなら A（採否は #19 とあわせて決める。出所の確認が取れるまで、本文は「採らない」を既定にしている）。理由: 既存の docs・設定が 7910 で、port を変えていない利用者の接続先が変わらない。web 設計 9.2 の表に載る他の使用（bantou-server の 7901・7902、memory の 7930）に 7910 は無い。ただし host ごとの他の program との衝突は【未確認】（他の program が 7910 を使う Mac では center が起動しない）。設定画面で port を変えていた利用者は、規定 port に移る（接続先の port の入力を外す）。番号は利用者が決める。

**#23 LAN から届く時の認証**
規定 port は誰にも予測できる番号になるので、LAN の中で center を探しやすくなる。center は今、常に全アドレスで待ち受け、Bearer token だけで守る（平文、`center.rs:29`、`docs/architecture.md`）。
- 案 A: 今のまま（全アドレス + Bearer token。token は 12 文字以上、desktop が作る物は 32 文字の base62）。
- 案 B: 待ち受けを既定で loopback にし、LAN へ開くのは明示の設定にする（「常に全アドレス」の確定事項を変える）。desktop だけで使う（center と同じ Mac から繋ぐ）利用者は LAN に開かなくて済む。
- 案 C: A に TLS を足す（center が終端、または前段の reverse proxy。web 設計 11 の判断 13 が同じ論点）。
- 案 D: client ごとの token と、接続元 IP の許可 list を足す。
- 推奨: A（利用者の決めてある線は今と同じ強さ。新しい仕組みを足さない）。B は仕組みを足さず安全側に倒せる案なので、LAN から使わない利用者向けの次の候補にして、別の決定にする。規定 port を知る者が token を試せる状態になる点を、手順書に書く（失敗の回数の制限などは利用者が決めていないので足さない）。

**#24 test・開発用の port（#22 の規定 port を採る場合。本番の起動は規定 port のみ）**
- 案 A: `--port` を廃止し、test も規定 port を使う（実行中の center と衝突する。test を 1 つずつ直列にする必要がある）。
- 案 B: 本番の経路（launchd の起動）では port を変えられず、test・開発用の起動の関数の引数（`startHttpServer` の `port` option など）でだけ変えられる。CLI の引数と環境変数では受けない。
- 案 C: 今のまま `--port` を残す。→ 「別の port に逃げない」の案（2.8）を採るなら、誤って別 port で起動できる形は案から外れる。
- 推奨: B（`packages/center/test/` と `scripts/e2e.ts` が `--port 0` で動いており、規定 port にすると開発中の center と衝突する。本番の起動の経路だけが規定 port に縛られる）。
**#25 `/graphql` の Host の検査**
- 事実: `/events`・core route・`/mcp` は、bind が loopback の時だけ Host を検査する（3.5）。S も D も全アドレスで待ち受けるので、通常は検査が無い。
- 案 A: 今の `/mcp`・`/events` と同じにする（loopback bind の時だけ検査する）。
- 案 B: 常に検査する（IP で繋ぐので、許可する Host の集め方が要る）。
- 案 C: 検査しない（Bearer だけ）。
- 推奨: A（今と同じ強さにそろえる。全アドレス待ち受けと規定 port の下での強化は #23）。

**#26 接続先の見つけ方（desktop から center を）**
- 事実: 今の desktop は URL + token（貼り付けた接続設定、`remote`）か、自分の sidecar。center が remote の server を見つける仕組み（agent-messenger の broker、`docs/architecture.md` の server の項 3）は desktop ↔ center の話ではない。
- 案 A: 今のまま（接続先の URL（host と port）と token を貼る）。
- 案 B（出所確認中の指示。決定ではない）: IP の指定だけにする（固定。port は規定 port、#22）。自動の発見（mDNS・broadcast）は使わない。
- 案 C: 自動の発見（mDNS など）を足す。
- 推奨: A を土台に、B は #22 の案を採ってから決める（規定 port が無ければ port の入力が要る）。C は足さない（決めていない仕様を増やさない）。

## 8. 次にやる事（推奨の順）

1. 決めてある事（同梱しない・launchd・GraphQL）の範囲で、未決 #2・#3・#6・#14・#15・#20 と、#4・#7 の決定（schema と配布の形に効く）。#22（規定 port の番号と採否）・#23・#24・#25・#26 は、0.1 の出所の確認と合わせて決める。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A の worker を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。
3. 並行して段階 C の実測（launchd で center が `claude` の認証を通すか、`service install` が管理者権限なしで登録できるか）を行う。結果で #2・#14 が決まる。
