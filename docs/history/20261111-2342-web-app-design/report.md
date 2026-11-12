# 調査報告: bantou の web アプリ版（スマホ対応）

- 日付: 2026-11-11 / 実行: w-web-design（role=docs、調査と設計のみ。コードは変更していない）
- 基点: `origin/develop` `2634a9712d0f43ded5601890067b73452c728c99`
- 設計は同 dir の `design.md`。**2026-11-12 追記: 利用者の方針（web は desktop と同じ仕組み・設定で動作を変える・既定は center を起動しない・実装は共有する前提）を受けて、9 章（desktop の center 設定の仕組み）を足し、1.1・1.3 の「不要」と判定していた行を直した。****利用者が決めた前提（2026-11-11）: web 版は外（internet）から使う／認証は web 独自に作らず inet250 の Cloudflare の認証を使う。** 8 章がその調査、設計への反映は design.md の 1・5.2・8 章、設置時に確かめる項目は design.md 13 章。この文書は「何を調べ、何が分かったか」だけを書く。
- 根拠は `file:line`（repo root からの相対）。`packages/desktop/` は `D/`、`packages/center/` は `C/` と略す。**推測は「推測」と明記**する。
- 202 の nginx・OS・user・空き port には触れていない（ssh 禁止）。そこは全て「未確認」。

## 1. desktop が Tauri に頼っている機能

### 1.1 Rust の command（`generate_handler!` 登録 41 件、`D/src-tauri/src/lib.rs:95-137`）

「web 置換」の記号: **HTTP** = web backend の HTTP route / **SSE** = backend 経由の SSE / **不要** = web には持ち込まない / **ブラウザ** = ブラウザの標準機能。

| command（定義） | 何をしているか | web での置換 |
|---|---|---|
| `pick_directory` (`workspace.rs:23`) | OS のフォルダ選択ダイアログ（rfd） | 不要。center の host 上の path は文字入力（`PathField.vue:19` は `canPick` が偽なら入力欄になる） |
| `set_workspace_directory` (`workspace.rs:30`) | window ごとの Cork workspace dir を設定・履歴保存 | 不要（Cork の task フォルダ。2 章） |
| `get_workspace_directory` (`workspace.rs:70`) | 同 取得 | 不要 |
| `list_workspace_history` (`workspace.rs:96`) | 履歴 | 不要 |
| `list_tasks` (`task.rs:171`) / `get_statuses` (`task.rs:180`) | workspace の `*.md` を task として読む | 不要（v1 は持ち込まない。判断 5） |
| `create_task` (`task.rs:200`) / `update_task_status` (`task.rs:212`) | task 作成・状態変更 | 不要。UI からは既に使われていない（`D/src/api/tasks.ts:4-6` に呼び出し口が無い、`docs/handoff.md:34`） |
| `list_threads` (`thread.rs:156`) / `get_thread` (`thread.rs:165`) | 返答待ち thread（workspace 外の JSON） | 不要（v1） |
| `broker_connect` (`broker.rs:816`) / `broker_status` (`broker.rs:831`) / `list_pings` (`broker.rs:842`) | messenger broker に peer `bantou-core`（`broker.rs:40`）として登録し、thread を受ける | 不要（v1）。入れるなら 202 の共有 broker に `bantou-core` の 2 つ目を登録できない（`docs/handoff.md:16`） |
| `agent_open` (`agent.rs:288`) / `agent_close` (`agent.rs:300`) / `agent_say` (`agent.rs:324`) / `agent_answer` (`agent.rs:344`) | thread を開くと `claude -p`（stream-json）を desktop 側で起動（`agent.rs:155-164`） | 不要（v1） |
| `list_sessions` (`session.rs:295`) | Rust 側メモリ `SessionCache`（`session.rs:238`）の最後の一覧を返す | HTTP。backend が同じ cache（`rev` 付き、`session.rs:247-256`）を持つ |
| `refresh_sessions` (`session.rs:301`) | center の `session_list` を読み直し cache 更新、変化があれば event | HTTP。backend が center を読み、変化を SSE で配る |
| `create_session` (`session.rs:335`) / `session_update` (`session.rs:357`) | center の `session_create` / `session_update` を呼び、一覧を読み直す | HTTP（MCP tool の中継） |
| `session_get_settings` (`session.rs:95`) / `session_update_settings` (`session.rs:105`) | center の `session_settings_get/update`。追加指示は 16,000 字まで検査（`session.rs:25,30-46`） | HTTP（同じ検査を backend にも置く） |
| `session_path_hints` (`session.rs:326`) | center の `center_info` から既定の親フォルダ、`canPick`（sidecar かつ mac/win のみ真、`session.rs:321-323`） | HTTP。`canPick` は常に偽 |
| `center_get_settings` (`center.rs:729`) / `center_set_settings` (`center.rs:743`) | desktop の `settings.json`（`center` キー、`center.rs:22`）にある center 設定（9 章） | **HTTP（改訂）**。同じ command 名・同じ設定 object を持つ。get は token を返さない。set は既定で受けない（design.md 5.5、判断 14） |
| `center_regenerate_token` (`center.rs:758`) | sidecar の token 再生成→再起動 | 起動する形（まとまり S）でのみ。v1 は不要（改訂） |
| `center_status` (`center.rs:769`) | sidecar の running/restarting/error・ログ | 起動する形（まとまり S）でのみ。v1 は `/api/health` が到達可否を返す（改訂） |
| `center_ip_status` (`center.rs:737`) / `center_local_ips` (`center_snippet.rs:348`) / `center_connect_snippets` (`center_snippet.rs:354`) / `center_parse_connect` (`center_snippet.rs:359`) | 接続設定（mcp.json / `claude mcp add`）の生成・解析、この PC の IP 一覧 | 不要。token をブラウザに出さない（design.md 6.2） |
| `center_call` (`center_mcp.rs:468`) | center の MCP tool を名前で呼ぶ（**任意の tool**、`CALL_TIMEOUT` 600 秒、`center_mcp.rs:31`） | HTTP。web では **許可 tool の一覧**に絞る（design.md 5.3） |
| `center_connection` (`center_mcp.rs:487`) | 接続先 URL・ping で到達確認 | HTTP |
| `session_output_start` (`terminal.rs:325`) / `session_output_stop` (`terminal.rs:336`) | center の `GET /sessions/<n>/output`（SSE）を Rust が読んで event に流す。切断は指数待ちで再接続（`terminal.rs:179-181,281-321`）、45 秒無音で切る（`terminal.rs:28`） | SSE。backend が中継 |
| `session_input` (`terminal.rs:371`) / `session_resize` (`terminal.rs:376`) | center の `POST .../input`, `.../resize`（毎回 1 回の POST、`terminal.rs:340-368`） | HTTP（中継） |
| `session_attach_bytes` (`attachment.rs:190`) | クリップボード画像を center `POST .../attachments` へ送り、保存 path を pty に打つ（`attachment.rs:140-173`）。1 枚 20MB（`attachment.rs:19`） | HTTP（中継）。path を打つ処理は backend 側に残す |
| `session_attach_paths` (`attachment.rs:202`) | ドロップされたファイルの path から読んで同上 | 不要（ブラウザは path を渡せない）。ブラウザの `File` から `attach_bytes` と同じ経路 |
| `session_attach_pick` (`attachment.rs:208`) | OS のファイルダイアログ（rfd） | ブラウザ（`<input type="file" accept="image/*">`） |

