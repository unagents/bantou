# center を GraphQL の endpoint を持つ backend の server にし、起動の形を「(a) desktop 専用」と「(b) server（bantou-center）」の 2 つにする設計

- 作成: 2026-11-23（同日、利用者の決定を反映して複数回改訂。この版は 0 節の決定 1〜8 を正とする）
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。決まっていない点は「未決 #N」（7 節）。
- 関係する既存の設計: `docs/concept.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/design/resession.md`、`docs/design/master-cap-session.md`、`docs/design/center-tools.md`、web 版の設計（`origin/docs/web-app-design` の `docs/history/20261111-2342-web-app-design/design.md`）、進行中の `origin/feat/app-restart-check` と `origin/feat/sleep-resession`（5 節）。

## 0. 利用者の決定（出た順。原文つき）と、この設計の言葉

この節の 1〜8 を正とする。本文（1 節以降）がこの節と食い違う所は、この節に合わせて直してある。前の版（決定 1〜9）が書いていた「起動の形は S と D」「S での IP の範囲と port の置き場（旧 #29）」「S と D で同じ設定を使うか（旧 #30）」「port を入力しない（規定 port のみ）」「Bearer token 1 本」「launcher 鍵で起動元だけが設定を変えられる」「接続設定（token 入りの URL）の貼り付け」は、決定 3〜7 で置き換わった。

版の履歴: 初版（4edee56）は「app に同梱しない・sidecar をやめる」、第 2 版（8ac588a）は「app が launchd に登録する」、第 3 版（4ee5501）は S と D の 2 形、第 4 版（dc8da51）は「規定 port のみ」を書いた。01cd7d1 と ae4d942 は、これらを「出所が確認できない」として取り下げたが、利用者の決定（下の 2〜5）が出所だと分かったので、`git revert`（9bbbaae・90e4b50。通常の commit）で打ち消した。review の指摘を反映した d241443（launcher 鍵の 7 項目・添付の分け方・行番号など）は残している。前の版（91418a1）は決定 1〜9 に沿って S と D を書いた。この版は決定 1〜8 の最終形で、S と D を「(a) desktop 専用」と「(b) server」に置き換えた。

### 決定（出た順）

**決定 1: center は GraphQL の endpoint を持つ backend の server**

> center起動のbantouとclient起動のbantouの起動の仕組みを根本で変更する
>
> centerはデスクトップアプリにしないで、普通にlaunchでサーバーを起動させる。graphqlのエンドポイントを持ったバックエンドサーバー。クライアントアプリはフロントエンドアプリと同じようにgraphqlのエンドポイントを叩いて画面を操作するイメージ

center は GraphQL の endpoint を持つ backend の server。client の app（desktop・web）は、その endpoint を叩いて画面を動かす。

**決定 2: center は app に同梱して配る。版も app と一緒**

> いや、app同梱はする。

**決定 3: center の program は 1 つで、起動の形が 2 つ**

> まず普通にdesktopアプリを起動。この時、centerを起動っていうのを選ぶと、裏でcenter起動。これは今と同じ。で、desktopアプリとしてbantou-centerっていうのを別で用意する。そいつを起動すると、画面がないプロセスが起動する
>
> desktopが裏でcenter起動する時は、そのdesktop専用centerになる（desktop複数の想定は今のところないけど）だからdesktopのcenterを起動は、ipもportもdesktopが自分で決めて起動する。だから、desktopが裏でcenterを起動する場合、centerの設定は見える必要がない

- **(a) desktop 専用**: desktop の app で「center を起動」を選ぶと、desktop が裏で center を起動する（今と同じ）。その center はその desktop 専用。IP と port は desktop が自分で決める。center の起動と接続の設定（IP・port・鍵を渡す IP の範囲など）は利用者に見せない。
- **(b) server**: bantou-center（窓の無い app）を起動すると、center が常駐の server として起動する（launchd。決定 1 の「普通にlaunchでサーバーを起動」）。設定はメニューバーから開く（port、鍵を渡す接続元の IP の範囲）。
- desktop の app は、(a) 自分の center を使うか、(b) の server に IP でつなぐか、のどちらか。

**決定 4: client から server を見つける方法は IP の指定だけ**

> desktop側からのサーバーのdiscoveryはipのみで固定。

自動の発見（mDNS など）はしない。

**決定 5: (b) の port は設定で変えられる。既定は 7910。基本は固定**

> centerのportを規定しておいて、規定portのみで起動する形は？

（master-cap が説明した後、利用者は「ok」と答えた。その後、次の訂正が出た）

> portだけど、設定はできるようにする。でも固定が基本にする

(b) の port は設定で変えられ、既定は 7910（決定 8）で、基本は固定。center は設定した port でしか起動しない（別の port に逃げない）。client は IP を入れ、port を変えた時だけ port も入れる。

**決定 6: 見え方を全 client で同じにする。設定は client の上で全部変えられ、保存先は center の host**

> 今まではserver側とクライアントで見え方が違ったわけだけど、それが無くなる。クライアントアプリ上で設定変更を全部出来るようにする。でも保存する先は、server側（mac200）。クライアントアプリが今はmcpサーバーとしてサーバーを指定してるがこれがなくなり、serverのipを指定するのみになる（クライアント側で入れる唯一の設定）

見え方を全 client で同じにする。client の上で設定の変更を全部できる（launcher 鍵で守っていた 7 項目も含む）。保存先は center の host（今は mac200）。client が center を MCP の server として指定する形は無くなる。(a)・(b) の両方に当てはまる。

**決定 7: (b) の認証。鍵を取る接続と、それ以外の通信に分ける**

利用者の原文は、初めに「Aで」（master-cap が出した認証の案 A、「client が初めて center につないだ時に center が鍵を渡し、client が覚える。鍵の無い通信は断る」への選択）。その後、binone の設計と同じ方式にする提案を、利用者が承諾した（承諾の原文はこの task の記録に無い）。内容:

- client の通信は「鍵を取る接続」と「それ以外の通信」に分ける。
- 鍵を取る接続は、設定した IP の範囲からかどうかだけを見て鍵を渡し、client が覚える。
- それ以外の通信は、鍵が無いと受け付けない。
- IP の範囲は server 側のメニューバーの設定で指定する（server 側で指定する設定はこれだけ）。

**決定 8: master-cap の決定（利用者の原文ではない）**

- 既定の port の番号は 7910。
- test・開発で port を変えるのは、起動の関数の引数だけ。本番の起動は設定から読む。

### この設計の言葉

- **(a)**: desktop 専用の center（決定 3）。前の版の S。
- **(b)**: server の center = bantou-center（決定 3）。前の版の D。
- **center の port**: (b) では設定した port（既定 7910）。(a) では desktop が決める。
- **鍵**: 決定 7 の、center が渡し client が覚える物。以前の Bearer token と launcher 鍵の置き換え。
- **鍵を取る接続 / それ以外の通信**: 決定 7。
- **IP の範囲**: 決定 7 の「鍵を渡してよい接続元の IP の範囲」。

### 未決（7 節に各案と推奨）

- #25 `/graphql` の Host の検査

（このほかの未決 #1〜#5・#7・#8・#10〜#18・#21 などは 7 節。#6・#9・#19・#20・#22〜#24 は決定済みまたは置き換え済みで 7 節に経緯だけ残してある。#26〜#28 は欠番。下記。）

決定済み（master-cap の決定。決定 1〜8 から導いた物）の点（review gql-final-review の指摘。7 節に経緯を残してある）:

- #31 (a) の時の鍵の扱い: 案 B。desktop が center を起動する時に鍵を渡す（今の token・launcher 鍵と同じ流儀）。(a) では鍵を取る接続を使わない。
- #32 (a) と (b) が同じ mac で同時に動く時: 案 A。desktop は (a) を起動する前に、同じ Mac の center が動いていないか確かめ、動いていれば (a) を起こさず、その center につなぐ。

- #33 (a) の workspace・claudePath: 接続の設定ではなく、session の作業に関わる設定。(a)・(b) とも client の画面で変えられ、保存先は center の host。(a) で見せないのは起動と接続の設定（IP・port・bind・鍵・鍵を渡す IP の範囲）だけ。
- #34 「(a) を選ぶ」の入力: desktop は今どおり「center を起動」を選ぶと (a)。(b) の server につなぐ時だけ IP を入れる。(a) を選んだ時は IP を入れない。
- #35 (a) の port の渡し方: desktop が決めた IP と port を config（`--config`。今 `write_config` が起動のたびに書く）に書き、center は設定から読む（決定済み。#24 に例外を作らない）。
- #36 port の変更の入口: (b) の port・IP の範囲は server 側のメニューバーのみ。client は IP のみ入れ、port は変えた時だけ入れる。決定 6 の「client の上で設定の変更を全部できる」の例外は、port と IP の範囲だけ（server 側のメニューバーで指定する。決定 3・7）。

前の版の #29（S での IP の範囲と port の置き場）と #30（S と D で同じ設定を使うか）は無くなった（(a) は desktop が決めて見せない。(b) はメニューバー）。番号は欠番にしてある。#26〜#28 も欠番で、利用者が話に出していないので扱わない。#19 は #32 に移した（決定済み。7 節に経緯）。

この設計は、利用者が決めていない上限・期限・数値・独自の仕様を足さない。決められない点は 7 節の未決にした。

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
- 【事実】接続設定の共有（token 入りの URL を別 host の desktop に貼る）は `center_snippet.rs`（`center_connect_snippets` / `center_parse_connect` / `center_local_ips`）と、`center.rs:744` の `center_ip_status`。center は常に全アドレス（`0.0.0.0`）で待ち受け、今は Bearer だけで守る（TLS 無し）。`docs/architecture.md`「desktop ↔ center（確定）」。
- 【事実】desktop には center と無関係の OS 側の部品もある: workspace（`workspace.rs`。window ごとの folder、`bantou <path>` の CLI、履歴、folder 選択）、updater（`tauri_plugin_updater`）、OS の sleep 復帰・network 変化の event（`os_events.rs`）、menu（`menu.rs`）、`security.rs`、Cork の task md を読む `task.rs` / `frontmatter.rs`、旧 broker 経由の `thread.rs` / `broker.rs` / `agent.rs`。

### 1.4 web 版・center-client・packages/ui の `~/tauri` の層

