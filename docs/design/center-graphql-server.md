# center の起動を「desktop の裏の起動（S）」と「bantou-center の常駐（D）」の 2 形にし、GraphQL を持たせる設計

- 作成: 2026-11-23（同日、利用者の訂正と追加の決定を 2 回反映して改訂）
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の指示（原文）と、決めてある事

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

利用者の訂正:

> いや、app同梱はする。

利用者の追加の決定:

> まず普通にdesktopアプリを起動。この時、centerを起動っていうのを選ぶと、裏でcenter起動。これは今と同じ。で、desktopアプリとしてbantou-centerっていうのを別で用意する。そいつを起動すると、画面がないプロセスが起動する
>
> desktop側からのサーバーのdiscoveryはipのみで固定。

利用者の追加の決定（port）:

> centerのportを規定しておいて、規定portのみで起動する形は？

（master-cap が説明した後、利用者は「ok」と答えた）

決めてある事（変えない。最新の形）:

1. center は GraphQL の endpoint を持つ backend の server。client の app（desktop・web）は、frontend の app と同じく、その endpoint を叩いて画面を動かす。
2. center の起動の形は 2 つ。この設計では次の名前で呼ぶ。
   - **S（sidecar 起動）**: desktop の app を普通に起動し、起動の時に「center を起動」を選ぶと、裏で center を起動する。**今と同じ**（`center.rs`、1.2）。
   - **D（常駐起動）**: desktop の app とは別に、desktop の app として `bantou-center` を用意する。窓の無い app で、起動すると center の process だけが動く。初回の起動で、自分を launchd に常駐として登録する（mac。登録の手段は未決 #14）。
3. center は app に同梱して配る（S の desktop も D の bantou-center も、center の binary を持つ。版は app と一緒）。
4. desktop から center を見つける方法は IP の指定だけ（固定）。自動の発見（mDNS など）は使わない。desktop は「IP と規定 port」でつなぐ。
5. center の port は 1 つに決めておき（規定 port）、center はその port でしか起動しない。別の port に逃げない。同じ mac に center は 1 つだけになる。2 つ目の center は port が使用中で起動に失敗する。desktop は「center を起動」を選んでも、規定 port で center が動いていれば起こさず、それにつなぐ（2.8）。
6. port が他の program に使われていて起動できない時は、理由が分かる error を出す（2.8.3）。
7. 規定 port の番号は利用者が決める（未決 #22）。LAN から届く時の認証は未決 #23。

版の履歴: 初版（4edee56）は「app に同梱しない・sidecar をやめる」、第 2 版（8ac588a）は「app が launchd に登録する・sidecar を外す」を前提に書いた。この版でどちらも取り下げ、上の 5 点に書き直した（desktop は launchd に触らない。sidecar 起動は残る。D は別の app が自分を登録する）。GraphQL の schema（2.3）、session の claude と MCP が center に残る事（2.6）は変わらない。第 3 版（4ee5501）は S と D の 2 形で、同じ Mac に両方動く時を未決 #19 にしていた。この版は、規定 port の決定で #19 を片付ける形に書き直した（2.8 を新設）。

この設計は、上の 7 点に上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

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
   │   見つけ方は IP の指定だけ（固定。自動の発見は無い）。port は規定 port（2.8）
   ▼
bantou-center（GraphQL を持つ backend の server。起動の形が 2 つ）
   ├ S: desktop.app が子 process として起動（「center を起動」を選んだ時。今と同じ）
   └ D: bantou-center.app（窓の無い app）を起動すると center の process だけが動く。
        初回の起動で自分を launchd に常駐として登録する（以後は launchd が起動する）
   center の中身は S も D も同じ:
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は S の時だけ center を子 process として起動する。D の center は desktop と無関係に動く（desktop を閉じても、起動していなくても動く）。desktop は launchd に触らない。
- desktop から center を見つける方法は IP の指定だけ（S の時の自分の center は `127.0.0.1`）。port は規定 port で、入力しない（2.8）。mDNS・broadcast などの自動の発見は使わない。なお center が remote の server を見つける仕組み（agent-messenger の broker 経由。`docs/architecture.md` の server の項 3、`packages/center/src/server-link.ts`）は desktop ↔ center の話ではなく、変えない。
- web は今の BFF の位置づけを未決 #4 で決める。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。D の center は desktop から独立して常駐するので、`docs/concept.md` の「desktop と基本は一体」・`docs/architecture.md`・`CLAUDE.md` の「sidecar 同梱」の文の改訂が要る（4 節の段階 G）。

### 2.2 center の起動の形ごとの扱い（入れ方・起動・止め方・更新・消し方）

S は今と同じ（desktop が子 process として起動・監視・停止する。1.2）。以下は D（bantou-center の常駐）。土台にする既存の仕組み: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | `bantou-center.app` を入れる（配り方は未決 #3）。**初回の起動で app が自分を launchd に登録する**（手段は未決 #14）。利用者の操作は app を起動する 1 回だけ。冪等（登録済みで起動しても二重に登録しない）。 |
| 起動 | 初回は利用者が app を起動した時。以後は launchd が起動する（login 時など）。中身は center の process（`--transport http --bind --config`。**port は規定 port で、引数で変えられない**、2.8・#24）。token は config（`token`、12 文字以上、無いと起動しない `daemon.ts:296-297`）。D の token の作り方・渡し方は未決 #20。種別（LaunchAgent / LaunchDaemon）は未決 #2。 |
| 親の監視 | center は 2 秒ごとに `ppid` を見て、起動時から変わったら終わる（`parent-watch.ts`）。bantou-center の作り方（未決 #15）で親が変わる: shell が center を子として起動する形なら、shell が死ねば center も終わる（今の S と同じ）。center が launchd の直下なら `ppid` は変わらず何もしない【推測。6 節で実測】。 |
| 止め方 | 窓が無い app の止め方は未決 #18。launchd が止める時は SIGTERM。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:258 付近（`stopGraceMs + HARD_EXIT_MARGIN_MS`）`）。service の停止待ちはそれより長く取る（web 設計 9.1）。 |
| 更新 | center は app に同梱で、版も app と一緒。bantou-center.app を更新しても、動いている center は旧 binary のまま。再起動して初めて新しい版になる。更新の配り方は #3、再起動の入口は #18。再起動で session は `--continue` で戻る（`restore()`）。 |
| 消し方 | 常駐をやめる（launchd の登録を外す）。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）。app を消した時に登録が残る問題は 2.7.6。入口は #18。 |
| ログ | S は今 desktop が `center_status` に末尾を出す（`center.rs`）。D は center のログ file（`logDir`、`packages/center/src/log.ts`）と launchd の stdout / stderr 設定。画面の「center の状態」は GraphQL で返す（3 節）。 |
| Linux | systemd user unit（web 設計 9.1 の例）。app の無い host の入れ方は未決 #21。Windows は未決 #10。 |

