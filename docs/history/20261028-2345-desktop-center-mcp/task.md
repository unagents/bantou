# 指示書: desktop と center を MCP でつなぐ

- 日付: 2026-10-28 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## 方針（ユーザー確定）

- desktop ↔ center の transport は MCP（center が既に出している Streamable HTTP `/mcp`）。agent-messenger は使わない。
- 認証は後回し（今回入れない）。

## 変更内容

1. desktop の Rust 側に center への MCP client を持たせる（webview から直接 fetch しない）。
   - 接続先: 設定 `remoteUrl` があればその center、無ければ sidecar の center（`http://127.0.0.1:<center.port>/mcp`、center 有効時のみ）。
   - `remoteUrl` の「保存のみ」扱いを解除し、実際に接続先として使う。設定画面の説明文も直す。
   - 実装手段（rmcp 等の crate か、JSON-RPC を直接組むか）は任せる。判断は report に書く。
   - center の再起動・設定変更・接続先変更でセッションが切れても、次の呼び出しで張り直す。
2. Tauri command を追加する。
   - center の tool を名前と引数で呼ぶ汎用 command（返り値は tool の結果そのまま、失敗は分かるエラー）。
   - 接続状態（接続先 URL、接続可否、直近エラー）を返す command。
3. 画面（UI）
   - center の状態を見る画面（設定画面とは別でも中でもよい、判断は任せる）を作り、次を表示する: 接続状態、`rc_list`（project ごとの remote-control 状態）、`server_list`、各 server の `server_status`（cap / worker 一覧）。更新ボタンで再取得。
   - 操作系（rc_start / rc_stop / cap_kick 等）のボタンは今回作らない。
4. テスト
   - Rust: MCP client の単体テスト（モック HTTP で initialize → tools/call、セッション切れからの張り直し、接続先の選択）。
   - Playwright: e2e mock（`desktop/e2e/mock/bantou.ts`）に新 command を足し、center 状態画面の表示を検証する spec を追加。既存 spec を壊さない。
5. 資料
   - `docs/architecture.md` の「未決」から desktop ↔ center の transport を外し、MCP に確定と書く。
   - `desktop/README.md` に center 状態画面と接続先の説明を足す。

## 範囲外

- version bump、release、main への push、npm publish。
- center（packages/center）と server の変更。必要が出たら変更せず report に書く。
- agent-messenger 側の変更。この Mac・mac200・202 の設定変更。

## 確認

- `cargo test`、center 状態画面に関わる typecheck。
- Playwright は 204 では動かない（sandbox で fonts 取得不可）。spec を書くところまででよい。mac200 での実行は main cap が行う。
- 可能なら 204 で center を起動し（`packages/center` を http transport で）、Rust の MCP client 単体から tools/call が通ることを確認。sandbox で塞がれたら無理に迂回せず report に書く。

## 報告

- 同 dir に `report.md`。commit 一覧、変更点、テスト結果、判断した点、未解決。
- develop に commit・push（task.md と report.md も含める）。push まで必ず行う。
