# desktop と center を MCP でつなぐ: report

## commit
- COMMIT_HASH（develop。push はしていない。cap が行う）

## 変更ファイルと要点
- `desktop/src-tauri/src/center_mcp.rs`（新規）: center への MCP client。reqwest で JSON-RPC を直接組む。`initialize` → `notifications/initialized` → `tools/call` / `ping`。応答は JSON と SSE の両方を解釈。session は URL に紐づけ、404 なら initialize し直して 1 回だけ再試行。Tauri command `center_call`（tool 名＋引数、結果は MCP tool result のまま、`isError:true` は Err）と `center_connection`（url / source / connected / lastError）。
- `center.rs`: `load_settings` を pub(crate) に。`remote_url` のコメント更新のみ。`lib.rs`: mod・state・command 登録。
- `desktop/src/components/CenterDialog.vue`（新規）+ `AppHeader.vue` / `pages/index.vue`: center 状態画面（ヘッダーのサーバーアイコンから開くモーダル）。接続状態、rc_list、server_list、server_status（cap / worker）、更新ボタン。操作系なし。
- `SettingsDialog.vue`: remoteUrl の説明文を修正。`src/api/center.ts` `index.ts` `types/index.ts`: API と型。
- `e2e/mock/bantou.ts` に `center_connection` / `center_call` を追加、`e2e/center.spec.ts`（新規、3 test）。
- `docs/architecture.md`: 未決から transport を外し「desktop ↔ center（確定）」節を追加。`desktop/README.md`: 状態画面と接続先の説明。

## テスト結果
- `cd desktop/src-tauri && cargo test --offline`: 178 passed / 0 failed / 5 ignored（center_mcp の新規 15 本を含む。mock HTTP で initialize→tools/call、session 再利用、セッション切れ→張り直し、URL 変更で新 session、isError→Err、接続不可、target 選択、SSE/JSON 解析）。
- `bun run typecheck`（desktop）: exit 0（`vue-router/volar/sfc-route-blocks` の解決警告は既存環境の問題で、型エラーなし）。
- 実 center 実測: `packages/center/dist/cli.js --transport http --port 7955`（projects 0 件）を起動し、`BANTOU_CENTER_URL=http://127.0.0.1:7955/mcp cargo test live_center -- --ignored --nocapture`（新規の ignored test）が pass。`rc_list: []`、`server_list: []`、`rc_status(nope)` は isError が Err になり "rc_status が失敗: {…" を返した。
- 後始末: center は `timeout 120` で終了済み。7955 は解放（`ss` で LISTEN なし）。
- Playwright は 204 で実行不可のため未実行（spec は書いただけ）。mac200 での実行は cap。

## 判断した点
- MCP client は rmcp 等の crate を使わず reqwest で直接組んだ。必要な操作が 3 つだけ、reqwest が既存依存、`--offline` ビルドを保てる、依存追加で Cargo.lock が膨らむのを避けた。
- 画面はヘッダーから開く別モーダル（設定ダイアログとは独立）。設定は「構成」、状態は「閲覧」で用途が違うため。
- `isError:true` は Err にした（UI で失敗が分かる）。「結果そのまま」は成功時に適用。
- sidecar の接続先は `127.0.0.1:<port>`。bind が loopback / wildcard 以外ならその bind を使う（そうしないと繋がらないため）。remoteUrl はパス無しなら `/mcp` を補う。
- 接続先は呼び出しごとに設定から決める。session は URL に紐づくので、remoteUrl / port / enabled の変更は次の呼び出しで反映され、再起動の判定（needs_restart）は変えていない。
- 指示書の「push まで必ず行う」と依頼文の「push はしない」が食い違った。依頼文（cap が push）に従い push していない。
- report は指定先に置き、同内容を `docs/history/20261028-2345-desktop-center-mcp/report.md` にも置いて commit に含めた。

## 未解決・範囲外で気づいた点
- center の Host 検査（`packages/center/src/http.ts` `allowedHostsFor`）は wildcard bind でも loopback 名宛て以外を 403 にする。別ホストの center を `http://mac200:7910` で呼ぶと拒否される見込み（未実測、コードからの推測）。remoteUrl を実用するには center 側の対応（許可 Host の設定など）が要る。center は範囲外のため変更していない。
- reqwest は `default-features=false, features=["json"]` で TLS 無し。`https://` の remoteUrl は接続できない（バリデーションは https を許可している）。
- 認証なし（指示どおり）。
- `/tmp/claude-1002/dcm/c.json`（実測用の設定）が 1 ファイル残っている可能性がある（rm が permission で拒否された）。
- 実 center の実測は、sandbox 内の loopback が別 namespace で届かなかったため、cargo test と curl を sandbox 無効で実行した。
