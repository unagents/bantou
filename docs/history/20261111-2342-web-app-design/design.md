# 設計: bantou の web アプリ版（スマホから使う）

- 日付: 2026-11-11 / 基点 `origin/develop` `2634a9712d0f43ded5601890067b73452c728c99`
- 調査の事実と根拠は同 dir の `report.md`（以下「報告」+ 章番号）。この文書は設計と判断材料。
- 根拠は `file:line`（repo root 相対。`packages/desktop/` = `D/`、`packages/center/` = `C/`）。**推測は「推測」と明記**。202 の nginx・OS・user は見られていない（未確認）。
- コードの実装・変更はしていない。この文書は docs の追加のみ。
- **利用者が決めた前提（2026-11-11 追記）**: (a) web 版は外（internet）から使う。(b) 認証は web 版で独自に作らず、既存 host「inet250」の Cloudflare の認証を使う。以降の設計はこの 2 点を固定の前提とする（初版の「LAN 内だけか」「login 方式」の判断は取り下げた）。
- inet250 / Cloudflare の構成は、inet250 の管理 API の**読み取り照会**（ingress・relay の route・host 一覧の参照）で 2026-11-11 に観測した範囲だけを使う（変更系は呼んでいない、host へ ssh していない）。観測の内容は報告 8 章（公開 repo のため、他の app の情報は伏せている）。観測できなかったものは「未確認」と書き、**設置の時に確かめる項目**を 13 章に一覧する。

## 0. 結論

1. **center は 202 で独立した常駐プロセスにする。** web backend の子にしない。center は親が変わると自分で終了する（`C/src/daemon.ts:238`、`C/src/parent-watch.ts:13-20`）うえ、center を止めると全 session の TUI が中断されるため（`daemon.ts:167-194`、復帰は `--continue`、`daemon.ts:256`）。
2. **ブラウザは center に直接つながない。** web backend（Nitro、BFF）を挟む。center には CORS が無く（報告 3.2）、Bearer token は center の全操作の鍵（`/mcp` は任意 tool、`C/src/http.ts:392-397`）で、ブラウザに置けない。
3. **端末は WebSocket にせず、center と同じ SSE + POST のまま中継する。** center は SSE（`id` 付き・`Last-Event-ID` で続き、`http.ts:312-346`、`C/src/core.ts:107-120`）で再接続を既に解いており、WebSocket は center 側の新規実装が要る。SSE は 15 秒ごとの `: ka`（`http.ts:21`）で無音を作らない設計だが、Cloudflare・relay・nginx が溜めずに通すかは**未確認**（8.5、13 章 6）。WebSocket の通る条件は 8.5 に書くが v1 では使わない。
3a. **外からの認証は Cloudflare Access に任せ、web backend は独自の login を持たない。** ただし 202 の nginx は LAN から直に叩けるので、backend が Cloudflare の署名付き JWT（`Cf-Access-Jwt-Assertion`）を**自分で検証**する（Cloudflare を通らない到達を防ぐ主たる守り。nginx の送信元制限が副）。JWT が backend まで届くかは未確認で、届かない場合の代替も 8.4 に書く。
4. **画面は Nuxt layer `packages/ui` に共有部品を出し、`packages/desktop` と新設 `packages/web` が `extends` する。** 共有の継ぎ目は「`invoke(cmd, args)` と `listen(event)` の transport 1 枚」。e2e のモックが既にこの形（`D/e2e/mock/install.ts:28-35`）。
5. **v1 は Cork の task・thread・messenger 受信（`bantou-core`）を web に持ち込まない。** 202 の共有 broker に `bantou-core` を 2 つ登録できない（`docs/handoff.md:16`）。
6. スマホ画面は専用の page（一覧 → 端末の 2 画面）と、soft keyboard 用の「特殊キー列」「入力欄」を足す。
7. 実装は 13 のまとまり（1、2a、2b、3a、3b、4、5a、5b、6a、6b、7、8、任意の 9。10 章）。「1 → 2a → 2b」と「3a → 3b」「3a → 4」の 3 本が並走でき、5a は 2b と 3b の後、5b は 4 と 5a の後、6a・6b は 5b の後に順に行う。7（deploy の手順書、docs のみ）は 4 の後。8（center に pty サイズの口）は判断 3 が A の時だけで、202 に届くのは desktop の release を経てから。依存の一覧は 10.1。

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
   │  Access の JWT 検証／許可 tool の絞り込み／MCP client ／ SessionCache ／ events の fan-out
   │  HTTP + Bearer（center token は backend の env にだけ置く。Cloudflare の識別とは無関係）
   ▼
center（packages/center、202、127.0.0.1:7910、独立した systemd unit）
   ├─ MCP /mcp（session_*, rc_*, server_*, remote_*, center_*）
   ├─ SSE /events, SSE /sessions/<n>/output, POST input/resize/attachments
   ├─ core（pty の出力キュー 8MiB/session）
   ├─ bantou-pty-wrapper ── claude（対話型、--remote-control）  ＝ session（master-cap）
   └─ messenger client（peer "bantou-center"）
          ▼
   broker（202:7901）── bantou-server（remote-cap。既に 202 で常駐）
```

- 図の Cloudflare〜202 の部分は inet250 の管理 API の読み取り照会で観測した形（報告 8 章。他 app の hostname・port は公開 repo のため伏せている）。**観測した事実**: 全 ingress が inet250 上の relay へ向く／relay の route は `http://<LAN ip>:<port>` を宛先にし `https` を受けない／202:80 を宛先にする既存 route があり、`http_host_header` で Host を書き換える形と `path_prefix` を使う形がある／`access` が真の hostname は ingress に Access の `aud` を持つ（hostname ごとにも、複数 hostname で共有にもできる）。**未確認**: relay が JWT を 202 まで転送するか、relay の許可一覧が何を見て判定するか、SSE を溜めずに通すか、添付（20MB）の上限、Access の session 期間、Cloudflare の team 名。→ 13 章。
- desktop（mac）は今まで通り Tauri の Rust が center に直接つなぐ（変更なし）。同じ session を mac でも見たい時は、desktop の center 設定を「別 host の center（`remote`）」にして 202 の center を指す（`D/src-tauri/src/center.rs:60-68`、`center_mcp.rs:97`）。これは**判断 2** の結果次第で使う。
- 「session / messenger」: session = center が起動する対話型 claude（pty は wrapper が持つ、`C/src/wrapper.ts:119-155`）。messenger = center の peer（`C/src/server-link.ts:327`）で、bantou-server との通信用。web backend は messenger に参加しない。