### 1.2 Rust から JS への event

| event（定義 / emit） | 受け手 | web での置換 |
|---|---|---|
| `session-output`（`terminal.rs:23` / `:296`） | `useTerminalStore.ts:44` | SSE。web の transport が `EventSource` で受けて同名 event を内部で再発行する |
| `session-output-status`（`terminal.rs:24` / `:278`） | `useTerminalStore.ts:45` | 同上（`EventSource` の open/error から `connected`/`retrying`/`rejected` を作る） |
| `center-sessions-changed`（`center_events.rs:18` / `:83`） | `useSessionRefresh.ts:90` | SSE（backend が center の `GET /events` を 1 本持ち、全ブラウザへ配る） |
| `bantou://sessions-changed`（`session.rs:22` / `:276`） | `useBoard.ts:207` | SSE（上と同じ流れ。cache が変わった時だけ） |
| `bantou://center-running`（`center.rs:26` / `:558`） | `useSessionRefresh.ts:96` | 既定の形では不要（起動しない）。起動する形（まとまり S）では同名 event を backend が出す。再接続は backend の再試行 |
| `bantou://os-wake`（`os_events.rs:17` / `:67,:100`、mac・win のみ） | `useSessionRefresh.ts:91` | ブラウザ（`visibilitychange` / `pageshow`） |
| `bantou://os-network-changed`（`os_events.rs:18` / `:40`） | `useSessionRefresh.ts:97` | ブラウザ（`online` event） |
| `bantou://threads-changed`（`thread.rs:13`、emit は `broker.rs:797`, `agent.rs:147,239,337,363`） | `useBoard.ts:201` | 不要（v1） |
| `bantou://pings-changed`（`broker.rs:800`） | `useBoard.ts:204` | 不要（v1） |
| `bantou://agent`（`agent.rs:24` / `:68`） | `ThreadModal.vue:22` | 不要（v1） |
| `menu:check-for-updates`（`menu.rs:95`） | `useUpdater.ts:165` | 不要 |
| `menu:open-settings`（`menu.rs:101`）, `menu:open-create-task`（`menu.rs:107`） | **受け手なし**（`D/src` と `D/e2e` の grep で 0 件） | 不要 |

### 1.3 Rust 側の仕組み（command 以外）

