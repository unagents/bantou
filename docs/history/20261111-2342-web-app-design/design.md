# 設計: bantou の web アプリ版（スマホから使う）

- 日付: 2026-11-11（2026-11-12 改訂: 利用者の方針、下記） / 基点 `origin/develop` `2634a9712d0f43ded5601890067b73452c728c99`
- 調査の事実と根拠は同 dir の `report.md`（以下「報告」+ 章番号）。この文書は設計と判断材料。
- 根拠は `file:line`（repo root 相対。`packages/desktop/` = `D/`、`packages/center/` = `C/`）。**推測は「推測」と明記**。202 の nginx・OS・user は見られていない（未確認）。
- コードの実装・変更はしていない。この文書は docs の追加のみ。
- **利用者が決めた前提（2026-11-11 追記）**: (a) web 版は外（internet）から使う。(b) 認証は web 版で独自に作らず、既存 host「inet250」の Cloudflare の認証を使う。以降の設計はこの 2 点を固定の前提とする（初版の「LAN 内だけか」「login 方式」の判断は取り下げた）。
- inet250 / Cloudflare の構成は、inet250 の管理 API の**読み取り照会**（ingress・relay の route・host 一覧の参照）で 2026-11-11 に観測した範囲だけを使う（変更系は呼んでいない、host へ ssh していない）。観測の内容は報告 8 章（公開 repo のため、他の app の情報は伏せている）。観測できなかったものは「未確認」と書き、**設置の時に確かめる項目**を 13 章に一覧する。

- **利用者の方針（2026-11-12 追記。この版の改訂の軸）**: (1) web 版は desktop と同じ仕組みにする。(2) コードは将来そのまま実装を共有する前提で設計する。(3) desktop と同様に、設定により動作を変える方式で構築する。(4) 既定は「center を起動しない」（center への接続設定を使う。desktop の「別 host の center（remote）」と同じ）。初版の「独立常駐の center を置き、backend は env の固定 addr でつなぐ」「web 側に TS で書き直す」「新しい center を置いて desktop を切り替える（旧判断 2）」は、この方針で改めた。desktop の設定の仕組みの調査は報告 9 章。
- Cloudflare・nginx 配下で外から使う前提と、守り L1〜L4（5.2）は変えていない。

## 0. 結論

1. **web は desktop と同じ「center 設定」を持ち、既定は center を起動せず、設定で指す center へつなぐ（`remote`）。** 設定の項目名・意味・接続先の選び方は desktop と揃える（5.5、報告 9 章）。「center を起動する（`enabled`）」形も同じ項目で持つが、v1 の後（まとまり S、6.6）。center は設定が指す先で、特定の host とは限らない。起動する形では center は web backend の子になり、親が変わると center は自分で終了する（`C/src/daemon.ts:238`、`C/src/parent-watch.ts:13-20`）。center が止まると全 session の TUI が中断される（`daemon.ts:167-194`、復帰は `--continue`、`daemon.ts:256`）ので、起動する形では web backend の再起動が session の中断になる（6.6、R30）。既定の形（別に置いた center につなぐ）にはこの性質は及ばない。
2. **ブラウザは center に直接つながない。** web backend（Nitro、BFF）を挟む。center には CORS が無く（報告 3.2）、Bearer token は center の全操作の鍵（`/mcp` は任意 tool、`C/src/http.ts:392-397`）で、ブラウザに置けない。
3. **端末は WebSocket にせず、center と同じ SSE + POST のまま中継する。** center は SSE（`id` 付き・`Last-Event-ID` で続き、`http.ts:312-346`、`C/src/core.ts:107-120`）で再接続を既に解いており、WebSocket は center 側の新規実装が要る。SSE は 15 秒ごとの `: ka`（`http.ts:21`）で無音を作らない設計だが、Cloudflare・relay・nginx が溜めずに通すかは**未確認**（8.5、13 章 6）。WebSocket の通る条件は 8.5 に書くが v1 では使わない。
3a. **外からの認証は Cloudflare Access に任せ、web backend は独自の login を持たない。** ただし 202 の nginx は LAN から直に叩けるので、backend が Cloudflare の署名付き JWT（`Cf-Access-Jwt-Assertion`）を**自分で検証**する（Cloudflare を通らない到達を防ぐ主たる守り。nginx の送信元制限が副）。JWT が backend まで届くかは未確認で、届かない場合の代替も 8.4 に書く。
4. **画面は Nuxt layer `packages/ui` に共有部品を出し、`packages/desktop` と新設 `packages/web` が `extends` する。** 共有の継ぎ目は「`invoke(cmd, args)` と `listen(event)` の transport 1 枚」。e2e のモックが既にこの形（`D/e2e/mock/install.ts:28-35`）。
4a. **center とつなぐ側（MCP client、SessionCache、events の中継、端末の出力・入力・添付の中継、center 設定の読み書き）は、web 専用にせず新設の共有 package `packages/center-client`（TS、framework 非依存）に置く。** web backend はそれを呼ぶ薄い層。desktop は今すぐは変えず（Rust のまま）、将来この package を使う形へ寄せられるようにする（5.6）。command 名・event 名の契約は desktop と同じ。
5. **v1 は Cork の task・thread・messenger 受信（`bantou-core`）を web に持ち込まない。** 202 の共有 broker に `bantou-core` を 2 つ登録できない（`docs/handoff.md:16`）。
6. スマホ画面は専用の page（一覧 → 端末の 2 画面）と、soft keyboard 用の「特殊キー列」「入力欄」を足す。
7. 実装は 16 のまとまり（1、2a、2b、3a、3b、3c、3d、4a、4b、5a、5b、5c、6a、6b、7、8）＋ v1 の後の S（center を起動する形）・(M)（desktop を共有 package に寄せる）・(9)（Cork）。10 章。既定の形（接続設定）はまとまり 3b・3c・3d・4a・4b・5a で先に動き、S はそれを前提に後から足す。依存の一覧は 10.1。8（center に pty サイズの口）は判断 3 が A の時だけで、設置先の center に届くのは desktop の release を経てから。7（deploy の手順書、docs のみ）は 3d と 4b の後。

## 1. 構成図（文章）

```
スマホ browser / PC browser
   │  HTTPS（TLS は Cloudflare の edge で終端）
   ▼
Cloudflare（Access: 利用者の識別。許可した email だけ通す。JWT を付ける）
   │  Tunnel（cloudflared）
   ▼
inet250（cloudflared。ingress は全 hostname を同 host の relay へ。
   │      ingress 側に Access の JWT 検証（access / aud）がある hostname がある）
   │  relay（hostname → http://<LAN ip>:<port>、path_prefix、http_host_header、email の許可一覧）
   │  平文 HTTP（relay は https を受けない）
   ▼
202 の nginx（:80。Host / path で振り分け。bantou 用の server block を足す）
   │  /api/**   → web backend（SSE は buffering off）
   │  /         → web backend（SPA 静的ファイル）  ※ nginx 直配りも可
   ▼
web backend（packages/web、Nitro、127.0.0.1:<web-port>）
   │  Access の JWT 検証／許可 tool の絞り込み／center 設定（5.5）の読み書き
   │  └─ packages/center-client（共有 package。MCP client ／ SessionCache ／ events ／ 端末の中継、5.6）
   │  HTTP + Bearer（center の token は backend の設定にだけ置く。Cloudflare の識別とは無関係）
   ▼
center（packages/center。**center 設定が指す先**。特定の host とは限らない）
   │  既定: remote ＝ 別に置いた center の url と token を設定で与える（起動しない）
   │  任意: enabled ＝ backend が子として起動（v1 の後、まとまり S、6.6）
   ├─ MCP /mcp（session_*, rc_*, server_*, remote_*, center_*）
   ├─ SSE /events, SSE /sessions/<n>/output, POST input/resize/attachments
   ├─ core（pty の出力キュー 8MiB/session）
   ├─ bantou-pty-wrapper ── claude（対話型、--remote-control）  ＝ session（master-cap）
   └─ messenger client（peer "bantou-center"）
          ▼
   broker（202:7901）── bantou-server（remote-cap。既に 202 で常駐）
```

- 図の Cloudflare〜202 の部分は inet250 の管理 API の読み取り照会で観測した形（報告 8 章。他 app の hostname・port は公開 repo のため伏せている）。**観測した事実**: 全 ingress が inet250 上の relay へ向く／relay の route は `http://<LAN ip>:<port>` を宛先にし `https` を受けない／202:80 を宛先にする既存 route があり、`http_host_header` で Host を書き換える形と `path_prefix` を使う形がある／`access` が真の hostname は ingress に Access の `aud` を持つ（hostname ごとにも、複数 hostname で共有にもできる）。**未確認**: relay が JWT を 202 まで転送するか、relay の許可一覧が何を見て判定するか、SSE を溜めずに通すか、添付（20MB）の上限、Access の session 期間、Cloudflare の team 名。→ 13 章。
- desktop（mac）は今まで通り Tauri の Rust が center に直接つなぐ（変更なし）。同じ session を mac でも見たい時は、desktop と web の center 設定が**同じ center を指す**ようにする（desktop は「別 host の center（`remote`）」、web も `remote`。`D/src-tauri/src/center.rs:60-68`、`center_mcp.rs:97`）。web がどの center につなぐかは設定で決まり、本設計は特定の center の置き場を前提にしない（6.1・6.5）。
- 「session / messenger」: session = center が起動する対話型 claude（pty は wrapper が持つ、`C/src/wrapper.ts:119-155`）。messenger = center の peer（`C/src/server-link.ts:327`）で、bantou-server との通信用。web backend は messenger に参加しない。

## 2. 新設する package と既存の変更点

### 2.1 新設

| package | 名前 | 中身 |
|---|---|---|
| `packages/ui` | `bantou-ui`（private） | Nuxt 4 **layer**（`nuxt.config.ts` に `extends` される側）。`components/`（現 `D/src/components/*`）、`composables/`、`types/`、`assets/`、`api/`（transport 経由の関数群と `Transport` 型）。画面の共有部品と、それを動かす transport 契約 |
| `packages/center-client` | `bantou-center-client`（private） | **center とつなぐ側の共有実装**（TS、Nuxt/Nitro/Tauri を import しない純粋な package）。center 設定（型・検証・接続先の選択・file 保存・secret の伏せ）、MCP client、SessionCache、events の購読、端末の出力・入力・resize・添付の中継、（まとまり S で）center の子プロセス管理。web backend が使い、将来 desktop も使える形（5.5・5.6） |
| `packages/web` | `bantou-web`（private） | Nuxt 4 アプリ（`ssr: false`）+ Nitro server route。`app/`（HTTP transport、mobile-first の page。login page は持たない）と `server/`（BFF: Access の JWT 検証、許可 tool 一覧、`packages/center-client` を呼ぶ route、SSE の公開）。起動は `node .output/server/index.mjs`（同じ monorepo の `packages/server` が Nitro を使う前例: `packages/server/nuxt.config.ts:11`） |

### 2.2 既存の変更

| 対象 | 変更 |
|---|---|
| `packages/desktop` | `src/` の共有部品を `packages/ui` に移し、`nuxt.config.ts` に `extends: ["../ui"]`。Tauri 呼び出しを `src/tauri/`（transport 実装）に集める。`pages/index.vue`・`AppHeader` は desktop 側に残る。**Rust（`src-tauri/`）は変更しない**。center とつなぐ Rust（`center_mcp.rs`・`session.rs`・`center_events.rs`・`terminal.rs`・`attachment.rs`）を `packages/center-client` に寄せる作業は**今回の範囲外**（まとまり (M)、5.6） |
| `packages/center` | **原則変更なし**。ただし判断 3 を推奨（スマホは既定で幅を変えない）にするなら、pty の今のサイズを返す口（`GET /sessions/<n>/size` 相当）を足す必要がある（`core.size`、`C/src/core.ts:38` は HTTP に出ていない、使うのは wrapper 起動時だけ `C/src/remote-control.ts:491`）。これは**まとまり 8**。center は desktop に同梱されるため、反映の順序に制約がある（10 章）。それ以外の center 変更は想定しない |
| root `package.json` | `workspaces: ["packages/*"]`（`package.json:1`）なので追加不要。`bun.lock` は実装まとまりの中で更新 |
| root `CLAUDE.md` | Map に `packages/ui` / `packages/center-client` / `packages/web` を追記。「役割分離ルール」は「共通のものは root の `docs/` と `packages/plugin/` に置く」（`CLAUDE.md` 役割分離ルール節）と書くので、**共有 UI を `packages/ui` に置く**ことと整合を取る修正が要る（まとまり 2b で実施、利用者へ要報告） |
| `docs/` | `docs/ops/web-install.md`（まとまり 7）。`docs/architecture.md` に web 節を足す（まとまり 5b） |
| release | `packages/desktop/scripts/release.sh` は desktop 用。web の配布は別（9.3）。ui の変更は desktop の release 前 e2e（mac200、`D/CLAUDE.md`）を通す |

## 3. 共有の方式（desktop と web で同じ画面部品）

### 3.1 比較

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A. `packages/ui` を Nuxt layer にして両方が `extends`（**推奨**） | 共有部品を別 package に出す | 責務が分かれる。desktop の Tauri 依存が web に入らない。layer は Nuxt 公式の機能 | 移動が大きい（約 5,300 行のうち共有部品）。layer 内の `~/` は**利用側 project を基準に解決される**（Nuxt 公式 docs `layers`）ので、47 箇所の import（`~/types` 21、`~/api` 17 ほか）を相対 path か named alias に書き換える必要がある |
| B. web が `extends: ["../desktop"]` | desktop を layer として使う | 移動なし | `src-tauri`・Tauri JS の依存を web が抱える。desktop の page/AppHeader を web が同 path で上書きする運用になり、desktop の変更が web を壊す。役割分離ルールに反する |
| C. コピー | web に components を複製 | 最速 | 差が開く（center の仕様追従が 2 重）。`TerminalView` のような長大 component（280 行）で破綻 |
| D. 1 package + build mode（alias で `~/api` を差し替え） | `packages/desktop` に web build を同居 | package 追加が無い | Tauri の依存と Rust が web の build に混ざる。役割分離ルールに反する |

選定: **A**。元の課題（スマホ用に画面を変えつつ center 連携の画面は共有したい）に対し、B/D は desktop と web の変更が絡み合い、C は仕様追従が 2 重になる。A の弱点（alias）は書き換えが機械的で、まとまり 2a の確認（desktop の既存 e2e が通る）で検出できる。

### 3.2 継ぎ目: transport

`packages/ui` が持つ契約（概念。名前は実装時に確定）:

```ts
interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>, opts?: { headers?: Record<string, string>; body?: Uint8Array }): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}
```