- `claude` の解決・PATH: service は login shell を通らない（`packages/center/src/path-env.ts`・`claude-path.ts` は login shell から PATH を引く作りで、無ければ固定の候補→config の `remoteControl.claude`）。D の `claude` の探索は【未確認】。実測（6 節）。
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
| `regenerateCenterToken` | center の token を作り直し、center を再起動する（D の center 用）。今の `center_regenerate_token` は Rust の command で、center の MCP tool には無い。S は今の Rust の command が残る。mutation にするか CLI（`bantou-center` の subcommand）にするかは未決 #20・#18。token が変わるので、client の接続は切れ、新しい token を入れ直す | `center_regenerate_token`（Rust、`center.rs`） |
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
- 変更後の最小形: GraphQL の endpoint も同じ Bearer token（今の仕組みを移す）。S の token は今のまま desktop が生成して center の config に書く。D は desktop が起動しない（desktop 無しで center が起動する）ので、token は bantou-center 側で作る必要があり、desktop への渡し方が要る。未決 #20。別 host の client への配り方は今の接続設定の共有（未決 #4）。
- 「launcher 鍵」: 今は desktop が sidecar を起動した事を、起動ごとの鍵で証明する。起動元だけが `memory`・`mcpServers` を読み書きでき、`projectMemory` を読める（書きは `bantou-center memory set --session`・移行・設定 file の直接編集だけ）。旧設定の `mcp`・`mcpConnections`・`mcpSecrets`・`coordinator` は誰からも MCP では書けない。守る項目は合わせて 7 つ（`CENTER_ONLY_KEYS`: `packages/center-client/src/tool-policy.ts:45`、`packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS`）。書きは `assertCenterOnly`、読みは `withoutLauncherKeys` が絞る（定義は `project-settings.ts`、`tools.ts`・`sessions.ts` が呼ぶ）。**S は今のまま**。D の center は desktop が起動しないので、desktop は「起動した所」ではない。7 項目それぞれの扱いは未決 #6。
- 取り返しのつかない操作（`retireServer`、`deleteSession`）を誰に許すか: 今は desktop だけ（web は許可 list から外す）。権限の単位は未決 #4。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| S の center の起動・監視・自動再起動・終了時の停止（`center.rs` の spawn / backoff / `Center::stop`、`lib.rs` の `RunEvent::Exit`）、同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_status` / `center_set_settings` の起動項目（enabled・bind・workspace・claudePath）、S の token の生成・regenerate（desktop が config を書き直して center を再起動する、今のまま。D の token は desktop からは作らず、center 側へ移す形。#4・#20）、launcher 鍵、`bantou://center-running` | **残す**（S は今と同じ。「center を起動」を選んだ時の裏の起動） |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`） | **捨てる**（webview が GraphQL を直接叩く。S の center にも D の center にも同じ形で繋がる。Rust の中継層が無くなる） |
| 添付（`attachment.rs`: `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`） | **分ける**。消す: center への中継（`upload` = reqwest で `POST /sessions/<n>/attachments`、`run` の接続先の選択 `select_target`・`load_settings`、保存した path を pty に打つ `post(.. "input" ..)`・`input_text`・`b64`）。webview が GraphQL（`attachToSession`・`terminalInput`）か、残す HTTP route（#7）で行う。残す: desktop の OS 側の入口 = `session_attach_pick`（file dialog、`rfd`）、`session_attach_paths`（drop された path の受け取り）、`load`（path から bytes を読む）、画像の型の見分け `sniff_type`・大きさの検査 `check_size`（`MAX_BYTES` = 20 MB。center も同じ検査をする）。この 2 つの command は「保存まで行う」から「読んだ bytes と名前を webview に返す」形に変わる（形は未決 #7）。`session_attach_bytes` は clipboard の bytes を webview が既に持つので、command ごと不要 |
| 接続先の指定 | **IP の指定だけ**（固定。自動の発見は使わない）。port は規定 port で入力しない（2.8）。S で「center を起動」を選んだ時の接続先は自分（`127.0.0.1`）。別 host の center・D の center は IP と token を入れる。今の `remote`（URL + token）の入力の置き換え。token は今の接続設定のまま【未決 #20】 |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips` / `center_ip_status`） | **残す**（S の center が自分の接続設定を出す、今のまま。D の center が出す側の入口は未決 #20） |
| updater・relaunch（app 自身の更新） | **残す**。bantou-center.app の更新は別の問題（未決 #3） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える） |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するかは未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と S の起動の操作だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す（token をブラウザに出さない・Cloudflare Access 前提を維持）案と、薄い proxy にする案、ブラウザが直接叩く案 |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` は今のまま: desktop は S の center を起動できる = true、web は false）。
- 設定画面（`SettingsDialog.vue`）: 「center を起動する」の switch（S）は今のまま。「接続先」は IP の指定になる。desktop は launchd に触らないので、D の登録・解除の操作は設定画面に持たない（入口は #18）。S と D が同じ Mac で動く時の画面の出し方は #19。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center の起動の形（S に D が加わる）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: D で session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:330` の `centerUrl`）で動く。
### 2.7 bantou-center（窓の無い app。D の形）

利用者の決定: desktop の app とは別に、desktop の app として `bantou-center` を用意する。窓が無く、起動すると center の process だけが動く。初回の起動で自分を launchd に常駐として登録する。

【事実】今の関係部品:
- 同梱の仕組み: `packages/desktop/src-tauri/tauri.conf.json` の `bundle.externalBin`（`binaries/bantou-center`・`binaries/bantou-pty-wrapper`）。build は `packages/desktop/scripts/build-sidecar.ts`（target triple の suffix 付きで置き、bundle 時に外れる）。desktop が S の時に起動する物と同じ binary を、bantou-center.app も持つことになる。
- 配り: Homebrew cask `packages/desktop/Casks/bantou.rb`（arm64 の macOS、`auto_updates true`、`app "bantou.app"` の 1 つだけ、`zap trash` は `~/Library/Application Support/jp.grrow.bantou` と `~/Library/Caches/jp.grrow.bantou`。**launchd の登録を外す stanza は無い**）。app 自身の更新は `tauri_plugin_updater`（1.6。bantou.app の bundle を置き換える物）。
- 署名: ad-hoc 署名（`signingIdentity: "-"`）で、版ごとに code identity が変わる（`docs/ops/desktop-signing.md`。Local Network の許可が更新で失われる問題の記録）。bantou-center.app も別の code identity を持つので、LAN への接続の許可（Local Network）を別に受ける必要が出うる【未確認】。

#### 2.7.1 実体（app の作り方）

窓の無い app の作り方の案は未決 #15（X: Tauri の窓無し app が center を子として起動する / Y: bundle の実行 file を center の binary にする / Z: 薄い native の launcher）。どの形でも、見える挙動は同じ: Dock に出ず、起動すると center が動く。

#### 2.7.2 起動の挙動（初回と 2 回目以降）

| 状態 | bantou-center の動き（案。細部は未決） |
|---|---|
| 初回の起動（未登録） | center を起動し、自分を launchd に常駐として登録する（手段は未決 #14）。OS の確認（Login Items への追加の通知など）が出うる（#17）。登録の結果は log に出す（窓が無い） |
| launchd が起動した（登録済み） | center を起動するだけ |
| 登録済みで、利用者が app を手で起動した（Finder など） | 既に center が動いていれば何もしない（二重に起動しない。#16）。止まっていれば起動する |
| 登録済みだが OS 側で無効にされた（System Settings の Login Items） | 起動した間は動く。次の login から自動では起動しない。知らせ方は #17 |
| 同じ Mac で S の center が既に規定 port を持っている | port の使用中で起動に失敗し、理由を出して終わる（2.8。launchd の再起動の loop にしない。#16・#19） |

