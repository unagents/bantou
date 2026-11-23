# center を launchd の常駐 server（別の app bantou-center）にして GraphQL を持たせ、全 client で同じ見え方にする設計

- 作成: 2026-11-23（改訂を重ねた。0.1 に版の履歴と、採用していない指示を書いた）
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の指示（原文）と、決めてある事

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

利用者の追加の決定（cap が再送した物。原文）:

> desktopアプリとしてbantou-centerっていうのを別で用意する。そいつを起動すると、画面がないプロセスが起動する
>
> desktop側からのサーバーのdiscoveryはipのみで固定。
>
> centerのportを規定しておいて、規定portのみで起動する形は？（master-cap の説明の後「ok」）
>
> 今まではserver側とクライアントで見え方が違ったわけだけど、それが無くなる。クライアントアプリ上で設定変更を全部出来るようにする。でも保存する先は、server側（mac200）。クライアントアプリが今はmcpサーバーとしてサーバーを指定してるがこれがなくなり、serverのipを指定するのみになる（クライアント側で入れる唯一の設定）

決めてある事（変えない）:

1. center は desktop の app に同梱しない。OS の常駐の仕組み（mac は launchd）で、普通の server として起動する。
2. center の起動は、desktop の app とは別の app `bantou-center`（窓の無い app）で行う。起動すると center の process だけが動く。初回の起動で、自分を launchd に常駐として登録する。登録の手段は未決 #14。
3. center は GraphQL の endpoint を持つ backend の server になる。
4. client の app（desktop・web）は、frontend の app と同じく、center の GraphQL endpoint を叩いて画面を動かす。
5. desktop から center を見つける方法は IP の指定だけ（固定）。自動の発見（mDNS など）は使わない。
6. center の port は 1 つに決めておき（規定 port）、center はその port でしか起動しない。別の port に逃げない。同じ mac に center は 1 つだけになる。2 つ目の center は port が使用中で起動に失敗する。port が他の program に使われていて起動できない時は、理由が分かる error を出す。番号は利用者が決める（今の既定 7910 を推奨として未決 #22 に書く）。
7. server 側（center の host）と client で、見え方が違う状態をなくす。どの client から見ても同じ見え方になる。
8. 設定の変更は、client の app の上で全部できる（launcher 鍵で守っていた 7 項目も含む）。保存する先は server 側（center の host。今は mac200）。
9. client の app が center を MCP の server として指定している形はなくなる。client で入れる設定は server の IP だけ（client 側で入れる唯一の設定）。port は規定 port。したがって client に token を入れさせる形は取れない。認証の形は未決 #4。

この設計は、上の 9 点に上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

### 0.1 出所の確認が取れていない指示（採用していない）

この設計書の旧版（8ac588a 以降）は、作業指示の message（作業を任された worker の会話の user 欄。送り主は worker からは確認できない）に書かれた次の指示も「利用者の決定」として反映していた。cap から、出所の分からない訂正は採用できないとの指摘があり、この版でも次の 2 つは採用しない（上の 9 点の 2・5・6 は cap が再送したので採用した）。

- 「いや、app同梱はする。」: 9 点の 1（同梱しない）と両立しない。
- 「まず普通にdesktopアプリを起動。この時、centerを起動っていうのを選ぶと、裏でcenter起動。これは今と同じ。」（desktop の「center を起動」で裏起動する形。以降「sidecar 起動」）: 同梱しない・desktop は client だけ、と両立しない。cap から再送されていない。

版の履歴: 初版（4edee56）は同梱しない前提。8ac588a〜d241443 は出所確認中の指示を前提にした版。01cd7d1・ae4d942 で同梱しない前提に戻した。この版（第 6 版）で、cap が再送した決定（上の 2・5・6・7・8・9）を入れた。review の指摘（medium-1〜3、low-1〜6、5 節）への修正と、実測項目・未決の追加は残した。

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
client（desktop / web）  = 同じ Nuxt 画面（packages/ui）。同じ見え方。client に入れる設定は server の IP だけ
   │   GraphQL over HTTP（query・mutation）+ subscription。接続先は「IP + 規定 port」
   ▼
bantou-center（別の app。窓が無く、起動すると center の process だけが動く。初回の起動で launchd に自己登録）
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ 設定の保存先（center の host。sessions.json・center-settings.json など。client の画面から全部変えられる）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は center を起動も監視も同梱もしない。web は今の BFF の位置づけを未決 #4 で決める。
- **同じ見え方**: 今は center の呼び出し元で見え方が違う（desktop の sidecar だけが外部記憶 `memory` と追加の MCP `mcpServers` を読み書きでき、web・別 host の desktop には出ない。web は許可する tool を絞る。`session_delete`・`server_retire` は web に出さない。`packages/ui/composables` の `useCenterLauncher`・`SettingsDialog.vue` の `commonLauncher`）。この区別をなくす（2.3・2.5・未決 #6）。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。center は「desktop と基本は一体」（`docs/concept.md` の登場者）から「独立した server」に変わるので、`docs/concept.md` / `docs/architecture.md` / `CLAUDE.md` の「sidecar 同梱」の文の改訂が要る（4 節の段階 G）。

### 2.2 center の常駐（入れ方・起動・止め方・更新・消し方）

どの案でも、既存の仕組みを土台にする: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | `bantou-center` の app を入れる（配り方は未決 #3）。**初回の起動で app が自分を launchd に登録する**（手段は未決 #14）。利用者の操作は app を起動する 1 回だけ。冪等（登録済みで起動しても二重に登録しない） |
| 起動 | 初回は利用者が app を起動した時。以後は launchd が起動する（login 時など）。中身は center の process（`--transport http --bind --config`。**port は規定 port で、引数で変えられない**、2.8・#24）。center の認証の鍵・設定は center の host に置く（#4）。種別（LaunchAgent / LaunchDaemon）は未決 #2、状態 dir は未決 #9 |
| 親の監視 | center は 2 秒ごとに `ppid` を見て、起動時から変わったら終わる（`parent-watch.ts`）。bantou-center の作り方（未決 #15）で親が変わる: app が center を子として起動する形なら、app が死ねば center も終わる。center が launchd の直下なら `ppid` は変わらず何もしない【推測。6 節で実測】 |
| 止め方 | client の画面から止められる形を第一に考える（GraphQL の mutation。未決 #18）。launchd が止める時は SIGTERM。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:258` 付近）。service の停止待ちはそれより長く取る（web 設計 9.1） |
| 更新 | bantou-center を更新しても、動いている center は旧 binary のまま。再起動して初めて新しい版になる。更新の配り方は #3、再起動の入口は #12・#18。再起動で session は `--continue` で戻る（`restore()`） |
| 消し方 | 常駐をやめる（launchd の登録を外す）。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）。app を消した時に登録が残る問題は 2.7.6。入口は #18 |
| ログ | center のログ file（`logDir`、`packages/center/src/log.ts`）と launchd の stdout / stderr 設定。画面の「center の状態」は GraphQL で返す（3 節） |
| Linux | systemd user unit（web 設計 9.1 の例）。app の無い host の入れ方は未決 #21。Windows は未決 #10 |