- 現行の `D/src/api/*.ts` は全て `invoke("<command>", {…})` の薄い関数（報告 1.1）。これを `ui/api/*.ts` に移し、`invoke` を `getTransport().invoke` に置換する。**関数名・command 名・event 名は変えない**（e2e のモック `bantou.ts:379` と同じ契約を守れる）。
- desktop の実装: `@tauri-apps/api` の `invoke`/`listen` を包む（`D/src/tauri/transport.ts`）。
- web の実装: command 名 → HTTP の対応表。`session_output_start/stop` と `session-output`/`session-output-status` は **web transport の中で `EventSource` を使って再現**し、`useTerminalStore` は無変更で動く（`useTerminalStore.ts:44-47,59-67`）。
- Tauri プラグイン・capability 由来の機能は transport とは別に「platform 機能」として差し替える: 更新後の再起動 `relaunch`（`tauri_plugin_process`: `lib.rs:85`、capability `process:default` `capabilities/default.json:17`、`api/updater.ts:1,26`、呼び出し `useUpdater.ts:137`）、drag region（capability `core:window:allow-start-dragging` `capabilities/default.json:11`、`data-tauri-drag-region`）、`openExternalUrl`（`center.ts:89-97`）、updater（`api/updater.ts`）、ドラッグ&ドロップ（`api/attachment.ts:26-29`）、log（`api/log.ts`）、fs 監視（`useWorkspaceWatcher.ts`）、`useUpdater` の menu event（`useUpdater.ts:165`）。web では: ブラウザの `window.open`／無効化（`AppHeader` の updater props を渡さない）／`drop` DOM event（任意）／`console`／無し。
- **漏れの先に潰す**: まとまり 1 で、`~/api` の外にある Tauri import 7 箇所（報告 1.4）を transport 経由にする。これを終えると「`@tauri-apps` を import するのは `D/src/tauri/` だけ」を grep で検査できる。
- 画面の分け方: `pages/index.vue`（372 行）のうち、選択・フィルタ・ダイアログ管理（`:62-158`）は composable（`useSessionBoard` 相当）に出し、desktop は 3 カラム、web は 2 画面で同じ composable を使う。`dir` が無いと一覧を出さない条件（`:179-190`）は desktop 側に残す（`useBoard` は `dir` 無しで center の一覧だけを読む分岐を既に持つ、`useBoard.ts:82-88`）。

## 4. 現行 command / event の置換方針（要約）

全表は報告 1.1〜1.3。web 版に残すもの:

- **center 設定**（desktop と同じ command 名、5.5）: `center_get_settings`、`center_set_settings`、`center_status`、`center_regenerate_token`（起動する形のみ。まとまり S。戻り値の token は返さない）。
- **center への中継**: `center_call`（許可 tool のみ）、`center_connection`、`list_sessions`/`refresh_sessions`、`create_session`/`session_update`、`session_get_settings`/`session_update_settings`、`session_path_hints`、`session_output_*`/`session_input`/`session_resize`、`session_attach_bytes`（`attach_paths`/`attach_pick` は `File` から同じ経路）。
- **web で意味が変わるもの**: `session_path_hints.canPick` は常に偽。`center_get_settings` の応答は **token を返さない**（`token` / `remote.token` は空で、設定済みかの印だけ。5.5）。`center_set_settings` は既定でブラウザからの変更を受けない（判断 14）。center の共通設定（`center_settings_get/update`、`SettingsDialog.vue:74-86`）はこれまで通り tool 経由。
- **持ち込まないもの**: workspace/task/thread/broker/agent（Cork 系 17 command: workspace 4、task 4、thread 2、broker 3、agent 4）、updater、menu、window、single-instance、os 通知（ブラウザの標準 event で代替）、`center_connect_snippets`/`center_parse_connect`/`center_local_ips`/`center_ip_status`（この PC の IP を使う接続設定の生成。token をブラウザに出さない方針と、web が「この PC」を持たないため）。

## 5. web backend（BFF）の責務

### 5.1 HTTP API（command 名をそのまま使う RPC + 3 本のストリーム）

| route | 役割 |
|---|---|
| `GET /api/me` | JWT を検証して利用者の識別（email）を返す。SPA が「Access の session 切れ」を見分けるのにも使う（5.2）。login / logout の route は持たない |
| `POST /api/rpc/:cmd` | 4 章の「center 設定」と「中継」command。body は JSON の `args`。許可リスト外は 404。実処理は `packages/center-client`（5.6） |
| `GET /api/events` | SSE。backend が center の `GET /events` を 1 本だけ持ち（`packages/center-client` の events 購読。`center_events.rs:60-103` と同じ働き）、`center-sessions-changed` と `bantou://sessions-changed` 相当を全ブラウザへ配る |
| `GET /api/sessions/:name/output` | SSE。center の `/sessions/<n>/output` を中継。`Last-Event-ID` と `?after=` をそのまま渡す（`http.ts:320-321`） |
| `POST /api/sessions/:name/input` / `resize` | 中継（`http.ts:359-381` の検査は center が行う） |
| `POST /api/sessions/:name/attachments` | 画像 1 枚を中継（Content-Type を画像型に限定、20MB、`C/src/attachments.ts:5-13`） |
| `GET /api/health` | backend と center の到達可否（`center_connection` 相当） |

### 5.2 認証と守り（Cloudflare Access 前提）

認証（誰が入れるか）は Cloudflare Access に任せる。web backend が持つのは「Cloudflare を通った要求だけを受ける」守りと、変更系の CSRF 対策だけで、パスワード・cookie の発行・login 画面は持たない。

**四層の守り**（外側から）

| 層 | どこで | 何を防ぐか | 状態 |
|---|---|---|---|
| L1 | Cloudflare Access + inet250 の cloudflared（ingress の `access` / `aud`）と relay の許可一覧 | 許可されていない人が外から入ること | 既存の仕組み。hostname ごとに設定する。web 用 hostname の追加は設置時の作業 |
| L2 | 202 の nginx: bantou 用 server block を **inet250 の送信元 IP だけ許可**（`allow <inet250 の IP>; deny all;`） | LAN 内の他の機器が 202 の :80 を直に叩く（Host を偽る）こと | 設計。inet250 の IP は未確認（13 章） |
| L3 | web backend: `Cf-Access-Jwt-Assertion` を**検証**（署名・`aud`・`iss`・`exp`）し、`email` を許可一覧と照合 | L2 を破られた時（nginx 設定ミス、LAN 内の侵害端末が inet250 を装う等）／relay や nginx を飛ばして backend の port に来た時 | 設計。JWT が backend まで届くかは未確認（13 章） |
| L4 | web backend: nginx だけが付ける**共有鍵 header**（`X-Bantou-Proxy-Key`）を照合し、無い・違う要求は 403 | nginx を飛ばして **202 の上のプロセスが backend の loopback port に直接**来ること。L2 は nginx を通る要求にしか効かず、L3 は JWT が届かない場合に成り立たない。202 では bantou-server が cap・worker を `claude -p` で起動し（`docs/architecture.md:27`）、cap の Bash は sandbox を切って動く（同 `:31`）。worker 自身の Bash 権限は本調査で直接確認していない（**推測**: 任意のコマンドを実行できる）。したがって同じ host のプロセスを信用しない | 設計。鍵は env（backend）と nginx の include（chmod 640）に置く。**JWT が届く場合も L4 は常に入れる** |

**同じ host からの到達（L4）の補足**:
- 鍵の比較は定時間（center の `bearerMatches` と同じ流儀、`C/src/http.ts:89-93`）。鍵は backend の env（`PROXY_KEY`）にだけ置き、ログに出さない。
- 代替: backend を unix socket で待ち受けて nginx の user だけが開ける権限にする（Nitro の node server が unix socket を受けるかは**要確認**。user unit の socket を nginx の user が開ける権限の付け方も未確認）。鍵 header の方が構成が単純なので第一案にする。
- 同じ host の別 user は、backend の user の `/proc/<pid>/environ` を読めない前提（一般的な Linux の権限。202 では未確認）。backend の HOME は 750 以下にする（`docs/ops/server-install.md:22` の流儀）。

**JWT の検証（L3）の中身**（Cloudflare 公式 docs の記述に基づく）:
- header 名は `Cf-Access-Jwt-Assertion`。docs は cookie `CF_Authorization` より header の検証を勧め、cookie は「渡される保証がない」と書く。
- 署名鍵は `https://<team 名>.cloudflareaccess.com/cdn-cgi/access/certs` から取り、JWT の `kid` で選ぶ（鍵を埋め込まない）。`aud` は Access の application の AUD tag と、`iss` は `https://<team 名>.cloudflareaccess.com` と一致させる。
- backend は鍵を取るために 202 から `cloudflareaccess.com` へ出る通信が要る（202 の外向き通信の許可は未確認、13 章）。鍵は取得結果を短時間 cache し、`kid` が未知なら 1 回だけ取り直す。
- `team 名` と AUD tag は設置時に backend の env へ入れる（値はこの docs に書かない。AUD tag は inet250 の ingress / relay 設定に既にあるものを使うか、web 用に新規作成するかは**判断 11**）。
- 許可する `email` は env に持つ（Access の policy と二重だが、L3 で独立に絞る）。
- **JWT が backend に届かない場合**（relay が header を落とす等）: L3 が成立しない。代替は (i) L2 の送信元制限と L4 の共有鍵だけで運用する（LAN 内の侵害端末が inet250 の IP を装う余地が残る）、(ii) relay を使わず web hostname の宛先を backend の port に直接向ける（relay の route は任意の LAN port を宛先にできる。nginx を飛ばす形になり L2 は使えない）。(ii) でも JWT が届くかは同じく未確認。**どちらにするかは設置時の実測（13 章 2 番）で決める**。利用者に聞く項目ではない。
- 開発・test: 本番コードに「検証を切るモード」は**置かない**。test では偽の JWKS（test が生成した鍵）を `WEB_CF_CERTS_URL` / `WEB_CF_TEAM` で指し、test 用に署名した JWT を使う。

**CSRF**: 認証が cookie（`CF_Authorization`）なので、変更系（`POST`）は `Origin` が自分の hostname と一致する時だけ受ける。`SameSite` は Cloudflare 側の cookie の属性で backend は制御できない（未確認）ため、Origin 検査を主にする。

**session 切れ**: Access の session が切れた後の fetch / EventSource は、Cloudflare のログイン画面への redirect になり、SPA からは失敗に見える（挙動は未確認、13 章）。SPA は SSE の失敗が続く時に `GET /api/me` を呼び、失敗なら `location.reload()` で Access のログインに戻す。

**center の token との関係**
- center の既存 token（`config.token`、12 文字以上、`C/src/daemon.ts:212-214`、`C/src/config.ts:34`）は「backend → center」の認証で、これまでと同じ（Bearer、`C/src/http.ts:89-93,392-397`）。Cloudflare の識別とは**独立**で、どちらかが破られても、もう一方だけでは center を操作できない。
- web backend は Cloudflare の header を center へ転送しない。center の token は center 設定の `remote.token`（既定の形）か `token`（起動する形）で、backend の設定 file か env（`EnvironmentFile`、chmod 600。`packages/memory/deploy/bantou-memory.service:2-3` の流儀）にだけ置く（5.5）。**ブラウザにも Cloudflare 側にも出さない**（設定の読み出しでも返さない。5.5）。center を起動する形では center を `127.0.0.1` に bind して外向けの経路に出さない（6.6）。別に置いた center の bind は、その center の置き場（6.2）。
- Cloudflare Access を通れる人 = center の全操作（session で claude を動かす権限）を持つ人。Access の許可一覧は**管理者の一覧として扱う**（R4、R25）。

**別案の比較**
- backend にパスワード login を持つ（初版案）→ 利用者が「独自に作らない」と決めたので取り下げ。
- nginx の `auth_request` で JWT 検証を nginx に置く → 検証が backend と二重になる。nginx 側に検証用の module/設定が要る（202 の nginx の構成は未確認）。backend 内で足りるので採らない。
- center の token をブラウザに入力させる → token がブラウザに残るため却下（初版から変わらず）。

### 5.3 許可 tool の絞り込み

desktop の `center_call` は任意 tool を呼べる（`center_mcp.rs:468-478`）が、web は Access を通れる端末（盗まれたスマホなど）が乗っ取られると center 全体が操作されるため、UI が実際に使う tool に限る。desktop の UI が `centerTool/centerToolStrict` で呼ぶ名前: `rc_list` `rc_start` `rc_stop` `server_list` `server_peers` `server_retire` `remote_list` `worker_reply` `session_login` `session_login_code` `center_settings_get` `center_settings_update`（`D/src/components/*`、`D/src/api/center.ts`）。加えて backend 内部で `session_list` `session_create` `session_update` `session_settings_get/update` `center_info`。`session_delete` は desktop の UI が使っていないので許可しない。`server_retire`（**不可逆**、`docs/ops/server-install.md:133`）は、判断 10 の推奨に従い**web の許可リストに入れない**（desktop のみ）。`rc_start/rc_stop` と session の作成・改名は許可するが、**スマホでの誤タップを防ぐ確認画面**を共有 component 側に要求する（危険 R5）。

### 5.4 SessionCache と events

実装は `packages/center-client` に置く（5.6）。web backend は 1 つの instance を全ブラウザで共有する。

- 一覧を最後に取れた内容で持ち、取れない時は `reachable: false` で古い一覧を返す（`session.rs:1-14,247-256` の仕様）。`rev` は backend が採番（`useBoard.ts:66-68` が最大の `rev` を採る前提を保つ）。**全ブラウザで 1 つ**。
- center の MCP session は backend が 1 本持ち、404 なら 1 回だけ再 initialize（`center_mcp.rs:8-12`）。center の MCP session 上限 32・30 分失効（`http.ts:34,36`）に、ブラウザの台数が影響しないようにする。

### 5.5 center 設定（desktop と同じ仕組み）

desktop の仕組み（報告 9 章）: 設定は 1 つの object `CenterSettings`（`enabled` `port` `bind` `workspace` `claudePath` `token` `remote`）で、`settings.json` の `center` キーに保存される。**接続先は呼び出しのたびに保存済みの設定から選ぶ**: `enabled` が真なら自分が起動する center（loopback）、偽で `remote` があればそれ、どちらも無ければ「接続先が無い」（`D/src-tauri/src/center_mcp.rs:85-98,460`）。web も同じ object・同じ選び方・同じ command 名（`center_get_settings` / `center_set_settings` / `center_status` / `center_regenerate_token`）にし、型は `packages/ui` の既存の `CenterSettings`（`D/src/types/index.ts:166-185`）を使う。web の応答では型の差が 2 つある: `bind` は持たないので optional にし、設定済みの印 `tokenSet` と `remote.tokenSet` を optional で足す（`packages/ui` の `types` に optional で足すだけで、desktop の応答型・値は変わらない）。

