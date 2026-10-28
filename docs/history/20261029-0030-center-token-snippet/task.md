# 指示書: center の MCP 接続を Cork 方式（token とコピペ設定）にする

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。
- 参考実装: Cork（`/home/vagrant/work/repos/Cork`）の `src-tauri/src/mcp.rs`、`src/components/organisms/settings/McpServerSection.tsx`、`McpSetupSnippets.tsx`。

## 方針（ユーザー確定）

- center は Cork の MCP Server と同じ立ち位置。設定画面の center on/off が「MCP Server を有効にする」切り替え。
- center on の時、同じ場所に次を出す（Cork そのまま）:
  - token 欄（コピーボタン、再生成ボタン）。
  - token 入りの接続設定（コピーして貼る用）。`mcp.json` 形式と `claude mcp add --transport http ... --header 'Authorization: Bearer <token>'`。
  - 再生成ボタンで token を作り直すと、接続設定の表示もその token で更新される。
- center は `Authorization: Bearer <token>` を検査し、合わない接続は拒否する（401）。
- desktop が別ホストの center につなぐ設定は、URL 入力（今の `remoteUrl`）をやめ、上の「コピーした接続設定」を貼り付けて行う。貼った内容から URL と token を取り出して保存し、接続に使う。

## 変更内容

1. center（`packages/center`）
   - config に token を持たせ、`/mcp` で Bearer を検査する。token が無い・空の時の扱いは Cork に合わせる（判断は report に）。
   - 別ホストから貼り付け設定で接続できるようにする。今の Host 検査（`http.ts` の `allowedHostsFor`）は loopback 以外を 403 にするので、bind が loopback 以外の時は別ホストからの接続を通す形に直す。
2. desktop（Rust）
   - token の生成（Cork 同様のランダム文字列）、保存（settings の `center`）、center.json への書き出し。token 変更時は center に反映（再起動でよい）。
   - 接続設定の生成（`mcp.json` 形式、`claude mcp add` 形式）。URL は bind が loopback なら `127.0.0.1`、それ以外なら別ホストから届くアドレスを出す（どのアドレスにするかは判断して report に）。
   - 貼り付けられた接続設定（上の 2 形式）を解析して URL と token を取り出す処理。解析できない時は分かるエラー。
   - 前回作った desktop → center の MCP client は、sidecar 宛も貼り付け先宛も Bearer token を付けて呼ぶ。
   - 旧 `remoteUrl` 設定は廃止。保存済みの旧値の扱い（読み捨て等）は判断して report に。
3. desktop（UI、設定画面の center 欄）
   - Cork の McpServerSection と同じ構成: on/off、状態表示、token 欄（コピー・再生成）、接続設定（コピー可能なコードブロック、形式ごとのタブ）。
   - 「別ホストの center につなぐ」欄: 接続設定を貼り付ける欄と、解析結果（URL、token の有無）の表示。`remoteUrl` 入力欄は削除。
4. テスト
   - center: Bearer 検査（一致・不一致・欠落）、別ホスト Host の許可。
   - Rust: token 生成、接続設定の生成（両形式）、貼り付けの解析（両形式・壊れた入力）、MCP client が token を送ること。
   - Playwright: e2e mock を合わせ、設定画面の token 再生成で接続設定が変わること、貼り付けで解析結果が出ることの spec。既存 spec を壊さない。
5. 資料: `docs/architecture.md`（desktop ↔ center 節）、`desktop/README.md`、`packages/center/README.md`。

## 範囲外

- version bump、release、main への push、npm publish。
- server（`server/`）の変更。agent-messenger 側の変更。この Mac・mac200・202 の設定変更。

## 確認

- center の test・typecheck、desktop の `cargo test`、typecheck。
- Playwright は 204 では動かない。spec を書くところまででよい（mac200 での実行は main cap）。
- 可能なら 204 で center を token 付きで起動し、正しい token で tools/call が通り、誤った token で 401 になることを実測。sandbox で塞がれたら迂回せず report に書く。

## 報告

- 同 dir に `report.md`。commit 一覧、変更点、テスト結果、判断した点、未解決。
- develop に commit・push（task.md と report.md を含める）。push まで必ず行う。