| もの | 何をしているか | web での置換 |
|---|---|---|
| center の起動・監視（`center.rs:534-592` start、`:596-611` 再起動、`:247-290` 失敗の集計、`:489-520` 停止） | sidecar を `shell().sidecar("bantou-center")` で起動し、異常終了は 2 秒から倍々（上限 60 秒）で再起動、10 分に 5 回超で断念（`center.rs:46-53`）。アプリ終了時に SIGTERM（`lib.rs:197-199`） | 既定の形（接続）では不要。起動する形（まとまり S）では同じ監視を `packages/center-client` の `process` に置く（design.md 6.6）。別に置く center は systemd が担う |
| center 設定の書き出し（`center.rs:174-205`） | `~/.local/share/bantou/center.json` に `workspace`/`token`/`remoteControl.claude` を書く。引数は `--transport http --port N --bind 0.0.0.0 --config <path>`（`center.rs:189-199`）。`LISTEN_BIND = "0.0.0.0"`（`center.rs:31`） | 既定の形では不要（別に置く center の手順は design.md 6.1・9 章）。起動する形（S）では web が同じ config を書く（loopback の待受、design.md 6.6） |
| 接続先の選択（`center_mcp.rs:89-98`） | `enabled` なら sidecar（`127.0.0.1:<port>`）、無ければ貼り付けた `remote`。**同じ設定で `terminal.rs`/`attachment.rs`/`center_events.rs` も同じ先に向く**（`terminal.rs:286`, `attachment.rs:141`, `center_events.rs:56-58`） | web の center 設定（`enabled` / `remote`、design.md 5.5）が同じ選び方で決める。`packages/center-client` に写す |
| MCP クライアント（`center_mcp.rs:1-22`） | JSON-RPC を手書き。`initialize`/`ping`/`tools/call`。center が 404 を返したら 1 回だけ再 initialize（`center_mcp.rs:8-12`） | backend の TS で同等（center 側が 30 分無通信で MCP session を閉じる、`C/src/http.ts:34`） |
| `settings.json`（plugin-store、`workspace.rs:8`） | workspace 履歴・center 設定の保存 | center 設定は backend の設定 file（`center` キー、同じ形、design.md 5.5）。ペイン幅などの画面の状態はブラウザの `localStorage`（既に `D/src/composables/usePaneWidths.ts:12`） |
| window 管理（`workspace.rs:335-365` build/new window、`:419-435` mac の Dock reopen、`:471-495` CLI 起動、`lib.rs:60-67` single-instance、`lib.rs:138-146`/`:189-196` 終了時の挙動） | `bantou <path>` CLI、複数 window、全 window を閉じても常駐 | 不要 |
| mac の window 外観（`workspace.rs:158-181` traffic light、`:345` `TitleBarStyle::Overlay`） | タイトルバー重ね | 不要。ただし UI 側に残骸: `AppHeader.vue:44-45`（`data-tauri-drag-region` と `pl-20`）、`pages/index.vue:180`、`assets/css/main.css:26,64-74` |
| ログ（`lib.rs:68-80` plugin-log、JS は `api/log.ts:1,11`） | webview の例外・警告を OS のログ dir の `bantou.log` へ | web は `console` + 任意で `POST /api/log` |
| updater（`lib.rs:84-85`、`tauri.conf.json:39-40`、JS は `api/updater.ts:1-2,12,24,26`） | GitHub Releases の `latest.json` を見て更新・再起動 | 不要。web の更新は deploy 手順（design.md 9.3） |
| `shell:allow-open`（`capabilities/default.json:18`、JS は `api/center.ts:96` `plugin:shell|open`） | 再ログインの URL を **mac の** ブラウザで開く（`LoginDialog.vue:60`） | ブラウザ（`window.open` / `<a target=_blank>`）。URL 検査 `checkExternalUrl`（`center.ts:68-82`）は web でも流用できる |
| process plugin（`lib.rs:85`、capability `process:default` `capabilities/default.json:17`、JS は `api/updater.ts:1,26` の `relaunch`、呼び出しは `useUpdater.ts:137`） | 更新のインストール後にアプリを再起動する | 不要（web の更新は deploy 手順、design.md 9.3） |
| capability `core:window:allow-start-dragging`（`capabilities/default.json:11`） | `data-tauri-drag-region` の領域でウィンドウを動かす | 不要（ブラウザはウィンドウを動かさない。UI 側の残骸は上の行の `AppHeader.vue:44-45` ほか） |
| fs 監視（`capabilities/default.json:12-13`、JS は `useWorkspaceWatcher.ts:1,14`） | Cork workspace の `*.md` の変更で再読込 | 不要 |
| ドラッグ&ドロップ（`api/attachment.ts:2,27`） | window へのファイルドロップ | `TerminalView.vue:178-181` が既に「ブラウザでは event が来ない」前提で例外を握っている。ブラウザは `drop` DOM event が使える（任意） |

### 1.4 Tauri が `~/api` の外にも染み出している箇所

`api/index.ts:1-2` は「全ての invoke の唯一の入口」と書くが、次は `~/api` を通らず Tauri を直接 import している（Tauri を外す時の漏れの元）。

| 場所 | import |
|---|---|
| `D/src/composables/useTerminalStore.ts:1` | `@tauri-apps/api/event` の `listen` |
| `D/src/composables/useBoard.ts:1` | 同 |
| `D/src/composables/useSessionRefresh.ts:1` | 同 |
| `D/src/components/ThreadModal.vue:2` | 同 |
| `D/src/composables/useUpdater.ts:1` | `@tauri-apps/api/webviewWindow` |
| `D/src/composables/useWorkspaceWatcher.ts:1` | `@tauri-apps/plugin-fs` |
| `D/src/types/index.ts:460` | `import("@tauri-apps/plugin-updater").Update`（型のみ） |
| `D/src/api/*.ts` | `invoke` / plugin（これは入口として正しい） |

e2e のモックは既に「`invoke(cmd, args, options)` と `emitter` を差し替える」形で動いている（`D/e2e/mock/install.ts:28-35`、`D/e2e/mock/bantou.ts:379`）。**3 つ目の transport（HTTP）を同じ形で差し込める**という実例。

## 2. Nuxt 側の共有可否

`D/src` は計 約 5,300 行（`api/` 10 file、components 16、composables 11、`pages/index.vue` 1、`types/index.ts` 498）。`@nuxt/ui` + xterm + `ssr: false` の SPA（`D/nuxt.config.ts:11`）。