- `claude` の解決・PATH: service は login shell を通らない（`packages/center/src/path-env.ts`・`claude-path.ts` は login shell から PATH を引く作りで、無ければ固定の候補→config の `remoteControl.claude`）。service 化後の `claude` の探索は【未確認】。実測（6 節）。
- 【事実】`claude` の認証は center を動かす OS user の設定 dir 配下で、mac は login keychain に保存される（`docs/handoff.md` の Lessons: keychain が locked だと refresh token を保存できず 401 になった事例）。LaunchAgent（user の login の domain）と LaunchDaemon（system の domain）で keychain に届くかは【未確認】。未決 #2 の判断材料で、実測する。

### 2.3 GraphQL schema の輪郭

置き場は center の http server（今の `/mcp` と同じ port・同じ認証。path は `/graphql`【案】）。型は `packages/ui/types/index.ts`（今の画面が使う型）を土台にする。以下は輪郭で、field の細部は実装の task で決める。

**Query**

| 名前 | 返す物（今の画面が使う型） | 今の元 |
|---|---|---|
| `sessions` | `SessionList`（`sessions[]`、`reachable`、`reason`）。`Session` = name / state / sessionUrl / source / lastError / path / contextUsage / instructions / activity / activityAt / background / remote / auth / loginUrl / loginError / sleeping | MCP `session_list`、`list_sessions`・`refresh_sessions` |
| `session(name)` | 1 session | 同上 |
| `sessionSettings(name)` | `ProjectSettings`（instructions / addDirs / outputStyle / servers / memory / mcpServers / projectMemory。どの client にも同じに出す。秘密の値の伏せ方は #6） | `session_settings_get` |
| `centerSettings` | center 共通の設定（`CenterCommonSettings` + memory / mcpServers / projectMemory ほか、範囲は #27）。`launcher` の印は無くなる（見え方が同じ） | `center_settings_get` |
| `centerInfo` | `{ workspace, systemInstructions[]（id / version / title） }`（`center_info` が返す形から `launcher` を外す。launcher の区別がなくなるため。`session_path_hints` の素は workspace） | `center_info` |
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
| `deleteSession(name)` | 今の desktop の UI は使っていない。見え方を同じにするので、web にだけ出さない区別はない。出すかは未決 #5 | `session_delete` |
| `startSessionLogin(name)` / `submitSessionLoginCode(name, code)` | session の claude の再ログイン | `session_login` / `session_login_code` |
| `restartSession(name)` | 再起動（今は `rc_stop` → `rc_start(resume)` の 2 手、`packages/ui/api/center.ts:118-121`）。1 つの操作にする案 | `rc_stop` + `rc_start` |
| `replyWorker(remoteId, server, workerId, text)` | worker への返答 | `worker_reply` |
| `retireServer(serverId)` | server の退役（取り返しがつかない）。見え方を同じにするので全 client に出る。確認の形は #4・#5 | `server_retire` |
| `revokeClientKey` など | 認証の形（#4）で決まる（案 B なら、発行済みの鍵の失効・承認待ちの接続の承認 / 拒否）。desktop が token を作って渡す今の `center_regenerate_token`（Rust の command）はなくなる | `center_regenerate_token`（Rust、`center.rs`） |
| `setMcpSecret(name, value)` | MCP の接続の鍵の値を center の host に保存する（write-only。どの query も値を返さない）。今は `bantou-center mcp secret`（標準入力か file）だけ。範囲は #6・#27 | `mcp-secrets.ts`（CLI） |
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
- 見え方（決めてある事の 7）: client の種類（desktop・web）で field・操作を変えない（launcher 判定・web 用の許可 tool の絞りは無い）。違いが出るのは認証（#4）の結果だけ。
- GraphQL が公開しない物: master-cap 向けの `/mcp/session`（`session_resession` など）、hook / status-line の受け口（session token）、server-link。session の claude が使う物は GraphQL に出さない。

### 2.4 認証