#### 2.7.3 desktop から見つける（IP のみ）

- desktop の設定で接続先を IP（と token）で指定する。port は規定 port（2.8）。自動の発見（mDNS・broadcast・同じ Mac の process 探索）は使わない。
- 同じ Mac の D の center に繋ぐ時も、IP（`127.0.0.1` など）を指定する。desktop が config file を読んで token を拾う、といった発見の代わりになる自動化は、利用者が決めていないので入れない。token の渡し方は未決 #20。
- center は全アドレスで待ち受ける（`docs/architecture.md`）ので、同じ LAN の別 host の desktop も、同じ指定で繋げる。

#### 2.7.4 更新（版は app と一緒）

- bantou-center.app の更新で新しい binary が入っても、launchd が起動済みの center は旧 binary で動き続ける【推測。bundle の置き換え中・後に実行 file と launchd の登録がどうなるかは【未確認】、6 節】。
- 新しい版にするには center の再起動が要る。入口は未決 #18（desktop の画面から GraphQL で / CLI で / OS の操作で）。再起動で session の claude は止まり、`restore()` が `--continue` で戻す（1.6。session の中断は今と同じ）。
- 版の違いの検出: client が GraphQL で center の版を取り、自分の版と比べる（#13）。server の版合わせは今の `follow.ts`（`BANTOU_PAIR_SERVER_VERSION`、build が埋める）のまま。
- bantou-center.app 自体の更新の配り方（cask / updater）は未決 #3。

#### 2.7.5 止め方・常駐をやめる

窓が無いので、画面から止められない。入口の案は未決 #18: (1) desktop の画面から GraphQL の mutation で（center が自分を止める）、(2) center の binary の subcommand（`bantou-center service …` のような物。center は既に `status-line`・`hook`・`memory`・`mcp` などの subcommand を持つ、`packages/center/src/cli.ts`）、(3) OS の Login Items の無効化と `launchctl` / kill。

#### 2.7.6 消し方

- 常駐をやめる: launchd の登録を外す（入口は #18）。状態 dir は消さない（#9）。
- app を削除した時（cask の uninstall）: 今の cask に launchd の登録を外す stanza は無い。登録が残って、実行 file の無い center の起動を launchd が試み続ける事になりうる。cask に `uninstall launchctl:`（label を指定）を足す案がある（cask の変更は別 task）。SMAppService の登録は app の削除で OS が扱うか【未確認】。

#### 2.7.7 同じ Mac で S と D が両方動く時

規定 port の決定（2.8）で片付いた。center は規定 port でだけ起動するので、同じ Mac に center は 1 つ。後から起動する方は port の使用中で起動に失敗して終わる。状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いは、center が 1 つなので起きない。残る小さな点は未決 #19。

#### 2.7.8 desktop の Rust に足す物・捨てる物

- 足す: 接続先を IP で指定する入力と、その疎通の確認（GraphQL の query）。S を起動する前の「規定 port に center が居るか」の確認（2.8.4）。port の設定項目と入力欄は外す。
- 捨てる: `center_mcp.rs` ほか中継層（2.5）。
- 変えない: S の起動・監視・停止（`center.rs`）。launchd の登録は desktop に持たせない。

#### 2.7.9 app の無い host（web 用の Linux の host など）

app が無いので bantou-center.app は使えない。配り方は未決 #21。

### 2.8 規定 port（center は規定 port でだけ起動する）

利用者の決定（原文）: 「centerのportを規定しておいて、規定portのみで起動する形は？」（master-cap の説明の後、「ok」）。

決める事:

1. center の port は 1 つに決めておく（規定 port）。番号は未決 #22（利用者が決める）。
2. center は規定 port でしか起動しない。別の port に逃げない（S も D も同じ）。
3. 同じ mac に center は 1 つだけになる。2 つ目の center は port が使用中で起動に失敗する。
4. desktop は「IP と規定 port」でつなぐ。port の入力は無い。
5. desktop は「center を起動」を選んでも、規定 port で center が動いていれば起こさず、それにつなぐ。
6. 規定 port が他の program に使われていて起動できない時は、理由が分かる error を出す。
7. LAN から届く時の認証は未決 #23。

この決定で、S と D が同じ Mac で両方動く問題（前の版の未決 #19）は片付く。残る小さな点は #19 に書いた。

#### 2.8.1 今の port の扱い（変わる所）

- 【事実】center の `--port` の既定は 7910（`packages/center/README.md`、`packages/center/src/args.ts`）。`0` は OS 任せ。
- 【事実】desktop の `CenterSettings.port` も既定 7910（`center.rs` の `DEFAULT_PORT`）で、設定画面から変えられる（`packages/ui/components/SettingsDialog.vue` の `centerSetSettings`）。port の変更は center の再起動を要する（`center.rs` の `needs_restart`）。
- 【事実】bind の失敗は、center の log から見分けて `CenterStatus.bindFailed` に出している（`center.rs:331` の `looks_like_bind_failure`、`packages/ui/types/index.ts` の `CenterStatus`）。
- 【事実】test は `--port 0` を使う（`packages/center/test/args.test.ts`・`http.test.ts`）。`packages/center/scripts/e2e.ts` は `node:net` を使う（空き port を取る用途と読める【推測】）。
- 変わる事: desktop の port の設定項目と入力欄を外す（`enabled`・`bind`・`workspace`・`claudePath`・`token` は残る）。center の `--port` 引数を本番の起動で使えなくする（test・開発の扱いは未決 #24）。

#### 2.8.2 center の起動の順（2 つ目の center が何にも触らない事）

- 【事実】今の `daemon.ts` は、store の生成（`:172`・`:230`）と `loadCapId`（`:221`）の後に listen（`startHttpServer`、`:299`）し、その後に `sessions.restore()`（`:354`）を呼ぶ。孤児 process の回収（`reapOrphans`）は session を start する時に走る（`packages/center/src/remote-control.ts:400`）ので、port で失敗すれば、session の起動・孤児の回収には届かない。
- 要件: 2 つ目の center は、listen に失敗したら、状態 dir の file を書き換えず、session・孤児 process・remote の記録に触れずに終わる。store の生成と `center-id` の作成（`loadCapId`）が listen より前に file を書くかは【未確認】。書くなら、listen を先に移す。実装の task が確かめる。
- listen を先にするのは、規定 port の決定が「別の center を動かさない」ための最後の守りだから（desktop の起動前の確認（2.8.4）は先に確かめるだけで、確認と起動の間に別の center が port を取りうる）。

#### 2.8.3 起動に失敗した時の error（理由が分かる）

出す内容:

- どの port か（規定 port の番号）。
- 使用中の相手が何か: (a) 規定 port で GraphQL の疎通を試し、center なら「既に center が動いている（版・起動の形）」。(b) 応答が GraphQL でない・接続だけできる・応答が無い、なら「他の program が使用中」。使用中の process 名・PID を OS に問い合わせて足せるか（`lsof` 相当）は【未確認】。
- 次にする事: 既に center なら「それにつなぐ」、他の program なら「その program を止める」。規定 port を変える手段は無い（番号は #22 で決まる 1 つ）。

出す先:

| 起動の形 | error の出し先 |
|---|---|
| S | center の log（stderr）と、desktop の画面（今の `center_status` の `bindFailed` と `error` に、上の理由の文言を足す） |
| D | center の log。bantou-center は窓が無いので、desktop が接続した時に「規定 port の相手が何か」を調べて画面に出す（#17 の知らせ方と同じ入口） |

#### 2.8.4 desktop が「center を起動」を選んだ時（S の起動前の確認）

desktop は S を起動する前に、`127.0.0.1` と規定 port の状態を確かめる。

| 規定 port の状態 | desktop の動き |
|---|---|
| center が動いている（GraphQL の疎通で center と分かる） | center を起こさず、それにつなぐ。画面に「動いている center につないだ」と出す |
| 空き | S を起動する（今と同じ） |
| 他の program が使用中（center と分からない応答・接続だけできる） | 起動せず、2.8.3 の error を出す |

確認と起動の間に別の center が port を取った場合は、center の listen の失敗（2.8.2）が最後の守りになる。

#### 2.8.5 同じ Mac に center が 1 つになる意味

- S と D が両方動く事は無い。後から起動する方は port で失敗して終わる。同じ状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いも、center が 1 つなら起きない。
- D の center が動いている間は、desktop の「center を起動」を選んでも S は起きず、その center につながる。S が規定 port を持っている間は、bantou-center は起動に失敗して終わる。その終わり方（launchd の再起動の loop にしない）は #16・#19。
- port は host で 1 つなので、同じ Mac の別の user の login でも center は 1 つ。別の user が自分の center を起こすことはできない【規定 port の決定から導いた制約。利用者に確かめる点】。

#### 2.8.6 desktop の接続

- 接続先は IP の指定だけ（規定 port は入力しない）。S の時の自分は `127.0.0.1`。別の host の center も、同じ規定 port。
- 規定 port が別の host で他の program に使われている時、その host には center を置けない（置くなら他の program を止める）。
- web の BFF の接続先（`center-client` の設定の URL）の形は #4 で決める（この決定は desktop の指定の形を決める）。

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
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | 残す。S の起動の項目（enabled・bind・workspace・claudePath）は今のまま。**port の項目は外す**（規定 port、2.8）。接続先は IP の指定になる（`remote` の url の置き換え。2.5）。分け方は未決 #9 |
| `center_status`（center.rs） | `centerStatus` | S の子 process の状態として残す。D の center の状態は GraphQL の `centerStatus`（2.3）で見る |
| `center_regenerate_token` | `centerRegenerateToken` | 残す（S の token。D の token は未決 #20） |
| `center_local_ips` / `center_ip_status` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | 残す（S の center の接続設定を別 host の desktop に配る今のまま。`center_parse_connect` は client のローカル処理。D の center が出す側の入口は #20） |
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
| `bantou://center-running`（`center.rs`、S で center を spawn した時） | desktop の Rust | 残す（S のため。client は疎通が戻るまで再試行する、`useSessionRefresh.ts` の `refreshUntilReachable`。D の center には出ない: 接続の再確立の契機は os-wake・network 変化と subscription の切断） |
| `bantou://os-wake` / `bantou://os-network-changed`（`os_events.rs`、web は browser が作る） | OS | client のローカルのまま（GraphQL の subscription の再接続の契機に使う） |
| `bantou://sessions-changed`（`useBoard.ts`） | Rust / client のローカル | client のローカルのまま（Cork task 側。未決 #8） |
| `bantou://threads-changed` / `bantou://pings-changed` / `bantou://agent` | `thread.rs` / `broker.rs` / `agent.rs` | 変わらない（未決 #8） |
| `menu:check-for-updates`（`menu.rs`） | desktop の menu | 変わらない（client の更新） |

### 3.4 `Platform`（`packages/desktop/src/tauri/platform.ts`、8 個）

`checkForUpdate` / `downloadAndInstall` / `relaunch`（app の更新。残す）、`openExternal`（残す）、`onFilesDropped`（残す）、`log`（残す）、`watchDir`（Cork の md 用。残す）、`currentWindow`（残す）。center に関わる物は無い。`centerSidecar`（S の center を起動できる shell か）は今のまま: desktop は true、web は false。

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

前提: 各段の終わりに、desktop も web も今の画面が動く。S（desktop が「center を起動」で裏に起こす center）は最後まで今のまま動く。center は MCP（`/mcp`・`/events`・`/sessions/*`）を最後の段まで残す（GraphQL を足すだけで消さない）。

| 段 | 内容 | この段の終わりに動く物 | 戻し方 |
|---|---|---|---|
| A | center に GraphQL の endpoint を足す（`/graphql`）。resolver は `packages/center-client/src/commands.ts` の表と center の中の関数を使う（query / mutation / subscription は 2.3）。認証は `/mcp` と同じ Bearer。GraphQL server の部品は未決 #1 | 今の desktop・web は無変更で動く（`/mcp` を使い続ける）。GraphQL は test と HTTP の呼び出しで確かめる | endpoint を足しただけ。外せば元に戻る |
| A2 | center の起動を規定 port だけにする（規定 port の番号は #22。`--port` の扱いは #24）。listen を状態への書き込みより先にし、失敗した時の error（使用中が center か他の program か）を出す（2.8.2・2.8.3）。S の desktop は port の設定項目を外し、起動前に規定 port を確かめる（2.8.4） | S は規定 port で今のまま動く。規定 port が使用中なら、理由の分かる error が出る | `--port` を戻す |
| B | `packages/ui/api/*.ts` を GraphQL client に差し替える。web の `~/tauri` の transport を GraphQL にする（BFF の形は未決 #4）。desktop の `src/tauri/transport.ts` は、center 系の command を GraphQL へ、native 系（workspace・updater・Cork）と S の起動の操作だけ Tauri に残す。接続先を IP の指定（port は規定 port）にする（2.5・2.8）。subscription は `terminalOutput`・`sessionsChanged`・`sessionMessage` | web が GraphQL で動く。desktop は S の center にも別 host の center にも GraphQL で繋がる | 差し替えを feature flag か branch 単位にすれば戻せる。center 側は無変更 |
| C | bantou-center.app を作る: C1 = app の実体（#15）と同梱・build・配り方（#3、cask の構成）、C2 = 初回の自己登録（#14）と登録の状態の扱い（#17）、C3 = 窓の無い app の操作の入口（止める・更新・登録解除・接続情報の表示。#18・#20。center の subcommand と GraphQL の mutation）、C4 = 規定 port の使用中の判定と error（2.8・#19。desktop 側と bantou-center 側の両方） | bantou-center.app を起動すると center が動き、登録され、desktop が IP で繋がる。S は今のまま動く | app を使わなければ S だけの今の形 |
| D | desktop の Rust の中継層（`center_mcp.rs`・`center_events.rs`・`session.rs` の cache・`terminal.rs`・`attachment.rs` の upload・接続先の選択・pty への input の中継。OS 側の入口 `pick` / `paths` と `load`・型・大きさの検査は残す、2.5）を外す（webview が GraphQL を直接叩く）。**S の起動・監視（`center.rs`）・同梱 binary・launcher 鍵は残す** | desktop の Rust は center の中継をしない。S は今どおり起動できる | D の前の release に戻せる |
| E | D の center への書き込みの権限（#6）と、`/mcp` の残し方（#5）の整理 | `memory` / `mcpServers` の読み書きが、S と D の両方で動く | 権限の方式を旧に戻す |
| F | 更新の入口（#18・#12）: 版の違いの検出と、D の center の再起動の入口。bantou-center.app の更新の配り（#3） | app を更新すれば center も同じ版に揃う（D の再起動は #18 の入口） | 手動の再起動に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`・`CLAUDE.md` の Map（「center は desktop に sidecar 同梱」→「center は app に同梱。desktop が裏で起こす形（S）と、bantou-center.app が launchd に常駐する形（D）」）・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に D の手順書を足す | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・認証・subscription）は、C（bantou-center.app）と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は新しい app の package・build・cask・center の `service` subcommand）。
- A の中でも、query 群（session・remote・server・rc の読み取り）、mutation 群（session の操作・設定・login・retire）、subscription（`sessionsChanged`・`sessionMessage`・`terminalOutput`・`centerStatus`）は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。
- C は C1・C2・C3・C4 に分けられる。C1 が app の土台で、C2・C3 はその上。C4 は desktop 側（`center.rs` の起動前の確認）と center 側（二重起動の検出）で別 worker にできる。#14・#15 の決定が先。
- B は A の schema に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- D は B の完了後。C とは独立。E・F は C の後、E は #6 の決定後。
- G（docs）は各段の完了ごとに、その段の分だけ。