- **そのまま共有できる**: `components/*`（`TerminalView`/`SettingsDialog`/`CenterDialog`/`RemoteActivity`/`AddSessionDialog`/`ProjectSettingsDialog`/`LoginDialog`/`ContextUsage`/`SessionActivityMark` ほか）。center の状態を `centerTool`（MCP tool 名）で読む画面は transport が同じ形ならそのまま動く（`CenterDialog.vue:39,59,60`, `RemoteActivity.vue:22,97`）。`composables/terminalBuffer.ts`（Nuxt/Tauri を import しない純粋部、`terminalBuffer.ts:1`）、`useBoard` の center 側計算（`useBoard.ts:82-88` は workspace 無しで center の一覧だけ読む分岐を既に持つ）、`types/index.ts`。
- **Tauri に縛られる**: 1.4 の表の 7 file と `api/*` 全部。
- **画面の構成が Tauri/PC 前提**: `pages/index.vue` は 372 行で、ペイン選択・フィルタ・ダイアログ管理（`:62-158`）と 3 カラムの固定幅レイアウト（`:191-320`、`usePaneWidths` の px 幅）が同居している。さらに `dir`（Cork workspace）が無いと一覧そのものを出さない（`:179-190`）。スマホ向け画面はこのファイルを共有できない（ロジックを composable に出し、レイアウトを別にする）。
- **層（Nuxt layer）を使う時の注意**（一次情報: Nuxt 公式 docs `guide/going-further/layers`）: layer 内の `~/` と `@/` は「**利用側 project の path** を基準に解決される」。回避策は相対 path か named alias。`D/src/api/` の外で `"~/…"` を import する箇所は 47（grep。`~/types` 21、`~/api` 17、`~/composables/*` 10、`~/utils` 1、`~/api/log` 1 の計 50 のうち `src/api/` 内の 3 を除く）。layer に移す時はこれを書き換えるか、`~/api` を**利用側が提供する差し替え点**として積極的に使うかを決める必要がある。

## 3. center を 202 で headless に動かすのに要るもの

### 3.1 center 側は既に headless

- 起動: `bantou-center --transport http --port <n> --bind <addr> --config <path>`（`C/src/args.ts:15-44`、既定 port 7910・bind `127.0.0.1`・config `~/.config/bantou/center.json`、`args.ts:4-6`）。desktop 無しで動く作りで、desktop は「引数を作って sidecar として起動する」だけ（`center.rs:189-199`）。
- http では config の `token`（12 文字以上）が必須（`C/src/daemon.ts:212-214`、`C/src/config.ts:34`）。
- 状態の置き場は config と同じ dir: `sessions.json`（`daemon.ts:131`）、`remotes.json`（`:148`）、`center-id`（`:140`、`C/src/center-id.ts:7`）、`center-settings.json`（`:132`）。ログは `logDir`（既定は config の隣の `center-logs`、`C/src/config.ts:149`）。
- 再起動すると保存済み session を `--continue` で復帰させる（`daemon.ts:256`、`C/src/sessions.ts:77`）。終了は SIGTERM/SIGINT/SIGHUP で子を止めてから exit 0（`daemon.ts:167-194`）。
- **親が変わると自分で終了する**（http のみ、`daemon.ts:238`。`ppid` を 2 秒ごとに見て起動時から変われば shutdown、`C/src/parent-watch.ts:13-20`）。systemd 直下なら ppid は安定する（推測。実測していない）が、`npx`・shell 経由の起動のように親が先に消える形だと落ちる。
- session（master-cap）の実体は **center が起動する `bantou-pty-wrapper`（Rust 製、pty を持つ）の中の対話型 `claude --remote-control <name>`**（`C/src/wrapper.ts:119-155`）。wrapper は center の実行ファイルと同じ dir から探し、env `BANTOU_PTY_WRAPPER` で上書きできる（`wrapper.ts:4-7`）。desktop は `externalBin` で 2 つを同梱している（`tauri.conf.json:20-23`、`D/scripts/build-sidecar.ts:51-62,81-99`。bun の linux x64/arm64 target あり、`build-sidecar.ts:15-20`）。
- claude の実行ファイル解決: config `remoteControl.claude` → login shell の `command -v claude` → `~/.local/bin/claude` / `/opt/homebrew/bin/claude` → `claude`（`C/src/claude-path.ts:54-84`、shell は env `SHELL`、無ければ `/bin/sh`、`:69`）。PATH は起動時に補う（`daemon.ts:57`）。systemd の service は login shell を通らないため、`remoteControl.claude` を明示するのが確実（推測。202 では未実測）。

### 3.2 center の HTTP の口

| path | 認証 | 用途 | 根拠 |
|---|---|---|---|
| `/mcp` | Bearer（外向け token） | MCP Streamable HTTP（tool 全部） | `C/src/http.ts:14,392-397` |
| `/mcp/session` | session ごとの使い捨て token + `X-Bantou-Session` | master-cap が center に戻る窓口 | `http.ts:17,398-408`、`C/src/session-auth.ts` |
| `GET /events` | Bearer | `sessions` SSE（created/deleted/restored/updated/context/activity/remote/changed、`C/src/events.ts:4`） | `http.ts:409-436` |
| `GET /sessions/<n>/output` | Bearer | pty 出力 SSE（`id`=chunk id、`event: output`/`reset`、15 秒ごとに `: ka`、`Last-Event-ID` か `?after=` で続き） | `http.ts:30,312-346,15` |
| `POST /sessions/<n>/input` / `resize` | Bearer | base64 入力 / cols・rows（1〜1000） | `http.ts:359-381` |
| `POST /sessions/<n>/attachments` | Bearer | 画像（png/jpeg/gif/webp、20MB、先頭バイト検査）→ `<workspace>/<session>/attachments/` | `http.ts:213-253`、`C/src/attachments.ts:5-13` |
| `POST /sessions/<n>/status-line`, `/hook` | session token | claude → center | `http.ts:255-292,437-442` |