## 2. 新設する package と既存の変更点

### 2.1 新設

| package | 名前 | 中身 |
|---|---|---|
| `packages/ui` | `bantou-ui`（private） | Nuxt 4 **layer**（`nuxt.config.ts` に `extends` される側）。`components/`（現 `D/src/components/*`）、`composables/`、`types/`、`assets/`、`api/`（transport 経由の関数群と `Transport` 型）。画面の共有部品と、それを動かす transport 契約 |
| `packages/web` | `bantou-web`（private） | Nuxt 4 アプリ（`ssr: false`）+ Nitro server route。`app/`（HTTP transport、mobile-first の page。login page は持たない）と `server/`（BFF: Access の JWT 検証、MCP client、SessionCache、events fan-out、SSE 中継、許可 tool 一覧、添付中継）。起動は `node .output/server/index.mjs`（同じ monorepo の `packages/server` が Nitro を使う前例: `packages/server/nuxt.config.ts:11`） |

### 2.2 既存の変更

| 対象 | 変更 |
|---|---|
| `packages/desktop` | `src/` の共有部品を `packages/ui` に移し、`nuxt.config.ts` に `extends: ["../ui"]`。Tauri 呼び出しを `src/tauri/`（transport 実装）に集める。`pages/index.vue`・`AppHeader` は desktop 側に残る。**Rust（`src-tauri/`）は変更しない** |
| `packages/center` | **原則変更なし**。ただし判断 3 を推奨（スマホは既定で幅を変えない）にするなら、pty の今のサイズを返す口（`GET /sessions/<n>/size` 相当）を足す必要がある（`core.size`、`C/src/core.ts:38` は HTTP に出ていない、使うのは wrapper 起動時だけ `C/src/remote-control.ts:491`）。これは**まとまり 8**。center は desktop に同梱されるため、反映の順序に制約がある（10 章）。それ以外の center 変更は想定しない |
| root `package.json` | `workspaces: ["packages/*"]`（`package.json:1`）なので追加不要。`bun.lock` は実装まとまりの中で更新 |
| root `CLAUDE.md` | Map に `packages/ui` / `packages/web` を追記。「役割分離ルール」は「共通のものは root の `docs/` と `packages/plugin/` に置く」（`CLAUDE.md` 役割分離ルール節）と書くので、**共有 UI を `packages/ui` に置く**ことと整合を取る修正が要る（まとまり 2b で実施、利用者へ要報告） |
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

- **center への中継**: `center_call`（許可 tool のみ）、`center_connection`、`list_sessions`/`refresh_sessions`、`create_session`/`session_update`、`session_get_settings`/`session_update_settings`、`session_path_hints`、`session_output_*`/`session_input`/`session_resize`、`session_attach_bytes`（`attach_paths`/`attach_pick` は `File` から同じ経路）。
- **web で意味が変わるもの**: `session_path_hints.canPick` は常に偽、`center_*settings*`（sidecar 設定）は持たず center の共通設定（`center_settings_get/update`、`SettingsDialog.vue:74-86`）だけを出す。
- **持ち込まないもの**: workspace/task/thread/broker/agent（Cork 系 17 command: workspace 4、task 4、thread 2、broker 3、agent 4）、updater、menu、window、single-instance、os 通知（ブラウザの標準 event で代替）。

## 5. web backend（BFF）の責務

### 5.1 HTTP API（command 名をそのまま使う RPC + 3 本のストリーム）

| route | 役割 |
|---|---|
| `GET /api/me` | JWT を検証して利用者の識別（email）を返す。SPA が「Access の session 切れ」を見分けるのにも使う（5.2）。login / logout の route は持たない |
| `POST /api/rpc/:cmd` | 4 章の「中継」command。body は JSON の `args`。許可リスト外は 404 |
| `GET /api/events` | SSE。backend が center の `GET /events` を 1 本だけ持ち（`center_events.rs:60-103` の TS 版）、`center-sessions-changed` と `bantou://sessions-changed` 相当を全ブラウザへ配る |
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
- center は `127.0.0.1` に bind（6.2）し、外向けの経路に出さない。web backend は Cloudflare の header を center へ転送しない。token は backend の env（`EnvironmentFile`、chmod 600。`packages/memory/deploy/bantou-memory.service:2-3` の流儀）にだけ置き、ブラウザにも Cloudflare 側にも出さない。
- Cloudflare Access を通れる人 = center の全操作（session で claude を動かす権限）を持つ人。Access の許可一覧は**管理者の一覧として扱う**（R4、R25）。

**別案の比較**
- backend にパスワード login を持つ（初版案）→ 利用者が「独自に作らない」と決めたので取り下げ。
- nginx の `auth_request` で JWT 検証を nginx に置く → 検証が backend と二重になる。nginx 側に検証用の module/設定が要る（202 の nginx の構成は未確認）。backend 内で足りるので採らない。
- center の token をブラウザに入力させる → token がブラウザに残るため却下（初版から変わらず）。

### 5.3 許可 tool の絞り込み