## 5. 進行中の別変更との関係

`git fetch` して差分を読んだ（読むだけ。これらの branch は変えていない）。

### 5.1 `feat/app-restart-check`（app の再起動の後の状況の確認）

- 内容: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、`packages/center/src/restart-check.ts`、`packages/center/test/restart-check.test.ts`）と `origin/feat/app-restart-check-sessions`（`packages/center/src/sessions.ts` の `restore()` に `onRestoreStart` / `onRestoreFail`）。center が起動し直した session の最初の入力（`SessionStart` の後）で「app が再起動した」事を知らせ、状況の確認を促す。検出は `restore()` の中（`supervisor.start(name, { resume: true })` の直前に印を付ける）。
- この設計との関係: 実装は center の中の物で、GraphQL 化・service 化とは別の file（`restart-check.ts`・`sessions.ts` の restore・`daemon.ts` の配線）。**衝突は少ない**。
- 意味が変わる点: その設計は「center は desktop の sidecar なので、app の再起動 = center の process の起動」（1.1 の【推測】）に立つ。**S では今のまま成り立つ**（desktop を起動して「center を起動」を選ぶと center が起動し直され、`restore()` が走る）。**D では成り立たない**: app（desktop）を終了・再起動しても D の center は再起動せず、`restore()` は走らない。D で `restore()` が走るのは center の起動の時（host の起動・login、launchd の再起動、異常終了からの復帰、更新後に center を再起動した時（#18））。つまり「app の再起動の最初の 1 回」は、S では desktop の起動、D では center の起動に当たる。
- 整合の案（利用者の判断。未決 #11）: (A) 実装は変えず、意味を「center が起動し直した時」に読み替える（S でも D でもそう読める。文面の「app が再起動した」を「center が再起動した」に直す）。(B) さらに「client が繋ぎ直した時」にも確認を送る（これは別の仕様になり、現在の指示「app が再起動された時の最初の 1 回」から外れる。足すなら利用者が決める）。推奨は A。

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
- 窓の無い app（2.7.2）: 初回の起動（未登録）・launchd 起動・手で起動（既に動いている / 止まっている）・OS で無効化された後、の各状態で、振る舞いが表のとおりになる。登録の結果が log に残る。
- 登録: 管理者権限なしで登録でき（LaunchAgent の場合。#2）、冪等（2 回起動しても二重に登録しない）。登録の解除（入口は #18）が通る。
- 規定 port（2.8、#19・#22）: (a) 規定 port が空いている時、S も D も起動する。(b) center が動いている時に S を選んでも起こさず、それにつなぐ。(c) 2 つ目の center（S・D のどちらでも）は、listen に失敗したら、状態 dir の file・session・孤児 process に触れずに終わる（2.8.2）。(d) 規定 port を他の program が使っている時、起動に失敗し、使用中が center か他の program かが分かる error が log と画面に出る（2.8.3）。(e) launchd が、port 使用中で終わった bantou-center を再起動し続けない（#16・#19）。(f) 別の port では起動できない（本番の経路。#24）。
- bantou-center.app の更新（#3）の最中・直後に、動いている center が落ちない。更新後に center の版の違いが検出され、再起動の入口（#18）が動く。
- Local Network の許可: bantou-center.app（別の code identity）から、LAN の別 host の remote の server・broker へ繋がるか。許可の確認の画面を出せない窓無しの app で許可が通るか（`docs/ops/desktop-signing.md` の件）【未確認】。
- cask の uninstall（`zap trash` だけで、launchd の登録を外す stanza は今無い）の後に、登録だけが残って起動に失敗し続けない事。
- 接続先の IP の指定だけで desktop が D の center に繋がる事（自動の発見が無くても）。

## 7. 未決（番号つき。各案と推奨）

**#1 GraphQL server の部品**
- 案 A: `graphql-yoga`（fetch API ベース。subscription は SSE、必要なら WebSocket を足せる）+ `graphql-js`（schema は code-first か SDL）。
- 案 B: Apollo Server（HTTP の query / mutation）+ `graphql-ws`（WebSocket の subscription）。
- 案 C: 手書きの薄い実装（`graphql-js` だけ + 自前の SSE）。
- 推奨: A。理由: center は今 `node:http` で `/events` を SSE で出しており（`packages/center/src/http.ts`）、同じ transport の考えで subscription を載せられる。web の Cloudflare 経由で SSE は通る前提の設計がある（web 設計 8.5）。WebSocket は不要にできる【推測】。ただし `bun build --compile` で動く事は【未確認】（6 節の実測）。動かなければ B か C に切り替える。schema を code-first にするか SDL にするかは実装の task が決める。