- **CORS ヘッダは無い**（`C/src` の grep で `access-control` / `cors` が 0 件）。ブラウザから別 origin の center を直接叩けない。
- 認証は Bearer のみ・定時間比較（`http.ts:89-93`）。bind が loopback の時だけ Host/Origin を絞る（DNS rebinding 対策、`http.ts:80-86,414,448,509-511`）。loopback 以外は Bearer だけで守り、**TLS は無く平文**（`C/README.md:37`、`docs/architecture.md:57`）。
- MCP session は 30 分無通信で閉じ、同時 32 まで（`http.ts:34,36`）。POST ボディは 4 MiB まで（`http.ts:32`）。
- **WebSocket は使っていない**（`C/src` の grep で `websocket`/`upgrade` が該当なし）。端末は SSE + POST。

### 3.3 pty と claude process の持ち主・複数端末

- pty の出力キューは center プロセス内の `core`（`C/src/core.ts`）。session ごとに 8 MiB（`core.ts:7`）で、購読者は `Set`（`:53,118`）＝**同時に何台でも購読できる**。続き（`after`）が残っていなければ `reset` + 全部を渡す（`:107-120`）。
- 入力は pty に直接書く（`core.ts:93-98`）。**排他は無い**ため、2 台が同時に打てば混ざる。
- サイズは **最後に送った端末が勝つ**（`core.ts:99-105`、設計決定: `docs/design/master-cap-session.md:118`）。desktop は session を表示した時に必ずサイズを送る（`D/src/components/TerminalView.vue:154-157`）。→ スマホで開くと mac 側の TUI の幅も変わる。
- center のサイズ記憶（`core.size`、`core.ts:38`）は **HTTP に出ていない**（使うのは wrapper の起動時だけ、`C/src/remote-control.ts:491`）。ブラウザは今の pty サイズを知る手段が無い。
- 同じ center / session を複数端末から見るには、**その center に全端末がつながる**必要がある。desktop は元から「別 host の center に接続」できる（`center.rs:60-68` の `remote`、`center_mcp.rs:97`）。mac の sidecar center の session は mac の path を持ち（`sessions.json` は center の host に置かれる、`daemon.ts:131`）、202 の center には移らない。
- center は `remote-cap` の記録を center ごとに持つ。cap_id は `c-<center-id>-<session>`（`docs/architecture.md:44,47`）で、`center-id` は center ごと（`daemon.ts:140`）。202 に新しい center を置けば remote-cap の一覧も別になる。

### 3.4 202 に center が 2 つ並ぶ時の衝突（コードで確認した事実）

- center は messenger の peer 名が**固定で `bantou-center`**（`C/src/server-link.ts:327`）。mac の sidecar と 202 の center は同名になる。
- server は center を「名前で覚え、送る時に今の peer id へ引く」（`packages/server/server/utils/bantou/daemon.ts:333-337`）。覚えている id がまだ居ればそれ、**居なければ同名のうち最後に登録した peer へ付け替える**（`packages/server/server/utils/bantou/reports.ts:159-175`）。→ ある center が再起動して peer id が変わった時、返信が**別の center へ行く**経路がコード上ある（実際に起きるかは未実測）。
- center は server の版を揃えようとする: 自分の「組の版」と違う server に `update_server` を送る。**新旧は比べない**（`docs/architecture.md:35`、`C/src/follow.ts:195-226`）。組の版は env `BANTOU_PAIR_SERVER_VERSION` か、無ければ作業ツリーの `packages/server/package.json`（`C/src/pair.ts:19-44`）。どちらも無ければ版合わせは無効（`follow.ts:205`、`pair.ts:6-7`）。→ 202 の center を desktop と別の commit から作ると、同じ 202 の bantou-server に別々の版を指示し合う。server は実行中の cap・worker が全部終わるのを待って入れ替わる（`docs/architecture.md:35`）。

## 4. スマホ画面について分かったこと

- 端末は `@xterm/xterm` 6.0.0 + `@xterm/addon-fit`（`D/package.json:28-29`）。`fontSize: 13` 固定・scrollback 5000（`TerminalView.vue:166-173`）。キー入力は `term.onData`（`:182`）で、1 回ごとに POST（`terminal.rs:340`）。
- 入力は `\r` が Enter（center の login 処理が `"/login\r"` を送っている、`C/src/login.ts:60,95`）。soft keyboard に無い Esc / Tab / Ctrl-C / 矢印 / Shift+Tab を送る手段が UI に無い（`TerminalView.vue` に該当 UI なし）。
- 画像の貼り付けは `paste` event（`TerminalView.vue:75-94`）。スマホにはこの操作が無いため、ファイル選択（`<input type=file>`）が要る。
- `navigator.clipboard` は `LoginDialog.vue:69` と `SettingsDialog.vue:202` が使う。**ブラウザでは secure context（HTTPS または localhost）でしか動かない**（Web 標準の一般論。この repo では未検証）。LAN の http でつなぐと再ログイン URL のコピーが失敗する。
- 画面幅: 3 カラムのペイン幅は px 固定（`usePaneWidths`）で、狭いと横スクロール（`PANE_ROW_MIN`、`usePaneWidths.ts:10`）。スマホ幅では使えない。ヘッダーは `pl-20`（mac の信号ボタン分、`AppHeader.vue:45`）。
- 表示すべき情報は center が既に持つ: `session_list` の `state`/`activity`（working/needs-input/idle）/`contextUsage`/`auth`/`remote`（`C/src/sessions.ts:26-53`）、`server_list`/`server_peers`/`rc_list`（`CenterDialog.vue:39,59,60`）、`remote_list`（`RemoteActivity.vue:22`、3 秒ごとの polling、`:10`）。