**項目（名前・意味は desktop と同じ）**

| 項目 | 意味 | 既定 | web v1 |
|---|---|---|---|
| `enabled` | center を起動するか（`center.rs:73`） | 偽（`center.rs:95`） | **偽のみ**。真の保存は検証で拒否し「この版では未対応」と返す（まとまり S で有効化） |
| `remote` | 別に置いた center。`{ url, token? }`（`center.rs:63-68`）。url は `/mcp` に正規化（`center_mcp.rs:53-67`） | なし | **v1 の主**。url と token を設定で与える |
| `port` | 起動する center の待受 port | desktop と同じ（`center.rs:28`） | 起動する形（S）でのみ使う |
| `workspace` | 起動する center の作業 dir（session 作成の既定の親） | desktop と同じ（`center.rs:57-58`） | S でのみ使う |
| `claudePath` | claude の絶対 path。未設定なら center が解決 | 未設定 | S でのみ使う |
| `token` | 起動する center が `/mcp` で要求する Bearer。空なら初回に生成（`center.rs:116-123`） | 空 | S でのみ使う |
| `bind` | desktop では**接続設定（snippet）の URL に書く IP**で、center の待受ではない（`center.rs:75-77`） | — | **持たない**（snippet を web に持ち込まないため、4 章）。保存 file にも書かない |

何も設定が無い（既定のまま）時は「接続先が無い」で、backend は起動する。`/api/health` は到達不可と理由を返し、画面は接続先の設定を促す。

**保存場所**
- backend の設定 file（JSON、chmod 600、書き込みは一時 file→rename）。内容は desktop の `settings.json` の `center` キーと同じ形（camelCase の `CenterSettings`）。場所は env `WEB_SETTINGS_FILE`（既定は backend の状態 dir）。desktop が使う tauri-plugin-store の file 形式と完全に同じかは**未確認**（まとまり (M) の着手時に確かめる）。
- 読み込み時の整形は desktop と同じ: 不正な保存値は既定に戻す、url の正規化と書き戻し（`center.rs:664-681`）。**token の生成だけ違う**: desktop は `enabled` に関わらず token が無ければ生成して保存する（`center.rs:671`）。web は `enabled` が偽の間は生成しない（使わない token を持たない。5.7 #10）。検証も同じ規則: port 1〜65535、workspace は絶対 path か `~` 始まり、claudePath は絶対 path、token は 12 文字以上、remote の url は `http(s)://`（`center.rs:126-160`）。
- **接続先は呼び出しのたびに file から選ぶ**ので、設定を変えても backend の再起動は要らない（desktop も同じ、`center_mcp.rs:7-8`）。接続先が変われば MCP session は作り直す。

**env との関係**（desktop には無い web 側の取り決め。設計）
- `WEB_SETTINGS_FILE`: 設定 file の場所。
- `CENTER_URL` / `CENTER_TOKEN`（任意）: 設定されていれば file の `remote` より優先し、その項目は画面・command から変更できない（「env で固定」と表示）。systemd の `EnvironmentFile` に秘密を置く運用のため。
- Cloudflare 系（`CF_TEAM` `CF_AUD` `ALLOWED_EMAILS`）、`PROXY_KEY`、`PORT` は center 設定ではなく **web backend の守り**（5.2）で、設定 file に入れず、ブラウザから変えられない。
- 優先順位は env > 設定 file > 既定。

**誰がどう変えるか**
1. **運用者が設定 file か env を編集する**（既定の変え方）。次の呼び出しから有効。
2. **設定画面**: 共有の `SettingsDialog`（`packages/ui`）。**desktop の「別 host の center だけを使う」表示（`sidecarVisible`）は流用できない**: `sidecarVisible = !remoteOnly || enabled`（`SettingsDialog.vue:294`）、`remoteOnly = !enabled && remote あり`（`D/src/composables/centerRole.ts:10`、`SettingsDialog.vue:50`）なので、web の既定（`enabled` 偽・`remote` なし）では `remoteOnly` が偽になり、起動スイッチ・port・IP・token・状態の欄が出てしまう。また「この PC の center を起動」ボタン（`:475`）は `enabled` を真にするが web は保存を拒否し、ダイアログは開く時に `centerStatus`（`:37`）・`centerLocalIps`（`:132`）・`centerIpStatus`（`:145`）を呼ぶが web の許可リストに無く 404 になる。そこで共有 `SettingsDialog` に **「web モード」の分岐**を足す（platform 機能として注入。`centerSidecar: false` 相当。起動系の欄・「この PC の center を起動」ボタン・IP/status 系の呼び出しを出さず、呼ばない）。web モードでは**接続先 center の url・token の欄（設定済みの印）と接続状態**だけを出す。desktop は注入が既定（`centerSidecar: true`）で表示も呼び出しも不変。画面からの**変更を受けるか**は判断 14（推奨: v1 は表示のみ、変更は file）。
3. **設定の解除**: `center_set_settings` は空の token を「変更しない」と読むので（下記）、画面から `remote.token` を「無し」に戻す手段は無い。戻す時は設定 file の編集（`remote` の `token` を消す）。

**token をブラウザに出さない**（方針を保つ）
- `center_get_settings` は `token` と `remote.token` を**空で返し**、設定済みかの印（`tokenSet`）だけを足す（型に optional の項目を足す。desktop の応答は従来どおり token を含み、変わらない）。
- `center_set_settings` で token が空なら「変更しない」。**ただし `remote.url` が変わる時は保存済みの token を引き継がず**、新しい token を同時に受ける（url の差し替えで既存の token を別の宛先へ送る経路を断つ。R29）。
- token と url の userinfo は、ログ・エラー文・`/api/health` に出さない。
- 画面に出すのは url の host 部と接続状態（`center_connection` 相当）まで。

### 5.6 実装の共有（center とつなぐ側を web 専用にしない）

**共有する範囲**: center とつなぐ側の全部 — MCP client（再 initialize）、SessionCache（`rev`）、events の購読、端末の出力・入力・resize・添付の中継、center 設定の読み書き（5.5）、（まとまり S で）center の子プロセス管理。desktop では `center_mcp.rs`・`session.rs`・`center_events.rs`・`terminal.rs`・`attachment.rs`・`center.rs` が担っている働き（報告 1.1〜1.3、9 章）。

**案の比較**

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A. 共有 TS package（**推奨**） | `packages/center-client` に TS で置く。web backend が使う。desktop は後で寄せる | web backend は Node なのでそのまま使える。center と protocol が既に TS で、TS を `bun build --compile` して desktop に同梱する前例がある（`D/scripts/build-sidecar.ts:80-99`） | desktop が使うには、実行の場所を決める作業が要る（下記） |
| B. Rust の共有 crate | 上の Rust ファイルを Tauri 非依存の crate に出し、web backend は native addon で使う | desktop は今の言語のまま | 5 file が `AppHandle` と plugin-store に依存している（例: `load_settings(app)`、`center_mcp.rs:463`）。web に native addon が入り、設置先の arch・toolchain が未確認（R11）の負担が増える |
| C. web 用に TS で書き直し（初版案） | desktop の Rust と別の実装を持つ | 速い | 実装が 2 つ。center の仕様追従が 2 重。方針 2 に反する |
| D. center に BFF 機能を足す | 一覧の cache・中継を center の HTTP に出す | client が薄くなる | SessionCache は「center に届かない時に古い一覧を返す」性質（`session.rs:1-14`）で center の中に置けない。center の変更が大きい |

選定: **A**。元の課題（将来そのまま実装を共有する）に対し、B は web に native 依存を持ち込み、C は共有にならず、D は SessionCache の性質に合わない。A の弱点（desktop を寄せる作業）は下記の「必要なこと」に分け、**今すぐは desktop を変えない**。

**形**
- framework 非依存の TS（Nuxt / Nitro / Tauri / ブラウザ専用 API を import しない）。fetch と stream の parse だけで SSE を読む。fs とプロセス起動は `settings` と `process` の module に閉じ込める（bundle して別の場所で動かせるように）。
- module: `settings`（`center.rs` の設定部と `center_mcp.rs` の `select_target`・`normalize_remote`）、`mcp`、`sessions`（SessionCache）、`events`、`terminal`、`attachment`、`process`（S）。
- 入口: `createCenterClient({ settingsStore, policy, redactSecrets })`。**command 名をキーにした handler 群**（`center_call`、`list_sessions`、`session_input` ほか。4 章）と、**event 名をキーにした購読**（`center-sessions-changed`、`session-output` ほか。報告 1.2）を返す。
- 差は注入で吸収し、実装は変えない: `settingsStore`（web は file、desktop は将来 tauri 側の store）、`policy.allowTool(name)`（web は 5.3 の許可リスト、desktop は全許可）、`redactSecrets`（web は真）。
- 契約: command 名・event 名・payload の型は `packages/ui` の `types` を正とする（既存の Rust の鏡、`D/src/types/index.ts`）。e2e のモック（`D/e2e/mock/install.ts:28-35`）も同じ契約を守る。web の route は handler を呼ぶだけの薄い層（5.1）。

**desktop を将来寄せる時に要ること**（今回は実施しない。まとまり (M)）
1. 実行の場所: `packages/center-client` を desktop の 2 つ目の sidecar（`build-sidecar.ts` の流儀で `bun build --compile`）として同梱し、loopback で起動する。webview は `packages/ui` の **HTTP transport（web と同じ）** でそれを呼ぶ。Tauri の `invoke` から HTTP transport への切り替えは、まとまり 1 の transport 継ぎ目で既に差し替え可能になっている。
2. 設定の保存: `CenterSettings` の保存先を共有 package の `settingsStore` に揃える。tauri-plugin-store の file 形式の確認が要る（5.5）。
3. loopback の認証: webview と sidecar の間に起動ごとの token が要る（web の守り L1〜L4 は不要だが、同じ host の他プロセスから叩かれない守りは要る）。Tauri の CSP・capability の `connect-src` を足す。
4. Rust の撤去: 上の 5 file のうち center と話す部分を外す。sidecar の監視（`center.rs` の Supervisor）は Rust のままにするか `process` に寄せるか、その時に決める。ダイアログ・updater・window・menu・os event などの platform 機能は Rust に残る（報告 1.3）。
5. 契約テスト: Rust の既存 test の入力と期待値（`normalize_remote` `center_mcp.rs:878-892`、`select_target` `:527-577`、`validate_settings` `center.rs:804-826`、token `:846-868`）を fixture（JSON）に出し、Rust と TS の両方が同じ fixture を通す。Rust を撤去するまで挙動のずれを防ぐ。まとまり 3b では**同じ入力を TS の test に写す**（出典の file:line を test に書く）。fixture の共有化で Rust 側の test を変えるのは (M) の最初。
6. 順序: v1（まとまり 1〜8）が安定してから。desktop の release 手順（`D/CLAUDE.md`）に乗せる。

**desktop が今すぐ変わらないこと**: Rust は無変更で、center とつなぐ挙動も変えない。desktop の frontend に手が入るのは、まとまり 1・2a・2b（整理）と、共有 component を触る 5c（設定ダイアログ）・6a・6b（`TerminalView` など）・R5 の確認画面。共有 component の変更は desktop の表示と挙動を変えない範囲にとどめ、desktop の e2e（`D/CLAUDE.md` の手順）で確かめる。

### 5.7 desktop との差（意図して変えている所を 1 か所に）

方針 1〜2 は「center とつなぐ側の仕組み（設定・接続・中継）を desktop と同じにし、実装を共有する」こと。次はそこに入らない、または共有の外側に置く差。

| # | 差 | 内容 | 方針 1〜2 に反しないか | 利用者に聞くか |
|---|---|---|---|---|
| 1 | Cork（task・thread・messenger 受信 `bantou-core`）を出さない | 17 command と `bantou://threads-changed` などは持ち込まない（4 章） | 反しない。center とつなぐ側ではなく別の仕組みで、共有 package に含めない。共有の broker に `bantou-core` を 2 つ登録できない（`docs/handoff.md:16`） | 聞く（既存の判断 5） |
| 2 | 許可 tool を絞る | web は 5.3 の一覧だけを通す。`server_retire` は出さない | 反しない。`center-client` は `policy` を受けるだけで、一覧は web backend が渡す。同じコードで desktop は全許可 | 聞く（既存の判断 10） |
| 3 | スマホ専用の page | 一覧 → 端末の 2 画面、特殊キー列、入力欄（7 章） | 反しない。画面の差で、center とつなぐ側は共有。選択・フィルタは共有 composable（3.2） | 聞かない |
| 4 | 設定の読み出しで token を返さず、書き込みで空の token を「変更しない」と読む | `center_get_settings` の応答と `center_set_settings` の入力（5.5）。desktop は応答に token を含み（`SettingsDialog.vue:405`）、`remote` の空 token は「無し」（`center.rs:156`）、sidecar の空 token は作り直し（`ensure_token`、`center.rs:116-123`）。web は `redactSecrets` が真の間、空を据え置きと読む。このため web の画面からは `remote.token` を「無し」に戻せない（戻すのは設定 file の編集、5.5 の 3） | 反しない。command 名と型は同じ（`tokenSet` が optional で増える）。意味の差は `redactSecrets` の有無として注入で吸収され、desktop が将来使う時は偽にすれば今の動きのまま。ブラウザに token を出さない方針を保つため | 聞かない（方針どおり） |
| 5 | 設定画面からの接続先の変更 | 既定は表示のみ、変更は file か env（5.5） | 反しない。同じ設定 object を、変更の口だけ絞る | **聞く（判断 14）** |
| 6 | env による固定（`CENTER_URL` / `CENTER_TOKEN`） | env があれば file より優先し、画面で変更不可 | 反しない。設定の与え方の一つで、選び方は同じ | 聞かない |
| 7 | 起動する形の待受 | web が起動する center は loopback のみで待つ（desktop は全 address、`center.rs:31`） | 反しない。設定値の違いで、web backend だけが client のため。他の PC から直接つなぐ口が要るなら desktop の center を使う | 聞かない |
| 8 | 持ち込まない platform 機能 | フォルダ選択、IP の選択と snippet、updater、menu、window、os event（4 章、報告 1.3） | 反しない。center とつなぐ側の外 | 聞かない |
| 9 | 端末の幅の既定（表示のみ。判断 3） | スマホは今の幅を送らない | 反しない。画面の挙動 | 聞く（既存の判断 3） |
| 11 | `center_regenerate_token` の戻り値 | desktop は新 token の文字列を返す（`center.rs:758-766`）。web（S）は捨てて `tokenSet` だけ返す（画面にも新 token を出さない。控えが要る時は設定 file を見る） | 反しない。command 名は同じで、token をブラウザに出さない方針のため。desktop は `redactSecrets` 偽で従来どおり | 聞かない（方針どおり） |
| 10 | token の生成の条件 | web は `enabled` が真の時だけ生成（desktop は常に、`center.rs:671`） | 反しない。使わない token を保存しないだけで、`enabled` が真の動きは同じ | 聞かない |