**#2 常駐の単位と、launchd の種別**
- 案 A: center 1 つを 1 つの常駐にする。mac は LaunchAgent（user の login の domain。`~/Library/LaunchAgents`、または `SMAppService.agent` が扱う bundle 内の plist）。
- 案 B: center 1 つを LaunchDaemon（`/Library/LaunchDaemons`、`UserName` 付き）にする（`packages/server/scripts/install-service.sh` の mac と同じ形）。
- 案 C: 複数（center と web backend を同じ service にまとめる、または session ごと）。
- 推奨: 単位は A（center 1 つ = 1 つの常駐。`docs/concept.md` の原則 6「session ごとに重い仕組みを抱えさせない」と、web 設計 6.4 の「1 host に center を複数立てない」に沿う）。種別は A（LaunchAgent）。理由: (1) app を起動する 1 回の操作で自己登録できる（user の domain なので管理者権限が要らない【推測】。LaunchDaemon は `/Library` に置くので管理者権限が要り、app からの登録に権限の確認が入る）。(2) `claude` の認証が login keychain にあり（`docs/handoff.md` の Lessons）、user の login の domain の方が keychain に届く【推測。未確認】。LaunchAgent は user が login していないと起動しない（host の再起動後に自動ログインが要る）という制約があり、これが許されない運用なら B（その場合、自己登録の形が変わる）。web backend は別の service（web 設計 9.1）のまま。

**#3 bantou-center.app の配り方と更新の配り方**
- 決めてある事: center は app に同梱し、版も app と一緒。bantou-center は desktop とは別の app。
- 事実: 今の cask は `app "bantou.app"` の 1 つだけ。app の更新は Tauri の updater（bantou.app の bundle を置き換える。`auto_updates true`）。updater が置き換えるのは更新対象の app の bundle で、別の app（bantou-center.app）は更新されない【推測。updater の挙動は未確認】。
- 配りの案: (a) 同じ cask・同じ dmg に app を 2 つ入れる（`app "bantou.app"` と `app "bantou-center.app"`）。(b) 別の cask にする。(c) bantou.app の bundle の中に bantou-center.app を入れる（`Contents/Library/LoginItems/` など。SMAppService が扱う標準の置き場。updater が両方更新する。ただし別の app として Finder から起動する入口にはならない）。
- 更新の案: (A) bantou-center.app にも Tauri の updater を持たせる（窓が無いので通知・再起動の入口は #18）。(B) cask の upgrade だけにする（`auto_updates true` との関係を見直す）。(C) (c) の入れ子にして desktop の updater に任せる。
- 推奨: 配りは (a)（利用者の「別で用意」に沿い、版が揃い、入れるのは 1 回）。更新は (A)（今の updater・Releases・`latest.json` の流儀を使う。center の binary を 2 つ持つ（desktop 用と bantou-center 用）事の容量は【未確認】だが、S を「今と同じ」に保つ事を優先する）。(C) は「別の app を起動する」入口と合わないので推奨しない。

**#4 認証の形と、web の BFF**
- 案 A: 今と同じ 1 本の Bearer token（LAN から届く時の認証は #23）。token は center が持つ。client は URL + token を貼る。web は BFF が token を持つ（今のまま）。
- 案 B: A に、client ごとの token（発行・失効）を足す。取り返しのつかない操作（`retireServer`・`deleteSession`）は権限を分ける。
- 案 C: A に TLS（center が終端、または前段の reverse proxy）を足す。
- web の形: (a) BFF を残す（token をブラウザに出さない。GraphQL を中継する）、(b) 薄い proxy にする、(c) ブラウザが center を直接叩く（token がブラウザに出る）。
- 推奨: 認証は A（利用者の決めてある事に新しい仕組みを足さない。今の desktop・web と同じ強さ）。web は (a)（Cloudflare Access の守りと token を隠す設計が既にある。`packages/web/server/`）。B・C は実運用で必要になった時に別の決定にする。S の token の生成と配り方は今のまま（desktop が生成して config に書き、接続設定で配る）。D の token は未決 #20。別 host の desktop・web は IP と token を入れて繋ぐ。

**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。

**#6 launcher 鍵が守る 7 項目の扱い（D の center）**
- 守る項目は 7 つ: `memory` / `mcpServers` / `projectMemory` / `mcp` / `mcpConnections` / `mcpSecrets` / `coordinator`（`packages/center-client/src/tool-policy.ts:45` の `CENTER_ONLY_KEYS`。center 側は `packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS` で、同じ 7 つ）。2 か所に別々の定義があるので、GraphQL の層は 1 か所にそろえる。書きは `assertCenterOnly`（`project-settings.ts:176`。`tools.ts:113・175・198` と `sessions.ts:237` が呼ぶ）、読みは `withoutLauncherKeys`（`:184`。`tools.ts:98` の `shown`）が絞る。
- 今の扱い（項目ごと）:

| 項目 | 分類 | 起動元 | 起動元以外 |
|---|---|---|---|
| `memory`・`mcpServers` | `LAUNCHER_KEYS` | 読み書きできる | 書くと error。読みの応答から除く |
| `projectMemory` | `FILE_ONLY_KEYS` | 読める。書きは設定の更新（MCP）では誰もできず、`bantou-center memory set --session`・移行・設定 file の直接編集だけ | 書くと error。読みの応答から除く |
| `mcp`・`mcpConnections`・`coordinator` | `LEGACY_INTERNAL_KEYS`（旧設定） | 誰からも MCP では書けない（起動元にも別の error）。読みの応答からは `withoutLauncherKeys` は除かない（旧設定が残っていれば応答に出うる【未確認】） | 書くと error |
| `mcpSecrets` | 同上 | settings の key としては同上。鍵の実体は別 file `mcp-secrets.json`（0600）で、入れるのは `bantou-center mcp secret`（標準入力か file）だけ。値は表示・log・error に出さない（`packages/center/src/mcp-secrets.ts` の冒頭）。どの経路でも値は読めない | 同上 |

- 前提: S は今のまま（desktop が起動ごとの鍵で証明する）。D の center は desktop が起動しないので、desktop は「起動した所」ではない。bantou-center が起動元になる。
- 案 A: bantou-center が初回に鍵を作って保存する（0600 の file など。center は env から取り出して消す `takeLauncherKey` の形）。同じ Mac の desktop は、その file を読んで header を付ける。項目ごと: `memory`・`mcpServers` は GraphQL で読み書きできる。`projectMemory` は読めるが書きは今のまま CLI など。旧設定 4 項目（`mcp`・`mcpConnections`・`mcpSecrets`・`coordinator`）は GraphQL でも書けない。`mcpSecrets` の値は読めず、入れるのは CLI の標準入力だけ。別 host の desktop・web は 7 項目とも読み書きできない（今と同じ）。
- 案 B: GraphQL では 7 項目すべてを読み書きしない（今の web と同じ。書くと error、読みの応答から除く。schema の `ProjectSettings` も 7 項目を持たない）。`memory`・`mcpServers`・`projectMemory` は center の host の CLI（`bantou-center memory` / `bantou-center mcp`、`cli.ts`・`memory-settings.ts`・`mcp-cli.ts`）で書く。`mcpSecrets` の値は今どおり CLI の `mcp secret` だけ。旧設定 4 項目は書かない。
- 案 C: admin 権限の token を別に持つ。admin で繋いだ client だけ、`memory`・`mcpServers` を読み書き、`projectMemory` を読める。それ以外の項目は案 A と同じ。
- 推奨: B（権限の仕組みを新しく足さない。CLI は既にある。A は desktop が同じ Mac の file を読む形で、利用者が決めた「IP の指定だけ」の線引き（自動の発見をしない）と近い所に踏み込む）。D の center の外部記憶・追加の MCP を desktop の画面から書きたい要望があれば、A か C を別の決定にする。その間、D の center の desktop の設定画面は「center の host で設定する」案内になる（S は今のまま画面から書ける。画面の体験が S と D で違う点なので、決定を要する）。

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
- 案 A: center の同梱と常駐は mac の app だけを対象にする（今の cask は arm64 の macOS だけ、`packages/desktop/Casks/bantou.rb` の `depends_on`）。bantou-center も mac の app。Windows の desktop は client としてだけ使い、IP を指定して center に GraphQL で繋ぐ。
- 案 B: Windows の center の常駐（Windows service）も扱う。
- 推奨: A（利用者の指示は launchd。`pty-wrapper` と `claude` の Windows 対応は今の repo に根拠が無い【未確認】）。