- 今: center の `/mcp` は `Authorization: Bearer <token>`（定時間比較、欠落・不一致は 401）。token は desktop が生成して center の config に書き、client は接続設定（URL + token）として持つ。web は BFF が token を持ち、前段の Cloudflare Access が守る。待ち受けは `0.0.0.0` で TLS 無し（`docs/architecture.md`）。
- 変わる事: client で入れる設定は server の IP だけ（決めてある事の 9）。**client に token を入れさせる形は取れない**。token を desktop が作って center の config に書く今の流れ（`center.rs`・`center_snippet.rs`）もなくなる（center を起動するのは `bantou-center` で、desktop は起動しない）。
- 認証の形は未決 #4（各案と推奨）。論点: (1) 認証なしで届く範囲を絞る（待ち受けの範囲・接続元の IP）、(2) 初回の接続で center 側が鍵を渡す、(3) 取り返しのつかない操作（`retireServer`・`deleteSession`）と設定の書き換え（7 項目を含む）を、どの client に許すか（見え方を同じにするので、client ごとの区別は無い。#6）。
- 「launcher 鍵」: 今は desktop が sidecar を起動した事を起動ごとの鍵で証明し、起動元だけが `memory`・`mcpServers` を読み書きでき、`projectMemory` を読める（書きは `bantou-center memory set --session`・移行・設定 file の直接編集だけ）。旧設定の `mcp`・`mcpConnections`・`mcpSecrets`・`coordinator` は誰からも MCP では書けない。守る項目は合わせて 7 つ（`CENTER_ONLY_KEYS`: `packages/center-client/src/tool-policy.ts:45`、`packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS`）。書きは `assertCenterOnly`、読みは `withoutLauncherKeys` が絞る（定義は `project-settings.ts`、`tools.ts`・`sessions.ts` が呼ぶ）。**見え方を同じにする決定（7・8）で、この区別はなくなる**。7 項目それぞれの扱いは未決 #6。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| center の sidecar 起動・監視（`center.rs`）、同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_status` / `center_set_settings` の起動項目（enabled・port・bind・workspace・claudePath）、token の生成・regenerate、launcher 鍵、`bantou://center-running` | **捨てる**（center は `bantou-center` が起動し、設定は center の host に置く。client には残さない） |
| 接続先の指定（今の `remote` = URL + token、`center_connection`、MCP の server としての指定） | **server の IP だけ**に変わる（client で入れる唯一の設定）。port は規定 port（2.8）。token は入れない（#4）。自動の発見は使わない |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`） | **捨てる**（webview が GraphQL を直接叩く。Rust の中継層が無くなる） |
| 添付（`attachment.rs`: `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`） | **分ける**。消す: center への中継（`upload` = reqwest で `POST /sessions/<n>/attachments`、`run` の接続先の選択 `select_target`・`load_settings`、保存した path を pty に打つ `post(.. "input" ..)`・`input_text`・`b64`）。webview が GraphQL（`attachToSession`・`terminalInput`）か、残す HTTP route（#7）で行う。残す: desktop の OS 側の入口 = `session_attach_pick`（file dialog、`rfd`）、`session_attach_paths`（drop された path の受け取り）、`load`（path から bytes を読む）、画像の型の見分け `sniff_type`・大きさの検査 `check_size`（`MAX_BYTES` = 20 MB。center も同じ検査をする）。この 2 つの command は「保存まで行う」から「読んだ bytes と名前を webview に返す」形に変わる（形は未決 #7）。`session_attach_bytes` は clipboard の bytes を webview が既に持つので、command ごと不要 |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips` / `center_ip_status`） | **捨てる**（token 入りの接続設定を貼る形がなくなる。入れるのは IP だけ） |
| 設定画面（`SettingsDialog.vue`・`ProjectSettingsDialog.vue`・`ProjectSettingsFields.vue`） | 設定の変更を全部この画面でできるようにする（launcher 鍵で守っていた 7 項目の欄も、どの client にも出す。launcher 判定の `useCenterLauncher`・`commonLauncher` はなくなる）。保存先は center の host（GraphQL の mutation）。範囲は未決 #27 |
| updater・relaunch（app 自身の更新） | **残す**（client の更新は center と切り離す） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える）。「client で入れる唯一の設定は server の IP」との整合は未決 #8 |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するか・「唯一の設定」との整合は未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と、移行中の互換だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す案と、薄い proxy にする案、ブラウザが直接叩く案。web も「見え方は同じ」で、許可 tool の絞り（`WEB_ALLOWED_TOOLS`）はなくなる |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` の項目は不要になる）。
- 設定画面の入口: client の設定は IP の入力欄 1 つ。「center を起動する」の switch・port・IP の選択・状態・token の再生成は消える。center の状態の表示は GraphQL（`centerStatus`）から。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center を起動する者（desktop の子 process → launchd）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:330` の `centerUrl`）で動く。
### 2.7 bantou-center（窓の無い別の app）

決めてある事: center は desktop の app に同梱しない。desktop の app とは別の app `bantou-center` を用意する。窓が無く、起動すると center の process だけが動く。初回の起動で自分を launchd に常駐として登録する。desktop は launchd にも center の binary にも触らない（client だけ）。

【事実】今の関係部品:
- 同梱の仕組み（今は desktop）: `packages/desktop/src-tauri/tauri.conf.json` の `bundle.externalBin`（`binaries/bantou-center`・`binaries/bantou-pty-wrapper`）。build は `packages/desktop/scripts/build-sidecar.ts`（target triple の suffix 付きで置き、bundle 時に外れる）。bantou-center の app はこの手順を使って center の binary と wrapper を自分の bundle に入れる。desktop の bundle からは外す。
- 配り: Homebrew cask `packages/desktop/Casks/bantou.rb`（arm64 の macOS、`auto_updates true`、`app "bantou.app"` の 1 つだけ、`zap trash` は `~/Library/Application Support/jp.grrow.bantou` と `~/Library/Caches/jp.grrow.bantou`。**launchd の登録を外す stanza は無い**）。app 自身の更新は `tauri_plugin_updater`（1.6。更新対象の app の bundle を置き換える物）。
- 署名: ad-hoc 署名（`signingIdentity: "-"`）で、版ごとに code identity が変わる（`docs/ops/desktop-signing.md`。Local Network の許可が更新で失われる問題の記録）。bantou-center も別の code identity を持つので、LAN への接続の許可（Local Network）を別に受ける必要が出うる【未確認】。

#### 2.7.1 実体（app の作り方）

窓の無い app の作り方の案は未決 #15（X: Tauri の窓無し app が center を子として起動する / Y: bundle の実行 file を center の binary にする / Z: 薄い native の launcher）。どの形でも、見える挙動は同じ: Dock に出ず、起動すると center が動く。

#### 2.7.2 起動の挙動（初回と 2 回目以降）

| 状態 | bantou-center の動き（案。細部は未決） |
|---|---|
| 初回の起動（未登録） | center を起動し、自分を launchd に常駐として登録する（手段は未決 #14）。OS の確認（Login Items への追加の通知など）が出うる（#17）。登録の結果は log に出す（窓が無い） |
| launchd が起動した（登録済み） | center を起動するだけ |
| 登録済みで、利用者が app を手で起動した（Finder など） | 既に center が動いていれば何もしない（規定 port の使用中で起動に失敗して終わる。2.8）。止まっていれば起動する |
| 登録済みだが OS 側で無効にされた（System Settings の Login Items） | 起動した間は動く。次の login から自動では起動しない。知らせ方は #17 |
| 規定 port を他の program が使っている | 起動に失敗し、理由を出して終わる（2.8。launchd の再起動の loop にしない。#16） |

#### 2.7.3 client から見つける（IP のみ）

- client の設定で入れるのは server の IP だけ。port は規定 port（2.8）。自動の発見（mDNS・broadcast・同じ Mac の process 探索）は使わない。
- 同じ Mac の center に繋ぐ時も、IP（`127.0.0.1` など）を入れる。
- center は全アドレスで待ち受ける（`docs/architecture.md`）ので、同じ LAN の別 host の client も、同じ指定で繋げる。認証の形は未決 #4。

#### 2.7.4 更新（版は app と一緒）

- bantou-center の更新で新しい binary が入っても、launchd が起動済みの center は旧 binary で動き続ける【推測。bundle の置き換え中・後に実行 file と launchd の登録がどうなるかは【未確認】、6 節】。
- 新しい版にするには center の再起動が要る。入口は未決 #18（client の画面から GraphQL で / center の host の CLI で / OS の操作で）。再起動で session の claude は止まり、`restore()` が `--continue` で戻す（1.6。session の中断は今と同じ）。
- 版の違いの検出: client が GraphQL で center の版を取り、自分の版と比べる（#13）。server の版合わせは今の `follow.ts`（`BANTOU_PAIR_SERVER_VERSION`、build が埋める）のまま。
- bantou-center の更新の配り方（cask / updater）は未決 #3。

#### 2.7.5 止め方・常駐をやめる

窓が無いので、app の側では止められない。入口の案は未決 #18: (1) どの client の画面からでも GraphQL の mutation で（center が自分を止める・登録を外す。見え方を同じにする決定と合う）、(2) center の binary の subcommand（`bantou-center service …` のような物。center は既に `status-line`・`hook`・`memory`・`mcp` などの subcommand を持つ、`packages/center/src/cli.ts`）、(3) OS の Login Items の無効化と `launchctl` / kill。

#### 2.7.6 消し方

- 常駐をやめる: launchd の登録を外す（入口は #18）。状態 dir は消さない（#9）。
- app を削除した時（cask の uninstall）: 今の cask に launchd の登録を外す stanza は無い。登録が残って、実行 file の無い center の起動を launchd が試み続ける事になりうる。cask に `uninstall launchctl:`（label を指定）を足す案がある（cask の変更は別 task）。SMAppService の登録は app の削除で OS が扱うか【未確認】。

#### 2.7.7 app の無い host（web 用の Linux の host など）

app が無いので bantou-center は使えない。配り方は未決 #21。

### 2.8 規定 port（center は規定 port でだけ起動する）

利用者の決定（原文）: 「centerのportを規定しておいて、規定portのみで起動する形は？」（master-cap の説明の後、「ok」）。

決める事:

1. center の port は 1 つに決めておく（規定 port）。番号は未決 #22（利用者が決める。推奨 7910）。
2. center は規定 port でしか起動しない。別の port に逃げない。
3. 同じ mac に center は 1 つだけになる。2 つ目の center は port が使用中で起動に失敗する。
4. client は「IP と規定 port」でつなぐ。port の入力は無い（client で入れるのは IP だけ）。
5. port が他の program に使われていて起動できない時は、理由が分かる error を出す。
6. 認証の形は #4、LAN への待ち受けの範囲は #23、test・開発の port は #24。

#### 2.8.1 今の port の扱い（変わる所）

- 【事実】center の `--port` の既定は 7910（`packages/center/README.md`、`packages/center/src/args.ts`）。`0` は OS 任せ。
- 【事実】desktop の `CenterSettings.port` も既定 7910（`center.rs` の `DEFAULT_PORT`）で、設定画面から変えられる（`packages/ui/components/SettingsDialog.vue` の `centerSetSettings`）。
- 【事実】bind の失敗は、center の log から見分けて `CenterStatus.bindFailed` に出している（`center.rs:331` の `looks_like_bind_failure`、`packages/ui/types/index.ts` の `CenterStatus`）。
- 【事実】test は `--port 0` を使う（`packages/center/test/args.test.ts`・`http.test.ts`）。`packages/center/scripts/e2e.ts` は `node:net` を使う（空き port を取る用途と読める【推測】）。
- 変わる事: client の port の設定項目と入力欄を外す。center の `--port` 引数を本番の起動で使えなくする（test・開発の扱いは #24）。

#### 2.8.2 center の起動の順（2 つ目の center が何にも触らない事）

- 【事実】今の `daemon.ts` は、store の生成（`:172`・`:230`）と `loadCapId`（`:221`）の後に listen（`startHttpServer`、`:299`）し、その後に `sessions.restore()`（`:354`）を呼ぶ。孤児 process の回収（`reapOrphans`）は session を start する時に走る（`packages/center/src/remote-control.ts:400`）ので、port で失敗すれば、session の起動・孤児の回収には届かない。
- 要件: 2 つ目の center は、listen に失敗したら、状態 dir の file を書き換えず、session・孤児 process・remote の記録に触れずに終わる。store の生成と `center-id` の作成（`loadCapId`）が listen より前に file を書くかは【未確認】。書くなら、listen を先に移す。実装の task が確かめる。

#### 2.8.3 起動に失敗した時の error（理由が分かる）

- center の host の log（stderr）に、どの port か・使用中の相手が何かを出す。相手の見分け: 規定 port で GraphQL の疎通を試し、center なら「既に center が動いている（版）」、応答が GraphQL でない・接続だけできる・応答が無いなら「他の program が使用中」。使用中の process 名・PID を OS に問い合わせて足せるか（`lsof` 相当）は【未確認】。
- client から見える物: center が起動に失敗していると、client は「つながらない」としか分からない（center の host の log は client から読めない）。client は規定 port の疎通の結果（接続を断られた／接続できたが GraphQL でない応答／応答が無い）から、「center が居ない」「他の program が使っている可能性」を画面に出す。center の host で理由をどう知らせるか（OS の通知など）は未決 #17。

#### 2.8.4 同じ Mac に center が 1 つになる意味

- center が 1 つなら、状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いは起きない。
- 同じ Mac の別の user の login でも port は共有なので center は 1 つ。別の user が自分の center を起こすことはできない【決定から導いた制約。利用者に確かめる点。#19】。
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
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | client のローカルの設定は server の IP だけ（#26）。起動の項目（enabled・port・bind）はなくなり、workspace・claudePath は center の設定として `centerSettings` / `updateCenterSettings`（#27）で扱う |
| `center_status`（center.rs） | `centerStatus` | GraphQL の query / subscription `centerStatus`（center の状態）。子 process の restart 回数・bindFailed は意味が変わる（launchd の状態・規定 port の疎通の結果になる。#16・2.8.3） |
| `center_regenerate_token` | `centerRegenerateToken` | なくなる（desktop が token を作って渡す形がなくなる。認証の形は #4） |
| `center_local_ips` / `center_ip_status` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | なくなる（token 入りの接続設定を出す・貼る形がなくなる。client で入れるのは server の IP だけ。#26） |
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
| A | center に GraphQL の endpoint を足す（`/graphql`）。resolver は `packages/center-client/src/commands.ts` の表と center の中の関数を使う（query / mutation / subscription は 2.3）。設定の読み書きは、launcher 判定をせず全項目を同じに扱う形にする（#6・#27）。GraphQL server の部品は未決 #1 | 今の desktop・web は無変更で動く（`/mcp` を使い続ける）。GraphQL は test と HTTP の呼び出しで確かめる | endpoint を足しただけ。外せば元に戻る |
| A2 | center の起動を規定 port だけにする（番号は #22。`--port` の扱いは #24）。listen を状態への書き込みより先にし、失敗した時の error（使用中が center か他の program か）を出す（2.8.2・2.8.3） | center は規定 port で今のまま動く。規定 port が使用中なら、理由の分かる error が center の host の log に出る | `--port` を戻す |
| A3 | 認証（#4）の実装。client に token を入れさせない形（選んだ案）を GraphQL の endpoint に入れる。**B の前に決める・入れる**（B で client が token を持たなくなるため） | GraphQL が選んだ認証で守られる | 認証の方式を戻す |
| B | `packages/ui/api/*.ts` を GraphQL client に差し替える。web の `~/tauri` の transport を GraphQL にする（BFF の形は未決 #4）。desktop の `src/tauri/transport.ts` は、center 系の command を GraphQL へ、native 系（workspace・updater・Cork）だけ Tauri に残す。接続先を「server の IP」だけにする（2.5）。subscription は `terminalOutput`・`sessionsChanged`・`sessionMessage`。設定画面を全項目・全 client で同じ見え方にする（#6・#27。launcher 判定の `useCenterLauncher`・`commonLauncher` を外す） | web が GraphQL で動く。desktop は「center 系は GraphQL / native 系は Tauri」の混在で動く | 差し替えを feature flag か branch 単位にすれば戻せる。center 側は無変更 |
| C | bantou-center の app を作る: C1 = app の実体（#15）と同梱・build・配り方（#3、cask の構成）、C2 = 初回の自己登録（#14）と登録の状態の扱い（#17）、C3 = 窓の無い app の操作の入口（止める・更新・登録解除。#18。GraphQL の mutation と center の subcommand）、C4 = 規定 port の使用中の判定と error（2.8・#19） | bantou-center を起動すると center が動き、登録され、client が IP だけで繋がる。desktop の sidecar は残したまま動く | app を使わなければ今の形 |
| D | desktop から sidecar を外す: `center.rs`・`center_mcp.rs`・`center_events.rs`・`session.rs` の cache・`terminal.rs`・`attachment.rs` の upload・接続先の選択・pty への input の中継（OS 側の入口 `pick` / `paths` と `load`・型・大きさの検査は残す、2.5）・`center_snippet.rs`・launcher 鍵・`externalBin`・`build-sidecar.ts` を消す。dmg から center が消える | desktop は IP だけで center に繋ぐ client だけになる。app の更新が center に触らない | D の前の release に戻せる |
| E | `/mcp` の残し方（#5）の整理と、取り返しのつかない操作（`retireServer`・`deleteSession`）を全 client に出す形の確認（#4・#5） | 全 client で同じ操作が使える | 出す操作を絞る |
| F | 更新の入口（#3・#12・#18）の自動化。center の更新と server の版合わせ（`follow.ts` の `BANTOU_PAIR_SERVER_VERSION`）を、desktop の build に依らない形にする | center が独立して更新・再起動する | 手動の更新に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`（57 行目の「Host / Origin を絞らず」の抜けも直す。3.5。「token を貼る接続設定」の節も）・`CLAUDE.md` の Map・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に bantou-center の設置の手順書を足す。ほかの設計書の「desktop の sidecar」の記述（`docs/design/master-cap-session.md` など）の読み替え | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・設定の全項目・subscription）は、C（bantou-center）と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は新しい app の package・build・cask）。
- A の中でも、query 群、mutation 群（session の操作・設定・login・retire）、subscription は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。A2・A3 は A と別の file（`daemon.ts` の起動順・認証）で、A3 は #4 の決定後。
- B は A・A3 の schema と認証に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- C は C1 が土台で、C2・C3 はその上。C4 は center 側（二重起動の検出）と client 側（接続できない時の表示）で別 worker にできる。#14・#15 の決定が先。
- D は B と C の完了後。E・F は D と並行できる。
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
- 見え方が同じ: 認証を通った client は、client の種類（desktop・web）によらず、同じ field・同じ操作を使える（launcher 判定・web 用の許可 tool の絞りがない。`tool-policy.ts` の `WEB_ALLOWED_TOOLS` に当たる物が無い）。
- 設定の全項目（#27・#6）: 設定画面の項目（7 項目を含む）が、client から書いて center の host の保存先（`center-settings.json`・`sessions.json`）に残り、別の client から読むと同じ値が見える。`mcpSecrets` の値は write-only で、どの query でも返らない。
- 認証（#4）: 選んだ案どおりに、認証の無い接続が拒否され（または絞った範囲だけが通り）、初回の接続で渡される鍵が使える（案 B の場合）。比較は定時間（`packages/center/test/` の既存の `/mcp` の認証 test と同じ形）。
- 互換: GraphQL の `Session` が `packages/ui/types/index.ts` の `Session` と同じ形で返る（`center-client` の `parseSession` と同じ検査）。
- subscription: 端末の `after` での続き・`reset`・`end`、接続が切れた後の再接続、`sessionsChanged` の reason が既存の 10 種を全部運ぶ（`packages/center/src/events.ts`）。
- client: `packages/ui` の既存の test（`packages/ui/test/`）と e2e（`packages/desktop/e2e/*.spec.ts` は Tauri の IPC を mock して画面を動かす。`packages/web/e2e/`）が、transport の差し替え後も通る。mock の層を GraphQL に置き換える（`packages/desktop/e2e/mock/`）。client の設定が server の IP だけで接続できる。
- center の既存 test（`packages/center/test/*.test.ts`）は全部通ったまま（GraphQL は足すだけの段階 A）。
- 窓の無い app（2.7.2）: 初回の起動（未登録）・launchd 起動・手で起動（既に動いている / 止まっている）・OS で無効化された後、の各状態で、振る舞いが表のとおりになる。登録の結果が log に残る。登録は冪等（2 回起動しても二重に登録しない）。登録の解除（入口は #18）が通る。
- 規定 port（2.8）: (a) 規定 port が空いている時に起動する。(b) 2 つ目の center は、listen に失敗したら、状態 dir の file・session・孤児 process に触れずに終わる（2.8.2）。(c) 規定 port を他の program が使っている時、使用中が center か他の program かが分かる error が center の host の log に出る。(d) launchd が、port 使用中で終わった center を再起動し続けない（#16）。(e) 別の port では起動できない（本番の経路。#24）。

**実測（mac の実機。値は測って書く。この設計では決めない）**

- launchd で center を起動し、`claude` が見つかり、認証が通る（LaunchAgent / LaunchDaemon の差。keychain が locked でも 401 にならないか。`docs/handoff.md` の Lessons）。
- `SMAppService` の登録が ad-hoc 署名・自己署名の app で通るか（#14）。管理者権限なしで登録できるか。
- 窓の無い別 identity の app で、Local Network の許可が通り、LAN の別 host の remote の server・broker へ繋がるか（`docs/ops/desktop-signing.md` の件）【未確認】。
- bantou-center の更新中・後に、動いている center と launchd の登録がどうなるか。cask uninstall の後に登録が残って起動に失敗し続けないか。
- `parent-watch.ts` が launchd の下で何もしない事（ppid が変わらない）。
- host の再起動・login の前後・center の kill・launchd による再起動で、session が `--continue` で戻る事（`restore()`）と、停止にかかる時間（`stopGraceMs` と service の停止待ちの関係）。
- GraphQL server の部品（未決 #1）が `bun build --compile` の単体 binary で動く事。今は `@modelcontextprotocol/sdk` と zod が compile で遅延初期化に包まれて落ちた事がある（`packages/center/src/cli.ts` の冒頭の注記）。同種の問題が GraphQL の部品で出ないか。
- 端末の subscription の実測: 出力が多い時の遅延・切断・再接続の後の続き。web の Cloudflare 経由（SSE / WebSocket が通る条件。web 設計 8.5）。
- 認証: 別 host の client（LAN・Tailscale）から、IP だけの設定で繋がる事。選んだ認証の案（#4）が、実際の経路で働く事。
- 更新: center を入れ替えて再起動した時の session の中断の長さと、`follow.ts` の server の版合わせ。
- client: center が止まっている時に「つながらない」を画面に出して、戻れば自動で再接続する。

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
- 推奨: 単位は A（center 1 つ = 1 つの常駐。`docs/concept.md` の原則 6 と、web 設計 6.4 の「1 host に center を複数立てない」に沿う）。種別は A（LaunchAgent）。理由: (1) app を起動する 1 回の操作で自己登録できる（user の domain なので管理者権限が要らない【推測】。LaunchDaemon は `/Library` に置くので管理者権限が要り、app からの登録に権限の確認が入る）。(2) `claude` の認証が login keychain にあり（`docs/handoff.md` の Lessons）、user の login の domain の方が keychain に届く【推測。未確認】。LaunchAgent は user が login していないと起動しない（host の再起動後に自動ログインが要る）という制約があり、これが許されない運用なら B（その場合、自己登録の形が変わる）。web backend は別の service（web 設計 9.1）のまま。

**#3 bantou-center の配り方と更新の配り方（決めてある事: desktop の app に同梱しない）**
- 事実: 今の cask は `app "bantou.app"` の 1 つだけ。app の更新は Tauri の updater（更新対象の app の bundle を置き換える。`auto_updates true`）。updater が置き換えるのは更新対象の app の bundle で、別の app は更新されない【推測。updater の挙動は未確認】。
- 配りの案: (a) 同じ cask・同じ dmg に app を 2 つ入れる（`app "bantou.app"` と `app "bantou-center.app"`。desktop の bundle に center は入れないが、2 つ同時に入る）。(b) 別の cask にする（`bantou-center`）。(c) cask を使わず GitHub Releases の配布物と手順書で入れる。
- 更新の案: (A) bantou-center にも Tauri の updater を持たせる（窓が無いので通知・再起動の入口は #18）。(B) cask の upgrade だけにする（`auto_updates true` との関係を見直す）。(C) 手動の入れ替え。
- 推奨: 配りは (b)（center だけを入れる host（mac200 など）に desktop を入れずに済み、center と desktop の更新が切り離れる）。更新は (A)（今の updater・Releases・`latest.json` の流儀を使う）。center を置く host に app（bantou-center）を入れる前提で、app の無い host は #21。

**#4 認証の形と、web の BFF（client に token を入れさせない形）**
- 前提（決めてある事）: client で入れる設定は server の IP だけ。port は規定 port。したがって client に token を入れさせる形は取れない。今の「token を desktop が作って config に書き、接続設定で配る」流れ（`center.rs`・`center_snippet.rs`）はなくなる。見え方を同じにする決定で、設定の全項目（7 項目を含む）の書き換えと、取り返しのつかない操作（`retireServer`・`deleteSession`）が、認証を通った全 client に開く。認証の重みは今より増える。center は全アドレスで待ち受ける（`docs/architecture.md`、#23）。
- 案 A: **認証なしで、届く範囲を絞る**。絞り方: (a) loopback だけ（同じ Mac の client だけ）、(b) 同じ LAN の private な範囲・Tailscale だけ（bind / 接続元 IP の範囲）、(c) 接続元 IP の許可 list（center の設定。許可 list の編集は client の画面から）。認証の仕組みは増えないが、範囲の中の誰でも全設定・全操作ができる。
- 案 B: **初回の接続で center 側が鍵を渡す**（pairing）。client が初めて繋ぐと、center が client に鍵を発行して返し、client がそれを保存して、以降の接続で使う（client の利用者が入力する物ではない）。渡す条件: (B1) 無条件（最初に繋いだ client が鍵を得る。範囲内の誰でも得られる）、(B2) center の host で承認してから渡す（承認の入口は #20）。鍵の失効は center の host から行う。
- 案 C: 認証なし（全アドレスで開く）。今より弱い。
- 案 D: 前段の仕組みに任せる（Tailscale などの VPN、Cloudflare Access、reverse proxy の認証）。center 自身は認証を持たず、前段を通った接続だけが届く範囲に置く（案 A の (a)(b) と組み合わせる）。
- web の形: (a) BFF を残す（BFF が client として鍵を持ち、ブラウザには出さない。BFF が入れる設定も server の IP だけ）、(b) 薄い proxy、(c) ブラウザが center を直接叩く（鍵を保存する場所がブラウザになる）。
- 推奨: 認証は B2（center の host で承認してから鍵を渡す）を土台にし、届く範囲は案 A の (a)(b) の考えで #23 の待ち受けの範囲として別に決める。理由: 案 A だけだと範囲の中の誰でも 7 項目を含む全設定を書き換えられ、B1 は最初に繋いだ者が鍵を得る。B2 は client の利用者に何も入れさせず、承認が center の host の側に残る。web は (a)。これは利用者に聞く点（認証の強さと、初回の承認の手間の釣り合い）。

**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。見え方を同じにする決定（7）で、web にだけ出さない区別はなくなる。`retireServer` を全 client に出す扱いは #4 の論点。

**#6 launcher 鍵の廃止と、7 項目の扱い（どの client からも設定を全部変えられる）**
- 決めてある事: 見え方を同じにし、設定の変更を client の画面で全部できるようにする（launcher 鍵で守っていた 7 項目も含む）。保存先は center の host。したがって launcher 鍵（起動元だけが読み書きできる仕組み）はなくなる。desktop が center を起動しないので「起動元」も無い。
- 守っていた項目は 7 つ: `memory` / `mcpServers` / `projectMemory` / `mcp` / `mcpConnections` / `mcpSecrets` / `coordinator`（`packages/center-client/src/tool-policy.ts:45` の `CENTER_ONLY_KEYS`。center 側は `packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS` で、同じ 7 つ）。書きは `assertCenterOnly`（`project-settings.ts:176`）、読みは `withoutLauncherKeys`（`:184`）が絞っている。
- 項目ごとの今の扱いと、変えた後の案:

| 項目 | 今の扱い | 変えた後の案 |
|---|---|---|
| `memory`・`mcpServers`（`LAUNCHER_KEYS`） | 起動元だけが読み書きできる。それ以外は書くと error、読みの応答から除く | どの client からも読み書きできる（設定画面の欄を全 client に出す）。秘密の値を含みうるので、読みの応答での値の扱いを決める（下の案 A / B） |
| `projectMemory`（`FILE_ONLY_KEYS`） | 起動元だけが読める。書きは MCP の設定の更新では誰もできず、`bantou-center memory set --session`・移行・設定 file の直接編集だけ | どの client からも読み書きできる（GraphQL に書く口を足す）。または今のまま CLI だけにする（#27 の範囲） |
| `mcp`・`mcpConnections`・`coordinator`（`LEGACY_INTERNAL_KEYS`） | 旧設定。誰からも MCP では書けない（起動元にも別の error）。読みの応答からは除かれない（旧設定が残っていれば応答に出うる【未確認】） | 「設定」ではなく旧設定の残りなので、GraphQL に出さない（書けない・読めない）。残っている旧設定は center が移行して消す扱いを実装の task が確かめる |
| `mcpSecrets`（`LEGACY_INTERNAL_KEYS`。鍵の実体は別 file `mcp-secrets.json`、0600） | settings の key としては同上。鍵の値を入れるのは `bantou-center mcp secret`（標準入力か file）だけ。値は表示・log・error に出さない（`packages/center/src/mcp-secrets.ts` の冒頭） | 鍵の値は client から書ける（write-only の mutation）。読みは値を返さない（名前だけ）。client から書く時に値が通信路を通る点は #23（待ち受け・TLS）の論点 |

- 案 A: 上の表の「変えた後の案」のとおり（`memory`・`mcpServers`・`projectMemory` は全 client から読み書き、旧設定 4 項目は出さない、鍵の値は write-only）。読みの応答での値の扱いは、そのまま返す。
- 案 B: 案 A のうち、秘密を含みうる欄（`mcpServers` の env・header の値など。entry が秘密の値を直接持つのか `mcp-secrets.json` の名前で参照するのかは【未確認。`mcp-server-def.ts`・`mcp-session.ts` を実装の task が確かめる】）の値は、読みの応答で伏せ（名前・存在だけを返し）、書く時に値を入れ直す（write-only）。
- 案 C: `memory`・`mcpServers` だけ全 client から読み書きし、`projectMemory` と鍵の値は今のまま center の host の CLI だけにする（全部は client からできないので、決めてある事から外れる部分が残る）。
- 推奨: B（見え方は同じで、秘密の値だけ読みの応答から伏せる。伏せ方で settings の往復（読んで書き戻す）が壊れないよう、「伏せた欄は変更なし」として扱う）。C は決めてある事（全部できる）と合わないので推奨しない。認証（#4）が弱い案だと、全 client に 7 項目の書き換えを開く重みが増す点は #4 の判断材料。

**#7 端末の入出力と添付を GraphQL に載せる範囲**
- 案 A: 出力は subscription、入力・サイズは mutation、添付の画像（bytes）は既存の HTTP route `POST /sessions/<n>/attachments` を残す。
- 案 B: 全部 GraphQL（添付は GraphQL multipart upload か base64 の mutation）。
- 案 C: 端末の出力・入力も既存の HTTP route を残し、GraphQL は一覧と操作だけ。
- 推奨: A。理由: 出力は `id` / `after` / `reset` の再開付きの stream で、今の SSE の振る舞い（`Last-Event-ID`）を subscription で再現できる【未確認】。画像の bytes は GraphQL に載せにくい。C は「画面が使う物は GraphQL で漏れなく」の方針から外れる。
- 添付の bytes を webview に渡す形（2.5 で残す OS 側の入口 `session_attach_paths` / `session_attach_pick` の形）: 案 A: Tauri の command が file を読んで bytes と名前を返し、webview が `attachToSession`（または残す HTTP route）で送る（Rust に center への通信が残らない）。案 B: 今どおり Rust が読んで center に直接 upload する（Rust の中継層（reqwest・接続先・token）が添付の分だけ残る）。推奨 A（中継層をなくす方針）。大きい画像（20 MB まで）を IPC で返す形は【未確認】（今の `session_attach_bytes` は JSON 配列にしないため raw body を使っている。`attachment.rs` の doc）。

**#8 Cork の task・旧 broker・thread・agent と、desktop ローカルの状態（「client で入れる唯一の設定は server の IP」との整合）**
- 案 A: この設計では触らず、desktop ローカルの機能として残す。window の folder（`pick_directory`・`set_workspace_directory`・履歴）は、利用者が入れる「設定」ではなく選ぶ物・状態なので、「唯一の設定」の対象に含めない。
- 案 B: center に移して GraphQL に出す。
- 案 C: 廃止する。
- 推奨: A（利用者の指示は center の起動の仕組みで、これらは center と無関係。`docs/handoff.md` の Open にも、使われていない command がある）。web がこれらを出していない（web 設計の判断 5）のと同じ扱い。廃止の可否は別の決定。「唯一の設定」に window の folder を含めるかは、利用者に確かめる点。

**#9 状態 dir の置き場と、設定の分け方（接続先 / center の起動項目）**
- 案 A: 今 desktop が使う `~/.local/share/bantou/` をそのまま使う（`sessions.json`・`remotes.json`・`handoffs/`・`center-id` が引き継がれ、session・remote-cap の記録が残る）。
- 案 B: service 用の新しい場所（`~/.config/bantou/` など。`packages/center/README.md` の既定）に作り直す。
- 推奨: A。理由: 移行で session と cap の記録が消えない。`center-id`（cap_id の素、`docs/architecture.md`）が変わると cap の記録の対応が崩れる。設定の分け方は、center の設定（workspace・claudePath ほか）は center の host に保存し、client のローカルは server の IP だけ（#26）とする。

**#10 Windows**
- 案 A: bantou-center は mac の app（launchd）で、Linux は systemd（#21）。Windows の desktop は client として、IP だけで center に GraphQL で繋ぐ。
- 案 B: Windows の center の常駐（Windows service）も扱う。
- 推奨: A（利用者の指示は launchd。`pty-wrapper` と `claude` の Windows 対応は今の repo に根拠が無い【未確認】。今の cask も arm64 の macOS だけ）。

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
**#14 自分を launchd に登録する手段（bantou-center の初回の起動）**
- 案 A: `SMAppService.agent(plistName:)`。app の bundle 内の plist（`Contents/Library/LaunchAgents/`）を OS が登録する。launchd が `KeepAlive` を管理できる。登録は OS の Login Items に出て、利用者が System Settings で無効にできる。macOS 13 以降（今の cask は sequoia 以降、`depends_on macos: :sequoia`）。
- 案 B: `SMAppService.mainApp`（ログイン項目）。login 時に app が起動するだけで、launchd の `KeepAlive` は無い。
- 案 C: app が `~/Library/LaunchAgents/<label>.plist` を書き、`launchctl bootstrap gui/<uid>` を実行する。OS の承諾の画面は無い。今の `center.rs` が `kill(1)` を `std::process::Command` で呼ぶのと同じ流儀。
- 案 D: center の subcommand（`bantou-center service install`）が plist を書いて登録する（app はそれを 1 回呼ぶ。Linux の systemd unit も同じ入口にできる）。
- 案 E: LaunchDaemon（管理者権限が要る。#2 の B）。
- 推奨: A（利用者の挙げた SMAppService に沿い、OS の画面で利用者が見て止められる。`KeepAlive` が使える）。ただし ad-hoc 署名・自己署名の app で `SMAppService` の登録が通るかは【未確認】（`docs/ops/desktop-signing.md`）で、実測する。通らなければ C か D。Rust から `SMAppService`（Objective-C / Swift の API）を呼ぶ方法（objc2 など）も実装の task が確かめる。

**#15 bantou-center の実体（窓の無い app の作り方）**
- 案 X: Tauri の窓の無い app（macOS の activation policy を accessory にして Dock に出さない）が、center を子 process として起動する。今の `center.rs`（spawn・backoff・停止）をほぼ流用できる。launchd が見るのは app、app が見るのは center の 2 段。
- 案 Y: app の bundle の実行 file を center の binary にする（`LSUIElement` 相当の Info.plist）。launchd が直接 center を起動する。process は 1 つ。ただし `SMAppService` を center（bun の単体 binary）から呼べないので、登録の呼び出しだけ別の物が要る。
- 案 Z: 薄い native の launcher（Swift など）が center を子として起動し、登録も行う。新しい toolchain が増える。
- 推奨: X（最少の新しい部品。Rust 側に既に center の起動・監視・停止がある。center の `parent-watch.ts` の「親が死ねば終わる」もそのまま働く）。launchd と app の 2 段の再起動（launchd の `KeepAlive` と、`center.rs` の backoff の二重）の整理は #16。

**#16 落ちた時の再起動の持ち主と、二重起動の時の終わり方**
- 案 A: launchd に任せる（異常終了だけ再起動する設定。値は実測して決める）。後から起動して「規定 port が使用中」と分かった時は、異常終了にせず自分から終わる（launchd が再起動し続ける loop を避ける。2.8）。
- 案 B: launchd は起動だけ。再起動は app（案 X なら app）が見る（今の sidecar と同じ backoff・断念）。
- 推奨: A（常駐の再起動は launchd に任せる）。X の app の中の backoff を残すか外すかは実装の task が決める。連続して失敗した時の振る舞い（launchd 側の扱い）は【未確認】。

**#17 初回の登録の承諾・無効にされた時・起動に失敗した時の知らせ方（窓が無い app）**
- 登録: 案 A 黙って行う（利用者の操作は app の起動だけ。OS が Login Items への追加を通知する場合はそれに任せる）／案 B 起動した時に 1 度だけ確認を出す（窓が無いので通知か小さな確認の画面）／案 C 登録は別の操作で行う（CLI など）。
- 知らせ方（登録が無効にされた・規定 port の使用中などで起動に失敗した）: center の host の log だけ／macOS の通知／client の画面（接続した時に「つながらない」と、規定 port の疎通の結果から分かる範囲の理由を出す。2.8.3）。
- 推奨: 登録は A（「初回の起動で自分を登録する」という利用者の決定どおり）。知らせは log と client の画面（窓の無い app から新しい通知の仕組みを足さない）。center の host の人が失敗を知る必要がある運用なら、通知を別の決定にする。

**#18 止め方・常駐をやめる・更新後の再起動・状態の見方（操作の入口）**
- 案 A: どの client の画面からでも、GraphQL の mutation（center の停止・再起動・登録の解除）と query（center の状態・版）で行う。center が自分で動く。
- 案 B: center の binary の subcommand（`bantou-center service status|restart|stop|uninstall` のような物。`cli.ts` の既存の subcommand の流儀）を、center の host で呼ぶ。
- 案 C: OS の操作だけ（System Settings の Login Items、`launchctl`、Activity Monitor）。
- 推奨: A と B の両方（A は見え方を同じにする決定に合い、client の画面だけで済む。center が止まっている時や認証できない時のために B）。A の mutation は `Mutation` に足す（2.3）。止めると client から再起動できなくなる（center が居ない）点は、画面に出す文言で知らせる。再起動すると session の claude が止まる（1.6）。更新後の再起動（#12）も同じ入口にする。

**#19 同じ Mac で center が 2 つ動く時（決定済み。規定 port で片付いた。残る小さな点）**
- 決定（利用者）: center は規定 port でだけ起動し、別の port に逃げない。同じ Mac に center は 1 つ。2 つ目は port が使用中で起動に失敗する（2.8）。
- 残る点 1: bantou-center が、port の使用中で起動に失敗した時の終わり方。案 A: 正常終了として終わり、launchd が再起動し続けないようにする（#16 の設定）。案 B: 異常終了にする（launchd が再起動を試み続ける）。案 C: A の上に、失敗を log で知らせる（2.8.3・#17）。推奨: A と C。
- 残る点 2: port を持っていた center が止まって規定 port が空いた後、手で起動した app の center が自動で戻るか。案 A: 戻らない（次の login か、利用者が起動した時）。案 B: 戻す（port が空くのを待つ仕組みを足す）。推奨: A（待ちの仕組みを足さない）。
- 残る点 3: 同じ Mac の別の user の center（2.8.4）。決定どおり、起動できない扱いでよいか。推奨: そのまま。

**#20 初回の接続の承認の入口（#4 の案 B2 を採った場合）**
- 案 A: center の host の CLI で承認する（`bantou-center` の subcommand。待っている接続の一覧・承認・拒否・失効）。
- 案 B: macOS の通知の承認ボタン（窓の無い app から出す。native の部品が増える）。
- 案 C: 承認を求めず、初回の短い間だけ鍵を渡す（その間は誰でも得られる。#4 の B1 に近い）。
- 推奨: A（窓が無い app に新しい画面を足さない。CLI は既にある流儀。承認が center の host の側に残る）。待ちの長さなどの数値は利用者が決めていないので決めない。

**#21 app の無い host（Linux、web 用の host など）の center の入れ方**
- 案 A: center の subcommand（`bantou-center service install`。#14 の D）と単独の配布物で入れる。Linux は systemd user unit。配り方は別の決定。
- 案 B: 今の手順（ソースから起動する。web 設計 6.1）のまま。
- 推奨: B（この設計の範囲は bantou-center の app。app の無い host の配布は利用者がまだ決めていない）。#14 の D を作れば A に進める。

**#22 規定 port の番号（利用者が決める。規定 port で起動する事は決定済み）**
- 案 A: 今の既定の 7910 を規定 port にする（center の `--port` の既定、desktop の `DEFAULT_PORT`、`packages/center/README.md`）。
- 案 B: 別の番号にする（利用者が決める）。
- 推奨: A（利用者の指示: 今の既定 7910 を推奨として書く）。理由: 既存の docs・設定が 7910 で、port を変えていない利用者の接続先が変わらない。web 設計 9.2 の表に載る他の使用（bantou-server の 7901・7902、memory の 7930）に 7910 は無い。ただし host ごとの他の program との衝突は【未確認】（他の program が 7910 を使う Mac では center が起動しない。2.8.3 の error になる）。設定画面で port を変えていた利用者は、規定 port に移る。番号は利用者が決める。

**#23 待ち受けの範囲（bind）と TLS**
規定 port は誰にも予測できる番号になるので、LAN の中で center を探しやすくなる。center は今、常に全アドレスで待ち受け（`center.rs:29`、`docs/architecture.md`）、鍵・token は平文で運ばれる。認証の形は #4。
- 案 A: 今のまま（全アドレスで待ち受ける。TLS 無し）。
- 案 B: 待ち受けを既定で loopback にし、LAN へ開くのは明示の設定にする（「常に全アドレス」の確定事項を変える。その設定を client の画面から変えると、変えた後は client から届かなくなる点に注意）。
- 案 C: TLS を足す（center が終端、または前段の reverse proxy。web 設計 11 の判断 13 が同じ論点）。
- 推奨: A（利用者の決めてある事に新しい仕組みを足さない）。ただし client から全設定・秘密の値を書く形（#6）で、平文の通信路を流れる物が増える点を、手順書に書く。C は #4 で鍵を渡す案（B）を採る場合に、鍵が平文で渡る点とあわせて、別の決定にする。

**#24 test・開発用の port（本番の起動は規定 port のみ）**
- 案 A: `--port` を廃止し、test も規定 port を使う（実行中の center と衝突する。test を 1 つずつ直列にする必要がある）。
- 案 B: 本番の経路（bantou-center・launchd の起動）では port を変えられず、test・開発用の起動の関数の引数（`startHttpServer` の `port` option など）でだけ変えられる。CLI の引数と環境変数では受けない。
- 案 C: 今のまま `--port` を残す。→ 「別の port に逃げない」の決定に反する（誤って別 port で起動できる）ので案から外す。
- 推奨: B（`packages/center/test/` と `scripts/e2e.ts` が `--port 0` で動いており、規定 port にすると開発中の center と衝突する。本番の起動の経路だけが規定 port に縛られる）。

**#26 server の IP の入力の形**
- 決めてある事: client で入れる設定は server の IP だけ（固定）。port は規定 port。自動の発見は使わない。
- 案 A: IP のみ（IPv4。IPv6 を受けるかは実装の task が決める）。
- 案 B: ホスト名も入れられる（Tailscale の MagicDNS など）。
- 推奨: A（決めてある事のとおり。B は決めていない拡張なので足さない）。入力した IP の疎通の確認（GraphQL の query）と、複数の center を切り替える履歴を持つかは、実装の task が確かめて利用者に聞く。

**#27 「設定の変更を全部」の範囲**
- 事実: 今の画面で変えられる設定は、session の設定（instructions・addDirs・outputStyle・servers。`session_settings_update`）、center 共通の設定（同上から `servers` を除いた物、`center_settings_update`）、desktop が持つ center の起動の設定（enabled・port・bind・workspace・claudePath・token・remote。`center.rs`）。launcher だけが見える欄は `memory`・`mcpServers`。config file にだけある項目は、`remoteControl.*`（env・continueOnRestart・autoConsent・restartDelayMs・maxRestarts・stopGraceMs・model）、`servers[]`（name・peer・timeoutMs・model・workerModel）、`remotes.pushProgress`、`logDir`、`projects[]`（`packages/center/README.md` の config の節）。
- 案 A: 今の画面にある設定（launcher だけの欄 `memory`・`mcpServers` と、#6 の `projectMemory`・鍵の値を含む）を全部、client から書けるようにする。desktop が持っていた center の起動の設定のうち、workspace と claudePath は center の設定として GraphQL から書く（enabled・port・bind・token・remote は無くなる）。
- 案 B: A に加えて、config file にだけある項目も client から書けるようにする。
- 推奨: A（利用者の指示は「設定変更を全部」だが、config file にだけある項目まで含むかは決めていない。B は利用者に確かめる）。

## 8. 次にやる事（推奨の順）

1. 認証の形（#4。利用者に聞く点）と、#6（7 項目の読みの応答の扱い）・#22（規定 port の番号。推奨 7910）・#27（設定の「全部」の範囲）・#3・#14・#15（bantou-center の配り方・登録・作り方）の決定（schema と配布の形に効く）。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A（GraphQL）・A2（規定 port）を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。A3（認証）は #4 の決定後。
3. 並行して段階 C の実測（`SMAppService` の登録が通るか、launchd で center が `claude` の認証を通すか、窓の無い app の Local Network の許可）を行う。結果で #2・#14・#15 が決まる。
