# feat/web-4b-terminal-routes (work unit 4b)

## 基点
- origin/develop は feat/web-4a-terminal (c29aff6) を含まなかった。origin/develop (a507dc0) から branch を切り、origin/feat/web-4a-terminal を merge（merge commit 636ed77）。rebase・force-push なし。
- 初回 commit 365ade5。review 後の修正 commit が最新（修正 commit の full SHA は末尾に記載）。

## 追加した route（packages/web/server/api/sessions/[name]/）
- `output.get.ts`: SSE。`Last-Event-ID` が先、無ければ `?after=`（10 進整数以外は 400）。header 即 flush、`: ok` 後に 15 秒ごと `: ka`、`X-Accel-Buffering: no`。center の `output`/`reset` は `id`/`event`/`data` のまま写し、`event: status`（JSON、`StatusPayload`）を足す。`rejected` で閉じる。切断で購読を止める。
- `input.post.ts` / `resize.post.ts`: body は JSON object（1MiB 上限。受信中に数え、超えたら 413）。検査は center-client（`checkInputData`/`checkSize`）、不正は 400 で center に届かない。
- `attachments.post.ts`: body がそのまま画像 bytes。Content-Type は png/jpeg/gif/webp のみ（415）、先頭 bytes と申告が一致しなければ 415、空は 400、20MB 超は受信中に 413（Content-Length 無しの chunked でも、残りを読み捨てて 413 を返す。接続は reset しない）。保存先 path を pty に入力するのは center-client の `attachBytes`。
- 本体は `server/utils/terminal/handlers.ts`（注入 `getService`）。route file は 1 行ずつ。
- エラー: center の 4xx はそのまま。401/403（center への認証失敗）・到達不可・5xx は 502。文は scrub 済みで、token は応答に出ない。

## (a)(b) の直し方（center-client/src/terminal.ts）
- 3c の `selectFailure`（mcp.ts）と同じ形を `createTerminals` に入れた。`getTarget` の失敗は `TerminalError` に包み、任意の error は固定文「接続先の選択に失敗」（`code` が `[A-Z0-9_]{1,40}` なら「 (CODE)」付き）、`CenterSettingsError` の message だけ最後に見た target で scrub して通す。
- (a) input / resize / attachBytes（`getTarget` は `terminals.getTarget` 経由で attachBytes も同じ）は、これまで raw な error をそのまま再 throw していた。固定文に統一。
- (b) openOutput の最初の失敗は秘密が分からず scrub できなかった（旧 test は「scrub する」前提）。同じ固定文にした。旧 test を 3c 形に書き換え、(a) 用に 1 件足した（183 → 184）。`known`（最後に見た target）は createTerminals 全体で共有。

## test
- packages/web: typecheck OK、test 51 件（38 + 配線 13 件）全 pass。
- packages/center-client: typecheck OK、test 186 件全 pass。
- packages/protocol: 43 件 pass。
- 配線 test（nuxt build した server を偽 JWKS で起動、偽 center は 127.0.0.1 の HTTP server）: 全 4 route が守りの内側（共有鍵・JWT・許可 email・Origin。center に届かない）、SSE が流れる・`after`/`Last-Event-ID`・拒否で `rejected`、2 クライアント同時購読、input/resize の検査と中継、409 透過、center が token を含む本文を返しても応答に出ない、attachments の型・空・20MB 超 413・20MB ちょうど 200。e2e は回していない。

## 共通 file に足した物（3d と衝突しうる所）
- `packages/web/package.json`: `dependencies` に `"bantou-center-client": "workspace:*"`。`bun.lock` は該当 3 行のみ（server の version 行は戻した）。
- `packages/web/tsconfig.json`: include に `../center-client/src/ui-types-shim.d.ts`（center-client が packages/ui の型を経由して参照する `~/tauri` を typecheck で解決するため）。
- `packages/web/test/server/nitro-wiring.test.ts`: before に偽 center と env（`CENTER_URL` `CENTER_TOKEN` `WEB_SETTINGS_FILE`）を追加、新 test を末尾に追加。既存 test は無変更。
- `nuxt.config.ts` は無変更（Nitro は workspace の TS をそのまま bundle できた）。

## 組み立て（3d の物へ寄せる前提）
- 置いた物: `packages/web/server/utils/center.ts` の `terminalService()` 1 つ。設定 file（`WEB_SETTINGS_FILE`、既定は状態 dir 配下）と env から `createCenterSettings`（`redactSecrets: true`）→ `createTerminals` → `createAttachments` を 1 回だけ作る。
- 寄せ方: 3d の組み立て（settings/mcp/sessions/events/terminal を 1 回作る所）が出来たら、`terminalService()` を削除し、`server/api/sessions/[name]/*.ts` の `() => terminalService()` を 3d の取得関数に差し替える。`handlers.ts` は `{ terminals, attachments }` を返す関数だけを要求するので無変更で済む。settings の作り方（`redactSecrets`、env）は 3d と揃えること。`WEB_SETTINGS_FILE` の既定 path は 4b 側の仮置き。

## 設計書との差・申し送り
- output の SSE の形（`id/event/data` を center のまま、`status` event を追加）は設計書に細かい指定が無く、4b で決めた。5b/transport 側が `OutputPayload` に写す前提。
- input/resize の body 上限 1MiB は設計に無い追加（受信中に数える）。
- attachments は 20MB 超を受信中に検出（Nginx 側の body 上限（設計 8 章）は別途）。
- 実 center に対する確認（設計 10.2 の「実 center に対し」）は未実施（偽 center のみ。制約により e2e なし）。

## review 後の修正
1. attachments の chunked 20MB 超: `req.destroy()`（ECONNRESET）をやめ、`readLimited` が超過後は溜めずに読み捨てて 413 を返す。配線 test: chunked 25MB → 413。受信中の検査を外すと落ちることを確認（mutation）。
2. input/resize の JSON も同じ `readLimited`（1MiB）で受信中に打ち切り、413。配線 test: chunked 3MiB → 413（その後の通常の input は通る）。
3. output SSE: `data` を base64 の検査（`checkInputData`）に通し、外れた chunk（改行入り・base64 でない）は流さず、`status` event（`rejected`, 「center の出力の形式が不正」）を送って閉じる。配線 test 追加（偽 center が改行入り／非 base64 の data を返す）。検査を外すと落ちることを確認。
4. center-client test: upload の 5xx 本文・接続失敗、postSession の接続失敗（`cause.message`／例外文）と 5xx 本文に token と userinfo を入れた偽 fetch を使い、error とログに出ないことを確認（2 件）。scrub を外す mutation で 2 件とも落ちることを確認。
5. 配線 test: center の 401 → 502（本文の token は出ない）、保存 0 件（center が 500）→ 502（token は出ない）。`toHttpError` の 401/403 除外、`saved.length === 0` の判定を外すと落ちることを確認。「redactSecrets:false でも通る件」は、route の応答が設定の redact に依らず token を出さない確認と解釈し、上の 2 件が token を応答に出さないことを assert する形で入れた（redactSecrets を切る口は本番コードに置いていない）。
- 直さない（報告のみ）: 指摘 6（center origin の表示は desktop と揃う）、7（4a の scrub 仕様）。
- test: web 51 件、center-client 186 件、protocol 43 件、各 typecheck OK。
- 修正 commit: 418157e68bba7f6e899be6e0935f1283dba56844（この記載を足した docs commit が branch の HEAD。その full SHA は完了報告に記載）