## 6. center をどこに置くか（設定で決まる。既定は別に置いた center につなぐ）

### 6.1 既定の形: 別に置いた center につなぐ（`remote`）／その center の起動形

既定では web は center を起動せず、center 設定の `remote`（url と token、5.5）が指す center へつなぐ。その center は desktop の「別 host の center」と同じもので、**どこに置くかは設定が決める**（web と同じ host、別の host、desktop が使っている center でもよい）。本設計は置き場を決めない。置く時の起動形は次のとおり（`bantou-center` を単独で headless 常駐させる）。center が systemd の直下で動く限り、親が変わると終了する性質（`daemon.ts:238`）は web backend の再起動と無関係。

- 引数: `--transport http --port <port> --bind <addr> --config <path>`（`C/src/args.ts:15-44`）。config に `token`（12 文字以上必須、`daemon.ts:212-214`）、`workspace`、必要なら `remoteControl.claude`（絶対 path。service は login shell を通らない可能性があるため、明示を推奨。推測）。
- 起動物（2 通り。どちらも center の host で `pty-wrapper` が要る）:
  - (i) **ソースから**: `packages/protocol` と `packages/center` を build し `node packages/center/dist/cli.js`（`C/package.json` `bin`・`engines.node >=22`）。wrapper は `BANTOU_PTY_WRAPPER` で指す（`wrapper.ts:4-7`）。
  - (ii) **単体バイナリ**: `D/scripts/build-sidecar.ts` と同じ手順（`bun build --compile`、Linux x64/arm64 は対応、`build-sidecar.ts:15-20`）で center と wrapper を同じ dir に置く。wrapper は `cargo build --release` が 202（または同 arch の Linux）で要る（`build-sidecar.ts:51-62`）。
  - 推奨は (i)。理由: center を置く host に node 22 があるという**推測**（`docs/ops/server-install.md:31` は bantou-server の設置の事前条件として system 全体の node 22 以上を挙げるが、202 での実測はしていない）の上で、Rust と bun を 202 に入れずに済む。wrapper だけは Rust の build が要る（別 Linux で build して置くことも可）。202 の arch・node・toolchain は**設置者が実測する**（13 章 12。まとまり 7 は docs のみで 202 には触れない）。
- 親が変わると落ちる（`daemon.ts:238`）ので、systemd が直接 `node` を起動する形にする（`npx`・shell script 経由にしない。ラッパー shell が `exec` しない場合に親 pid が変わる恐れ。推測）。
- 1 host に center を複数立てない。同じ `~/.config/bantou/center.json` と状態 dir を共有しない（`daemon.ts:112` の `stateDir` = config の dir）。

### 6.2 認証と token の扱い

- center の token は center の config と、web backend の center 設定（`remote.token`、5.5）にだけ置く。スマホにも web の画面にも出さない（`center_connect_snippets` 系は web に持ち込まない、報告 1.1）。
- center を loopback に bind すると Host/Origin 検査が効く（`http.ts:80-86,414`）。web backend と center が同じ host なら `remote.url` は loopback の url でよく、検査の影響を受けない。別の host に置いた center へつなぐ時は、その center の bind と経路（平文／https）が token の守りになり、web backend の接続も LAN を平文で流れうる（判断 13）。
- **desktop（mac）が web と同じ center に入る場合**（置き場が LAN 内の host の時。判断 13）は center に LAN から届く必要がある。選択肢（判断 13）: (a) center を `0.0.0.0` で待ち受ける（今の desktop の sidecar と同じ。token のみ・平文、`center.rs:31`、`docs/architecture.md:57`）／(b) center は loopback のまま、同じ host の nginx に **LAN 内の desktop 向けの HTTPS の listener**（`/center/` など）を別に設け、Host を center の loopback の宛先に書き換えて中継する（loopback bind の Host 検査を通すため、`http.ts:80-86`）。desktop の `remote` は `https://` の URL を受ける（`center.rs:152`）。(b) の方が token を LAN に平文で流さない。**8.1 の「202 の nginx に証明書は要らない」は、Cloudflare → inet250 → 202 の外向けの経路（平文 HTTP）の話で、(b) の LAN 内 HTTPS は別の listener であり証明書が要る。** center を置く host に証明書があるか、mac がそれを信頼できるか（私的な認証局の登録など）は未確認（13 章 17）。
- **desktop を外（家の LAN の外）から、web と同じ center につなぐ経路は、本設計に含まない。** desktop の MCP client は `Authorization: Bearer` だけを付ける作りで（`center_mcp.rs:9-10`）、Cloudflare Access が非ブラウザに求める追加の header（service token）を付ける口が無い（コードに該当なし。Access 側の要件は未確認）。外で使うのは web（ブラウザ）だけで、desktop は LAN（または VPN で LAN 相当）から使う前提。

### 6.3 session の claude process と pty の持ち主

- pty は wrapper が持ち、center の `core` が出力を 8 MiB/session で保持する（`core.ts:7`）。持ち主は **設定が指す center**。web backend も desktop も持たない（起動する形では web backend の子になるが、pty は center の中、6.6）。ブラウザを閉じても session は続き、再接続すると続きが来る（`after` が残っていれば差分、無ければ `reset` + 全部、`core.ts:107-120`）。
- claude の認証は center を動かす OS user の `CLAUDE_CONFIG_DIR` 配下。ログインは既存の再ログイン画面（`LoginDialog`）で出来る（`C/src/login.ts`、`D/src/components/LoginDialog.vue`）。web ではその URL を**端末（ブラウザ）で開く**ので `window.open`（`LoginDialog.vue:60`）。

### 6.4 複数端末（mac の desktop とスマホ）から同じ center / session を見る場合（desktop と web が同じ center を指す設定の時）

| 項目 | 振る舞い | 根拠 |
|---|---|---|
| 出力の閲覧 | 何台でも同時に購読できる | `core.ts:53,118` |
| 入力 | 全員が同じ pty に書く。**排他は無い**。同時に打てば混ざる | `core.ts:93-98` |
| 大きさ | **最後にサイズを送った端末が勝つ**。表示した時点で必ず送る | `core.ts:99-105`、`TerminalView.vue:154-157`、`docs/design/master-cap-session.md:118` |
| 一覧・状態 | center に 1 つ。全端末が同じ内容を見る | `session_list` |
| 引き継ぎ | desktop の sidecar center の session は別の center に移らない（`sessions.json` は center の host に置かれる） | `daemon.ts:131` |
| remote-cap の記録 | center ごと（cap_id に center-id を含む） | `docs/architecture.md:44,47`、`daemon.ts:140` |

→ 「desktop と同じ session をスマホで続ける」は、**desktop と web が同じ center を指す設定にする**ことでのみ成り立つ（desktop は `remote`、web も `remote`）。desktop の sidecar center を web から指すこと（desktop の機械が起きている間だけ）もできるが、その center の置き場と到達性は設定する側の責任（6.2）。

### 6.5 desktop と web が同じ center を指す時の切り替えと注意

旧判断 2（「新しい center を置いて desktop をそこへ切り替える」）は方針 4 で前提でなくなった。web がどの center につなぐかは設定で決まる。desktop も同じ center を指したい時だけ、次に注意する。

- 切り替え方: desktop の設定で「center を起動する」を切り、web と同じ center の接続設定を貼る。`enabled` が真のあいだは貼った `remote` より sidecar が優先されるので（`D/src-tauri/src/center_mcp.rs:87-98`）、切り替えると desktop の sidecar は止まる（`center.rs:211-221`、`:638`）。
- 副作用の注意: center が同名 peer `bantou-center`（`server-link.ts:327`）で同じ broker に**複数**並ぶと、片方が再起動して peer id が変わった後、server の返信が**もう一方**へ行くことがコード上ありうる（`reports.ts:159-175`、実挙動は未測定）。desktop と web が**同じ 1 つの center** を指すなら center は 1 つで、この状態は起きない。別の center を web 用に立てる時と、他の desktop が center を常駐させている運用（`docs/architecture.md:10`）が同じ broker にいる時に起きうる（同じ broker かは未確認、推測）。並べる期間は両方に同時に指示を出さない。
- remote-cap の一覧は center ごと（center-id が違う、`daemon.ts:140`）。別の center を指す間は session が別々に見える。

### 6.6 center を起動する形（`enabled`）を web でも持つ場合

desktop の sidecar と同じ項目（`enabled` `port` `workspace` `claudePath` `token`、5.5）で、web backend が center を**子プロセスとして起動**する形。**v1 には入れず、まとまり S として後に足す**（既定の接続形が先に動く。10 章）。v1 の検証は `enabled` の真を拒否するので、S を足すまで誤って有効にならない。

**扱い（desktop の sidecar と同じ監視を `packages/center-client` の `process` に置く）**
- 起動: 設定から config を書き（`workspace` と `remoteControl.claude` と `token`。`center.rs:174-187`）、`--transport http --port <port> --bind <addr> --config <path>` で子として起動（`center.rs:189-199`）。web backend が**直接の親**になる（shell・npx を挟まない。`daemon.ts:238` の親監視のため）。待受は loopback のみ（5.7 #7）。接続先は `enabled` の時、loopback の `port`（`select_target`、`center_mcp.rs:85-98`）。
- 監視: desktop と同じ — 異常終了は 2 秒から倍々（上限 60 秒）で再起動、10 分に 5 回超で断念、5 分安定で失敗の数を戻す（`center.rs:44-55,247-290`）。ログの末尾を状態に載せる（`center.rs:37,448`、`center_status`）。
- 停止: SIGTERM を先に送り、center が子の claude を止めるのを待つ（`center.rs:44,504`）。web backend の停止（SIGTERM）でも同じ停止を行う（`lib.rs:197-199` の desktop 終了時と同じ）。
- 設定の反映: 起動に関わる項目（port・workspace・claudePath・token）が変わった時だけ再起動し、`remote` の変更は center に渡らないので再起動しない（`needs_restart`、`center.rs:211-221`）。

**親が変わると center が終わる性質（`daemon.ts:238`）との関係**
- この形では**web backend の再起動 = center の再起動**で、全 session の TUI が中断される（`--continue` で復帰、`daemon.ts:167-194,256`）。desktop でアプリを終了すると center が止まるのと同じ性質（R30）。
- 既定の形（別に置いた center）なら、web の更新は session に影響しない（9.3）。**session を止めたくない運用では、起動する形を使わず既定の形を使う**。
- systemd の unit は `KillMode` の既定（control-group）で子も止まる。`TimeoutStopSec` は center 自身の停止時間より長くする。center は SIGTERM で子を止めるのに `stopGraceMs`（5 秒、`C/src/config.ts:24`）を待ち、間に合わなければ `HARD_EXIT_MARGIN_MS`（5 秒、`C/src/daemon.ts:31,175`）後に強制終了するので最大約 10 秒。9.1 の center unit の 30 秒もこの 10 秒が基準（`center.rs:44` の 15 秒は desktop が center の終了を待つ時間で、center の停止時間ではない）。
- 更新手順（9.3）は、この形の時だけ「web の更新 = center の更新」として cap が空の時に行う。

**S に入れるもの**: `process` module、`enabled` の検証解除、`center_status`・`center_regenerate_token` の command（**`center_regenerate_token` は desktop では新 token の文字列を返す**、`center.rs:758-766`・`D/src/api/center.ts:10`。web では戻り値を捨て、`tokenSet` だけ返す。5.7 #11）、設定画面の起動の欄（スイッチ・port・状態・再起動回数・ログ。`SettingsDialog.vue` の `sidecarVisible`）、起動した center の `pty-wrapper` の解決（6.1 の (i)(ii)）。

## 7. スマホの画面

### 7.1 画面構成

- `/`（session 一覧）→ `/s/:name`（端末 + 入力）の 2 階層。login 画面は無い（Cloudflare Access が先に出る。session 切れ後の戻し方は 5.2）。3 カラム（`pages/index.vue:191-320`）は使わない。
- 一覧の行: 名前、`activity` の印（working / needs-input / idle / remote-*、`SessionActivityMark`）、`contextUsage` の %、`auth` が要再ログインなら鍵（`index.vue:230-261` の中身を共有 component 化）。上部にタブ「session / server・cap」。
- 「server・cap」: `CenterDialog` が表示する server 一覧・版・rc 状態（`CenterDialog.vue:39,59,60`）と、session ごとの cap の状態 `RemoteActivity`（`:22`）を、縦積みカードに。
- 状態変化の取得: `GET /api/events` の SSE。スマホがバックグラウンドに回ると接続が止まる（推測）ので、`visibilitychange`/`pageshow` で一覧を取り直し、端末の SSE は `after` で再開する（`useSessionRefresh.ts:84-104` の desktop 用の契機を、ブラウザ event に差し替える）。
- ヘッダー: `pl-20`（`AppHeader.vue:45`）と drag-region を持たない専用ヘッダーを `web` に置く。

### 7.2 端末（xterm）の扱い

- 幅: `FitAddon` で端末の列数を決める（`TerminalView.vue:174-176`）。スマホの縦持ちは狭い（推測: 40 列前後）。claude の TUI は幅に依存して描く。**このサイズが pty 全体に反映される**（6.4）。
  - 方式 A（判断 3 の A、**推奨**）: スマホは「表示のみ（サイズを送らない）」が既定。今の pty の列数で描き、横スクロールで見る。入力を始める時にだけ「この端末の幅に合わせる」を選ぶ。pty の今のサイズを知る口が要る（center に追加、まとまり 8）。
  - 方式 B（判断 3 の B）: スマホで開いたらそのサイズを送る。mac 側の TUI も狭くなる。center の変更は要らない。