## 5. nginx 配下での配信について分かったこと

- SPA は `ssr: false`（`D/nuxt.config.ts:11`）で `nuxt generate` が静的ファイルを出す（`D/package.json` `generate`）。API を持つなら Nitro の server route が要る。同じ monorepo に Nuxt/Nitro の headless サーバーの実例が 2 つある: `packages/server`（`nuxt.config.ts:11` `preset: "node-listener"`）と `packages/memory`（CLAUDE.md の Map）。
- 端末と events は **長く開く SSE**（15 秒ごとの keep-alive、`http.ts:21`、読み取り 45 秒で切る側の想定、`terminal.rs:28`）。reverse proxy は buffering を切り、読み取り timeout を 45 秒より長くする必要がある（nginx の一般仕様。202 の nginx は未確認）。
- 添付は 1 枚 20MB（`C/src/attachments.ts:13`）。proxy のボディ上限がそれ未満だと失敗する（nginx の `client_max_body_size` の既定は一般に 1MB。202 の設定は未確認）。
- 認証: center は Bearer のみ・平文・CORS 無し（3.2）。外に出す場合の守りは proxy / backend 側に別に要る。

## 6. 202 の常駐・共存について分かったこと

- bantou-server の標準形は **専用 OS ユーザー `bantou` + systemd の system unit**（`Restart=always`）。user unit + linger は「linger の設定漏れで host 再起動後に戻らない事故」を避けて採らないと決めてある（`docs/ops/server-install.md:25`）。HOME が server root（`:7-22`）。使う port は broker 7901・mcp 7902・UDP 7902 discovery（`:42`）。
- memory は **systemd user unit**（`packages/memory/deploy/bantou-memory.service:1-3`）、port `MEMORY_PORT=7930`（`memory.env.example:2`）、PostgreSQL は 127.0.0.1:5433・Ollama は 127.0.0.1:11435（`compose.yaml`）。環境変数は `EnvironmentFile`（chmod 600）に置く流儀（同 `:2-3`）。
- center の既定 port は 7910（`args.ts:5`）。web backend 用の port は未決（候補 7920 は **推測**。202 で空いているかは未確認）。
- bantou-server は npm `bantou@latest` を `npx` で起動し、`update_server` で自己更新する（`server-install.md:66-68,113-116`）。
- host で 1 つしか動かせないのは bantou-server（`/tmp/bantou-server.lock`、`server-install.md:118-120`）。center にこの lock は無い（`C/src` に該当なし）。
- 過去の決定: 「web だけの dev（204 で nuxt dev）は backend がモックになるので却下」（`docs/handoff.md:18`）。今回は実 backend を持つ web を作るので、この却下理由には当たらない（本設計は backend を実装する）。
- 既にスマホから使える別経路: `claude remote-control`（server mode）の session が master-cap で、Claude モバイルアプリ / claude.ai/code から指示できる（`docs/architecture.md:15-19`）。center が起動する master-cap の対話型 claude も `--remote-control <name>` 付き（`wrapper.ts:144`）で、一覧に `sessionUrl`（claude.ai/code の URL）がある（`D/src/types/index.ts:80`）。web 版はこれを置き換えるものではなく、**bantou 固有の画面（server・cap の状態、添付、設定）** を足すものになる。

## 7. 確認できなかったこと（設計では前提または未確定として扱う）

- 202 の nginx の構成・バージョン、ドメイン名・証明書の有無、LAN 内 DNS。
- 202 の OS の CPU architecture（x86_64 か arm64 か）、Rust/bun/node の有無、`bantou` ユーザー以外のユーザー構成、linger の設定状況。
- 202 で 7920 が空いているか。
- mac の sidecar center と 202 の bantou-server がつながる broker が同一か（`docs/handoff.md:9` は mac の `bantou-core` が 202 の broker に居ると書く。center が同じ broker に居るかは未確認）。
- スマホ実機（iOS/Android）での xterm の IME・visualViewport の挙動。
- 同名 `bantou-center` が 2 つ居る時の実挙動（コードの読みのみ）。

## 8. inet250 / Cloudflare の観測（2026-11-11 追記。利用者が決めた前提: 外から使う・認証は Cloudflare に任せる）

### 8.1 観測の方法と範囲

- inet250 の管理 API の**読み取り照会だけ**を使った（ingress・relay の route・host 一覧の参照。変更系は呼んでいない。host へ ssh していない）。
- 結果のうち、**email アドレス・Access の AUD tag の値は docs に書かない**（個人情報・設定値のため）。件数と形だけを書く。
- 観測できたのは「設定の宣言」であり、**実際の通信（header が通るか、buffering するか、timeout）は観測していない**。

### 8.2 観測した事実（公開 repo のため、bantou の設計に要る形だけを書く。他の app の hostname・port・許可者・AUD の値は伏せた）