- 【事実】`packages/ui` は Nuxt 4 の layer（`packages/desktop/nuxt.config.ts` の `extends: ["../ui"]`）。Tauri の package に依存せず、`~/tauri`（利用側 project の `src/tauri/` または `app/tauri/` に解決される）の `getTransport()`（`invoke` / `listen`）と `getPlatform()` だけを見る（`CLAUDE.md`「役割分離ルール」、`packages/ui/api/*.ts`）。
- 【事実】desktop の `~/tauri` は `packages/desktop/src/tauri/{transport,platform,index}.ts`（Tauri の `invoke` / `listen`、updater・relaunch・shell open・file drop・log・fs watch・window）。
- 【事実】web の `~/tauri` は `packages/web/app/tauri/{transport,platform,session-watch,index}.ts`。command は `POST /api/rpc/<cmd>`、event は `GET /api/events`（SSE）、端末は `GET /api/sessions/<n>/output`（EventSource）と `POST …/input|resize|attachments`（`packages/web/app/tauri/transport.ts`）。command 名・event 名・payload の型は desktop と同じ。
- 【事実】web の backend（Nitro、`packages/web/server/`）は `packages/center-client` を持つ BFF。`packages/center-client/src/commands.ts` が「desktop の Rust command と同じ名前・同じ args・同じ結果」の表（`createCommands`）を持ち、center の MCP tool に翻訳する。center の token は backend が持ちブラウザに出さない。許可する center tool は絞る（`packages/center-client/src/tool-policy.ts` の `WEB_ALLOWED_TOOLS`。`session_delete` は web に出さない）。守りは Cloudflare Access（`packages/web/server/plugins/00.guard.ts`、`packages/web/server/utils/guard/`）。
- 【事実】web の `Platform.centerSidecar` は false（`packages/web/app/tauri/platform.ts`）。設定画面は「自分で center を起動する」項目を出さず、接続先 center の url と token だけを持つ（`packages/ui/components/SettingsDialog.vue` の `webMode`）。
- 【推測】`center-client` の command 表は、そのまま GraphQL の resolver の素材になる（同じ許可・同じ検査・同じ変換）。移行の入口はここ（4 節）。

### 1.5 center が session の claude（pty）と MCP を持つ所

- 【事実】session の実体は、center が `pty-wrapper`（`packages/pty-wrapper`、Rust）経由で動かす対話型 `claude --remote-control <名前>`（`packages/center/src/wrapper.ts`、`remote-control.ts`、`docs/design/master-cap-session.md`）。出力は center の `core`（`packages/center/src/core.ts`）が session ごとに queue（上限は `CORE_QUEUE_MAX_BYTES`）で持ち、購読者へ配る。入力・サイズ変更は wrapper へ渡る（最後にサイズを送った側が勝つ）。
- 【事実】session の claude には MCP が 2 系統付く: `/mcp/session`（master-cap 向け。`session_resession` など。session token で認証、`packages/center/src/session-auth.ts`、`mcp-session.ts`）と、`/mcp`（外向け。token）。加えて center の設定の `memory`・`mcpServers` が全 session の `--mcp-config` に足される（`docs/design/external-memory.md`、`packages/center/src/mcp-source.ts`）。hook / statusLine は `POST /sessions/<n>/hook|status-line`（session token）で center に届く（`http.ts:30-31`）。
- 【事実】center の MCP tool は `packages/center/src/tools.ts` の `registerTool(` で登録している。名前は下記。session 系（`session_create` `session_delete` `session_sleep` `session_wake` `session_update` `session_settings_get/update` `session_list` `session_login` `session_login_code` `session_resession`）、center 系（`center_settings_get/update` `center_info`）、remote 系（`remote_list` `remote_send` `remote_create` `remote_wait` `task_status` `worker_reply`）、rc 系（`rc_list` `rc_start` `rc_stop` `rc_status`）、server 系（`server_list`）。
- 【事実】center → remote の経路は agent-messenger の protocol `bantou`（`packages/center/src/server-link.ts`、`docs/protocol.md`）。desktop・web はこれに関わらない。

### 1.6 app の更新で center が上がる流れ

- 【事実】app の更新は `tauri_plugin_updater`（`packages/desktop/src-tauri/tauri.conf.json` の `plugins.updater`、endpoint は GitHub Releases の `latest.json`）。`packages/ui/composables/useUpdater.ts` が `checkForUpdate` → `downloadAndInstall` → `relaunch` を呼ぶ（desktop の `platform.ts`）。center は同じ bundle の中の binary なので、app を更新して relaunch すると新しい center が sidecar として起動する（`RunEvent::Exit` で古い center は止まる）。
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
   │   見つけ方は IP の指定だけ（固定。自動の発見は無い）。port は変えた時だけ（2.8）
   ▼