desktop の `center_call` は任意 tool を呼べる（`center_mcp.rs:468-478`）が、web は Access を通れる端末（盗まれたスマホなど）が乗っ取られると center 全体が操作されるため、UI が実際に使う tool に限る。desktop の UI が `centerTool/centerToolStrict` で呼ぶ名前: `rc_list` `rc_start` `rc_stop` `server_list` `server_peers` `server_retire` `remote_list` `worker_reply` `session_login` `session_login_code` `center_settings_get` `center_settings_update`（`D/src/components/*`、`D/src/api/center.ts`）。加えて backend 内部で `session_list` `session_create` `session_update` `session_settings_get/update` `center_info`。`session_delete` は desktop の UI が使っていないので許可しない。`server_retire`（**不可逆**、`docs/ops/server-install.md:133`）は、判断 10 の推奨に従い**web の許可リストに入れない**（desktop のみ）。`rc_start/rc_stop` と session の作成・改名は許可するが、**スマホでの誤タップを防ぐ確認画面**を共有 component 側に要求する（危険 R5）。

### 5.4 SessionCache と events

- 一覧を最後に取れた内容で持ち、取れない時は `reachable: false` で古い一覧を返す（`session.rs:1-14,247-256` の仕様）。`rev` は backend が採番（`useBoard.ts:66-68` が最大の `rev` を採る前提を保つ）。**全ブラウザで 1 つ**。
- center の MCP session は backend が 1 本持ち、404 なら 1 回だけ再 initialize（`center_mcp.rs:8-12`）。center の MCP session 上限 32・30 分失効（`http.ts:34,36`）に、ブラウザの台数が影響しないようにする。

## 6. center を 202 で headless に動かす

### 6.1 起動形（独立した unit）

- 引数: `--transport http --port 7910 --bind 127.0.0.1 --config <path>`（`C/src/args.ts:15-44`）。config に `token`（12 文字以上必須、`daemon.ts:212-214`）、`workspace`、必要なら `remoteControl.claude`（絶対 path。service は login shell を通らない可能性があるため、明示を推奨。推測）。
- 起動物（2 通り。どちらも center の host で `pty-wrapper` が要る）:
  - (i) **ソースから**: `packages/protocol` と `packages/center` を build し `node packages/center/dist/cli.js`（`C/package.json` `bin`・`engines.node >=22`）。wrapper は `BANTOU_PTY_WRAPPER` で指す（`wrapper.ts:4-7`）。
  - (ii) **単体バイナリ**: `D/scripts/build-sidecar.ts` と同じ手順（`bun build --compile`、Linux x64/arm64 は対応、`build-sidecar.ts:15-20`）で center と wrapper を同じ dir に置く。wrapper は `cargo build --release` が 202（または同 arch の Linux）で要る（`build-sidecar.ts:51-62`）。
  - 推奨は (i)。理由: 202 に node 22 があるという**推測**（`docs/ops/server-install.md:31` は bantou-server の設置の事前条件として system 全体の node 22 以上を挙げるが、202 での実測はしていない）の上で、Rust と bun を 202 に入れずに済む。wrapper だけは Rust の build が要る（別 Linux で build して置くことも可）。202 の arch・node・toolchain は**設置者が実測する**（13 章 12。まとまり 7 は docs のみで 202 には触れない）。
- 親が変わると落ちる（`daemon.ts:238`）ので、systemd が直接 `node` を起動する形にする（`npx`・shell script 経由にしない。ラッパー shell が `exec` しない場合に親 pid が変わる恐れ。推測）。
- 1 host に center を複数立てない。同じ `~/.config/bantou/center.json` と状態 dir を共有しない（`daemon.ts:112` の `stateDir` = config の dir）。

### 6.2 認証と token の扱い

- center の token は 202 内（center の config と backend の env）にだけ置く。スマホにも desktop の設定画面にも出さない（`center_connect_snippets` 系は web に持ち込まない、報告 1.1）。
- center を `127.0.0.1` に bind すると Host/Origin 検査が効く（`http.ts:80-86,414`）。backend は `http://127.0.0.1:7910` に直接つなぐので影響しない。
- **desktop（mac）が同じ 202 の center に入る場合**（判断 2 の A）は center に LAN から届く必要がある。選択肢（判断 13）: (a) center を `0.0.0.0` で待ち受ける（今の desktop の sidecar と同じ。token のみ・平文、`center.rs:31`、`docs/architecture.md:57`）／(b) center は `127.0.0.1` のまま、202 の nginx に **LAN 内の desktop 向けの HTTPS の listener**（`/center/` など）を別に設け、Host を `127.0.0.1:7910` に書き換えて中継する（loopback bind の Host 検査を通すため、`http.ts:80-86`）。desktop の `remote` は `https://` の URL を受ける（`center.rs:152`）。(b) の方が token を LAN に平文で流さない。**8.1 の「202 の nginx に証明書は要らない」は、Cloudflare → inet250 → 202 の外向けの経路（平文 HTTP）の話で、(b) の LAN 内 HTTPS は別の listener であり証明書が要る。** 202 に証明書があるか、mac がそれを信頼できるか（私的な認証局の登録など）は未確認（13 章 17）。
- **desktop を外（家の LAN の外）から 202 の center につなぐ経路は、本設計に含まない。** desktop の MCP client は `Authorization: Bearer` だけを付ける作りで（`center_mcp.rs:9-10`）、Cloudflare Access が非ブラウザに求める追加の header（service token）を付ける口が無い（コードに該当なし。Access 側の要件は未確認）。外で使うのは web（ブラウザ）だけで、desktop は LAN（または VPN で LAN 相当）から使う前提。

### 6.3 session の claude process と pty の持ち主

- pty は wrapper が持ち、center の `core` が出力を 8 MiB/session で保持する（`core.ts:7`）。持ち主は **202 の center**。web backend も desktop も持たない。ブラウザを閉じても session は続き、再接続すると続きが来る（`after` が残っていれば差分、無ければ `reset` + 全部、`core.ts:107-120`）。
- claude の認証は 202 の center を動かす OS user の `CLAUDE_CONFIG_DIR` 配下。ログインは既存の再ログイン画面（`LoginDialog`）で出来る（`C/src/login.ts`、`D/src/components/LoginDialog.vue`）。web ではその URL を**端末（ブラウザ）で開く**ので `window.open`（`LoginDialog.vue:60`）。