| 事実 | 内容 |
|---|---|
| 経路 | cloudflared の ingress は複数の hostname の rule と catch-all（`http_status:404`）から成り、**全 rule の宛先は inet250 上の relay**。relay が hostname ごとに LAN の宛先へ振る |
| Access | ingress に `access` と `access_aud`（Access application の AUD tag）を持つ hostname と持たない hostname がある。`access_aud` は hostname ごとにも、複数 hostname で 1 つを共有する形にもなっている |
| relay の route | `hostname` → 宛先 `http://<LAN ip>:<port>`、`path_prefix`、`http_host_header`、`allow`（email の一覧）、`cf_auth`（真偽）、`access_aud`。管理機能の説明では、宛先は `http://` のみ（**`https` は拒否**）、許可一覧に email を足せるのは「Cloudflare auth が有効な route」だけ |
| 202 を宛先にしている既存 route | 202 の `:80` を宛先にする route が既にあり、`http_host_header` で Host を書き換える形と `path_prefix` を使う形がある。202 の `:80` 以外の port を宛先にする route もある（任意の LAN port を宛先にできる） |
| allow 一覧 | Access が有効な route では email の一覧（複数）が入っている。`cf_auth` が偽の route は空 |
| inet250 の host 一覧 | 202 を含む LAN の host を監視している。**inet250 自身の LAN IP は一覧に無い**（未確認） |
| 管理機能の操作 | hostname の追加（relay の route + ingress。Access を有効にして AUD を省くと host 用の Access application を自動作成）、relay の許可一覧の更新、DNS の同期、cloudflared の再起動、登録済み zone の一覧 |

### 8.3 Cloudflare 公式 docs で確認したこと

| 事項 | 内容 | 出典 |
|---|---|---|
| Access の JWT | request header `Cf-Access-Jwt-Assertion`。docs は cookie `CF_Authorization` より header の検証を勧め、cookie は「渡される保証がない」と書く。署名鍵は `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`（`kid` で選ぶ）、`aud` は application の AUD tag、`iss` は `https://<team>.cloudflareaccess.com` | developers.cloudflare.com「Validate JWTs」 |
| cloudflared の `access` | ingress の origin parameter `access`: cloudflared が Access の JWT を**検証してから** origin へ渡す。Access は JWT を `Cf-Access-Jwt-Assertion` header で cloudflared へ送る | developers.cloudflare.com「Origin parameters」 |
| WebSocket | 「どちらの方向にもデータが流れない期間が一定時間続くと閉じる」。**秒数は書かれていない**（Enterprise は個別設定）。heartbeat（ping/pong）を勧める。Tunnel・Access との関係は書かれていない | developers.cloudflare.com「WebSockets」 |
| 524 | origin が **125 秒**応答しないと発生（Enterprise は延長可）。長い処理は polling を勧める | developers.cloudflare.com「Error 524」 |
| cloudflared の接続 | `keepAliveTimeout` は既定 1m30s、`tcpKeepAlive` は既定 30s。SSE 向けの記述は無い | 「Origin parameters」 |

### 8.4 まだ見られていない（設置の時に確かめる。design.md 13 章）

- Cloudflare の team 名、web 用 Access application の AUD tag。
- relay が JWT を 202 へ転送するか、`allow` 一覧と `cf_auth` が何を見て判定するか。
- 実際の通信: SSE が溜まらないか、idle 切断の秒数、添付 20MB が通るか、Access の session 期間と切れた後の挙動。
- inet250 の LAN IP（202 の nginx で送信元を限るのに要る）、202 の nginx の構成（vhost、`default_server`）、202 から `cloudflareaccess.com` へ出られるか。
- 202 の `bantou` 用 port の空き（候補 7920 は推測）。

## 9. desktop の center 設定の仕組み（2026-11-12 追記。利用者の方針: web も同じ仕組み・設定で動作を変える・既定は center を起動しない）

`D/src-tauri/src/` の実コードを読んだ事実だけを書く（動かしての確認はしていない）。web 版の設計は design.md の 5.5〜5.7・6 章。

### 9.1 設定の項目（`CenterSettings`、`center.rs:70-102`）

| 項目 | 意味（コードのコメントどおり） | 既定 | 根拠 |
|---|---|---|---|
| `enabled` | sidecar（この PC の center）を起動する | **偽** | `center.rs:73`、既定 `:95`、test `:789` |
| `port` | sidecar の待受 port | `DEFAULT_PORT` | `center.rs:28,74,96` |
| `bind` | 接続設定（mcp.json / `claude mcp add`）の URL に書く IP。**center の待受ではない**（待受は常に `LISTEN_BIND = "0.0.0.0"`） | 空 | `center.rs:29-31,75-77` |
| `workspace` | center に渡す作業 dir（`session_create` を path 無しで呼んだ時の親）。`~` / `~/x` / 絶対 | `~/.bantou` | `center.rs:57-58,78-79,134-140` |
| `claudePath` | claude の絶対 path。未設定なら center が login shell で解決 | なし | `center.rs:80-82,141-146` |
| `token` | sidecar が `/mcp` で要求する Bearer。空なら初回に自動生成（32 文字） | 空→生成 | `center.rs:83-84,106-123` |
| `remote` | 別 host の center。`{ url, token? }`（token は貼った接続設定から） | なし | `center.rs:60-68,85-89` |

- JSON は camelCase（`#[serde(rename_all = "camelCase", default)]`、`center.rs:70-71`）。足りない項目は既定で埋まる（test `center.rs:797-801`）。型の鏡は `D/src/types/index.ts:166-185`。
- 検証（`validate_settings`、`center.rs:126-160`）: port 1〜65535、workspace は絶対か `~` 始まり、claudePath は絶対、token は 12 文字以上（`MIN_TOKEN_LEN`、`center.rs:33`）、remote の url は `http(s)://` で始まり、`/mcp` に正規化（`normalize_remote`、`center_mcp.rs:53-67`。表は test `center_mcp.rs:878-892`）、remote の空 token は「無し」。