**#11 「app の再起動の後の状況の確認」の意味（5.1）**
- 案 A: center が起動し直した時（host 起動・launchd 再起動・更新・異常終了からの復帰）に読み替える。実装は変えない。
- 案 B: A に加えて、client（desktop）が繋ぎ直した時にも確認を送る。
- 案 C: 確認を止める。
- 推奨: A。
- 参照: `app-restart-check` の設計書 `docs/design/app-restart-check.md` の U4「center だけが再起動した時も対象にするか」（A: 対象にする = center の起動を app の再起動と扱う、B: desktop が「app の起動」を center に知らせる口を足し、その時だけ送る。推奨 A）と同じ論点。この設計の案 A は U4 の A、案 B（client が繋ぎ直した時にも送る）は U4 の B に当たる（center が client の接続を知る口が要る）。D で desktop と center が独立しても、U4 の推奨 A の根拠（区別する材料が center に無い）は変わらない。

**#12 center の更新で session が中断される事（1.6）**
- 案 A: 今と同じ（更新の再起動で session は `--continue` で戻る。人が空いている時にやる）。
- 案 B: center が更新の前に session の状態を見て、作業中なら待つ。
- 推奨: A（利用者が決めていない待ちの仕組みを足さない）。B は更新の自動化（段階 F）の時に別の決定にする。

**#13 版の互換（client と center の版が違う時）**
- 案 A: GraphQL の field の追加だけを許し（古い client は新しい field を無視）、削除・型の変更は client と center を同じ release で出す。client は center の版を query で取り、組が合わない時は画面に出す。
- 案 B: schema に版を持たせ、複数の版を同時に提供する。
- 推奨: A（今の `Session` の `null` = 古い center の扱いと同じ考え）。
**#14 自分を launchd に登録する手段（bantou-center の初回の起動）**
- 案 A: `SMAppService.agent(plistName:)`。app の bundle 内の plist（`Contents/Library/LaunchAgents/`）を OS が登録する。launchd が `KeepAlive` を管理できる。登録は OS の Login Items に出て、利用者が System Settings で無効にできる。macOS 13 以降（今の cask は sequoia 以降、`depends_on macos: :sequoia`）。
- 案 B: `SMAppService.mainApp`（ログイン項目）。login 時に app が起動するだけで、launchd の `KeepAlive` は無い。
- 案 C: app が `~/Library/LaunchAgents/<label>.plist` を書き、`launchctl bootstrap gui/<uid>` を実行する。OS の承諾の画面は無い。
- 案 D: LaunchDaemon（管理者権限が要る。#2）。
- 推奨: A（利用者の挙げた SMAppService に沿い、OS の画面で利用者が見て止められる。`KeepAlive` が使える）。ただし ad-hoc 署名・自己署名の app で `SMAppService` の登録が通るかは【未確認】（`docs/ops/desktop-signing.md`）で、実測する。通らなければ C（今の `center.rs` が `kill(1)` を `std::process::Command` で呼ぶのと同じ流儀）。Rust から `SMAppService`（Objective-C / Swift の API）を呼ぶ方法（objc2 など）も実装の task が確かめる。

**#15 bantou-center.app の実体（窓の無い app の作り方）**
- 案 X: Tauri の窓の無い app（macOS の activation policy を accessory にして Dock に出さない）が、center を子 process として起動する。S の `center.rs`（spawn・backoff・停止）をほぼ流用できる。launchd が見るのは app、app が見るのは center の 2 段。
- 案 Y: app の bundle の実行 file を center の binary にする（`LSUIElement` 相当の Info.plist）。launchd が直接 center を起動する。process は 1 つ。ただし `SMAppService` を center（bun の単体 binary）から呼べないので、登録の呼び出しだけ別の物が要る。
- 案 Z: 薄い native の launcher（Swift など）が center を子として起動し、登録も行う。新しい toolchain が増える。
- 推奨: X（最少の新しい部品。Rust 側に既に center の起動・監視・停止がある。center の `parent-watch.ts` の「親が死ねば終わる」もそのまま働く）。launchd と app の 2 段の再起動（launchd の `KeepAlive` と、`center.rs` の backoff の二重）の整理は #16。

**#16 落ちた時の再起動の持ち主と、二重起動の時の終わり方**
- 案 A: launchd に任せる（異常終了だけ再起動する設定。値は実測して決める）。後から起動して「規定 port が使用中」と分かった時は、異常終了にせず自分から終わる（launchd が再起動し続ける loop を避ける。2.8・#19）。
- 案 B: launchd は起動だけ。再起動は app（案 X なら shell）が見る（今の S と同じ backoff・断念）。
- 推奨: A（常駐の再起動は launchd に任せる）。X の shell の中の backoff を残すか外すかは実装の task が決める。連続して失敗した時の振る舞い（launchd 側の扱い）は【未確認】。

**#17 初回の登録の承諾と、無効にされた時の知らせ方**
- 案 A: 登録を黙って行う（利用者の操作は app の起動だけ。OS が Login Items への追加を通知する場合はそれに任せる）。
- 案 B: 起動した時に 1 度だけ確認を出す（窓が無いので通知か、小さな確認の画面）。
- 案 C: 登録は利用者が別の操作で行う（CLI など）。
- 登録が無効にされた時（System Settings の Login Items）の知らせ方: log だけ / 通知 / desktop の画面（接続した時に「常駐が無効」を出す）。
- 推奨: 登録は A（「初回の起動で自分を登録する」という利用者の決定どおり）。無効にされた時の知らせは desktop の画面と log（窓の無い app から新しい通知の仕組みを足さない）。

**#18 窓の無い app の止め方・常駐をやめる・更新後の再起動・状態の見方（操作の入口）**
- 案 A: desktop の画面から、GraphQL の mutation（center の停止・再起動・登録の解除）と query（center の状態・版）で行う。center が自分で動く。
- 案 B: center の binary の subcommand（`bantou-center service status|restart|stop|uninstall` のような物。`cli.ts` の既存の subcommand の流儀）を、利用者か desktop が呼ぶ。
- 案 C: OS の操作だけ（System Settings の Login Items、`launchctl`、Activity Monitor）。
- 推奨: A と B の両方（画面から操作できるのが A、desktop が無い host や画面が使えない時に B。C は利用者の手間が大きい）。A の mutation は `Mutation` に足す（2.3）。再起動すると session の claude が止まる（1.6）ので、画面に出す文言で知らせる。更新後の再起動（#12）も同じ入口にする。