- フォント: 13px 固定（`TerminalView.vue:169`）→ スマホは `fontSize` を props で変え、ピンチで拡大縮小しない（誤操作防止）。
- 縦の高さ: soft keyboard が出ると `visualViewport` の高さが変わる。端末の領域を `visualViewport.height` に追従させる（Web 標準の API。スマホ実機での確認が要る、未検証）。
- **特殊キー列**（端末の下に固定）: Esc `\x1b`、Tab `\t`、Shift+Tab `\x1b[Z`、Ctrl+C `\x03`、Ctrl+D `\x04`、矢印 `\x1b[A/B/C/D`、Enter `\r`、`y`/`n`（permission 応答）。Enter が `\r` なのは `C/src/login.ts:60,95` が根拠。他の制御列は一般的な端末の規約（この repo では未検証。実機で確認）。
- **入力欄**（会話の入力）: 端末の hidden textarea への直打ちは日本語 IME で崩れる恐れ（推測）。端末の下に通常の `<textarea>` を置き、「送信」で本文 + `\r` を `input` に送る。複数行は bracketed paste（`\x1b[200~ … \x1b[201~`）で包む案があるが、claude の TUI が解釈するかは**未検証**（まとまり 6a の最初に実測）。Enter キーの確定は IME 確定と区別する（`docs/handoff.md:28` の方針）。
- キー入力 1 回ごとの POST（`TerminalView.vue:182`、`terminal.rs:340`）は、モバイル回線で遅延が出る。web transport は入力を短時間（数十 ms）まとめて送る（desktop の挙動は変えない）。
- 画像の添付: `paste` が無いので、ファイル選択ボタン（`<input type="file" accept="image/*" multiple>`）。1 枚 20MB・型の検査は desktop と同じ（`TerminalView.vue:33-34`、`C/src/attachments.ts`）。スマホのカメラ/写真ライブラリから選べる（`accept` の一般仕様。実機未検証）。

## 8. 経路（Cloudflare → inet250 → 202 の nginx）と配信の要件

### 8.1 202 の nginx への要件

| 要件 | 理由 / 根拠 |
|---|---|
| bantou 用の `server` block を `listen 80` で足す。`server_name` で振り分ける | relay は 202 の `:80` に平文 HTTP で来る（relay は `https` を受けない）。既に他の app の route が 202:80 を宛先にしている（報告 8 章）。**TLS は Cloudflare の edge で終端**され、この外向けの経路では 202 の nginx に証明書は要らない（LAN 内の desktop 向けに HTTPS を設ける場合は別の listener で証明書が要る。6.2・判断 13） |
| 送信元を inet250 の IP に限る（`allow <IP>; deny all;`） | L2（5.2）。LAN 内の他機器が 202:80 に Host を偽って来るのを防ぐ。inet250 の IP は**未確認** |
| `Host` を保つ（relay の `http_host_header` で渡る） | 既存の route に `http_host_header` を使う例がある。web 用 route も同じ形にすれば `server_name` で選べる（推測。relay の挙動は route 設定のとおりとしか観測していない） |
| SSE を通す: `proxy_buffering off`、`proxy_http_version 1.1`、`Connection ""`、gzip しない | SSE が溜まらないように（nginx の一般仕様）。backend も `X-Accel-Buffering: no` を返す |
| `proxy_read_timeout` を長く（例 3600s） | center の keep-alive は 15 秒（`http.ts:21`）、読み取りの無音は 45 秒で切る設計（`terminal.rs:28`）。nginx の既定 60 秒は ka より長いが余裕を持たせる |
| `client_max_body_size 21m` 以上 | 添付 1 枚 20MB（`C/src/attachments.ts:13`）。nginx の既定は一般に 1MB |
| `X-Bantou-Proxy-Key` を付けて backend へ渡す（L4）。値は別 file に置き include する | nginx を飛ばして来る同一 host のプロセスを backend が拒否できるように（5.2） |
| `Cf-Access-Jwt-Assertion` を backend へそのまま渡す（nginx は既定で request header を渡す。上書きしない） | L3 の検証に使う（5.2）。relay が落としていれば nginx では直せない |
| WebSocket の `Upgrade` を通す設定は**入れておく**（`map $http_upgrade`） | v1 では使わないが、将来 WebSocket 化する時に nginx を触らずに済む（8.5） |

### 8.2 URL の形（sub domain か sub path）

**sub domain（hostname を 1 つ足す）**。理由: inet250 の既存 route は hostname ごとに 1 つの宛先を持つ形で（報告 8 章）、`path_prefix` も専用 hostname を持った上での使い方。sub path にすると Nuxt の `app.baseURL` と relay の `path_prefix` と nginx の `location` の 3 か所を合わせる必要が出る（`app.baseURL` が build 時設定か runtime 設定かは実装時に公式 docs で確認）。ドメインは inet250 に登録済みの zone のどれか（どれにするかは判断 9）。

### 8.3 設定例（要件の例示。202 の nginx は見られていないので適用前に確認）

```nginx
# WebSocket の Upgrade 用（v1 は使わない）
map $http_upgrade $connection_upgrade { default upgrade; '' ''; }

server {
    listen 80;
    server_name bantou.example.app;                 # 例。実名は判断 9。relay の http_host_header と一致させる

    # L2: inet250 からだけ受ける（IP は設置時に確認）
    allow 192.0.2.250;                              # 例の値。実際の inet250 の IP に置き換える
    deny  all;

    client_max_body_size 21m;                       # 添付 20MB

    location /api/ {
        proxy_pass         http://127.0.0.1:7920;   # web backend（port は例。空き未確認）
        proxy_http_version 1.1;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Host       $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering    off;                     # SSE
        proxy_cache        off;
        gzip               off;
        proxy_read_timeout 3600s;
        # Cf-Access-Jwt-Assertion は上書きせず、そのまま backend へ渡す
        include /etc/nginx/bantou-proxy-key.conf;       # 中身: proxy_set_header X-Bantou-Proxy-Key "<鍵>";（chmod 640）
    }

    location / {
        proxy_pass http://127.0.0.1:7920;           # SPA（静的ファイルを nginx 直配りにしてもよい）
        proxy_set_header Host $host;
        include /etc/nginx/bantou-proxy-key.conf;
    }
}
```

`listen 80` の block は他の vhost と同居する前提（`server_name` で選ばれる）。既定 server（`default_server`）が先に受けると、Host の合わない要求が他の app に行くので、設置時に確認する（未確認）。

### 8.4 inet250 / Cloudflare 側に要る設定（設置時の作業。値はこの docs に書かない）

inet250 の管理機能には、hostname の追加（relay の route と cloudflared の ingress）、host 用の Access application の作成、relay の許可一覧の更新、DNS の同期、cloudflared の再起動がある。以下は**やることの一覧**で、実行は設置者が確認しながら行う（この worker は照会しかしていない）。

1. hostname を決める（判断 9）。DNS は inet250 の管理機能が整える。
2. route を足す: 宛先は 202 の `:80`（`http://<202 の IP>:80`）、`http_host_header` = その hostname（既存の `http_host_header` を使う route と同形）。`path_prefix` は空。
3. Access を有効にする: 判断 11 の結果に従い、既存の Access application の `aud` を共有するか、新規に作る。
4. 許可する利用者（email）を relay の許可一覧に足す。
5. 202 の nginx に 8.3 の block を足す。送信元の許可 IP は inet250 の IP。
6. backend の env に team 名・AUD tag・許可 email を入れる（5.2）。
7. 13 章の確認項目を通す。

### 8.5 WebSocket と SSE が Cloudflare 経由で通る条件

**v1 は SSE + POST で WebSocket を使わない。** 次は、将来 WebSocket にする時と、今の SSE を安定して通すための条件。

| 項目 | 内容 | 根拠 / 状態 |
|---|---|---|
| WebSocket の idle 切断 | Cloudflare は「どちらの方向にもデータが流れない期間が一定時間続くと」接続を閉じる。**秒数は docs に書かれていない**（Enterprise は個別に変更できる） | Cloudflare 公式 docs（Network → WebSockets） |
| 対策 | クライアント側の heartbeat（ping/pong）を入れる。間隔は center の `: ka` と同じ 15 秒（`http.ts:21`）を出発点にする（秒数の根拠は無い。**推測**。設置時に idle 切断を実測して決める） | 同上（heartbeat の推奨）。15 秒は推測 |
| Tunnel / Access 越しの WebSocket | Cloudflare の WebSocket の docs は Tunnel・Access に触れておらず、通るかは**未確認** | 同上。13 章 |
| inet250 の relay を通るか | relay が `Upgrade` を中継するかは**未確認** | 13 章 |
| 長い HTTP 応答（SSE）の timeout | origin が **125 秒**応答しないと `524`（Enterprise のみ延長可）。SSE は response header をすぐ返し、15 秒ごとに `: ka` を書くので、origin から無応答にはならない。web backend も header を直ちに flush し（center は `res.flushHeaders()`、`http.ts:323`）、`: ka` を途切れさせない | Cloudflare 公式 docs（error 524）。backend の実装は設計 |
| SSE が溜まらずに届くか | Cloudflare の edge・cloudflared・relay・nginx のどこかが buffering すると、`: ka` や出力が束になって遅れる。**未確認**。設置時に実測（13 章） | 未確認 |
| 添付の大きさ | 20MB（`attachments.ts:13`）の POST が Cloudflare・relay・nginx を通るか。Cloudflare のプラン別のボディ上限は**未確認** | 13 章 |
| Access の session 切れ | Access の session 期間（application ごとの設定）を過ぎると、開いている SSE・次の fetch の挙動が変わる。**未確認** | 5.2、13 章 |

SSE が通らない（溜まる）と分かった場合の代替: (1) buffering を止める設定が各層にあるか確かめる、(2) WebSocket 化（center にも変更が要る。本設計の範囲外）、(3) 端末の更新を短い周期の取得（`after` 付きの GET）にする。どれにするかは実測後に決める。

## 9. 202 での常駐・更新・共存

### 9.1 systemd

指示は **user unit**。既存の方針とは次のように食い違う（判断 6）: bantou-server は system unit（`docs/ops/server-install.md:25`）、memory は user unit（`memory/deploy/bantou-memory.service:1`）。

例（user unit。専用 user を想定。`loginctl enable-linger <user>` が要る）。**`bantou-center` の unit は、既定の形（別に置いた center につなぐ）で、その center を web と同じ host に置く場合だけ要る**。別の host に置く、または desktop の center を指す場合は web の unit だけでよい。起動する形（6.6）では center の unit は要らず、web の unit が center を子として起動する:

```ini
# ~/.config/systemd/user/bantou-center.service
[Unit]
Description=bantou center (headless)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/bantou/packages/center
EnvironmentFile=%h/.config/bantou/center.env          # BANTOU_PTY_WRAPPER、BANTOU_PAIR_SERVER_VERSION（9.3）など（chmod 600）
ExecStart=/usr/bin/node dist/cli.js --transport http --port <port> --bind <addr> --config %h/.config/bantou/center.json
Restart=on-failure
RestartSec=5
# center は SIGTERM で子を止めるのに最大 stopGraceMs(5s)+5s かかる（daemon.ts:171-175）
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/bantou-web.service
[Unit]
Description=bantou web (BFF + SPA)
# center を同じ host の unit に置く場合のみ: After=bantou-center.service / Wants=bantou-center.service

[Service]
Type=simple
WorkingDirectory=%h/bantou/packages/web
EnvironmentFile=%h/.config/bantou-web/env             # WEB_SETTINGS_FILE, CF_TEAM, CF_AUD, ALLOWED_EMAILS, PROXY_KEY, PORT（5.2・5.5。値は書かない）。任意: CENTER_URL, CENTER_TOKEN（center 設定の remote を env で固定する時、5.5）
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- 既定の形では `bantou-web` が落ちても center と session は影響を受けない（独立）。`After=/Wants=` は起動順のみで、`Requires=` にしない。起動する形（6.6）では web が落ちると center も終わる。
- `Restart=always` ではなく `on-failure`（memory と同じ）。

### 9.2 202 で既に動いているものとの共存

| もの | port / 場所 | 衝突しないための事項 |
|---|---|---|
| bantou-server | broker 7901、mcp 7902、UDP 7902（`server-install.md:42`）。`bantou` user の HOME。system unit | center を同じ host に置くなら別 user・別 HOME・別 port。**center が同じ HOME を使うと `claude` の認証（`$HOME/.claude`）・`caps/`・`workers/` を server と共有してしまう**（`server-install.md:17`）ので、専用 user を推奨（判断 6） |
| memory | 7930（`memory.env.example:2`）、PostgreSQL 5433、Ollama 11435 | center と web は別 port（center の port は center 設定。起動する形では `port`）。7920 は**推測**（空きは未確認）。必ず `ss -tlnp` で確認 |
| nginx（202:80）| 既に他の app の relay 宛先（報告 8 章）。nginx の構成そのものは未確認 | bantou 用 `server_name` を足すだけで他 vhost を壊さない。`default_server` に取られないか確認（8.3） |
| 202 の他の port | 他の app が 202 の複数の port を使っている（一覧は公開 repo のため伏せる。inet250 の監視対象とその route 先に含まれる） | web backend の port は設置時に `ss -tlnp` で空きを確認して選ぶ（候補 7920 は推測。空きは未確認） |
| messenger | center は peer 名 `bantou-center`（`server-link.ts:327`） | 別の center を足すと desktop の center と同名（危険 R2）。server の返信先付け替え（`reports.ts:159-175`）を避けるには、web を既存の center に向ける（設定、6.5）か、並べる期間を区切る |

### 9.3 更新

- web: `git fetch && git checkout <tag>` → `bun install` → protocol/center-client/ui/web の build → `systemctl --user restart bantou-web`。SSE は切れるが、ブラウザが再接続し（`after` で続き）、**既定の形では** session は影響を受けない（起動する形では web の再起動 = center の再起動、6.6）。
- center（別に置いた center を更新する時）: 更新は **cap が空の時**に `systemctl --user restart bantou-center`（再起動で session は `--continue` で復帰するが TUI は中断される、`daemon.ts:167-194,256`）。
- **版の揃え方（危険 R1。web が指す center を新しく立てる時）**: center は組の版と違う server に `update_server` を送る（`follow.ts:213-226`、新旧は比べない）。組の版は env `BANTOU_PAIR_SERVER_VERSION` を**先に**読み、無ければ作業ツリーの `packages/server/package.json` を読む（`C/src/pair.ts:19-30`、`:36-44`）。したがって、center の unit の env（`center.env`）に `BANTOU_PAIR_SERVER_VERSION=<202 の server が今動いている版>` を置けば、**center の変更なしで**、ソースから起動した center でも server の版と揃えられる。ただし 202 の bantou-server は `latest` で自己更新する（`docs/ops/server-install.md:66-68,113-116`）ので、固定した値はすぐ古くなる。server が上がった後に値を更新しないと、center は server を**固定した古い版へ戻す指示**を出す（`follow.ts:213-226`）。→ server の更新手順に「`BANTOU_PAIR_SERVER_VERSION` の更新と center の再起動（cap が空の時）」を含める（まとまり 7）。env を置かずに、202 の center を desktop と同じ release の tag から作る方法でも揃う（その tag の `packages/server/package.json` の版が組になる）。版合わせを無効にする手段は env が未設定かつ `../../server/package.json` が読めない場合だけ（`follow.ts:205`、`pair.ts:6-7`）。
- 手順書は `docs/ops/web-install.md` に（まとまり 7）。

## 10. 実装のまとまり

1 まとまり = cap を 1 回起こして終えられる大きさ。成果物と確認方法を各まとまりに付ける。確認方法は**実在する手段だけ**を書く（desktop の e2e は `page.screenshot` で画像を保存するだけで、画像の自動比較は無い: `D/e2e/board.spec.ts:33`、`D/e2e/login.spec.ts:72` ほか。見た目の同一性は `D/CLAUDE.md` Review check 手順 4 のとおり、保存された画像を**人が見て**確かめる）。**202 と inet250 に触れる作業はこの一覧のどのまとまりにも入れない**（設置者の作業として 13 章に出した）。

### 10.1 依存の一覧

| まとまり | 先に終えておくもの | 並走できるもの |
|---|---|---|
| 1 | なし | 3a |
| 2a | 1 | 3a |
| 2b | 2a | 3a、3b、3c、3d、4a、4b |
| 3a | なし | 1、2a、2b、3b、3c、4a |
| 3b | 2a | 2b、3a |
| 3c | 3b | 2b、3a、4a |
| 3d | 3a、3c | 2b、4a、4b |
| 4a | 3b | 2b、3a、3c |
| 4b | 3a、4a | 2b、3c、3d |
| 5a | 2b、3d | 4a、4b |
| 5b | 4b、5a | 5c |
| 5c | 5a（3d の設定 command を使う） | 5b、4a、4b |
| 6a | 5b | 7、8 |
| 6b | 6a（同じ `TerminalView` を触るため直列） | 7、8 |
| 7（docs のみ） | 3d、4b | 5a〜5c、6a、6b |
| 8（center の変更） | なし | 全部（効果の確認だけが設置後） |
| S（center を起動する形。**v1 の後**） | 3c、3d、5c | — |
| (M)（desktop を共有 package に寄せる。**任意・後**） | 3c、4a、S（desktop が起動する形を使う場合） | — |
| (9)（Cork。任意・後） | 5b | — |

- **v1 = 1〜8（16 まとまり）**。既定の形（接続設定）は 2a → 3b（共有 package と設定）→ 3c（MCP・cache・events）→ 3d（設定 command と中継の route）→ 4a・4b（端末）→ 5a（一覧）で動き始める。S は v1 の後に、同じ設定の `enabled` を有効にする形で足す（S を足すまで `enabled` の保存は拒否される、5.5）。
- 8 の流れ: 8 → desktop の release → 設置先の center の入れ替え → 13 章 15（設置後の実機確認）。他のまとまりはこれを待たない。
- 6a・6b は 8 に**依存しない**（center にサイズの口が無くても方式 B で動く作りにし、口がある場合の挙動は偽 center で確かめる）。8 の効果の確認は設置後（13 章 15）。
- 2a は import の書換と移動だけにとどめる（切り戻し点）。2b 以降で問題が出ても 2a の状態へ戻せる。
- 3b は 2a の後、3c・4a は 3b の後（契約の型を `packages/ui` の `types` から `import type` で使うため。`types` は Nuxt/Tauri の実行時依存を持たない純粋な TS で、`center-client` が layer に依存するのではなく型だけを参照する）。3b 以降は desktop の整理（2b）や web の守り（3a）と並走できる。

### 10.2 一覧

| # | まとまり | 依存 | 成果物 | 確認方法 |
|---|---|---|---|---|
| 1 | **Tauri 依存の集約（desktop 内、挙動不変）** | なし | `D/src/tauri/transport.ts`。`~/api` の外にある Tauri import 7 箇所（報告 1.4）を transport 経由に。`api/*.ts` は `invoke`→`getTransport().invoke`。platform 機能（updater と `relaunch`・open・drop・log・fs 監視・drag region、3.2）を 1 か所の interface に | `grep -rn "@tauri-apps" D/src` が `D/src/tauri/` だけを指す。`nuxt typecheck`。mac200 で desktop の e2e 全通過（`D/CLAUDE.md`） |
| 2a | **`packages/ui` の抽出（layer 化と import 書換のみ。ここが切り戻し点）** | 1 | `packages/ui`（`package.json` を含む private package。components / composables / types / assets / api）。desktop は `extends: ["../ui"]`。`~/` の 47 箇所を相対 / named alias に書換（Nuxt 公式 docs: layer 内の `~/` は利用側 project 基準）。**ビルドへの影響の確認**: `D/src-tauri/tauri.conf.json:9-10` の `beforeBuildCommand`（`bun run build:sidecar && bun run generate`）と `frontendDist`（`../.output/public`）は desktop で実行・出力されるため変更不要の見込み（**推測**。layer の assets が `.output/public` に入ることを確認する）。`pages/index.vue` と `AppHeader` は desktop に残す。**他は変えない**（挙動・構造の変更は 2b 以降） | desktop の `nuxt typecheck`・`nuxt build`、`bun run generate` の出力（`.output/public`）が layer 化前と同じ構成であること（file 一覧の比較）、mac200 の e2e 全通過、`bun run tauri build` が通る（`D/CLAUDE.md`）。**見た目は e2e が保存する画像（`board.png` ほか）を、layer 化の前後で人が見比べる**（自動比較は無い） |
| 2b | **`pages/index.vue` のロジック分離と文書更新** | 2a | 選択・フィルタ・ダイアログ管理（`pages/index.vue:62-158`）を composable（`useSessionBoard` 相当、`packages/ui`）に出し、desktop の 3 カラムはそれを使う。root `CLAUDE.md` の Map と役割分離の節を更新（`packages/ui` と `packages/center-client`、R15） | `nuxt typecheck`、mac200 の e2e 全通過、保存された画像を人が見て 2a と同じ見た目であること。`pages/index.vue` の行数が減り、選択・フィルタの state が composable に移っていること（diff で確認） |
| 3a | **web backend: 守り（JWT・共有鍵・Origin・`/api/me`）** | なし | `packages/web/server/`: **Access の JWT 検証（5.2 の L3。署名・aud・iss・exp、鍵の cache、許可 email）、L4 の共有鍵照合、Origin 検査、`GET /api/me`**（login/cookie は持たない）と、これらを全 route に掛ける middleware。node の test | `node --import tsx --test`（`C/package.json` の test と同じ流儀）で: **JWT 無し・署名違い・aud 違い・期限切れ・許可外 email は 401/403（test が生成した偽 JWKS で署名）**、鍵ローテーション（未知の `kid` で 1 回だけ取り直す）、共有鍵が無い・違う要求は 403、POST の `Origin` が違えば 403、`/api/me` が email を返す |
| 3b | **`packages/center-client`: 新設と設定（共有の核 その 1）** | 2a | 新設 package（5.6。framework 非依存。契約の型は `packages/ui` の `types` から `import type`）。**設定**: `CenterSettings` の検証・正規化・`select_target`・file 保存（一時 file→rename、chmod 600）・env の上書き（`CENTER_URL`/`CENTER_TOKEN`）・secret を伏せた読み出し（5.5）。型の差（`bind` を optional、`tokenSet`・`remote.tokenSet` を optional で足す）は `packages/ui` の `types` に optional で足す（desktop の応答型は従来のまま）。注入点（`settingsStore` `policy` `redactSecrets`）。Rust の既存 test の入力・期待値を TS の test に写す（出典 file:line を記す、5.6 #5） | `node --import tsx --test` で: `select_target` が enabled／remote／無しの 3 通りで報告 9 章どおり、`normalize_remote` の表（`center_mcp.rs:878-892`）の全行、validate の拒否（port 範囲・workspace・claudePath・token 12 文字・remote の scheme）、`enabled:true` の保存は「未対応」で拒否（S まで）、get が token を返さず `tokenSet` を返す、set で token 空は据え置き・**remote.url を変えると token を引き継がない**、env 設定時は変更不可。`packages/center-client` が Nuxt/Nitro/Tauri を import していない（grep） |
| 3c | **`packages/center-client`: MCP client・SessionCache・events（共有の核 その 2）** | 3b | **MCP client**（404 で 1 回だけ再 initialize、`center_mcp.rs` と同じ働き。接続先は 3b の `select_target` を呼び出しごとに引く）、**SessionCache**（`rev`、`reachable:false`）、**events の購読**（`center_events.rs` と同じ働き）。`policy.allowTool` の注入 | `node --import tsx --test` で偽 center に対し: center 停止中は `reachable:false`、再起動後に再 initialize（404→1 回だけ）、`rev` が単調増加、設定 file を書き換えると次の呼び出しから新しい宛先に向く、`policy` が false の tool は呼ばない |
| 3d | **web backend: 設定 command・中継の route** | 3a、3c | `packages/web/server/`: 許可 tool 一覧（5.3）、`/api/rpc/:cmd`（`center_get_settings` ほか center 設定 command と中継 command。実処理は `center-client` の handler）、`/api/events`（center-client の events を全ブラウザへ fan-out）、`/api/health`（接続先が無い・到達不可の理由）、設定の変更を受けるかの gate（判断 14。既定は読み取りのみ）。**この段階で UI は不要** | `node --import tsx --test` で（偽 center + 3a の middleware）: 許可外 tool は 404、設定 get の応答（`/api/rpc/center_get_settings`）・`/api/health`・ログに token が出ない、gate が閉じている時の `center_set_settings` は拒否、接続先無しで backend が起動し health が理由を返す、events が 2 クライアントに配られる。S の後は `center_status`・`center_regenerate_token` の応答にも token が無い（S の確認方法） |
| 4a | **`packages/center-client`: 端末の module** | 3b | 出力 stream の購読と再接続、`input`/`resize`/添付（`terminal.rs`・`attachment.rs` と同じ働き。45 秒無音で切る、指数待ち）。検査（base64、cols/rows 1〜1000、画像型・20MB）。web の route 無しで単体 test できる形 | 実 center（`C/scripts/e2e.ts` の流儀）に対し、center-client だけで: 出力が届く、切断→`after` で続きが来る、`reset` が伝わる、20MB 超は拒否、2 購読が同時に動く |
| 4b | **web backend: 端末の route** | 3a、4a | `packages/web/server/` の route: `/api/sessions/:n/output`（SSE 中継、`Last-Event-ID`/`after`、header の即 flush、`: ka`、`X-Accel-Buffering: no`）、`input`/`resize`/`attachments`。検査の二重化 | 実 center に対し route 経由で: 出力が届く、切断→`after` で続き、20MB 超は 413、2 クライアント同時購読。curl で SSE を確認。3a の守りが全 route に掛かる |
| 5a | **web frontend: 足場・HTTP transport・一覧** | 2b、3d | `packages/web`（`package.json`、`nuxt.config.ts` で `extends: ["../ui"]`、plugin で HTTP transport を登録）、HTTP transport（`/api/rpc/:cmd` と `/api/events`）、**Access の session 切れの検知（SSE 失敗が続けば `/api/me` を呼び、失敗なら再読込）**、session 一覧 page（mobile-first、共有 composable を使う）、「接続先が無い」状態の表示、e2e の土台（`packages/web/playwright.config.ts`、test 用の偽 JWKS と JWT 署名 helper） | Playwright（`devices` のスマホ幅）で、実 backend（偽 JWKS + 署名済み JWT）+ 実 center に対し: 一覧が出る、JWT 無しは何も出ない、JWT を失効させると再読込の経路に入る、接続先無しで「接続先が無い」が出る。e2e は mac200 で（`D/CLAUDE.md` 方針）。**「web だけ dev で backend モック」は却下済み**（`docs/handoff.md:18`）なので実 backend で行う |
| 5b | **web frontend: 端末 page・server/cap のカード** | 4b、5a | HTTP transport の端末系: `session_output_start/stop`（`EventSource` で `session-output` / `session-output-status` を再現、`useTerminalStore` は無変更）、**`session_input` / `session_resize`（JSON を `POST /api/sessions/:n/input|resize` へ。5.1 の個別 route）、`session_attach_bytes`（`Transport.invoke` の `body: Uint8Array` を、画像の Content-Type で `POST /api/sessions/:n/attachments` へ。3.2）**、端末 page（共有 `TerminalView` をそのまま使う最小版）、server・cap のカード（共有の `CenterDialog` / `RemoteActivity` の部品）、`docs/architecture.md` に web 節 | Playwright で: 端末に出力が出る、入力が center の `input` に届く、2 つのブラウザで同じ session の出力が両方に出る、cap カードが `remote_list` の内容を出す |
| 5c | **web frontend: 設定画面（接続先 center）** | 5a | 共有 `SettingsDialog`（`packages/ui`）に「web モード」の分岐（platform 機能として注入。5.5 の 2）を足し、web では「接続先 center」の欄（url・token の設定済み表示・接続状態）だけを出す。起動系の欄・「この PC の center を起動」ボタンを出さず、`centerStatus`・`centerLocalIps`・`centerIpStatus` を呼ばない。desktop の表示と呼び出しは不変（注入の既定が desktop の現状）。判断 14 が「変更を受ける」の場合の入力欄（token は書き込みのみ、url 変更時は token を同時入力） | Playwright（web）で: 設定画面に token が出ない（画面・DOM・ネットワークの応答。S の後は `center_regenerate_token` の応答も）、web モードで 404 になる呼び出しが無い（ネットワークに `center_status`・`center_local_ips`・`center_ip_status` が出ない）、起動スイッチ・port・IP の欄が無い、既定（変更不可）では入力欄が無効、`CENTER_URL` 固定時は「env で固定」表示。**desktop の e2e（`D/CLAUDE.md` の手順）が全通過し、保存画像で設定ダイアログの見た目が変わらない**ことを人が確認 |
| 6a | **スマホの端末 UX（入力）** | 5b | 特殊キー列、入力欄（IME 区別。bracketed paste は先に偽の pty で実測し、結果を 7.2 に追記）、入力のまとめ送り（数十 ms。`session_input` の POST を束ねる） | Playwright のスマホ emulation で: 特殊キーが所定のバイト列を送る（center の `input` で受信）、入力欄の送信で本文 + `\r`、まとめ送りで連続入力の POST 回数が減り、順序と内容が保たれる。実機の確認は設置後（13 章 16） |
| 6b | **スマホの端末 UX（表示・添付・幅）** | 6a | `visualViewport` 追従、ファイル選択による添付（`<input type=file>` の `File` を 5b の `session_attach_bytes` で送る。web では `session_attach_paths` / `session_attach_pick` を使わない）、`visibilitychange` での再取得、サイズ方針: **center にサイズの口が無い（404）時は方式 B（開いたら幅を送る）で動く**。口がある時の方式 A の挙動は偽 center（口を持つ）で実装・test する | Playwright のスマホ emulation で: 添付が保存され path が pty に打たれる、**口が 404 の center で B として動く**、口がある偽 center で A として動く（開いただけでは `resize` を送らない）、`visibilitychange` 後に一覧と端末が取り直される。cap の完了条件はここまで。**スマホ実機の確認と、実 center での A の確認は設置後の項目**（13 章 15・16） |
| 7 | **deploy の手順書（docs のみ）** | 3d、4b | `docs/ops/web-install.md`、unit の雛形（web。center を同 host に置く場合の center の unit も）、設定 file の雛形（`center` キーの `remote`。値は書かない）、`env` の雛形（`WEB_SETTINGS_FILE` / `CF_TEAM` / `CF_AUD` / `ALLOWED_EMAILS` / `PROXY_KEY`、任意で `CENTER_URL` / `CENTER_TOKEN`。値は書かない）、nginx の block（8.3）、inet250 側の登録手順（8.4。実行は設置者）、更新手順（`BANTOU_PAIR_SERVER_VERSION` の扱いを含む、9.3）、R1 を避ける tag の指定方法、**13 章の確認項目を手順書の確認欄に 1 対 1 で転記**。**成果物は docs のみ。設置先と inet250 への実測や適用は含まない** | 手順書の確認欄が 13 章の全項目と対応していること（突き合わせ）、unit の雛形は `systemd-analyze verify` にかけられる範囲でかける（結果を記録。かけられない環境なら未実施と明記）、nginx の block は `nginx -t` を一時 config でかける（nginx が無ければ未実施と明記）。**設置先と inet250 への適用・実測は設置者の作業で、結果は 13 章の表に記録する** |
| 8 | **center: pty の今のサイズを返す口**（判断 3 が A の時だけ） | なし | `packages/center` の `http.ts` に `GET /sessions/<n>/size`（Bearer、`core.size` を返す。無ければ 404 か null）と README・test | `C/test/http.test.ts` の流儀で: 認証なしは 401、未登録 session は 404、`resize` の後に同じ値が返る、実行中でない session の扱い。`npm test`（`C/package.json`） |
| S | **center を起動する形（`enabled`）— v1 の後** | 3c、3d、5c | `packages/center-client` の `process` module（起動・監視・停止・設定反映、6.6）、`enabled` の保存の解禁、`center_status`・`center_regenerate_token` の command と許可、設定画面の起動の欄。web backend の SIGTERM で center を止める | `node --import tsx --test` で偽の center プロセスに対し: `enabled` で起動し loopback の宛先を選ぶ、異常終了で 2 秒から倍々に再起動し 10 分に 5 回超で断念（`center.rs:44-55` の表を写す）、設定の起動項目が変わると再起動・`remote` だけ変わっても再起動しない、web の終了で子が止まる。実 center で web backend を止めると center も終わり、再起動後に session が `--continue` で復帰する（13 章 21）。`center_status`・`center_regenerate_token` の応答・DOM に token が無い（regenerate は `tokenSet` だけ） |
| (M) | 任意・後: desktop を `center-client` に寄せる | 3c、4a（S） | 5.6 の「必要なこと」1〜6。fixture の共有化、2 つ目の sidecar、HTTP transport 化、Rust の撤去 | desktop の release 前 e2e（`D/CLAUDE.md`）。**着手は利用者の判断後**（desktop の変更を伴うため） |
| (9) | 任意・後回し: Cork の task / thread を web に | 5b | 判断 5 の結果次第 | 別途 |

**center の変更（まとまり 8）が設置先の center に届くまでの順序**（8 以外の作業はこれを待たない）: center は desktop の release に同梱され（`D/scripts/build-sidecar.ts:81-99`）、web が指す center を新しく立てる場合は R1 により desktop と同じ release の tag から作る必要がある。したがって次の順になる。
1. まとまり 8 を develop に入れる
2. desktop を release する（`D/CLAUDE.md` Release。mac200 で e2e・署名・publish。利用者または release 担当の作業）
3. その tag から、web が指す center を作り直して入れ替える（cap が空の時、9.3。設置者の作業）
4. 13 章 15 で「幅を送らない表示」を実機で確認する

3 の前は、web は center にサイズの口が無いので方式 B にフォールバックする（まとまり 6b の完了条件）。

各まとまりの「完了の定義」: そのまとまりの確認方法を満たし、`bun install` の差分（`bun.lock`）を含む変更が 1 branch にまとまること。version bump は実装担当ではなく release 手順で（`D/CLAUDE.md`）。

## 11. 利用者の判断が要る点

各点は「選んだ結果、利用者に何が違って見えるか」で書く。**推奨を先頭**に置き、理由を 1 行。

**取り下げ（利用者が決めた前提）**: 初版の判断 1「外から使えるか、LAN 内だけか」は**外から使う**で確定、判断 4「login の手間」は**認証は Cloudflare（inet250）に任せ、web 独自の login を作らない**で確定したため外した。判断 12（LAN 内から直に開いて入れるか）も、聞く項目ではなく設置時の実測で決まる設計事項のため 5.2 と 13 章に移した。番号は参照が崩れないよう欠番にし、新しい判断は 11・13 とした（12 も欠番）。

**2026-11-12 の改訂**: 利用者の方針（冒頭）により、**判断 2（スマホで見る session をどこで動かすか。「新しい center を置き desktop を切り替える」が推奨）を取り下げた**。web がどの center につなぐかは設定（5.5）で決まり、既定は「起動しない＋接続設定」。center の置き場は設置者が設定で決める。判断 13 は「center が LAN 内の別 host にあり、web backend や desktop がそこへ入る場合」だけの条件付きに書き直した。判断 3・6・7 は center の置き場に依存する言い方を直した。判断 14 を足した。

### 判断 2: （取り下げ）
- 方針 4 により前提でなくなった（「どこで動かすか」は center 設定で決まる。5.5・6.1）。desktop と web を同じ center に向ける時の切り替えと注意は 6.5。

### 判断 3: スマホで開いたとき、mac で見ている端末の画面が崩れるか
- **推奨: 崩れない（スマホは既定で見るだけ。打ち始めたときだけ幅が変わる）。** 理由: 見るだけで mac の画面が狭くなるのを避けられる。
- A（推奨）: スマホを開いても mac の画面は崩れない（desktop と web が同じ center を指している場合）。スマホは mac と同じ幅で描かれるので横スクロールで見る。打ち始めると mac 側も狭くなる。**使えるようになるまでに追加の作業と時間がかかる**（desktop の新しい版の配布と、web が指す center の入れ替えを経る、10 章の順序）。それまでは B と同じ動きになる。
- B: スマホで開いた瞬間に mac の画面も狭くなる（最後に幅を送った端末に合わせる仕組み）。すぐ使える。スマホ側は崩れず読める。
- 必要な追加作業の中身は 7.2 と 10 章（まとまり 8）に移した。

### 判断 5: Cork の task・thread を web でも見るか
- **推奨: v1 は見ない（session・server・cap の状態と端末だけ）。** 理由: web と mac の desktop が同じ返答待ちを取り合い、共有の messenger に同じ名前で二重に入れない（`docs/handoff.md:16`）。
- A（推奨）: スマホには「返答待ち thread」「task 一覧」が出ない。それらは今まで通り mac の desktop で見る。
- B: スマホにも出す。mac の desktop と同時に動かすと衝突するため、別のまとまり（10 章の (9)）として後でやる。

### 判断 6: host を再起動した後に自動で戻るか／既存の server と作業場所が混ざるか（web または center を常駐させる host で）
- **推奨: 専用の利用者で動かし、「再起動後に戻る設定」を設置手順で必ず確認する。** 理由: 既存の server と認証・作業場所が混ざらず、戻らない事故は確認項目で防げる。
- A（推奨）: 専用の利用者で動かす。**戻る設定を 1 つ忘れると、host の再起動後に戻らない**（既存の server がこの事故を理由に別の形を選んでいる、`docs/ops/server-install.md:25`）。設置手順の確認項目で防ぐ。
- B: OS が全体として管理する形で動かす（既存の server と同じ）。host の再起動後は必ず戻る。設置に管理者権限が要り、専用の利用者を別に作らないと既存の server と作業場所が混ざる。
- C: 既存の server と同じ利用者で動かす。設定は少ないが、claude の認証と作業場所が server と混ざる（`server-install.md:17`）。非推奨。
- 各案の systemd 上の形（user unit + linger / system unit）は 9.1 に移した。

### 判断 7: 更新で session が止まるか
- **推奨: web は随時更新、center は cap が空の時だけ更新。** 理由: 既定の形では web を再起動しても session は続く（center を起動する形では web の再起動で center も止まる、6.6）。center を止めると TUI が中断される（再開は `--continue`）。
- A（推奨）: web の更新ではスマホの接続が一瞬切れるだけで、自動で続きから再接続する。center の更新時は端末が一度止まって再開する。
- B: 一括更新（center と web を同時）。手順は単純だが、毎回 session が中断される。

### 判断 8: スマホに通知が来るか
- **推奨: v1 は通知なし（開いた時に一覧で「判断待ち」が見える）。** 理由: Web Push は service worker と PWA 化が要り（HTTPS は Cloudflare 側で満たされる）、iOS は「ホーム画面に追加」した PWA でのみ使える（一般仕様。**推測**: 本設計では未検証）。Cloudflare Access の認証と PWA の相性（Access の login 画面を PWA が扱えるか）も未確認。
- A（推奨）: 判断待ち（`needs-input`）になっても通知は来ない。気づくには開く。
- B: Web Push で「判断待ち」「cap が lost」を通知。PWA 化が前提で、Access との相性の確認が要り、まとまりを 1 つ足す。

### 判断 9: URL のドメイン名（どの hostname で開くか）
- **推奨: 既存の zone の下に専用 hostname（`bantou.<既存のドメイン>` の形）。** 理由: 他の app も zone ごとに専用 hostname を持つ運用で（報告 8 章）、Access や DNS の手順が同じで済む。どの zone にするかは利用者が決める。
- A（推奨）: 例えば `https://bantou.<ドメイン>/`。sub domain なので URL に path は付かない（8.2）。
- B: 別の zone を選ぶ。見た目が違うだけで機能は同じ。
- 登録済み zone は inet250 の管理機能で確認できる。新しいドメインを足すのは別作業。

### 判断 10: スマホから取り返しのつかない操作ができるか
- **推奨: server の退役（不可逆）はスマホに出さず、session の停止・改名などは確認画面つきで出す。** 理由: 退役は印が残り戻せない（`docs/ops/server-install.md:133-143`）ので、誤タップの被害が最も大きい。
- A（推奨）: スマホの画面に「退役」の操作は無い（desktop でだけできる）。session の作成・改名・停止・再起動は出るが、押すと確認画面が挟まる。
- B: スマホにも退役を含め全て出す（確認画面つき）。外出先から server を外せるが、Access を通れる端末（盗まれたスマホなど）の被害も大きい。外から使う前提では、A を推奨する理由が強まる。
- C: スマホは閲覧と端末への入力だけ。作成・改名・停止もできない。誤操作は最小だが、session の追加や再起動に mac が要る。

### 判断 11: web を開く人の許可を、既存のサービスと一緒にするか分けるか
- **推奨: 分ける（web 専用の許可にする）。許可する人は今のところ既存と同じ人。** 理由: web を開ける人は 202 で claude を動かせるので、既存サービスの閲覧者と権限が同じとは限らず、web だけ後から増減できる。
- A（推奨）: web 専用。web を開くときに、既存サービスとは別にログインが 1 回増える。許可する人は web だけで増減できる。
- B: 既存のサービスと共用。既存でログイン済みなら追加のログインなしで開ける。許可する人を増減すると他のサービスにも及ぶ。
- どちらでも、許可する人は backend 側にも持つ（5.2 の L3）。application / `aud` の扱いは 8.4 に移した。

### 判断 13: center が LAN 内の別 host にある時、web backend や desktop から入るとき token が LAN に平文で流れてよいか
- 対象: web backend → 別 host の center（既定の形で center を別 host に置く場合）、および desktop が同じ center に入る場合。web と center が同じ host で loopback を使う場合は対象外。
- **推奨: 流さない（LAN の中でも暗号化して入る）。** 理由: token は center で claude を動かす鍵で、LAN の他の機器から読めてしまう形は避けたい。
- A（推奨）: 暗号化して入る。`remote.url` は https の URL。center を置く host に LAN 用の証明書が要り、つなぐ側（web backend の Node、mac の desktop）がそれを信頼する必要がある（私的な認証局を使うなら登録が要る。**推測**）。設置の作業が増える。
- B: 平文のまま入る（今の desktop が自分の center に入る形と同じ）。設置は簡単だが、同じ LAN の他の機器が token を盗み見られる。
- この判断が要らない場合: web と center が同じ host（loopback）／desktop は自分の sidecar center を使う／center を web が子として起動する形（6.6）。
- どちらでも外（インターネット側）の経路は変わらない。desktop を外から web と同じ center につなぐ経路は本設計に含まない（6.2）。技術的な内訳は 6.2 と 8.1 の注に移した。

### 判断 14: 設定画面から、web が指す center（url・token）を変えられるか
- **推奨: v1 は変えられない（画面は現在の接続先と状態の表示まで。変更は設定 file か env）。** 理由: Access を通れる端末（盗まれたスマホなど）で接続先を差し替えられたり、起動する形で center を止められたりするのを避けられる。接続先の変更は頻繁ではなく、設置者が file で直せる。
- A（推奨）: 画面では見るだけ。接続先を変えるには設置者が設定 file（か env）を編集する。desktop の設定ダイアログと同じ表示だが、保存はできない。
- B: 画面で変えられる（desktop と同じ）。スマホだけで切り替えられる。url を変える時は token も入れ直す（既存の token を別の宛先へ送らないため）。Access を通れる人は center の全操作を持つ（R25）。接続先の差し替えが外から起こせるようになるが、url を変えると token を引き継がないので、既存の token を別の宛先へ送る経路は作らない（R29）。
- どちらでも token は画面に出ない（5.5）。まとまり 5c の入力欄の有無とまとまり 3d の gate が変わる。

## 12. 危険と未確定の点

| # | 内容 | 根拠 | 区分 |
|---|---|---|---|
| R1 | web が指す center を新しく立てて desktop の center と別の commit から作ると、同じ bantou-server に、desktop の center と別の版を `update_server` で指示することになる（新旧は比べない）。server は cap が空になるのを待つ。その center は desktop と同じ release tag から作る必要がある。既存の center を指すだけなら起きない。既に複数の desktop（mac200 など）が同じ server に指示している運用なら、これは新しい種類の危険ではなく、増える center が 1 つ（推測: 同じ broker・同じ server を見ている場合）。env `BANTOU_PAIR_SERVER_VERSION` で組の版を固定する方法もある（9.3。固定値は server の自己更新で古くなる） | `C/src/follow.ts:195-226`、`C/src/pair.ts:19-44`、`docs/architecture.md:35` | 事実（挙動は未実測） |
| R2 | 同名 peer `bantou-center` の center が同じ broker に複数いる時、center 再起動で peer id が変わると、server が同名の最後の登録に返信先を付け替える。web を desktop と同じ center に向ければ center は 1 つで起きない（6.5）。別の center を足した場合と、他の desktop が center を常駐させている場合（`docs/architecture.md:10`）だけ | `C/src/server-link.ts:327`、`packages/server/server/utils/bantou/reports.ts:159-175` | コードの読み（実挙動は未測定） |
| R3 | pty サイズは最後に送った端末が勝つ。スマホで開くと mac 側が狭くなる。pty の今のサイズは HTTP に出ていない | `C/src/core.ts:38,99-105`、`D/src/components/TerminalView.vue:154-157` | 事実 |
| R4 | center は Bearer のみ・平文・CORS 無し。token = 全操作。ブラウザに置けず、LAN を平文で流れる。外から使う前提では、web backend だけが Bearer を持つ（5.2、5.5）。center を起動する形では 127.0.0.1 に bind して外向け経路に出さない（6.6）。別に置いた center の bind と経路は置き場次第（6.2） | `C/src/http.ts:89-93,392-397`、`C/README.md:37` | 事実 |
| R5 | 共有 component のままだと、スマホの画面から `server_retire`（不可逆）・`rc_start/rc_stop` が呼べてしまう。許可リストと画面の両方で絞らないと、画面だけ隠しても backend が通す | `docs/ops/server-install.md:133`、`D/src/components/CenterDialog.vue:172` | 事実。判断 10 で決める。許可リストから外し、画面は prop で出し分け |
| R6 | center は親プロセスが変わると自分で終了する。別に置いた center では systemd 直下の ppid が安定するかは実測していない。shell/npx 経由だと落ちる恐れ。起動する形（6.6）では web backend が親になる（R30） | `C/src/daemon.ts:238`、`C/src/parent-watch.ts:13-20` | 事実（systemd 下の挙動は推測） |
| R7 | center の停止・更新で全 session の TUI が中断される（復帰は `--continue`） | `C/src/daemon.ts:167-194,256` | 事実 |
| R8 | 入力はキー 1 回ごとの POST。モバイル回線で遅延が出る | `D/src/components/TerminalView.vue:182`、`D/src-tauri/src/terminal.rs:340` | 事実。まとめ送りで緩和（効果は推測） |
| R9 | スマホのバックグラウンドで SSE が止まる | — | 推測。`visibilitychange` で再取得（実機確認） |
| R10 | layer 内の `~/` は利用側 project 基準。47 箇所の書き換えを誤ると desktop が壊れる | Nuxt 公式 docs（layers）、`D/src` の grep 47 件 | 事実（公式 docs） |
| R11 | wrapper（Rust）が center を置く host で必要。その host の arch と toolchain は未確認 | `C/src/wrapper.ts:4-7`、`D/scripts/build-sidecar.ts:51-62` | 未確認 |
| R12 | service から claude が見つからない恐れ（login shell を通らない） | `C/src/claude-path.ts:54-84` | 推測。`remoteControl.claude` を明示 |
| R13 | 7920 などの port が 202 で空いているか | `server-install.md:42`、`memory.env.example:2` | 未確認 |
| R14 | xterm の日本語 IME・`visualViewport`・ファイル選択はスマホ実機で未確認。bracketed paste を claude の TUI が解釈するかも未検証 | — | 推測 |
| R15 | 共有 UI を `packages/ui` に、center とつなぐ共有実装を `packages/center-client` に置くことが、root CLAUDE.md の役割分離（共通物は root の `docs/` と `packages/plugin/` に置く）と文言上ぶつかる | `CLAUDE.md` 役割分離ルール | 事実。まとまり 2b で CLAUDE.md を更新（利用者へ報告） |
| R16 | e2e は mac200 でのみ実行する方針。web の e2e も mac200 で回す前提になり、実 backend + 実 center の準備が要る | `D/CLAUDE.md` Review check | 事実 |
| R17 | Cork 系 command は web に出さないが、`useBoard` は Cork 側 event（`threads-changed` 等）も listen する。web transport では来ないだけで害は無いが、不要な listener が残る | `D/src/composables/useBoard.ts:201-209` | 事実（影響小） |
| R18 | center の MCP session は 30 分で失効・同時 32。ブラウザ台数が増えても backend が 1 本だけ持てば上限に当たらないが、失効時の 404→再 initialize を実装しないと一覧が止まる | `C/src/http.ts:34,36`、`D/src-tauri/src/center_mcp.rs:8-12` | 事実 |
| R19 | 既にスマホから使える経路（Claude モバイル / claude.ai/code）が master-cap にある。web 版は置き換えでなく bantou 固有画面（server・cap の状態、添付、設定）を足すもの | `docs/architecture.md:15-19`、`C/src/wrapper.ts:144` | 事実。利用者が価値を判断 |
| R20 | 202 の nginx の構成は見られていない。8 章の設定例は要件の例示で、適用前に確認が要る | — | 未確認 |
| R21 | JWT（`Cf-Access-Jwt-Assertion`）が cloudflared → relay → nginx → backend に届くか。relay が header を落とすと L3 が成立せず、L2（送信元制限）だけになる | Cloudflare 公式 docs（cloudflared が JWT を検証して origin へ渡す、header 名）。relay の挙動は観測できていない | 未確認（13 章） |
| R22 | Cloudflare・cloudflared・relay・nginx のどこかが SSE を buffering すると、端末が遅れる／束になる。WebSocket が Tunnel・Access・relay を通るかも未確認 | Cloudflare 公式 docs（WebSocket の idle 切断、秒数なし。524 は 125 秒） | 未確認（8.5、13 章） |
| R23 | Access の session 期間が切れた後の SSE・fetch の挙動（redirect で失敗に見える）。SPA が無限に再試行して端末が止まったように見える恐れ | — | 推測（13 章で実測） |
| R24 | backend が Access の鍵を取るため、202 から `<team>.cloudflareaccess.com` へ出る通信が要る。出られないと全要求が検証できず 401 になる | Cloudflare 公式 docs（certs の URL）、`server-install.md:41`（202 の外向き通信の既存要件の書き方） | 未確認（202 の egress） |
| R25 | 外から使う前提では、Access の許可一覧 = 202 上で claude を動かせる人の一覧になる（session の `permissionMode` は center の設定、`C/src/config.ts:8-15,53`）。許可者の管理が実質 shell 権限の管理になる | `C/src/config.ts:8-15,53`、`C/src/http.ts:392-397` | 事実。判断 11 |
| R27 | nginx を飛ばして 202 上のプロセスが backend の loopback port に来る（cap・worker は `claude -p`。Bash 権限は推測）。L2・L3 では防げない場合がある。共有鍵 header（L4）で防ぐ。鍵が nginx の設定 file を読める user に見える | `docs/architecture.md:27,31`、5.2 | 事実（cap の Bash sandbox 無効）+ 推測（worker の権限）+ 設計 |
| R28 | center の token がブラウザに出る経路が増える: 設定の読み出し（desktop の `center_get_settings` は token を返す、`SettingsDialog.vue:405`）を共有 component がそのまま表示する、ログやエラー文に url の userinfo が出る | `D/src/components/SettingsDialog.vue:403-422`、5.5 | 設計で対処（応答で伏せる。S の `center_regenerate_token` の戻り値も捨てる）。3d・5c・S の確認方法に入れる |
| R29 | 設定の書き込みで `remote.url` を差し替えられると、保存済みの token が別の宛先へ送られる | 5.5 | 設計で対処（url が変わる時は token を引き継がない）。判断 14 の既定で書き込み自体も閉じる |
| R30 | 起動する形（6.6）では web backend の再起動・停止が center の終了になり、全 session の TUI が中断される（親が変わると終わる性質） | `C/src/daemon.ts:238`、`C/src/parent-watch.ts:13-20`、`D/src-tauri/src/lib.rs:197-199`（desktop も終了時に止める） | 事実（性質）。S は v1 の後。session を止めたくない運用は既定の形 |
| R31 | 共有 package（TS）と desktop の Rust が、(M) までは別実装で、挙動がずれる恐れ（`normalize_remote` `select_target` など） | 5.6 | 設計で対処（Rust の test の入力を TS の test に写す。(M) の最初に fixture を共有） |
| R26 | relay の route の `allow` 一覧と backend の `ALLOWED_EMAILS` と Access の policy の 3 か所に許可者が散る。片方だけ更新して食い違う | relay の管理 API の読み取り照会（`allow`）、5.2 | 事実（運用）。13 章で一覧化 |

## 13. 設置の時に確かめる未確認の項目

inet250 / Cloudflare / 202 の構成は、この worker は管理 API の読み取り照会（報告 8 章）と Cloudflare 公式 docs でしか見ていない。次を設置の時に**1 つずつ実測**し、結果を `docs/ops/web-install.md` に記録する。合格条件は観測できる形で書く。

| # | 確かめること | 合格条件 | 関連 |
|---|---|---|---|
| 1 | Cloudflare の team 名と、web 用 Access application の AUD tag | backend の env に入れた値で、本物の JWT の `aud` / `iss` が一致する | 5.2、判断 11 |
| 2 | `Cf-Access-Jwt-Assertion` が backend まで届くか（cloudflared → relay → nginx → backend） | backend が受けた request に header がある。**無ければ 5.2 の代替（L2 + L4 のみ、または relay を飛ばす）に切り替える**。この切り替えは設置者が実測で決める | R21、5.2 |
| 3 | relay が `access` / 許可 email をどう判定するか（JWT の何を見るか。許可外 email がどの層で止まるか） | 許可外 email で開くと 202 に届かない（nginx の access log に出ない） | R26 |
| 4 | inet250 の IP（nginx の `allow` に入れる値）と、nginx が見る送信元がその IP になっているか（NAT・`X-Forwarded-For` の有無） | LAN 内の別端末から 202:80 を直接打つと 403、inet250 経由は通る | 8.1、5.2 |
| 5 | 202 の nginx の構成: `default_server`、既存の vhost に影響しないか、`nginx -t` | 既存の URL が設置前後で同じ応答 | 8.3 |
| 6 | SSE が溜まらず届くか（Cloudflare → cloudflared → relay → nginx → backend） | 端末の出力と `: ka` が 1 秒以内に手元に届く（束にならない） | 8.5、R22 |
| 7 | 長時間の idle 後の挙動: 5 分・30 分無操作で SSE が切れるか、切れた時に `after` で続きから再接続できるか | 切れても自動で再接続し、出力が欠けない | 8.5 |
| 8 | 添付 20MB（`attachments.ts:13`）が Cloudflare・relay・nginx を通るか。Cloudflare のプラン別のボディ上限 | 20MB の画像が保存され path が pty に打たれる。超えた時は 413 が読める文言で出る | 8.1 |
| 9 | Access の session 期間と、切れた後の SSE・fetch の挙動 | 切れたら SPA が再読込で Access のログインに戻り、ログイン後に端末が再開する | 5.2、R23 |
| 10 | 202 から `<team>.cloudflareaccess.com` への外向き通信 | backend が鍵を取得でき、検証が通る | R24 |
| 11 | WebSocket を使う場合のみ: Tunnel・Access・relay 越しの `Upgrade`、idle 切断の秒数 | 将来 WebSocket 化する時に実測（v1 は対象外） | 8.5 |
| 12 | （設置者の実測。まとまり 7 には含まない）202 の空き port（web backend 用。候補 7920 は推測）、arch・toolchain・linger の状態 | `ss -tlnp` で衝突なし、6.1 / 9.1 / 判断 6 の確認項目 | R11、R13 |
| 13 | 同じ 202 の別 user のプロセスから backend の loopback port を直接叩く（nginx を飛ばす） | `X-Bantou-Proxy-Key` が無い要求は 403。鍵の値が `ps`・ログ・backend 以外の user が読める file に出ていない | 5.2 L4、R27 |
| 14 | web 用 hostname の DNS・ingress・route が出来ているか（inet250 の管理機能で zone・ingress・route を確認） | ブラウザで開くと Access のログインが出て、許可した利用者だけ通る | 8.4 |
| 15 | まとまり 8 を含む desktop の release から作った center に、web が指す center を入れ替えた後、スマホを開いても mac の端末の幅が変わらないこと（判断 3 の A） | スマホで開いた直後に mac 側の端末の列数が変わらない。打ち始めたときだけ変わる | まとまり 8、10 章の順序 |
| 16 | スマホ実機（iOS / Android）での日本語入力、soft keyboard の出入りでの端末の高さ、画像選択、特殊キー列、bracketed paste | 入力が崩れず、端末が潰れず、画像が添付できる | まとまり 6a・6b、R14 |
| 17 | 判断 13 の A を選んだ場合: center を置く host の証明書と、つなぐ側（web backend、mac の desktop）がそれを信頼できるか | web backend と mac の desktop が https の URL で center に入れ、token が平文で流れない | 6.2、判断 13 |
| 18 | 既定の形で、設定 file（か env）の `remote` に url と token を与えて起動する | backend が center につながり一覧が出る。**ブラウザの DevTools（ネットワークの応答・DOM・storage）、`/api/health`、backend のログのどこにも token が出ない** | 5.5、R28 |
| 19 | 設定が空（接続先が無い）で backend を起動する／設定 file を後から書き換える | backend は起動し、画面と `/api/health` が「接続先が無い」を返す。file に `remote` を書くと、backend の再起動なしで次の呼び出しから一覧が出る | 5.5 |
| 20 | 判断 14 の既定（変更不可）で、画面と `/api/rpc/center_set_settings` から接続先を変えようとする。B を選んだ場合は `remote.url` だけ変えて保存する | 既定では拒否される。B では token が空のまま保存されて接続できなくなる（既存の token が新しい url へ送られない。新しい宛先の access log に Bearer が来ない） | 5.5、R29、判断 14 |
| 21 | （まとまり S を入れた後のみ）`enabled` を真にして起動し、web backend を停止・再起動する | center が子として起動し loopback の宛先に向く。backend の停止で center も終わり、再起動後に session が `--continue` で復帰する（TUI は中断される）。異常終了させると 2 秒から倍々で再起動する | 6.6、R30 |