### 9.2 保存場所

- tauri-plugin-store の `settings.json`（`SETTINGS_FILE`、`workspace.rs:8`）の `center` キー（`CENTER_KEY`、`center.rs:22`）。読みは `load_settings`（`center.rs:664-681`）: 壊れた値は既定に戻し、token が無ければ生成して書き戻し、古い形の remote url（`//mcp` など）を直して書き戻す。書きは `center_set_settings`（`center.rs:743-753`）: 検証→token 保証→保存→`apply`。
- sidecar に渡す center 側の config は別 file（`config_path`、`center.rs:202`、書き出し `:174-187,223-232`）。`workspace`・`remoteControl.claude`・`token` を持つ。`remote` は center に渡さない（`center.rs:207-211`）。

### 9.3 「起動する」と「接続する」の切り替え

- **接続先は、呼び出しのたびに保存済みの設定から選ぶ**（`center_mcp.rs:7-8`）。`select_target`（`center_mcp.rs:85-98`）: `enabled` が真 → 自分の sidecar（`http://127.0.0.1:<port>/mcp`、host は常に loopback `SIDECAR_HOST`、token は自分のもの）。偽で `remote` あり → その url と token。どちらも無し → 接続先なし（`NO_TARGET`「接続先が無い」、`center_mcp.rs:460-464`）。**`enabled` が真のあいだ、保存済みの `remote` は残るが無視される**（test `center_mcp.rs:542-549`）。
- 同じ選び方を使うのは MCP（`center_mcp.rs:463,482,489`）に加え、端末の出力（`terminal.rs:286`）・入力と resize（`terminal.rs:341`）・添付（`attachment.rs:141`）・events（`center_events.rs:57`）。つまり接続先の切り替えは設定 1 か所で全部に効く。
- 起動: アプリ起動時 `autostart`（`center.rs:703-726`、`lib.rs:168`）が `enabled` なら sidecar を起動。偽なら「起動しない」とログに残す（`center.rs:695-700`）。設定を保存すると `apply`（`center.rs:615-647`）が、起動に関わる項目（`enabled` `port` `workspace` `claudePath` `token`）が変わった時だけ止めて起動し直す（`needs_restart`、`center.rs:211-221`）。`remote` と `bind` は再起動を起こさない。
- 監視: 異常終了は 2 秒から倍々（上限 60 秒）で再起動、10 分に 5 回超で断念、5 分以上動けば失敗の数を戻す（`center.rs:44-55,247-290`）。停止は SIGTERM を先に送って 15 秒待つ（`center.rs:44,504-508`）。アプリ終了時も止める（`lib.rs:197-199`）。

### 9.4 接続設定の形（remote）

- 貼り付けた接続設定（mcp.json 形式か `claude mcp add` 形式）から url と token を取り出す（`parse_connect`、`center_snippet.rs:331`。command は `center_parse_connect`、`:359`）。自分の sidecar 用の接続設定は `center_connect_snippets`（`center_snippet.rs:168,354`）が、`bind` の IP・port・token から作る。
- 取り出した値は `remote = { url, token? }` として保存される（`SettingsDialog.vue:246`）。

### 9.5 設定画面（`D/src/components/SettingsDialog.vue`）

- 「この PC の center」: スイッチ「center を起動する」（`:386`）、port（`:392`）、接続設定の IP（`:394`）、Auth Token と再生成（`:405-422`）、接続設定の表示（`:427`）、workspace（`:449`）、claudePath（`:453`）。`enabled` の下にだけ出る（`:389`）。
- 「別 host の center」: 接続設定の貼り付け欄（`:486`）、解析結果（`:492`）、「この PC の center を起動」ボタン（`:475`）、解除（`clearRemote`、`:277`）。
- **「別 host の center だけを使う」時の表示**: 保存値が `enabled` 偽かつ `remote` あり（`isRemoteOnly`、`D/src/composables/centerRole.ts:10`）だと、起動のスイッチ・状態・ログ・参照 dir の欄を出さない（`sidecarVisible`、`SettingsDialog.vue:285-294`）。
- api は `D/src/api/center.ts`: `centerGetSettings`（`:4`）、`centerSetSettings`（`:6`）、`centerRegenerateToken`（`:10`）、`centerConnectSnippets`（`:19`）、`centerParseConnect`（`:23`）、`centerStatus`（`:25`）、`centerConnection`（`:27`）。**`center_get_settings` の応答は token を含む**（画面が表示・コピーする、`SettingsDialog.vue:405-413`）。web ではこれを返さない設計にした（design.md 5.5）。

### 9.6 web への含意（コードから言えること）

- 「起動しない＋接続設定」は desktop で既に**既定**（`enabled` 偽、remote 経由は完成した経路）で、`remote` だけで MCP・端末・添付・events の全部が動く。web も同じ形で既定にできる。
- 設定の選び方・検証・正規化は Tauri に依存しない純粋な関数（`select_target`、`validate_settings`、`normalize_remote`、`ensure_token`）で、test も入力と期待値の表になっている。TS に写して同じ test を通せる。
- 一方、`load_settings(app)`（`center_mcp.rs:463` ほか）のように `AppHandle` と plugin-store に直接依存する部分は多く、Rust を共有 crate にするには切り離しが要る（design.md 5.6 の案 B）。
- 未確認: tauri-plugin-store の file が単純な JSON object か（形式の確認はしていない）。