### 6.4 複数端末（mac の desktop とスマホ）から同じ center / session を見る場合

| 項目 | 振る舞い | 根拠 |
|---|---|---|
| 出力の閲覧 | 何台でも同時に購読できる | `core.ts:53,118` |
| 入力 | 全員が同じ pty に書く。**排他は無い**。同時に打てば混ざる | `core.ts:93-98` |
| 大きさ | **最後にサイズを送った端末が勝つ**。表示した時点で必ず送る | `core.ts:99-105`、`TerminalView.vue:154-157`、`docs/design/master-cap-session.md:118` |
| 一覧・状態 | center に 1 つ。全端末が同じ内容を見る | `session_list` |
| 引き継ぎ | mac の sidecar center の session は 202 に移らない（`sessions.json` は center の host に置かれる） | `daemon.ts:131` |
| remote-cap の記録 | center ごと（cap_id に center-id を含む） | `docs/architecture.md:44,47`、`daemon.ts:140` |

→ 「desktop と同じ session をスマホで続ける」は、**desktop が 202 の center につなぎ直す**ことでのみ成り立つ。

### 6.5 判断 2 の補足（切り替え手順と移行期間の注意）

- 切り替え方（判断 2 の A）: desktop の設定で「center を起動する」を切り、202 の center の接続設定を貼る。`enabled` が真のあいだは貼った `remote` より sidecar が優先されるので（`D/src-tauri/src/center_mcp.rs:87-98`）、切り替えると mac の sidecar は止まる（`center.rs:211-221`、`:638`）。
- 副作用の注意: center が同名 peer `bantou-center`（`server-link.ts:327`）で同じ broker に並ぶと、片方が再起動して peer id が変わった後、server の返信が**もう一方**へ行くことがコード上ありうる（`reports.ts:159-175`、実挙動は未測定）。切り替え後は mac の sidecar が止まるので 2 つ並ぶのは移行期間だけ。ただし mac200 など他の desktop が center を常駐させている運用（`docs/architecture.md:10`）が同じ broker にいるなら、この状態は 202 の center を足す前から起こりうる（同じ broker かは未確認、推測）。移行期間は両方に同時に指示を出さない。
- remote-cap の一覧は center ごと（center-id が違う、`daemon.ts:140`）。切り替え前は mac の session と 202 の session が別々に見える。

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

例（user unit。専用 user を想定。`loginctl enable-linger <user>` が要る）:

```ini
# ~/.config/systemd/user/bantou-center.service
[Unit]
Description=bantou center (headless)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/bantou/packages/center
EnvironmentFile=%h/.config/bantou/center.env          # BANTOU_PTY_WRAPPER、BANTOU_PAIR_SERVER_VERSION（9.3）など（chmod 600）
ExecStart=/usr/bin/node dist/cli.js --transport http --port 7910 --bind 127.0.0.1 --config %h/.config/bantou/center.json
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
After=bantou-center.service
Wants=bantou-center.service

[Service]
Type=simple
WorkingDirectory=%h/bantou/packages/web
EnvironmentFile=%h/.config/bantou-web/env             # CENTER_URL, CENTER_TOKEN, CF_TEAM, CF_AUD, ALLOWED_EMAILS, PROXY_KEY, PORT（5.2。値は書かない）
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- `bantou-web` が落ちても center と session は影響を受けない（独立）。`After=/Wants=` は起動順のみで、`Requires=` にしない。
- `Restart=always` ではなく `on-failure`（memory と同じ）。

### 9.2 202 で既に動いているものとの共存

| もの | port / 場所 | 衝突しないための事項 |
|---|---|---|
| bantou-server | broker 7901、mcp 7902、UDP 7902（`server-install.md:42`）。`bantou` user の HOME。system unit | center は別 user・別 HOME・別 port。**center が同じ HOME を使うと `claude` の認証（`$HOME/.claude`）・`caps/`・`workers/` を server と共有してしまう**（`server-install.md:17`）ので、専用 user を推奨（判断 6） |
| memory | 7930（`memory.env.example:2`）、PostgreSQL 5433、Ollama 11435 | center 7910、web は別 port。7920 は**推測**（空きは未確認）。必ず `ss -tlnp` で確認 |
| nginx（202:80）| 既に他の app の relay 宛先（報告 8 章）。nginx の構成そのものは未確認 | bantou 用 `server_name` を足すだけで他 vhost を壊さない。`default_server` に取られないか確認（8.3） |
| 202 の他の port | 他の app が 202 の複数の port を使っている（一覧は公開 repo のため伏せる。inet250 の監視対象とその route 先に含まれる） | web backend の port は設置時に `ss -tlnp` で空きを確認して選ぶ（候補 7920 は推測。空きは未確認） |
| messenger | center は peer 名 `bantou-center`（`server-link.ts:327`） | mac の center と同名（危険 R2）。server の返信先付け替え（`reports.ts:159-175`）を避けるため、判断 2 の選択に影響する |

### 9.3 更新

- web: `git fetch && git checkout <tag>` → `bun install` → protocol/ui/web の build → `systemctl --user restart bantou-web`。SSE は切れるが、ブラウザが再接続し（`after` で続き）session は影響を受けない。
- center: 更新は **cap が空の時**に `systemctl --user restart bantou-center`（再起動で session は `--continue` で復帰するが TUI は中断される、`daemon.ts:167-194,256`）。
- **版の揃え方（危険 R1）**: center は組の版と違う server に `update_server` を送る（`follow.ts:213-226`、新旧は比べない）。組の版は env `BANTOU_PAIR_SERVER_VERSION` を**先に**読み、無ければ作業ツリーの `packages/server/package.json` を読む（`C/src/pair.ts:19-30`、`:36-44`）。したがって、center の unit の env（`center.env`）に `BANTOU_PAIR_SERVER_VERSION=<202 の server が今動いている版>` を置けば、**center の変更なしで**、ソースから起動した center でも server の版と揃えられる。ただし 202 の bantou-server は `latest` で自己更新する（`docs/ops/server-install.md:66-68,113-116`）ので、固定した値はすぐ古くなる。server が上がった後に値を更新しないと、center は server を**固定した古い版へ戻す指示**を出す（`follow.ts:213-226`）。→ server の更新手順に「`BANTOU_PAIR_SERVER_VERSION` の更新と center の再起動（cap が空の時）」を含める（まとまり 7）。env を置かずに、202 の center を desktop と同じ release の tag から作る方法でも揃う（その tag の `packages/server/package.json` の版が組になる）。版合わせを無効にする手段は env が未設定かつ `../../server/package.json` が読めない場合だけ（`follow.ts:205`、`pair.ts:6-7`）。
- 手順書は `docs/ops/web-install.md` に（まとまり 7）。

## 10. 実装のまとまり

1 まとまり = cap を 1 回起こして終えられる大きさ。成果物と確認方法を各まとまりに付ける。確認方法は**実在する手段だけ**を書く（desktop の e2e は `page.screenshot` で画像を保存するだけで、画像の自動比較は無い: `D/e2e/board.spec.ts:33`、`D/e2e/login.spec.ts:72` ほか。見た目の同一性は `D/CLAUDE.md` Review check 手順 4 のとおり、保存された画像を**人が見て**確かめる）。**202 と inet250 に触れる作業はこの一覧のどのまとまりにも入れない**（設置者の作業として 13 章に出した）。

### 10.1 依存の一覧

| まとまり | 先に終えておくもの | 並走できるもの |
|---|---|---|
| 1 | なし | 3a、3b、4 |
| 2a | 1 | 3a、3b、4 |
| 2b | 2a | 3a、3b、4 |
| 3a | なし | 1、2a、2b |
| 3b | 3a | 1、2a、2b、4 |
| 4 | 3a | 1、2a、2b、3b |
| 5a | 2b、3b | 4 |
| 5b | 4、5a | なし |
| 6a | 5b | 7、8 |
| 6b | 6a（同じ `TerminalView` を触るため直列） | 7、8 |
| 7（docs のみ） | 4 | 5a、5b、6a、6b |
| 8（center の変更） | なし | 全部（効果の確認だけが設置後） |
| (9)（任意） | 5b | — |

- 8 の流れ: 8 → desktop の release → 202 の center の入れ替え → 13 章 15（設置後の実機確認）。他のまとまりはこれを待たない。
- 6a・6b は 8 に**依存しない**（center にサイズの口が無くても方式 B で動く作りにし、口がある場合の挙動は偽 center で確かめる）。8 の効果の確認は設置後（13 章 15）。
- 2a は import の書換と移動だけにとどめる（切り戻し点）。2b 以降で問題が出ても 2a の状態へ戻せる。

### 10.2 一覧

| # | まとまり | 依存 | 成果物 | 確認方法 |
|---|---|---|---|---|
| 1 | **Tauri 依存の集約（desktop 内、挙動不変）** | なし | `D/src/tauri/transport.ts`。`~/api` の外にある Tauri import 7 箇所（報告 1.4）を transport 経由に。`api/*.ts` は `invoke`→`getTransport().invoke`。platform 機能（updater と `relaunch`・open・drop・log・fs 監視・drag region、3.2）を 1 か所の interface に | `grep -rn "@tauri-apps" D/src` が `D/src/tauri/` だけを指す。`nuxt typecheck`。mac200 で desktop の e2e 全通過（`D/CLAUDE.md`） |
| 2a | **`packages/ui` の抽出（layer 化と import 書換のみ。ここが切り戻し点）** | 1 | `packages/ui`（`package.json` を含む private package。components / composables / types / assets / api）。desktop は `extends: ["../ui"]`。`~/` の 47 箇所を相対 / named alias に書換（Nuxt 公式 docs: layer 内の `~/` は利用側 project 基準）。**ビルドへの影響の確認**: `D/src-tauri/tauri.conf.json:9-10` の `beforeBuildCommand`（`bun run build:sidecar && bun run generate`）と `frontendDist`（`../.output/public`）は desktop で実行・出力されるため変更不要の見込み（**推測**。layer の assets が `.output/public` に入ることを確認する）。`pages/index.vue` と `AppHeader` は desktop に残す。**他は変えない**（挙動・構造の変更は 2b 以降） | desktop の `nuxt typecheck`・`nuxt build`、`bun run generate` の出力（`.output/public`）が layer 化前と同じ構成であること（file 一覧の比較）、mac200 の e2e 全通過、`bun run tauri build` が通る（`D/CLAUDE.md`）。**見た目は e2e が保存する画像（`board.png` ほか）を、layer 化の前後で人が見比べる**（自動比較は無い） |
| 2b | **`pages/index.vue` のロジック分離と文書更新** | 2a | 選択・フィルタ・ダイアログ管理（`pages/index.vue:62-158`）を composable（`useSessionBoard` 相当、`packages/ui`）に出し、desktop の 3 カラムはそれを使う。root `CLAUDE.md` の Map と役割分離の節を更新 | `nuxt typecheck`、mac200 の e2e 全通過、保存された画像を人が見て 2a と同じ見た目であること。`pages/index.vue` の行数が減り、選択・フィルタの state が composable に移っていること（diff で確認） |
| 3a | **web backend: 守り（JWT・共有鍵・Origin・`/api/me`）** | なし | `packages/web/server/`: **Access の JWT 検証（5.2 の L3。署名・aud・iss・exp、鍵の cache、許可 email）、L4 の共有鍵照合、Origin 検査、`GET /api/me`**（login/cookie は持たない）と、これらを全 route に掛ける middleware。node の test | `node --import tsx --test`（`C/package.json` の test と同じ流儀）で: **JWT 無し・署名違い・aud 違い・期限切れ・許可外 email は 401/403（test が生成した偽 JWKS で署名）**、鍵ローテーション（未知の `kid` で 1 回だけ取り直す）、共有鍵が無い・違う要求は 403、POST の `Origin` が違えば 403、`/api/me` が email を返す |
| 3b | **web backend: center 中継の核** | 3a | MCP client（再 initialize、`center_mcp.rs` 相当）、許可 tool 一覧（5.3）、`/api/rpc/:cmd`、SessionCache（`rev`）、`/api/events`（center `/events` の fan-out）、`/api/health`。node の test（偽 center で）。**この段階で UI は不要** | `node --import tsx --test` で: 許可外 tool は 404、center 停止中は `reachable:false`、center 再起動後に再 initialize（404→1 回だけ）、`rev` が単調増加、events が 2 クライアントに配られる、`/api/health` が center の到達可否を返す |
| 4 | **web backend: 端末の中継** | 3a | `/api/sessions/:n/output`（SSE 中継、`Last-Event-ID`/`after`、header の即 flush、`: ka`、`X-Accel-Buffering: no`）、`input`/`resize`/`attachments` 中継。検査（base64、cols/rows 1〜1000、画像型・20MB）の二重化 | 実 center（`C/scripts/e2e.ts` の流儀）に対し: 出力が届く、切断→`after` で続きが来る、`reset` が伝わる、20MB 超は 413、2 クライアント同時購読。curl で SSE を確認 |
| 5a | **web frontend: 足場・HTTP transport・一覧** | 2b、3b | `packages/web`（`package.json`、`nuxt.config.ts` で `extends: ["../ui"]`、plugin で HTTP transport を登録）、HTTP transport（`/api/rpc/:cmd` と `/api/events`）、**Access の session 切れの検知（SSE 失敗が続けば `/api/me` を呼び、失敗なら再読込）**、session 一覧 page（mobile-first、共有 composable を使う）、e2e の土台（`packages/web/playwright.config.ts`、test 用の偽 JWKS と JWT 署名 helper） | Playwright（`devices` のスマホ幅）で、実 backend（偽 JWKS + 署名済み JWT）+ 実 center に対し: 一覧が出る、JWT 無しは何も出ない、JWT を失効させると再読込の経路に入る。e2e は mac200 で（`D/CLAUDE.md` 方針）。**「web だけ dev で backend モック」は却下済み**（`docs/handoff.md:18`）なので実 backend で行う |
| 5b | **web frontend: 端末 page・server/cap のカード** | 4、5a | HTTP transport の端末系: `session_output_start/stop`（`EventSource` で `session-output` / `session-output-status` を再現、`useTerminalStore` は無変更）、**`session_input` / `session_resize`（JSON を `POST /api/sessions/:n/input|resize` へ。5.1 の個別 route）、`session_attach_bytes`（`Transport.invoke` の `body: Uint8Array` を、画像の Content-Type で `POST /api/sessions/:n/attachments` へ。3.2）**、端末 page（共有 `TerminalView` をそのまま使う最小版）、server・cap のカード（共有の `CenterDialog` / `RemoteActivity` の部品）、`docs/architecture.md` に web 節 | Playwright で: 端末に出力が出る、入力が center の `input` に届く、2 つのブラウザで同じ session の出力が両方に出る、cap カードが `remote_list` の内容を出す |
| 6a | **スマホの端末 UX（入力）** | 5b | 特殊キー列、入力欄（IME 区別。bracketed paste は先に偽の pty で実測し、結果を 7.2 に追記）、入力のまとめ送り（数十 ms。`session_input` の POST を束ねる） | Playwright のスマホ emulation で: 特殊キーが所定のバイト列を送る（center の `input` で受信）、入力欄の送信で本文 + `\r`、まとめ送りで連続入力の POST 回数が減り、順序と内容が保たれる。実機の確認は設置後（13 章 16） |
| 6b | **スマホの端末 UX（表示・添付・幅）** | 6a | `visualViewport` 追従、ファイル選択による添付（`<input type=file>` の `File` を 5b の `session_attach_bytes` で送る。web では `session_attach_paths` / `session_attach_pick` を使わない）、`visibilitychange` での再取得、サイズ方針: **center にサイズの口が無い（404）時は方式 B（開いたら幅を送る）で動く**。口がある時の方式 A の挙動は偽 center（口を持つ）で実装・test する | Playwright のスマホ emulation で: 添付が保存され path が pty に打たれる、**口が 404 の center で B として動く**、口がある偽 center で A として動く（開いただけでは `resize` を送らない）、`visibilitychange` 後に一覧と端末が取り直される。cap の完了条件はここまで。**スマホ実機の確認と、実 center での A の確認は設置後の項目**（13 章 15・16） |
| 7 | **deploy の手順書（docs のみ）** | 4 | `docs/ops/web-install.md`、unit 2 本の雛形、`env` の雛形（`CF_TEAM` / `CF_AUD` / `ALLOWED_EMAILS` / `PROXY_KEY` を含む。値は書かない）、nginx の block（8.3）、inet250 側の登録手順（8.4。実行は設置者）、更新手順（`BANTOU_PAIR_SERVER_VERSION` の扱いを含む、9.3）、R1 を避ける tag の指定方法、**13 章の確認項目を手順書の確認欄に 1 対 1 で転記**。**成果物は docs のみ。202・inet250 への実測や適用は含まない** | 手順書の確認欄が 13 章の全項目と対応していること（突き合わせ）、unit の雛形は `systemd-analyze verify` にかけられる範囲でかける（結果を記録。かけられない環境なら未実施と明記）、nginx の block は `nginx -t` を一時 config でかける（nginx が無ければ未実施と明記）。**202 と inet250 への適用・実測は設置者の作業で、結果は 13 章の表に記録する** |
| 8 | **center: pty の今のサイズを返す口**（判断 3 が A の時だけ） | なし | `packages/center` の `http.ts` に `GET /sessions/<n>/size`（Bearer、`core.size` を返す。無ければ 404 か null）と README・test | `C/test/http.test.ts` の流儀で: 認証なしは 401、未登録 session は 404、`resize` の後に同じ値が返る、実行中でない session の扱い。`npm test`（`C/package.json`） |
| (9) | 任意・後回し: Cork の task / thread を web に | 5b | 判断 5 の結果次第 | 別途 |

**center の変更（まとまり 8）が 202 に届くまでの順序**（8 以外の作業はこれを待たない）: center は desktop の release に同梱され（`D/scripts/build-sidecar.ts:81-99`）、202 の center は R1 により desktop と同じ release の tag から作る必要がある。したがって次の順になる。
1. まとまり 8 を develop に入れる
2. desktop を release する（`D/CLAUDE.md` Release。mac200 で e2e・署名・publish。利用者または release 担当の作業）
3. その tag から 202 の center を作り直して入れ替える（cap が空の時、9.3。設置者の作業）
4. 13 章 15 で「幅を送らない表示」を実機で確認する

3 の前は、web は center にサイズの口が無いので方式 B にフォールバックする（まとまり 6b の完了条件）。

各まとまりの「完了の定義」: そのまとまりの確認方法を満たし、`bun install` の差分（`bun.lock`）を含む変更が 1 branch にまとまること。version bump は実装担当ではなく release 手順で（`D/CLAUDE.md`）。

## 11. 利用者の判断が要る点

各点は「選んだ結果、利用者に何が違って見えるか」で書く。**推奨を先頭**に置き、理由を 1 行。

**取り下げ（利用者が決めた前提）**: 初版の判断 1「外から使えるか、LAN 内だけか」は**外から使う**で確定、判断 4「login の手間」は**認証は Cloudflare（inet250）に任せ、web 独自の login を作らない**で確定したため外した。判断 12（LAN 内から直に開いて入れるか）も、聞く項目ではなく設置時の実測で決まる設計事項のため 5.2 と 13 章に移した。番号は参照が崩れないよう欠番にし、新しい判断は 11・13 とした（12 も欠番）。

### 判断 2: スマホで見る session を、どこで動かすか（mac の desktop と同じ session をスマホで続けられるか）
- **推奨: 常時稼働の 202 で動かし、mac の desktop もそこを見る。** 理由: mac を閉じていてもスマホから使え、同じ session を desktop とスマホの両方で続けられる。
- A（推奨）: 202 で動かす。スマホは mac が閉じていても使える。desktop も 202 の側を見るよう切り替えれば同じ session を続けられる。**今 mac で動いている session は 202 に移らない**ので、切り替え前は mac の session と 202 の session が別々に見える。
- B: mac で動かしたままにする。mac が閉じている間はスマホから見えない。mac の既存 session はそのまま使える。
- 切り替え手順と、移行期間中の注意（返信が別の center に行く恐れ）は 6.5 に移した。

### 判断 3: スマホで開いたとき、mac で見ている端末の画面が崩れるか
- **推奨: 崩れない（スマホは既定で見るだけ。打ち始めたときだけ幅が変わる）。** 理由: 見るだけで mac の画面が狭くなるのを避けられる。
- A（推奨）: スマホを開いても mac の画面は崩れない。スマホは mac と同じ幅で描かれるので横スクロールで見る。打ち始めると mac 側も狭くなる。**使えるようになるまでに追加の作業と時間がかかる**（desktop の新しい版の配布と 202 の入れ替えを経る、10 章の順序）。それまでは B と同じ動きになる。
- B: スマホで開いた瞬間に mac の画面も狭くなる（最後に幅を送った端末に合わせる仕組み）。すぐ使える。スマホ側は崩れず読める。
- 必要な追加作業の中身は 7.2 と 10 章（まとまり 8）に移した。

### 判断 5: Cork の task・thread を web でも見るか
- **推奨: v1 は見ない（session・server・cap の状態と端末だけ）。** 理由: web と mac の desktop が同じ返答待ちを取り合い、共有の messenger に同じ名前で二重に入れない（`docs/handoff.md:16`）。
- A（推奨）: スマホには「返答待ち thread」「task 一覧」が出ない。それらは今まで通り mac の desktop で見る。
- B: スマホにも出す。mac の desktop と同時に動かすと衝突するため、別のまとまり（10 章の (9)）として後でやる。

### 判断 6: host を再起動した後に自動で戻るか／既存の server と作業場所が混ざるか
- **推奨: 専用の利用者で動かし、「再起動後に戻る設定」を設置手順で必ず確認する。** 理由: 既存の server と認証・作業場所が混ざらず、戻らない事故は確認項目で防げる。
- A（推奨）: 専用の利用者で動かす。**戻る設定を 1 つ忘れると、host の再起動後に戻らない**（既存の server がこの事故を理由に別の形を選んでいる、`docs/ops/server-install.md:25`）。設置手順の確認項目で防ぐ。
- B: OS が全体として管理する形で動かす（既存の server と同じ）。host の再起動後は必ず戻る。設置に管理者権限が要り、専用の利用者を別に作らないと既存の server と作業場所が混ざる。
- C: 既存の server と同じ利用者で動かす。設定は少ないが、claude の認証と作業場所が server と混ざる（`server-install.md:17`）。非推奨。
- 各案の systemd 上の形（user unit + linger / system unit）は 9.1 に移した。

### 判断 7: 更新で session が止まるか
- **推奨: web は随時更新、center は cap が空の時だけ更新。** 理由: web を再起動しても session は続く。center を止めると TUI が中断される（再開は `--continue`）。
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

### 判断 13: mac の desktop から 202 の session に入るとき、token が LAN に平文で流れてよいか（判断 2 で 202 を選んだ場合のみ）
- **推奨: 流さない（LAN の中でも暗号化して入る）。** 理由: token は 202 で claude を動かす鍵で、LAN の他の機器から読めてしまう形は避けたい。
- A（推奨）: 暗号化して入る。desktop の接続先は https の URL。202 に LAN 用の証明書が要り、mac がそれを信頼する必要がある（私的な認証局を使うなら mac への登録が要る。**推測**）。設置の作業が増える。
- B: 平文のまま入る（今の desktop が自分の center に入る形と同じ）。設置は簡単だが、同じ LAN の他の機器が token を盗み見られる。
- どちらでも外（インターネット側）の経路は変わらない。desktop を外から 202 につなぐ経路は本設計に含まない（6.2）。技術的な内訳は 6.2 と 8.1 の注に移した。

## 12. 危険と未確定の点

| # | 内容 | 根拠 | 区分 |
|---|---|---|---|
| R1 | 202 の center を desktop と別の commit から作ると、同じ 202 の bantou-server に、desktop の center と別の版を `update_server` で指示することになる（新旧は比べない）。server は cap が空になるのを待つ。202 の center は desktop と同じ release tag から作る必要がある。既に複数の desktop（mac200 など）が同じ server に指示している運用なら、これは新しい種類の危険ではなく、増える center が 1 つ（推測: 同じ broker・同じ server を見ている場合）。env `BANTOU_PAIR_SERVER_VERSION` で組の版を固定する方法もある（9.3。固定値は server の自己更新で古くなる） | `C/src/follow.ts:195-226`、`C/src/pair.ts:19-44`、`docs/architecture.md:35` | 事実（挙動は未実測） |
| R2 | 同名 peer `bantou-center` の center が同じ broker に複数いる時、center 再起動で peer id が変わると、server が同名の最後の登録に返信先を付け替える。desktop を 202 の center に切り替えれば mac の sidecar は止まる（`center_mcp.rs:87-98`、`center.rs:211-221`）ので、並ぶのは移行期間と、他の desktop が center を常駐させている場合（`docs/architecture.md:10`）だけ | `C/src/server-link.ts:327`、`packages/server/server/utils/bantou/reports.ts:159-175` | コードの読み（実挙動は未測定） |
| R3 | pty サイズは最後に送った端末が勝つ。スマホで開くと mac 側が狭くなる。pty の今のサイズは HTTP に出ていない | `C/src/core.ts:38,99-105`、`D/src/components/TerminalView.vue:154-157` | 事実 |
| R4 | center は Bearer のみ・平文・CORS 無し。token = 全操作。ブラウザに置けず、LAN を平文で流れる。外から使う前提では、center は 127.0.0.1 に bind して外向け経路に出さず、web backend だけが Bearer を持つ（5.2、6.2） | `C/src/http.ts:89-93,392-397`、`C/README.md:37` | 事実 |
| R5 | 共有 component のままだと、スマホの画面から `server_retire`（不可逆）・`rc_start/rc_stop` が呼べてしまう。許可リストと画面の両方で絞らないと、画面だけ隠しても backend が通す | `docs/ops/server-install.md:133`、`D/src/components/CenterDialog.vue:172` | 事実。判断 10 で決める。許可リストから外し、画面は prop で出し分け |
| R6 | center は親プロセスが変わると自分で終了する。systemd 直下の ppid が安定するかは実測していない。shell/npx 経由だと落ちる恐れ | `C/src/daemon.ts:238`、`C/src/parent-watch.ts:13-20` | 事実（systemd 下の挙動は推測） |
| R7 | center の停止・更新で全 session の TUI が中断される（復帰は `--continue`） | `C/src/daemon.ts:167-194,256` | 事実 |
| R8 | 入力はキー 1 回ごとの POST。モバイル回線で遅延が出る | `D/src/components/TerminalView.vue:182`、`D/src-tauri/src/terminal.rs:340` | 事実。まとめ送りで緩和（効果は推測） |
| R9 | スマホのバックグラウンドで SSE が止まる | — | 推測。`visibilitychange` で再取得（実機確認） |
| R10 | layer 内の `~/` は利用側 project 基準。47 箇所の書き換えを誤ると desktop が壊れる | Nuxt 公式 docs（layers）、`D/src` の grep 47 件 | 事実（公式 docs） |
| R11 | wrapper（Rust）が 202 で必要。202 の arch と toolchain は未確認 | `C/src/wrapper.ts:4-7`、`D/scripts/build-sidecar.ts:51-62` | 未確認 |
| R12 | service から claude が見つからない恐れ（login shell を通らない） | `C/src/claude-path.ts:54-84` | 推測。`remoteControl.claude` を明示 |
| R13 | 7920 などの port が 202 で空いているか | `server-install.md:42`、`memory.env.example:2` | 未確認 |
| R14 | xterm の日本語 IME・`visualViewport`・ファイル選択はスマホ実機で未確認。bracketed paste を claude の TUI が解釈するかも未検証 | — | 推測 |
| R15 | 共有 UI を `packages/ui` に置くことが、root CLAUDE.md の役割分離（共通物は root の `docs/` と `packages/plugin/` に置く）と文言上ぶつかる | `CLAUDE.md` 役割分離ルール | 事実。まとまり 2b で CLAUDE.md を更新（利用者へ報告） |
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
| 15 | まとまり 8 を含む desktop の release から作った center に入れ替えた後、スマホを開いても mac の端末の幅が変わらないこと（判断 3 の A） | スマホで開いた直後に mac 側の端末の列数が変わらない。打ち始めたときだけ変わる | まとまり 8、10 章の順序 |
| 16 | スマホ実機（iOS / Android）での日本語入力、soft keyboard の出入りでの端末の高さ、画像選択、特殊キー列、bracketed paste | 入力が崩れず、端末が潰れず、画像が添付できる | まとまり 6a・6b、R14 |
| 17 | 判断 13 の A を選んだ場合: 202 の nginx の証明書と、mac がそれを信頼できるか | mac の desktop が https の URL で 202 の center に入れ、token が平文で流れない | 6.2、判断 13 |