**#19 同じ Mac で S（desktop が裏で起こす center）と D（bantou-center）が両方動く時（決定済み。規定 port で片付いた。残る小さな点）**
- 決定（利用者）: center は規定 port でだけ起動し、別の port に逃げない。同じ Mac に center は 1 つ。2 つ目は port が使用中で起動に失敗する。desktop は「center を起動」を選んでも、規定 port で center が動いていれば起こさずにそれにつなぐ（2.8）。前の版の案 B（D 優先）・C（別 port・別状態 dir で両立）・D（禁止）は、この決定で不要になった。
- 残る点 1: bantou-center が、S の center が規定 port を持っている間に起動して port の使用中で失敗した時の終わり方。案 A: 正常終了として終わり、launchd が再起動し続けないようにする（#16 の設定）。案 B: 異常終了にする（launchd が再起動を試み続ける）。案 C: A の上に、失敗を log と desktop の画面で知らせる（2.8.3）。推奨: A と C（loop を作らず、理由を見せる）。
- 残る点 2: S が止まって規定 port が空いた後、D が自動で戻るか。案 A: 戻らない（次の login か、利用者が bantou-center を起動した時に起動する）。案 B: 戻す（port が空くのを待つ仕組みを足す）。推奨: A（待ちの仕組みを足さない）。
- 残る点 3: 同じ Mac の別の user の center（2.8.5）。規定 port の決定どおり、起動できない扱いでよいか。推奨: そのまま（決定を変えない）。

**#20 D の center の token（作り方・渡し方）と、接続先の指定の入力**
- 決めてある事: desktop から center を見つける方法は IP の指定だけ（固定）。
- 案 A: bantou-center が初回に token を作って config に書く。利用者が `bantou-center` の subcommand（接続情報を表示する）か log file で token を見て、desktop の接続先（IP・port・token）に貼る（今の「別 host の center の接続設定を貼る」と同じ形）。
- 案 B: 同じ Mac の desktop が config file（`~/.local/share/bantou/center.json`）から token を読む（IP は指定するが、token は自動で入る）。
- 案 C: 初回の起動の時だけ、bantou-center が接続情報を小さな画面か通知で出す。
- 推奨: A（利用者が決めた「IP の指定だけ」を超える自動化を足さない。今の接続設定の貼り付けと同じ流儀）。port は規定 port で入力しない（2.8）。B は desktop が同じ user の file を読む形で、#6 の案 A と同じ線上の判断になる。

**#21 app の無い host（web 用の Linux の host など）の center の入れ方**
- 案 A: center の `service` subcommand（#18 の B）と単独の配布物で入れる。配り方は別の決定。
- 案 B: bantou-center.app の対象外とし、今の手順（ソースから起動する。web 設計 6.1）のまま。
- 推奨: B（この設計の範囲は app 同梱の center。app の無い host の配布は利用者がまだ決めていない）。#18 の B を作れば、A に進める余地が残る。

**#22 規定 port の番号（利用者が決める）**
- 案 A: 今の既定の 7910 を規定 port にする（center の `--port` の既定、desktop の `DEFAULT_PORT`、`packages/center/README.md`）。
- 案 B: 別の番号にする（利用者が決める）。
- 案 C: 番号を設定で変えられるようにする。→ 「規定 port のみ」の決定に反するので案から外す。
- 推奨: A。理由: 既存の docs・設定が 7910 で、port を変えていない利用者の接続先が変わらない。web 設計 9.2 の表に載る他の使用（bantou-server の 7901・7902、memory の 7930）に 7910 は無い。ただし host ごとの他の program との衝突は【未確認】（他の program が 7910 を使う Mac では center が起動しない）。設定画面で port を変えていた利用者は、規定 port に移る（接続先を IP だけに直す）。番号は利用者が決める。

**#23 LAN から届く時の認証**
規定 port は誰にも予測できる番号になるので、LAN の中で center を探しやすくなる。center は今、常に全アドレスで待ち受け、Bearer token だけで守る（平文、`center.rs:29`、`docs/architecture.md`）。
- 案 A: 今のまま（全アドレス + Bearer token。token は 12 文字以上、desktop が作る物は 32 文字の base62）。
- 案 B: 待ち受けを既定で loopback にし、LAN へ開くのは明示の設定にする（「常に全アドレス」の確定事項を変える）。S だけ使う利用者は LAN に開かなくて済む。
- 案 C: A に TLS を足す（center が終端、または前段の reverse proxy。web 設計 11 の判断 13 が同じ論点）。
- 案 D: client ごとの token と、接続元 IP の許可 list を足す。
- 推奨: A（利用者の決めてある線は今と同じ強さ。新しい仕組みを足さない）。B は仕組みを足さず安全側に倒せる案なので、LAN から使わない利用者向けの次の候補にして、別の決定にする。規定 port を知る者が token を試せる状態になる点を、手順書に書く（失敗の回数の制限などは利用者が決めていないので足さない）。

**#24 test・開発用の port（本番の起動は規定 port のみ）**
- 案 A: `--port` を廃止し、test も規定 port を使う（実行中の center と衝突する。test を 1 つずつ直列にする必要がある）。
- 案 B: 本番の経路（S・D・launchd の起動）では port を変えられず、test・開発用の起動の関数の引数（`startHttpServer` の `port` option など）でだけ変えられる。CLI の引数と環境変数では受けない。
- 案 C: 今のまま `--port` を残す。→ 「別の port に逃げない」の決定に反する（誤って別 port で起動できる）ので案から外す。
- 推奨: B（`packages/center/test/` と `scripts/e2e.ts` が `--port 0` で動いており、規定 port にすると開発中の center と衝突する。本番の起動の経路だけが規定 port に縛られる）。
**#25 `/graphql` の Host の検査**
- 事実: `/events`・core route・`/mcp` は、bind が loopback の時だけ Host を検査する（3.5）。S も D も全アドレスで待ち受けるので、通常は検査が無い。
- 案 A: 今の `/mcp`・`/events` と同じにする（loopback bind の時だけ検査する）。
- 案 B: 常に検査する（IP で繋ぐので、許可する Host の集め方が要る）。
- 案 C: 検査しない（Bearer だけ）。
- 推奨: A（今と同じ強さにそろえる。全アドレス待ち受けと規定 port の下での強化は #23）。

## 8. 次にやる事（推奨の順）

1. 未決 #22（規定 port の番号。利用者が決める）・#23（LAN の認証）・#24（test の port）・#25（/graphql の Host の検査）と、#2・#3・#14・#15・#20（bantou-center の作り方・登録・token）、#4・#6・#7 の決定（schema と配布の形に効く）。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A の worker を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。
3. 並行して段階 C の実測（`SMAppService` の登録が ad-hoc 署名の app で通るか、launchd 下で center が `claude` の認証を通すか、窓無し app の Local Network の許可）を行う。結果で #2・#14・#15 が決まる。