center（GraphQL を持つ backend の server。program は 1 つ、起動の形が 2 つ）
   ├ (a) desktop 専用: desktop.app が子 process として起動（「center を起動」を選んだ時。今と同じ）。
   │      IP と port は desktop が自分で決める。center の設定は利用者に見せない
   └ (b) server: bantou-center.app（窓の無い app）を起動すると、常駐の server として起動する（launchd）。
          設定はメニューバーから開く（port、鍵を渡す接続元の IP の範囲）
   center の中身は (a) も (b) も同じ:
   ├ GraphQL endpoint（今の /mcp の tool 群と /events と /sessions/<n>/* が担う物を型つきで公開）
   ├ /mcp/session（master-cap 向け MCP。残る）  /mcp（外向け MCP。残るかは未決 #5）
   ├ session の claude（pty-wrapper）と core（出力の queue）  … center の中に残る
   └ server-link → remote の bantou-server  … 変わらない
```

- client は center の GraphQL だけを見る。desktop は (a) か (b) のどちらかを使う: (a) 自分の center を使う（「center を起動」を選ぶと、desktop が裏で center を起動する）。(b) の server に IP でつなぐ。(b) の center は desktop と無関係に動く（desktop を閉じても、起動していなくても動く）。desktop は launchd に触らない。
- (a) は desktop 専用で、IP と port は desktop が自分で決め、center の起動と接続の設定は利用者に見せない（決定 3）。(b) の port は設定で変えられ、既定は 7910 で、基本は固定（2.8）。
- client から server を見つける方法は IP の指定だけ。port は (b) の port を変えた時だけ入れる（2.8）。mDNS・broadcast などの自動の発見は使わない。なお center が remote の server を見つける仕組み（agent-messenger の broker 経由。`docs/architecture.md` の server の項 3、`packages/center/src/server-link.ts`）は desktop ↔ center の話ではなく、変えない。
- web は今の BFF の位置づけを未決 #4 で決める。
- `docs/concept.md` の原則 3（desktop にとって center や server がどこにあるかは関心事ではない）・原則 6（共有できる物は center が持つ）に沿う。(b) の center は desktop から独立して常駐するので、`docs/concept.md` の「desktop と基本は一体」・`docs/architecture.md`・`CLAUDE.md` の「sidecar 同梱」の文の改訂が要る（4 節の段階 G）。

### 2.2 center の起動の形ごとの扱い（入れ方・起動・止め方・更新・消し方）

(a) は今と同じ（desktop が子 process として起動・監視・停止する。1.2）。以下は (b)（bantou-center の常駐）。土台にする既存の仕組み: `packages/server/scripts/install-service.sh`（bantou-server 用。mac は `/Library/LaunchDaemons/<label>.plist`、Linux は systemd system unit、冪等。`docs/ops/server-install.md`）、web 設計 9.1 の systemd user unit の例（`TimeoutStopSec` は center の停止時間より長く）。

| 操作 | 形（案。細部は未決） |
|---|---|
| 入れ方 | `bantou-center.app` を入れる（配り方は未決 #3）。**初回の起動で app が自分を launchd に登録する**（手段は未決 #14）。利用者の操作は app を起動する 1 回だけ。冪等（登録済みで起動しても二重に登録しない）。 |
| 起動 | 初回は利用者が app を起動した時。以後は launchd が起動する（login 時など）。中身は center の process（`--transport http --bind --config`。**(b)（bantou-center・launchd）の起動では、port は設定で決まり（既定 7910）、CLI の引数と環境変数では変えられない**、2.8・#24。(a) は desktop が決めた IP と port を config に書き、center は設定から読む。#24 に例外は無い。#35）。認証は鍵の方式（2.4）で、今の config の `token` に代わる。種別（LaunchAgent / LaunchDaemon）は未決 #2。 |
| 親の監視 | center は 2 秒ごとに `ppid` を見て、起動時から変わったら終わる（`parent-watch.ts`）。bantou-center の作り方（未決 #15）で親が変わる: shell が center を子として起動する形なら、shell が死ねば center も終わる（今の (a) と同じ）。center が launchd の直下なら `ppid` は変わらず何もしない【推測。6 節で実測】。 |
| 止め方 | 窓が無い app の止め方は未決 #18。launchd が止める時は SIGTERM。center は子の claude を止めてから終わる（待ちは `stopGraceMs` + hard exit、`daemon.ts:258 付近（`stopGraceMs + HARD_EXIT_MARGIN_MS`）`）。service の停止待ちはそれより長く取る（web 設計 9.1）。 |
| 更新 | center は app に同梱で、版も app と一緒。bantou-center.app を更新しても、動いている center は旧 binary のまま。再起動して初めて新しい版になる。更新の配り方は #3、再起動の入口は #18。再起動で session は `--continue` で戻る（`restore()`）。 |
| 消し方 | 常駐をやめる（launchd の登録を外す）。状態 dir（`sessions.json` など）は消さない既定にし、消すのは別の明示の操作にする（`docs/ops/server-install.md` の退役と同じ向き）。app を消した時に登録が残る問題は 2.7.6。入口は #18。 |
| ログ | (a) は今 desktop が `center_status` に末尾を出す（`center.rs`）。(b) は center のログ file（`logDir`、`packages/center/src/log.ts`）と launchd の stdout / stderr 設定。画面の「center の状態」は GraphQL で返す（3 節）。 |
| Linux | systemd user unit（web 設計 9.1 の例）。app の無い host の入れ方は未決 #21。Windows は未決 #10。 |

- `claude` の解決・PATH: service は login shell を通らない（`packages/center/src/path-env.ts`・`claude-path.ts` は login shell から PATH を引く作りで、無ければ固定の候補→config の `remoteControl.claude`）。(b) の `claude` の探索は【未確認】。実測（6 節）。
- 【事実】`claude` の認証は center を動かす OS user の設定 dir 配下で、mac は login keychain に保存される（`docs/handoff.md` の Lessons: keychain が locked だと refresh token を保存できず 401 になった事例）。LaunchAgent（user の login の domain）と LaunchDaemon（system の domain）で keychain に届くかは【未確認】。未決 #2 の判断材料で、実測する。

### 2.3 GraphQL schema の輪郭

置き場は center の http server（今の `/mcp` と同じ port。認証は鍵（2.4）。path は `/graphql`【案】）。型は `packages/ui/types/index.ts`（今の画面が使う型）を土台にする。以下は輪郭で、field の細部は実装の task で決める。

**Query**

| 名前 | 返す物（今の画面が使う型） | 今の元 |
|---|---|---|
| `sessions` | `SessionList`（`sessions[]`、`reachable`、`reason`）。`Session` = name / state / sessionUrl / source / lastError / path / contextUsage / instructions / activity / activityAt / background / remote / auth / loginUrl / loginError / sleeping | MCP `session_list`、`list_sessions`・`refresh_sessions` |
| `session(name)` | 1 session | 同上 |
| `sessionSettings(name)` | `ProjectSettings`（instructions / addDirs / outputStyle / servers）。launcher 鍵で守っていた 7 項目（memory / mcpServers / projectMemory / mcp / mcpConnections / mcpSecrets / coordinator）も、client の画面から変えられる（決定 6。field の形は #6） | `session_settings_get` |
| `centerSettings` | center 共通の設定（`CenterCommonSettings`）（今の `center_settings_get` は `launcher`（呼び出し元が起動元か）も返す。型は `packages/ui/api/center.ts` の `{ settings, launcher? }`。起動元で client を分ける形は無くなるので、`launcher` は不要になる見込み。決定 6） | `center_settings_get` |
| `centerInfo` | `{ workspace, systemInstructions[]（id / version / title） }`（`center_info` の形。`session_path_hints` の素は workspace。今の `launcher` は上と同じ理由で不要になる見込み） | `center_info` |
| `remotes` | `CenterRemoteRecord[]`（remote_id・session・owners・server・serverName・server_label・state・model・createdAt・finishedAt） | `remote_list` |
| `servers` | `ServerInfo[]`（broker に protocol「bantou」で登録されている peer の一覧。name・host・protocol の版・lastSeen・version（server-info の答え）） | `server_list` |
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
| `replyWorker(server, sessionId, order, content?)` | worker への返答（order は answer / approve / reject） | `worker_reply` |
| `terminalInput(session, dataB64)` / `terminalResize(session, cols, rows)` | 端末の入力・サイズ | `POST /sessions/<n>/input|resize` |
| `attachToSession(session, …)` | 画像の添付。bytes を GraphQL に載せるか、既存の HTTP route を残すかは未決 #7 | `POST /sessions/<n>/attachments` |

**Subscription**

| 名前 | 内容 | 今の元 |
|---|---|---|
| `sessionsChanged` | `SessionsEvent`（reason + name）。client は取り直す（今の使い方）か、差分を直接受ける【案】 | center `/events`、`center-sessions-changed` |
| `sessionMessage` | turn の終わりの最後の応答（session / text / at） | `/events` の `session-message`、`center-session-message` |
| `terminalOutput(session, after)` | `{ id, data(base64) }` / `reset` / `status`（`end` を含む）。切れたら `after` で続きから | `GET /sessions/<n>/output`、`session-output` / `session-output-status` |
| `remotesChanged` | 画面が `remote_list` を取り直す契機（`SessionsEvent.reason = remote`（remote の running 件数が変わった時）） | 同上 |
| `centerStatus` | center 自身の状態（版・稼働・認証の要否など。今 desktop が子 process の状態を `center_status` で出している所の置き換え） | `center_status`（Rust） |

- 型の規則: 今の `Session` の `null` は「古い center が送らない」の意味を含む（`packages/ui/types/index.ts` の注記）。center と client が同じ release で動く前提になるので、その互換の扱い（client が新しく center が古い時の振る舞い）を決める必要がある（段階 B の完了条件、4 節）。
- GraphQL が公開しない物: master-cap 向けの `/mcp/session`（`session_resession` など）、hook / status-line の受け口（session token）、server-link。session の claude が使う物は GraphQL に出さない。

### 2.4 認証と設定の見え方（決定 6・7）

- 今（【事実】）: center の `/mcp` は `Authorization: Bearer <token>`（定時間比較、欠落・不一致は 401）。token は desktop が生成して center の config に書く。web は BFF が token を持ち、前段の Cloudflare Access が守る。待ち受けは `0.0.0.0` で TLS 無し（`docs/architecture.md`）。
- 変更後（決定 7。(b) の認証。binone の設計と同じ方式）:
  1. client の通信を 2 つに分ける。**鍵を取る接続**: 設定した IP の範囲からかどうかだけを見て鍵を渡し、client が覚える。**それ以外の通信**: 鍵が無いと受け付けない。
  2. 「鍵を渡してよい接続元の IP の範囲」は server 側のメニューバーの設定で指定する（server 側で指定する設定はこれだけ）。bantou-center（b）は窓の無い常駐で、設定はメニューバーのメニューから開く。
  3. 今の Bearer token（desktop が生成して config に書く。接続設定で貼る）は、この方式に置き換わる。
  4. (a) の時の鍵: desktop が center を起動する時に渡す（#31 の決定。案 B）。(a) は desktop が IP も port も決めて起動し、設定は利用者に見せない（決定 3）。
  5. port・IP の範囲は server 側のメニューバーのみで指定する（#36）。client の画面からは変えない。client は IP のみ入れ、port は変えた時だけ入れる（決定 5）。
- 「launcher 鍵」の置き換え（決定 6）: 今は desktop が sidecar を起動した事を、起動ごとの鍵で証明する。起動元だけが `memory`・`mcpServers` を読み書きでき、`projectMemory` を読める（書きは `bantou-center memory set --session`・移行・設定 file の直接編集だけ）。旧設定の `mcp`・`mcpConnections`・`mcpSecrets`・`coordinator` は誰からも MCP では書けない。守る項目は合わせて 7 つ（`CENTER_ONLY_KEYS`: `packages/center-client/src/tool-policy.ts:45`、`packages/center/src/project-settings.ts` の `LAUNCHER_KEYS` + `LEGACY_INTERNAL_KEYS` + `FILE_ONLY_KEYS`）。書きは `assertCenterOnly`、読みは `withoutLauncherKeys` が絞る（定義は `project-settings.ts`、`tools.ts`・`sessions.ts` が呼ぶ）。決定 6 で、client の app の上で、この 7 項目を含む設定の変更を全部できる形になる。起動元の証明（launcher 鍵）で client を分ける形は無くなり、見え方は (a) でも (b) でも web でも同じになる。7 項目の GraphQL 上の形は #6。
- 設定の保存先は center の host（今は mac200）。client が保存する接続の設定は center の IP だけ（port は変えた時だけ。決定 5・6）。client が center を MCP の server として指定する形は無くなる。「client で入れる唯一の設定は IP」は、「(b) につなぐ時に入れる接続の設定が IP だけ」の意味で、(a)/(b) の選択（#34）とは別。desktop は今どおり「center を起動」を選ぶと (a) になり、その時は IP を入れない。(b) の server につなぐ時だけ IP を入れる。
- 設定の見え方（決定 6。#33）: (a) でも (b) でも、client の画面で見せるのは同じ。見せないのは (a) の起動と接続の設定（IP・port・bind・鍵・鍵を渡す IP の範囲）だけ。workspace・claudePath は session の作業に関わる設定なので、(a)・(b) とも client の画面で変えられ、保存先は center の host。
- 取り返しのつかない操作（`deleteSession`）を鍵の持ち主の中で区別する決定は無い。今は desktop だけ（web は許可 list から外す）。区別を足すかは利用者が決める（web の形は #4）。

### 2.5 client 側（desktop は何を持ち何を捨てるか。web との共有）

| 部品 | 扱い |
|---|---|
| (a) の center の起動・監視・自動再起動・終了時の停止（`center.rs` の spawn / backoff / `Center::stop`、`lib.rs` の `RunEvent::Exit`）、同梱 binary（`externalBin`、`build-sidecar.ts`）、`center_status` / `center_set_settings` の起動の選択（`enabled`）と bind、`bantou://center-running` | **残す**（(a) は今と同じ。「center を起動」を選んだ時の裏の起動）。ただし (a) の IP・port・bind・鍵は desktop が決め、画面に出さない（決定 3）。workspace・claudePath は起動の設定ではなく、client の画面で変えられる（#33） |
| MCP client（`center_mcp.rs`）、SSE 購読（`center_events.rs`）、`SessionCache`（`session.rs`）、端末の中継（`terminal.rs`） | **捨てる**（webview が GraphQL を直接叩く。(a) の center にも (b) の center にも同じ形で繋がる。Rust の中継層が無くなる） |
| 添付（`attachment.rs`: `session_attach_bytes` / `session_attach_paths` / `session_attach_pick`） | **分ける**。消す: center への中継（`upload` = reqwest で `POST /sessions/<n>/attachments`、`run` の接続先の選択 `select_target`・`load_settings`、保存した path を pty に打つ `post(.. "input" ..)`・`input_text`・`b64`）。webview が GraphQL（`attachToSession`・`terminalInput`）か、残す HTTP route（#7）で行う。残す: desktop の OS 側の入口 = `session_attach_pick`（file dialog、`rfd`）、`session_attach_paths`（drop された path の受け取り）、`load`（path から bytes を読む）、画像の型の見分け `sniff_type`・大きさの検査 `check_size`（`MAX_BYTES` = 20 MB。center も同じ検査をする）。この 2 つの command は「保存まで行う」から「読んだ bytes と名前を webview に返す」形に変わる（形は未決 #7）。`session_attach_bytes` は clipboard の bytes を webview が既に持つので、command ごと不要 |
| 接続先の指定 | **(b) につなぐ時に入れるのは center の IP だけ**（固定。自動の発見は使わない。決定 4）。(a) を選んだ時は IP を入れない（#34）。port は (b) の port を変えた時だけ入れる（既定 7910。決定 5）。初めてつないだ時に center が渡す鍵を覚える（決定 7）。(a) を使う時の接続先は desktop が自分で決める（利用者に見せない。決定 3。鍵の扱いは #31）。今の `remote`（URL + token）の入力と、client が center を MCP の server として指定する形は無くなる（決定 6） |
| 接続設定の共有（`center_snippet.rs`: `center_connect_snippets` / `center_parse_connect` / `center_local_ips`。`center.rs:744` の `center_ip_status` も同じ用途） | **無くなる**（token 入りの URL を別 host の desktop に貼る形は、鍵の方式に置き換わる。2.4。`center_local_ips` などの OS 側の補助を残すかは実装の task） |
| updater・relaunch（app 自身の更新） | **残す**。bantou-center.app の更新は別の問題（未決 #3） |
| 画面の native 機能: folder 選択（`pick_directory`）・file drop（`onFilesDropped`）・fs watch（`watchDir`）・window / `bantou <path>` の CLI・menu・OS の sleep 復帰 / network 変化 event・log file | **残す**（desktop 固有。`~/tauri` の `Platform` に残る。web は browser の API で代える） |
| Cork の task md（`task.rs`・`frontmatter.rs`）、旧 broker（`broker.rs`・`thread.rs`・`agent.rs`） | center と別の desktop ローカル機能。この設計では触らない（残す。廃止するかは未決 #8） |
| `~/tauri` の層（`getTransport()` / `getPlatform()`） | 段階的に `~/api` を GraphQL client に差し替え、`getTransport()` は desktop 固有の native 機能と (a) の起動の操作だけに縮める。最終形では ui は「GraphQL client + Platform」を見る（4 節） |
| web の BFF（`center-client` + Nitro） | 未決 #4。BFF を残す（鍵をブラウザに出さない・Cloudflare Access 前提を維持）案と、薄い proxy にする案、ブラウザが直接叩く案 |

- 共有: desktop と web は同じ `packages/ui` を使い、GraphQL client も 1 つにする（`packages/ui/api/*.ts` の中身が GraphQL の document になる）。desktop と web の差は `Platform` だけ（`centerSidecar` は今のまま: desktop は (a) の center を起動できる = true、web は false）。
- 設定画面（`SettingsDialog.vue`）: 「自分の center を使う（(a)）」か「(b) の server に IP でつなぐ」かを選ぶ。今どおり「center を起動」を選ぶと (a)、(b) につなぐ時だけ IP を入れる（#34）。workspace・claudePath は (a)・(b) とも出して変えられる（#33）。(a) の起動と接続の設定（IP・port・bind・鍵）は見せない（決定 3）。「接続先」は IP の指定だけ（port は (b) の port を変えた時だけ）。port・IP の範囲は server 側のメニューバーのみ（#36）。server 側に保存する設定（7 項目を含む）は、この画面から全部変えられる（決定 6）。IP の範囲（決定 7）は server 側のメニューバーで指定する。desktop は launchd に触らないので、(b) の登録・解除の操作は設定画面に持たない（入口は #18）。(a) と (b) が同じ Mac で動く時の画面の出し方は #32。

### 2.6 session の claude と MCP は center に残るか

- 残る。session の claude（pty-wrapper 経由）、core、`/mcp/session`、hook / status-line、coordinator-mcp（子 process）、server-link は center の process の中・子として今のまま動く（`docs/concept.md` の原則 6）。
- 変わるのは center の起動の形（(a) に (b) が加わる）と、画面への出し方（MCP + SSE + 個別 HTTP → GraphQL）だけ。
- 影響する点: (b) で session の claude の cwd・PATH・認証（keychain）が launchd の環境で成り立つか（2.2、6 節）。center と session が desktop と別の host になっても、`/mcp/session` は loopback の center URL（`daemon.ts:330` の `centerUrl`）で動く。
### 2.7 bantou-center（窓の無い app。(b) の形）

利用者の決定: desktop の app とは別に、desktop の app として `bantou-center` を用意する。窓が無く、起動すると center の process だけが動く。初回の起動で自分を launchd に常駐として登録する。設定はメニューバーのメニューから開く（決定 3・7）。

【事実】今の関係部品:
- 同梱の仕組み: `packages/desktop/src-tauri/tauri.conf.json` の `bundle.externalBin`（`binaries/bantou-center`・`binaries/bantou-pty-wrapper`）。build は `packages/desktop/scripts/build-sidecar.ts`（target triple の suffix 付きで置き、bundle 時に外れる）。desktop が (a) の時に起動する物と同じ binary を、bantou-center.app も持つことになる。
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
| 同じ Mac で (a) の center が、(b) と同じ port を持っている | port の使用中で起動に失敗し、理由を出して終わる（2.8。launchd の再起動の loop にしない。#16・#32） |

#### 2.7.3 desktop から見つける（IP のみ）

- desktop の設定で、center の IP を指定する（(b) につなぐ時に入れる接続の設定はこれだけ。決定 6。(a) を選んだ時は入れない。#34）。(b) の port は既定 7910 で、変えた時だけ入れる（決定 5）。初回の接続で center が鍵を渡し、desktop が覚える（2.4）。自動の発見（mDNS・broadcast・同じ Mac の process 探索）は使わない。
- 同じ Mac の (b) の center に繋ぐ時も、IP（`127.0.0.1` など）を指定する。desktop が config file を読んで認証情報を拾う、といった発見の代わりになる自動化は、利用者が決めていないので入れない。
- center は全アドレスで待ち受ける（`docs/architecture.md`）ので、同じ LAN の別 host の desktop も、同じ指定で繋げる。鍵を取れるのは、設定した IP の範囲に入る接続元だけ（決定 7、2.4）。

#### 2.7.4 更新（版は app と一緒）

- bantou-center.app の更新で新しい binary が入っても、launchd が起動済みの center は旧 binary で動き続ける【推測。bundle の置き換え中・後に実行 file と launchd の登録がどうなるかは【未確認】、6 節】。
- 新しい版にするには center の再起動が要る。入口は未決 #18（desktop の画面から GraphQL で / CLI で / OS の操作で）。再起動で session の claude は止まり、`restore()` が `--continue` で戻す（1.6。session の中断は今と同じ）。
- 版の違いの検出: client が GraphQL で center の版を取り、自分の版と比べる（#13）。
- bantou-center.app 自体の更新の配り方（cask / updater）は未決 #3。

#### 2.7.5 止め方・常駐をやめる

窓が無いので、画面から止められない。入口の案は未決 #18: (1) desktop の画面から GraphQL の mutation で（center が自分を止める）、(2) center の binary の subcommand（`bantou-center service …` のような物。center は既に `status-line`・`hook`・`memory`・`mcp` などの subcommand を持つ、`packages/center/src/cli.ts`）、(3) OS の Login Items の無効化と `launchctl` / kill。

#### 2.7.6 消し方

- 常駐をやめる: launchd の登録を外す（入口は #18）。状態 dir は消さない（#9 の決定）。
- app を削除した時（cask の uninstall）: 今の cask に launchd の登録を外す stanza は無い。登録が残って、実行 file の無い center の起動を launchd が試み続ける事になりうる。cask に `uninstall launchctl:`（label を指定）を足す案がある（cask の変更は別 task）。SMAppService の登録は app の削除で OS が扱うか【未確認】。

#### 2.7.7 同じ Mac で (a) と (b) が両方動く時

(a) は desktop が決めた IP・port、(b) は設定した port（既定 7910）で起動する。同じ port の center は 1 つで、後から起動する方は port の使用中で起動に失敗して終わる（2.8.2）。別の port なら 2 つが同時に動きうる。その時は、状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いが起きうる。どう扱うかは #32 の決定（案 A、2.8.4）。

#### 2.7.8 desktop の Rust に足す物・捨てる物

- 足す: 接続先を IP で指定する入力（port は変えた時だけ入れる）と、その疎通の確認（GraphQL の query）。初回の接続で center が渡す鍵を覚える所。(a) を起動する前の「自分が決めた port に center が居るか」の確認（2.8.4。#32 の決定）。
- 捨てる: `center_mcp.rs` ほか中継層（2.5）。
- 変えない: (a) の起動・監視・停止（`center.rs`）。launchd の登録は desktop に持たせない。

#### 2.7.9 app の無い host（web 用の Linux の host など）

app が無いので bantou-center.app は使えない。配り方は未決 #21。

### 2.8 center の port（(b) は設定で変えられる。既定 7910。基本は固定）

利用者の決定（原文。決定 5）: 「centerのportを規定しておいて、規定portのみで起動する形は？」（master-cap の説明の後、「ok」）。その後の訂正: 「portだけど、設定はできるようにする。でも固定が基本にする」。(a) の port は、決定 3（原文: 「desktopのcenterを起動は、ipもportもdesktopが自分で決めて起動する」）のとおり desktop が決める。

決める事:

1. (b) の port は設定で変えられる。既定は 7910（決定 8）。基本は固定で、変える時だけ設定する。設定はメニューバーから開く（決定 3）。port は server 側のメニューバーのみで変え、client の画面からは変えない（#36）。
2. center は設定した port でしか起動しない。別の port に逃げない。
3. (a) の IP と port は desktop が自分で決める。利用者に見せない（決定 3）。決め方の細部は実装の task が決める。決めた IP と port は、desktop が config に書き、center は設定から読む（#35。#24 に例外を作らない）。
4. client は IP を入れる。(b) の port を変えた時だけ port も入れる（既定のままなら入れない）。
5. 同じ host・同じ port の center は 1 つだけ。2 つ目の center は port が使用中で起動に失敗する。(a) と (b) が同じ Mac で同時に動く時の扱いは #32 の決定（案 A、2.8.4）。
6. port が他の program に使われていて起動できない時は、理由が分かる error を出す。
7. test・開発で port を変えるのは、起動の関数の引数だけ。(b) の本番の起動は設定から読む（決定 8。#24）。
8. 認証は鍵の方式（2.4）。(a) は desktop が起動時に鍵を渡す（#31）。

#### 2.8.1 今の port の扱い（変わる所）

- 【事実】center の `--port` の既定は 7910（`packages/center/README.md`、`packages/center/src/args.ts`）。`0` は OS 任せ。
- 【事実】desktop の `CenterSettings.port` も既定 7910（`center.rs` の `DEFAULT_PORT`）で、設定画面から変えられる（`packages/ui/components/SettingsDialog.vue` の `centerSetSettings`）。port の変更は center の再起動を要する（`center.rs` の `needs_restart`）。
- 【事実】bind の失敗は、center の log から見分けて `CenterStatus.bindFailed` に出している（`center.rs:332` の `looks_like_bind_failure`、`packages/ui/types/index.ts` の `CenterStatus`）。
- 【事実】test は `--port 0` を使う（`packages/center/test/args.test.ts`・`http.test.ts`）。`packages/center/scripts/e2e.ts` は `node:net` を使う（空き port を取る用途と読める【推測】）。
- (a) の起動の引数: `sidecar_args`（`center.rs`）から `--port`・`--bind` を外し、desktop が決めた IP・port を config に足す（center は設定から読む。#35）。
- 変わる事: (b) の port の設定項目は残る（決定 5）。保存先は center の host の設定（決定 6）。(b)（bantou-center・launchd）の本番の起動では、center は CLI の引数と環境変数では port を受けず、設定から読む（決定 8）。(a) は desktop が決めた port を config に書き、center は同じく設定から読む（#35）。client の入力欄は、port を変えた時だけ使う。(a) の port は desktop が決め、今の設定画面の port の項目は出さない（決定 3）。test・開発は、起動の関数の引数で port を渡す（決定 8）。

#### 2.8.2 center の起動の順（2 つ目の center が何にも触らない事）

- 【事実】今の `daemon.ts` は、store の生成（`:172`・`:230`）と `loadCapId`（`:221`）の後に listen（`startHttpServer`、`:299`）し、その後に `sessions.restore()`（`:354`）を呼ぶ。孤児 process の回収（`reapOrphans`）は session を start する時に走る（`packages/center/src/remote-control.ts:400`）ので、port で失敗すれば、session の起動・孤児の回収には届かない。
- 要件: 2 つ目の center は、listen に失敗したら、状態 dir の file を書き換えず、session・孤児 process・remote の記録に触れずに終わる。store の生成と `center-id` の作成（`loadCapId`）が listen より前に file を書くかは【未確認】。書くなら、listen を先に移す。実装の task が確かめる。
- listen を先にするのは、port が同じ center を動かさないための最後の守りだから（desktop の起動前の確認（2.8.4）は先に確かめるだけで、確認と起動の間に別の center が port を取りうる）。

#### 2.8.3 起動に失敗した時の error（理由が分かる）

出す内容:

- どの port か（番号）。
- 使用中の相手が何か: その port で GraphQL の疎通を試し、center なら「既に center が動いている（版・起動の形）」。応答が GraphQL でない・接続だけできる・応答が無い、なら「他の program が使用中」。使用中の process 名・PID を OS に問い合わせて足せるか（`lsof` 相当）は【未確認】。
- 次にする事: 既に center なら「それにつなぐ」、他の program なら「その program を止める」。(b) の port を変えたい時は設定で変える（既定 7910。2.8）。

出す先:

| 起動の形 | error の出し先 |
|---|---|
| (a) | center の log（stderr）と、desktop の画面（今の `center_status` の `bindFailed` と `error` に、上の理由の文言を足す） |
| (b) | center の log。bantou-center は窓が無いので、desktop が接続した時に「port の相手が何か」を調べて画面に出す（#17 の知らせ方と同じ入口） |

#### 2.8.4 desktop が (a) を起動する前の確認（#32 の決定: 案 A）

desktop は (a) を起動する前に、自分が決めた IP・port の状態を確かめる。

| port の状態 | desktop の動き |
|---|---|
| center が動いている（GraphQL の疎通で center と分かる） | center を起こさず、それにつなぐ。画面に「動いている center につないだ」と出す |
| 空き | (a) を起動する（今と同じ） |
| 他の program が使用中（center と分からない応答・接続だけできる） | 起動せず、2.8.3 の error を出す |

確認と起動の間に別の center が port を取った場合は、center の listen の失敗（2.8.2）が最後の守りになる。(b) の port は設定で変えられ、desktop はそれを知らない事がある。同じ Mac の (b) とどう付き合うかは #32 の決定（案 A）のとおり、動いていれば (a) を起こさずその center につなぐ。

#### 2.8.5 同じ port の center は 1 つ

- 同じ host・同じ port で動く center は 1 つ。後から起動する方は port で失敗して終わる。別の port なら、同じ Mac に (a) と (b) が両方動きうる。その時は状態 dir（`~/.local/share/bantou/`）・`center-id`・messenger の peer 名 `bantou-center`（`packages/center/src/server-link.ts:341`）の奪い合いが起きうる（#32 の決定: 案 A で起こさない。2.8.4）。
- port は host で 1 つなので、同じ Mac の別の user の login でも、同じ port なら center は 1 つ。別の user が自分の center を起こすには別の port が要る【決定 5 から導いた点。利用者に確かめる点】。

#### 2.8.6 client の接続

- 接続先は center の IP。(b) の port を変えた時だけ port も入れる。(a) を使う時の接続先は、desktop が自分で決める。
- port が別の host で他の program に使われている時、その host の center は起動しない（error は 2.8.3）。
- web の BFF の接続先（`center-client` の設定）の形は #4 で決める。


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
| `center_get_settings` / `center_set_settings`（center.rs） | `centerGetSettings` / `centerSetSettings`（`packages/ui/api/center.ts`） | 残す。「自分の center を使う（(a)）」か「(b) の server に IP でつなぐ」かの選択（今の `enabled`）は、今どおり「center を起動」を選ぶと (a)。(b) につなぐ時だけ IP を入れ、(a) を選んだ時は IP を入れない（#34）。(a) の IP・port・bind・鍵は desktop が決め、画面に出さない。見せないのは起動と接続の設定だけで、workspace・claudePath は session の作業に関わる設定なので、(a)・(b) とも client の画面で変えられ、保存先は center の host（決定 6。#33）。接続先は IP の指定（port は変えた時だけ）になる（`remote` の url の置き換え。2.5）。server 側に保存する設定は、client の画面から全部変えられる（決定 6、#9） |
| `center_status`（center.rs） | `centerStatus` | (a) の子 process の状態として残す。(b) の center の状態は GraphQL の `centerStatus`（2.3）で見る |
| `center_regenerate_token` | `centerRegenerateToken` | 鍵の方式に置き換わる（2.4） |
| `center_ip_status`（center.rs:744） | 同名 | 無くなる（下の center_snippet.rs の 3 つと同じ用途。token 入りの URL を貼る形が鍵の方式に置き換わる。2.4） |
| `center_local_ips` / `center_connect_snippets` / `center_parse_connect`（center_snippet.rs） | 同名 | 無くなる（token 入りの URL を貼る形は、鍵の方式に置き換わる。2.4。`center_local_ips` などの OS 側の補助を残すかは実装の task） |
| `center_call`（center_mcp.rs） | `centerCall` / `centerTool` / `centerToolStrict`（10 個の tool、3.2） | 3.2 の各 query / mutation に分ける。汎用の `center_call` は無くす |
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

### 3.2 center の MCP tool を `centerTool` / `centerCall` で直接呼んでいる物（10 個）

| tool | 呼ぶ所 | 変更後 |
|---|---|---|
| `remote_list` | `RemoteActivity.vue:23` | query `remotes` |
| `worker_reply` | `RemoteActivity.vue:98` | mutation `replyWorker` |
| `server_list` | `CenterDialog.vue:62` | query `servers` |
| `rc_list` | `CenterDialog.vue:61` | query `rcStatus` |
| `rc_start` / `rc_stop`（`sessionRestart`） | `packages/ui/api/center.ts:118-121` | mutation `restartSession`（または 2 つの mutation） |
| `center_settings_get` / `center_settings_update` | `packages/ui/api/center.ts:33-37` | query `centerSettings` / mutation `updateCenterSettings` |
| `session_login` / `session_login_code` | `packages/ui/api/center.ts:103-110` | mutation `startSessionLogin` / `submitSessionLoginCode` |

### 3.3 event（ui の `listen` 12 個）

| event | 出所 | 変更後 |
|---|---|---|
| `center-sessions-changed`（`center_events.rs`） | center `/events` | subscription `sessionsChanged` |
| `center-session-message`（同上） | center `/events` | subscription `sessionMessage` |
| `session-output` / `session-output-status`（`terminal.rs`） | center `/sessions/<n>/output` | subscription `terminalOutput` |
| `bantou://center-running`（`center.rs`、(a) で center を spawn した時） | desktop の Rust | 残す（(a) のため。client は疎通が戻るまで再試行する、`useSessionRefresh.ts` の `refreshUntilReachable`。(b) の center には出ない: 接続の再確立の契機は os-wake・network 変化と subscription の切断） |
| `bantou://os-wake` / `bantou://os-network-changed`（`os_events.rs`、web は browser が作る） | OS | client のローカルのまま（GraphQL の subscription の再接続の契機に使う） |
| `bantou://sessions-changed`（`useBoard.ts`） | Rust / client のローカル | client のローカルのまま（Cork task 側。未決 #8） |
| `bantou://threads-changed` / `bantou://pings-changed` / `bantou://agent` | `thread.rs` / `broker.rs` / `agent.rs` | 変わらない（未決 #8） |
| `menu:check-for-updates`（`menu.rs`） | desktop の menu | 変わらない（client の更新） |

### 3.4 `Platform`（`packages/desktop/src/tauri/platform.ts`、8 個）

`checkForUpdate` / `downloadAndInstall` / `relaunch`（app の更新。残す）、`openExternal`（残す）、`onFilesDropped`（残す）、`log`（残す）、`watchDir`（Cork の md 用。残す）、`currentWindow`（残す）。center に関わる物は無い。`centerSidecar`（(a) の center を起動できる shell か）は今のまま: desktop は true、web は false。

### 3.5 center が HTTP で直接公開している物（GraphQL への置き換え）

`/mcp`（外向け MCP。未決 #5）、`/mcp/session`（master-cap 向け。残す）、`/events`（SSE。subscription に置き換え）、`/sessions/<n>/output|input|resize`（subscription / mutation に置き換え）、`/sessions/<n>/attachments`（未決 #7）、`/sessions/<n>/status-line|hook`（session 向け。残す）。`packages/center/src/http.ts:15-32`。

Host の検査: `/events` と `/sessions/<n>/output|input|resize|attachments` は Bearer に加えて、Host の検査（`allowedHostsFor`、不一致は 403 `forbidden host`、`http.ts:84-91`・`:423`・`:461`）を持つ。`/mcp` も同じ検査を `enableDnsRebindingProtection` で行う（`:524`）。ただし検査は bind が loopback の時だけ有効で、loopback 以外では `allowedHostsFor` が null を返して検査しない（`http.ts:80-86`、README の http transport の節）。(a) も (b) も全アドレスで待ち受けるので、通常の形では検査は無く、今は Bearer だけで守る（変更後は決定 7 の鍵。2.4）。`/graphql` がこの検査を引き継ぐかは未決 #25。`docs/architecture.md:57` の「Host / Origin を絞らず Bearer だけで守る」は全アドレスで待ち受ける形の説明で、loopback bind の時の検査には触れていない（食い違いというより抜け。docs の改訂（段階 G）で直す）。

### 3.6 網羅性の確かめ（grep で数えた結果）

ui・desktop・web の画面側の呼び出しを grep で数え、3.1〜3.4 の行と突き合わせた。

- Tauri command: `generate_handler!` に 43 個（workspace 4 / task 4 / thread 2 / broker 3 / agent 4 / session 9 / center 5 / center_snippet 3 / center_mcp 2 / terminal 4 / attachment 3）。ui の `invoke("…")` が名指しする物は 41 個（`create_task`・`update_task_status` の 2 個は呼ばれていない）。3.1 の表は 43 個全部を含む。
- `centerTool` / `centerToolStrict` / `centerCall` の tool 名: `remote_list` `worker_reply` `server_list` `rc_list` `rc_start` `rc_stop` `center_settings_get` `center_settings_update` `session_login` `session_login_code` の 10 個。3.2 の表に全部ある。
- `listen` する event 名: 12 個（`center-sessions-changed` `center-session-message` `session-output` `session-output-status` `bantou://center-running` `bantou://os-wake` `bantou://os-network-changed` `bantou://sessions-changed` `bantou://threads-changed` `bantou://pings-changed` `bantou://agent` `menu:check-for-updates`）。3.3 の表に全部ある。
- web の `~/tauri`（`packages/web/app/tauri/transport.ts`）が受ける command は desktop と同じ名前（`POST /api/rpc/<cmd>`）。`packages/center-client/src/commands.ts` の表がその実装で、3.1 の center 系・session 系と一致する。
- center の MCP tool（`tools.ts`）のうち、画面が使うのは 3.2 の 10 個と、web の backend が内部で使う `session_list` `session_create` `session_update` `session_sleep` `session_wake` `session_settings_get/update` `center_info`（`tool-policy.ts` の `WEB_ALLOWED_TOOLS`）。残り（`session_delete` `session_resession` `remote_send` `remote_create` `remote_stop` `remote_wait` `task_status` `rc_status`）は画面から呼ばれていない。master-cap（`/mcp` を使う素のエージェント）の道具として残す（未決 #5）。

## 4. 移行の段取り（段階に分ける。各段で動く物が残る）

前提: 各段の終わりに、desktop も web も今の画面が動く。(a)（desktop が「center を起動」で裏に起こす center）は最後まで今のまま動く。center は MCP（`/mcp`・`/events`・`/sessions/*`）を最後の段まで残す（GraphQL を足すだけで消さない）。

| 段 | 内容 | この段の終わりに動く物 | 戻し方 |
|---|---|---|---|
| A | center に GraphQL の endpoint を足す（`/graphql`）。resolver は `packages/center-client/src/commands.ts` の表と center の中の関数を使う（query / mutation / subscription は 2.3）。認証は段階 A3 で鍵の方式にする（それまでは `/mcp` と同じ Bearer）。GraphQL server の部品は未決 #1 | 今の desktop・web は無変更で動く（`/mcp` を使い続ける）。GraphQL は test と HTTP の呼び出しで確かめる | endpoint を足しただけ。外せば元に戻る |
| A2 | center の起動を、設定した port だけにする（(b) の port。既定 7910。CLI の引数・環境変数では変えず、test・開発は起動の関数の引数だけ。決定 8）。listen を状態への書き込みより先にし、失敗した時の error（使用中が center か他の program か）を出す（2.8.2・2.8.3）。(a) の desktop は、起動前に自分が決めた port を確かめる（2.8.4。#32） | (a) は今のまま動く。port が使用中なら、理由の分かる error が出る | `--port` を戻す |
| A3 | 鍵の方式（2.4）: 鍵を取る接続とそれ以外の通信の分け、IP の範囲の検査、鍵の発行と検査。IP の範囲の設定の置き場（メニューバー。#36）、(a) の鍵（desktop が起動時に渡す。#31） | 鍵の無い通信が断られる。(a) も (b) も同じ形で繋がる | Bearer に戻す |
| B | `packages/ui/api/*.ts` を GraphQL client に差し替える。web の `~/tauri` の transport を GraphQL にする（BFF の形は未決 #4）。desktop の `src/tauri/transport.ts` は、center 系の command を GraphQL へ、native 系（workspace・updater・Cork）と (a) の起動の操作だけ Tauri に残す。接続先を IP の指定（port は変えた時だけ。決定 5）にする（2.5・2.8）。subscription は `terminalOutput`・`sessionsChanged`・`sessionMessage` | web が GraphQL で動く。desktop は (a) の center にも別 host の center にも GraphQL で繋がる | 差し替えを feature flag か branch 単位にすれば戻せる。center 側は無変更 |
| C | bantou-center.app を作る: C1 = app の実体（#15）と同梱・build・配り方（#3、cask の構成）、C2 = 初回の自己登録（#14）と登録の状態の扱い（#17）、C3 = 窓の無い app の操作の入口（止める・更新・登録解除・接続情報の表示。#18・#20。center の subcommand と GraphQL の mutation）、C4 = center の port の使用中の判定と error（2.8・#32。desktop 側と bantou-center 側の両方） | bantou-center.app を起動すると center が動き、登録され、desktop が IP で繋がる。(a) は今のまま動く | app を使わなければ (a) だけの今の形 |
| D | desktop の Rust の中継層（`center_mcp.rs`・`center_events.rs`・`session.rs` の cache・`terminal.rs`・`attachment.rs` の upload・接続先の選択・pty への input の中継。OS 側の入口 `pick` / `paths` と `load`・型・大きさの検査は残す、2.5）を外す（webview が GraphQL を直接叩く）。**(a) の起動・監視（`center.rs`）・同梱 binary・launcher 鍵は残す** | desktop の Rust は center の中継をしない。(a) は今どおり起動できる | D の前の release に戻せる |
| E | client の画面から 7 項目を含む設定を全部変えられる形（#6）と、`/mcp` の残し方（#5）の整理 | 7 項目を含む設定の読み書きが、(a)・(b)・web の画面で同じに動く | 旧の launcher 鍵の方式に戻す |
| F | 更新の入口（#18・#12）: 版の違いの検出と、(b) の center の再起動の入口。bantou-center.app の更新の配り（#3） | app を更新すれば center も同じ版に揃う（(b) の再起動は #18 の入口） | 手動の再起動に戻す |
| G | docs の改訂: `docs/concept.md`・`docs/architecture.md`・`CLAUDE.md` の Map（「center は desktop に sidecar 同梱」→「center は app に同梱。desktop が裏で起こす形（(a)）と、bantou-center.app が launchd に常駐する形（(b)）」）・`docs/protocol.md` の desktop ↔ center の節・`packages/center/README.md` の起動・`packages/desktop/README.md`・`docs/ops/` に (b) の手順書を足す | docs が実装と合う | — |

並行できる単位（依存の少ない順）:

- A（GraphQL server 本体: schema・resolver・認証・subscription）は、C（bantou-center.app）と並行できる。互いに触る file が別（A は `packages/center/src` と新しい resolver、C は新しい app の package・build・cask・center の `service` subcommand）。
- A の中でも、query 群（session・remote・server・rc の読み取り）、mutation 群（session の操作・設定・login）、subscription（`sessionsChanged`・`sessionMessage`・`terminalOutput`・`centerStatus`）は、schema の合意（2.3）ができた後は別 worker に分けられる。端末の subscription は `core.ts` の購読（`after` / `reset` / `end`）に依存するので 1 つにまとめる。
- C は C1・C2・C3・C4 に分けられる。C1 が app の土台で、C2・C3 はその上。C4 は desktop 側（`center.rs` の起動前の確認）と center 側（二重起動の検出）で別 worker にできる。#14・#15 の決定が先。
- B は A の schema に依存する（schema の合意後、client の差し替えは `packages/ui/api/` のファイルごとに分けられる: sessions / center / terminal / attachment。web の transport と desktop の transport は別 worker）。
- D は B の完了後。C とは独立。E・F は C の後、E は #6 の決定後。
- G（docs）は各段の完了ごとに、その段の分だけ。

## 5. 進行中の別変更との関係

`git fetch` して差分を読んだ（読むだけ。これらの branch は変えていない）。

### 5.1 `feat/app-restart-check`（app の再起動の後の状況の確認）

- 内容: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、`packages/center/src/restart-check.ts`、`packages/center/test/restart-check.test.ts`）と `origin/feat/app-restart-check-sessions`（`packages/center/src/sessions.ts` の `restore()` に `onRestoreStart` / `onRestoreFail`）。center が起動し直した session の最初の入力（`SessionStart` の後）で「app が再起動した」事を知らせ、状況の確認を促す。検出は `restore()` の中（`supervisor.start(name, { resume: true })` の直前に印を付ける）。
- この設計との関係: 実装は center の中の物で、GraphQL 化・service 化とは別の file（`restart-check.ts`・`sessions.ts` の restore・`daemon.ts` の配線）。**衝突は少ない**。
- 意味が変わる点: その設計は「center は desktop の sidecar なので、app の再起動 = center の process の起動」（1.1 の【推測】）に立つ。**(a) では今のまま成り立つ**（desktop を起動して「center を起動」を選ぶと center が起動し直され、`restore()` が走る）。**(b) では成り立たない**: app（desktop）を終了・再起動しても (b) の center は再起動せず、`restore()` は走らない。(b) で `restore()` が走るのは center の起動の時（host の起動・login、launchd の再起動、異常終了からの復帰、更新後に center を再起動した時（#18））。つまり「app の再起動の最初の 1 回」は、(a) では desktop の起動、(b) では center の起動に当たる。
- 整合の案（利用者の判断。未決 #11）: (A) 実装は変えず、意味を「center が起動し直した時」に読み替える（(a) でも (b) でもそう読める。文面の「app が再起動した」を「center が再起動した」に直す）。(B) さらに「client が繋ぎ直した時」にも確認を送る（これは別の仕様になり、現在の指示「app が再起動された時の最初の 1 回」から外れる。足すなら利用者が決める）。推奨は A。

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
- 引継ぎの保存先 file は center の host にある（`handoffs/` は状態 dir の下、`daemon.ts:218`）。状態 dir は今の `~/.local/share/bantou/` をそのまま使う（#9 の決定: 案 A）ので、`handoffs/` と未取り出しの引継ぎもそのまま残る。

## 6. test と実測の観点

code は書かないので、ここは実装の task が足す test と、実機で測る事の一覧。

**test（実装が足す）**

- schema: query / mutation / subscription が 3.1〜3.3 の表の全項目を持つ（表を test の入力にして、漏れを機械的に検出する）。
- 認証: 鍵の無い通信は断る。「鍵を取る接続」は、設定した IP の範囲からかどうかだけで鍵を渡す（範囲外には渡さない）。鍵を持つ client は、7 項目を含む設定を変えられる（#6）。
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
- 認証: 別 host の client（LAN・Tailscale）が、IP の範囲に入っていれば鍵を取って繋げる事。範囲外は鍵を取れない事。
- 更新: center を入れ替えて再起動した時の session の中断の長さ。
- desktop: center の service が止まっている時に「繋がらない」を画面に出して、戻れば自動で再接続する。
- 窓の無い app（2.7.2）: 初回の起動（未登録）・launchd 起動・手で起動（既に動いている / 止まっている）・OS で無効化された後、の各状態で、振る舞いが表のとおりになる。登録の結果が log に残る。
- 登録: 管理者権限なしで登録でき（LaunchAgent の場合。#2）、冪等（2 回起動しても二重に登録しない）。登録の解除（入口は #18）が通る。
- center の port（2.8、#22・#32）: ① port が空いている時、(a) も (b) も起動する。② (a) の起動前の確認で、同じ port で center が動いていれば起こさず、それにつなぐ（#32 の決定）。③ 2 つ目の center（(a)・(b) のどちらでも）は、listen に失敗したら、状態 dir の file・session・孤児 process に触れずに終わる（2.8.2）。④ port を他の program が使っている時、起動に失敗し、使用中が center か他の program かが分かる error が log と画面に出る（2.8.3）。⑤ launchd が、port 使用中で終わった bantou-center を再起動し続けない（#16・#32）。⑥ (b) は設定した port 以外では起動できない（本番の経路。決定 8）。
- bantou-center.app の更新（#3）の最中・直後に、動いている center が落ちない。更新後に center の版の違いが検出され、再起動の入口（#18）が動く。
- Local Network の許可: bantou-center.app（別の code identity）から、LAN の別 host の remote の server・broker へ繋がるか。許可の確認の画面を出せない窓無しの app で許可が通るか（`docs/ops/desktop-signing.md` の件）【未確認】。
- cask の uninstall（`zap trash` だけで、launchd の登録を外す stanza は今無い）の後に、登録だけが残って起動に失敗し続けない事。
- 接続先の IP の指定だけで desktop が (b) の center に繋がる事（自動の発見が無くても。初回の接続で鍵を取る）。

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
- 配りの案: (ア) 同じ cask・同じ dmg に app を 2 つ入れる（`app "bantou.app"` と `app "bantou-center.app"`）。(イ) 別の cask にする。(ウ) bantou.app の bundle の中に bantou-center.app を入れる（`Contents/Library/LoginItems/` など。SMAppService が扱う標準の置き場。updater が両方更新する。ただし別の app として Finder から起動する入口にはならない）。
- 更新の案: (A) bantou-center.app にも Tauri の updater を持たせる（窓が無いので通知・再起動の入口は #18）。(B) cask の upgrade だけにする（`auto_updates true` との関係を見直す）。(C) (ウ) の入れ子にして desktop の updater に任せる。
- 推奨: 配りは (ア)（利用者の「別で用意」に沿い、版が揃い、入れるのは 1 回）。更新は (A)（今の updater・Releases・`latest.json` の流儀を使う。center の binary を 2 つ持つ（desktop 用と bantou-center 用）事の容量は【未確認】だが、(a) を「今と同じ」に保つ事を優先する）。(C) は「別の app を起動する」入口と合わないので推奨しない。

**#4 web の BFF の形（認証は決定済み）**
- 決定済み: 認証は鍵の方式（決定 7、2.4）。以前の案（Bearer 1 本 / client ごとの token / TLS）は置き換わった。
- web の形（未決）: (ア) BFF を残す（鍵をブラウザに出さない。GraphQL を中継する。BFF が center の client になり、鍵を持つ）、(イ) 薄い proxy にする、(ウ) ブラウザが center を直接叩く（鍵がブラウザに出る）。
- 推奨: (ア)（Cloudflare Access の守りと、secret をブラウザに出さない設計が既にある。`packages/web/server/`）。(b) の center の鍵の渡し方は決定 7 で置き換わった（旧 #20）。
**#5 `/mcp`（外向け MCP）を残すか、`session_delete` などを GraphQL に出すか**
- 案 A: `/mcp` はそのまま残す（素のエージェントが `claude mcp add` で cap 運用する入口。`docs/concept.md` の「center は MCP サーバー」）。GraphQL は画面用。
- 案 B: `/mcp` を GraphQL に統合して廃止。
- 推奨: A。理由: `/mcp` は master-cap・外部のエージェントが使う入口で、`docs/design/center-tools.md` の設計がある。画面（GraphQL）と エージェント（MCP）は別の利用者。`session_delete` は desktop の UI が使っていない（web も許可していない）ので、GraphQL には出さず MCP だけにする案を推奨。

**#6 launcher 鍵が守っていた 7 項目の扱い（決定 6 で決定済み）**
- 決定（利用者、決定 6）: client の app の上で、設定の変更を全部できる。launcher 鍵で守っていた 7 項目（`memory` / `mcpServers` / `projectMemory` / `mcp` / `mcpConnections` / `mcpSecrets` / `coordinator`）も含む。保存先は server 側。見え方は (a)・(b)・web で同じ。以前の案 A（bantou-center の起動元の鍵）・B（GraphQL では 7 項目を扱わない）・C（admin token）は、この決定で不要になった。
- 今の扱い（【事実】。項目ごと）:

| 項目 | 分類 | 起動元 | 起動元以外 |
|---|---|---|---|
| `memory`・`mcpServers` | `LAUNCHER_KEYS` | 読み書きできる | 書くと error。読みの応答から除く |
| `projectMemory` | `FILE_ONLY_KEYS` | 読める。書きは設定の更新（MCP）では誰もできず、`bantou-center memory set --session`・移行・設定 file の直接編集だけ | 書くと error。読みの応答から除く |
| `mcp`・`mcpConnections`・`coordinator` | `LEGACY_INTERNAL_KEYS`（旧設定） | 誰からも MCP では書けない（起動元にも別の error）。読みの応答からは `withoutLauncherKeys` は除かない（旧設定が残っていれば応答に出うる【未確認】） | 書くと error |
| `mcpSecrets` | 同上 | settings の key としては同上。鍵の実体は別 file `mcp-secrets.json`（0600）で、入れるのは `bantou-center mcp secret`（標準入力か file）だけ。値は表示・log・error に出さない（`packages/center/src/mcp-secrets.ts` の冒頭） | 同上 |

- 実装の task が決める細部（利用者が決めたのは「全部できる」まで）: 7 項目それぞれの GraphQL 上の field の形、旧設定 4 項目と `mcpSecrets` の値を画面に出すか入れるか。2 か所にある定義（`tool-policy.ts` と `project-settings.ts`）は GraphQL の層で 1 か所にそろえる。
- 影響: 設定の変更は鍵を持つ client なら誰でもできる形になる（2.4）。
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

**#9 設定の保存先（決定 6 で決定済み）と、状態 dir の置き場（決定済み。master-cap の決定: 案 A）**
- 設定の保存先（決定済み。利用者、決定 6）: server 側（center の host。今は mac200）。client が保存する設定は center の IP だけ（port は変えた時だけ）。以前の案の「`remote`（接続先 URL・token）は client のローカルの設定へ」は、token が鍵に置き換わり、client が center を MCP の server として指定する形が無くなるので、IP だけになる。
- 状態 dir の置き場（決定済み。master-cap の決定、案 A）: 今 desktop が使う `~/.local/share/bantou/` をそのまま使う（`sessions.json`・`remotes.json`・`handoffs/`・`center-id` が引き継がれ、session・remote-cap の記録が残る）。理由: 移行で session と cap の記録が消えない。`center-id`（cap_id の素、`docs/architecture.md`）が変わると cap の記録の対応が崩れる。
- 経緯（採らなかった案）: 案 B（service 用の新しい場所（`~/.config/bantou/` など。`packages/center/README.md` の既定）に作り直す）。
- 設定（起動項目・port・IP の範囲・鍵）の置き場の細部: (b) はメニューバーの設定（決定 3・7）、(a) は desktop が決める（決定 3）。

**#10 Windows**
- 案 A: center の同梱と常駐は mac の app だけを対象にする（今の cask は arm64 の macOS だけ、`packages/desktop/Casks/bantou.rb` の `depends_on`）。bantou-center も mac の app。Windows の desktop は client としてだけ使い、IP を指定して center に GraphQL で繋ぐ。
- 案 B: Windows の center の常駐（Windows service）も扱う。
- 推奨: A（利用者の指示は launchd。`pty-wrapper` と `claude` の Windows 対応は今の repo に根拠が無い【未確認】）。

**#11 「app の再起動の後の状況の確認」の意味（5.1）**
- 案 A: center が起動し直した時（host 起動・launchd 再起動・更新・異常終了からの復帰）に読み替える。実装は変えない。
- 案 B: A に加えて、client（desktop）が繋ぎ直した時にも確認を送る。
- 案 C: 確認を止める。
- 推奨: A。
- 参照: `app-restart-check` の設計書 `docs/design/app-restart-check.md` の U4「center だけが再起動した時も対象にするか」（A: 対象にする = center の起動を app の再起動と扱う、B: desktop が「app の起動」を center に知らせる口を足し、その時だけ送る。推奨 A）と同じ論点。この設計の案 A は U4 の A、案 B（client が繋ぎ直した時にも送る）は U4 の B に当たる（center が client の接続を知る口が要る）。(b) で desktop と center が独立しても、U4 の推奨 A の根拠（区別する材料が center に無い）は変わらない。

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
- 案 X: Tauri の窓の無い app（macOS の activation policy を accessory にして Dock に出さない）が、center を子 process として起動する。(a) の `center.rs`（spawn・backoff・停止）をほぼ流用できる。launchd が見るのは app、app が見るのは center の 2 段。
- 案 Y: app の bundle の実行 file を center の binary にする（`LSUIElement` 相当の Info.plist）。launchd が直接 center を起動する。process は 1 つ。ただし `SMAppService` を center（bun の単体 binary）から呼べないので、登録の呼び出しだけ別の物が要る。
- 案 Z: 薄い native の launcher（Swift など）が center を子として起動し、登録も行う。新しい toolchain が増える。
- 推奨: X（最少の新しい部品。Rust 側に既に center の起動・監視・停止がある。center の `parent-watch.ts` の「親が死ねば終わる」もそのまま働く）。launchd と app の 2 段の再起動（launchd の `KeepAlive` と、`center.rs` の backoff の二重）の整理は #16。

**#16 落ちた時の再起動の持ち主と、二重起動の時の終わり方**
- 案 A: launchd に任せる（異常終了だけ再起動する設定。値は実測して決める）。後から起動して「center の port が使用中」と分かった時は、異常終了にせず自分から終わる（launchd が再起動し続ける loop を避ける。2.8・#32）。
- 案 B: launchd は起動だけ。再起動は app（案 X なら shell）が見る（今の (a) と同じ backoff・断念）。
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

**#19（#32 に移した）**: 前の版の「S と D が同じ Mac で両方動く時」は、決定 3 で S が (a)、D が (b) になり、(a) の IP・port を desktop が決める形に変わったので、#32 に書き直した。

**#20 (b) の center の認証と接続先の入力（決定 7 で置き換え済み）**
- 以前の案（bantou-center が token を作り、利用者が log や subcommand で見て貼る / desktop が config file を読む / 初回に画面で出す）は、決定 7 で不要になった。client は IP を入れ、初めてつないだ時に center が鍵を渡す（2.4）。desktop が config file を読んで認証情報を拾う自動化はしない（決定 4・7）。

**#21 app の無い host（web 用の Linux の host など）の center の入れ方**
- 案 A: center の `service` subcommand（#18 の B）と単独の配布物で入れる。配り方は別の決定。
- 案 B: bantou-center.app の対象外とし、今の手順（ソースから起動する。web 設計 6.1）のまま。
- 推奨: B（この設計の範囲は app 同梱の center。app の無い host の配布は利用者がまだ決めていない）。#18 の B を作れば、A に進める余地が残る。

**#22 center の port の番号（決定 8 で決定済み: 7910）**
- 決定（master-cap、決定 8）: 既定は 7910（旧案 A）。center の `--port` の既定、desktop の `DEFAULT_PORT`、`packages/center/README.md` と同じ。
- 旧案 C（番号を設定で変えられる）は、以前は「規定 port のみ」に反するとして外していたが、決定 5 の訂正（「設定はできるようにする。でも固定が基本」）で、設定で変えられる形になった。
- 注意: 他の program が 7910 を使う Mac では、既定のままでは center が起動しない（2.8.3 の error が出る。【未確認】）。web 設計 9.2 の表に載る他の使用（bantou-server の 7901・7902、memory の 7930）に 7910 は無い。

**#23 LAN から届く時の認証（決定 7 で置き換え済み）**
- 以前の案 A〜D（今のまま Bearer / loopback 既定 / TLS / client ごとの token と IP の許可 list）は、決定 7（鍵と、鍵を渡してよい IP の範囲）で置き換わった。LAN から届く接続は、IP の範囲に入っていれば鍵を取れ、鍵が無い通信は断られる（2.4）。
- TLS（平文のまま）と待ち受けの範囲（全アドレス）は、利用者が決めていないので今のまま。

**#24 test・開発用の port（決定 8: 案 B）**
- 決定（master-cap、決定 8）: 案 B。(b)（bantou-center・launchd）の本番の起動では、center の port は設定でだけ決まる。CLI の引数と環境変数では受けない。(a) は desktop が決めた IP と port を config に書き、center は設定から読む。(a) にも CLI の引数の例外は無い（#35）。test・開発用の起動の関数の引数（`startHttpServer` の `port` option など）でだけ別の port を使える。
- 理由: `packages/center/test/` と `scripts/e2e.ts` が `--port 0` で動いており、設定の port にすると開発中の center と衝突する。
- 決定 5（設定で変えられる）との関係: 設定で変えられるのは (b) の本番の経路の port の設定だけ。CLI の引数で逃げられる形は取らない（「設定した port でしか起動しない」）。
- 旧案 A（`--port` を廃止し、test も同じ port）と旧案 C（`--port` を残す）は採らない。

**#25 `/graphql` の Host の検査**
- 事実: `/events`・core route・`/mcp` は、bind が loopback の時だけ Host を検査する（3.5）。(a) も (b) も全アドレスで待ち受けるので、通常は検査が無い。
- 案 A: 今の `/mcp`・`/events` と同じにする（loopback bind の時だけ検査する）。
- 案 B: 常に検査する（IP で繋ぐので、許可する Host の集め方が要る）。
- 案 C: 検査しない（鍵だけ）。
- 推奨: A（今と同じ強さにそろえる。全アドレス待ち受けの下での守りは、鍵と IP の範囲（2.4））。


**#26〜#28（欠番）**: 利用者が話に出していないので扱わない。

**#31 (a) の時の鍵の扱い（決定済み。master-cap の決定: 案 B）**
- 背景: 決定 7 は (b) の認証。(a) は desktop が IP も port も自分で決めて起動し、center の設定は利用者に見せない（決定 3）。今は desktop が token を生成して center の config に書く（1.2・2.4）。(a) の center に desktop がつなぐ時に鍵をどうするかは決まっていない。
- 案 A: (a) も (b) と同じ流れにする。desktop が自分の center から鍵を取る接続で鍵を取り、覚える。IP の範囲は desktop が決める（利用者に見せない）。
- 案 B: desktop が center を起動する時に鍵を渡す（今の token・launcher 鍵と同じ流儀）。(a) では鍵を取る接続を使わない。
- 案 C: (a) は鍵を使わない。
- 決定: 案 B。理由: (a) は desktop 専用で、鍵を渡す相手は起動した desktop 1 つだけ。IP の範囲という設定を (a) が持たずに済み、「(a) の設定は見せない」（決定 3）に合う。今の起動の流れ（desktop が渡す）から変わりが小さい。ただし center の program は、起動時に鍵を渡される形と、鍵を取る接続で渡す形の両方を持つ事になる。

**#32 (a) と (b) が同じ mac で同時に動く時の扱い（決定済み。master-cap の決定: 案 A）**（前の版の #19 を、決定 3 に合わせて書き直した）
- 背景: (a) の IP・port は desktop が決め、(b) の port は設定（既定 7910）。desktop は (a) か (b) のどちらかを使うが、同じ Mac で (b) が常駐しているところで (a) を起こす事は起こりうる。同じ host・同じ port の center は 1 つ（2 つ目は listen の失敗で終わる。2.8.2）。別の port なら 2 つ動き、状態 dir・`center-id`・peer 名 `bantou-center` を奪い合う（2.8.5）。
- 案 A: desktop は (a) を起動する前に、同じ Mac の center が動いていないか確かめ（2.8.4）、動いていれば (a) を起こさず、その center につなぐ。
- 案 B: 同時に動く事を許し、(a) は別の状態 dir・別の `center-id`・別の peer 名で起動する。
- 案 C: 禁止する。(b) が動いている Mac では (a) を使えず、(a) が動いている間は bantou-center が起動せずに終わる。
- 付随の点（前の #19 の残りと同じ推奨）: bantou-center が port の使用中で失敗した時は、正常終了として終わり、launchd が再起動し続けないようにする（#16）。(a) が止まった後、(b) が自動で戻る仕組みは足さない（次の login か、利用者が bantou-center を起動した時に起動する）。
- 決定: 案 A。理由: 状態 dir・`center-id`・peer 名の奪い合いが起きず、決定 3 の「desktop は (a) か (b) のどちらか」に合う。ただし desktop は (b) の port（設定で変えられる）を知らない事があり、その時の確認の仕方は実装の task で確かめる【未確認】。確認をすり抜けた時は、同じ port なら listen の失敗（2.8.2）が守る。

**#33 (a) の workspace・claudePath の扱い（決定済み。master-cap の決定）**
- 決定: workspace・claudePath は、center の起動と接続の設定（IP・port・bind・鍵・鍵を渡す IP の範囲）ではなく、session の作業に関わる設定。決定 6 のとおり、(a)・(b) とも client の画面で変えられ、保存先は center の host。(a) で見せないのは「起動と接続の設定だけ」。
- 経緯（採らなかった案）: 案 A（(a) の起動の設定として見せない）、案 C（項目ごとに決める）。決定 3 の「起動の設定」にこれらを含める読みなら A になるが、決定 3 が挙げた例（IP・port・IP の範囲）は接続の設定で、この読みは採らない。

**#34 「(a) を選ぶ」の入力は何か（決定済み。master-cap の決定）**
- 決定: desktop は今どおり「center を起動」を選ぶと (a)（今の `enabled`）。(b) の server につなぐ時だけ IP を入れる。(a) を選んだ時は IP を入れない。決定 6 の「client で入れる唯一の設定は IP」は、「(b) につなぐ時に入れる接続の設定が IP だけ」の意味。
- 経緯（採らなかった案）: 案 A（IP の有無で (a)/(b) を決める。IP を消し忘れると意図せず (a) が起動する）、案 C（IP が自分を指す時だけ (a)）。決定 3 が「center を起動を選ぶ」と明示の選択を前提にしている。

**#35 (a) で desktop が決めた port を center にどう渡すか（決定済み。master-cap の決定）**
- 決定（決定済み・案 A）: (a) では desktop が決めた IP と port を config（`--config`。今 `write_config` が起動のたびに書く）に書き、center は設定から読む。#24 の規則（本番は設定から読む。CLI の引数・環境変数で port を受けない）に (a) の例外を作らない。(b) と (a) で center の port の読み方が同じになる。
- 経緯（採らなかった案）: 案 B（(a) だけ CLI の `--port` を残す。#24 に例外ができる）。案 C（起動後に GraphQL で渡す）は、port が listen の前に要るので成り立たない。
- 影響: 2.2 の「起動」の行、#24、2.8.1。

**#36 port も client から変えるか、server 側のメニューバーだけか（決定済み。master-cap の決定）**
- 決定: (b) の port・IP の範囲は server 側のメニューバーのみ（2.4）。client は IP のみ入れ、port は変えた時だけ入れる（決定 5）。
- 経緯（採らなかった案）: 案 B（client の画面から port も変える）は、変えた client 自身の接続が切れ（center の再起動が要る）、決定 3 が port をメニューバーの設定に挙げている事とも合わない。案 C は両方で変えられる形で、同じ理由で採らない。

## 8. 次にやる事（推奨の順）

1. 利用者が決める未決: #25（`/graphql` の Host の検査）。（#31〜#36 は master-cap が決めた。7 節）#2・#3・#14・#15（bantou-center の作り方・登録）、#4（web の BFF）・#7（端末・添付）。#11 は進行中の 2 branch の merge の前に決める。
2. 段階 A の worker を、query / mutation / subscription に分けて並行で出す（schema の合意、2.3 を先に固める）。段階 A3（鍵の方式）は #31 の決定（済）に沿って進める。
3. 並行して段階 C の実測（`SMAppService` の登録が ad-hoc 署名の app で通るか、launchd 下で center が `claude` の認証を通すか、窓無し app の Local Network の許可）を行う。結果で #2・#14・#15 が決まる。
