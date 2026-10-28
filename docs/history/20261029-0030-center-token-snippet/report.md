# 報告: center の MCP 接続を Cork 方式（token とコピペ設定）にする

- 日付: 2026-10-28（204 remote cap）
- 実行: worker は sonnet。前回実行中に 204 が固まって再起動したため、作業ツリーに残った未 commit の途中変更（center と desktop/src-tauri）を引き継いで完了させた。
- cargo は `CARGO_BUILD_JOBS=2 cargo test -j 2`、コマンドは逐次実行。

## commit（develop）

- fc1be6d center: require Bearer token on /mcp and allow non-loopback hosts
- c6549b8 desktop: center token, connection snippets, paste parsing and Bearer client
- aaa9f37 desktop: token and connection snippets in settings, paste-to-connect remote center
- b563047 docs: center Bearer token, connection snippets and paste-to-connect
- 本 report と task.md は最後の commit に含める。

## 変更点

- center
  - `config.ts`: `token` と `MIN_TOKEN_LEN` を追加。
  - `http.ts`: `/mcp` の POST / GET / DELETE すべてで定時間比較の Bearer 検査。欠落・形式違い・不一致は 401（`WWW-Authenticate: Bearer`）。bind が loopback 以外の時は Host / Origin 検査を外す。
  - `daemon.ts`: http で token が無い・12 文字未満なら起動しない。
- desktop Rust
  - `center.rs`: token 生成（32 文字 base62、CSPRNG）、`center_regenerate_token`、`center.json` への token 書き出し、token 変更で center 再起動、`remote: {url, token?}`。
  - `center_snippet.rs`（新規）: `mcp.json` 形式と `claude mcp add` 形式の生成。貼り付け解析（`mcpServers` / `servers` / 単体 entry、`--header` / `--header=` / `-H`、引用符・行継続）。解析不能時は原因が分かるエラー。Tauri command `center_connect_snippets` / `center_parse_connect`。
  - `center_mcp.rs`: 全リクエストに Bearer を付与。session は URL と token に紐づく。401 は「token が違う」「token が必要」を分けて表示。
- desktop UI（`SettingsDialog.vue`）
  - center 有効時に token 欄（コピー・再生成）と、`mcp.json` / `claude mcp add` のタブ付き接続設定（コピー可）。port / bind / token の編集中の値で更新。
  - 「別ホストの center につなぐ」欄（貼り付け、URL と token 有無の表示、エラー、保存済み接続先と解除）。`remoteUrl` 入力欄は削除。
  - `CenterDialog` の接続先ラベルを `remote` に変更。
- e2e
  - mock に `center_regenerate_token` / `center_connect_snippets` / `center_parse_connect` を追加。
  - `center.spec.ts` を `remote` に合わせた。
  - `settings.spec.ts` に 2 本追加（token 再生成で接続設定が変わる、貼り付けで解析結果とエラーが出る）。
- 資料: `docs/architecture.md`、`desktop/README.md`、`packages/center/README.md`。

## テスト結果

- center `npm test`: 111 tests、pass 111、fail 0。`npm run typecheck`: エラーなし。
- center `bun test`: 110 pass / 1 fail（`remote-control.test.ts`「古い世代の child の exit は…」が 5000ms タイムアウト）。変更を stash した状態でも同じ test が落ちるため既存事象で本件とは無関係。
- Rust `cargo test`: 196 passed、0 failed、5 ignored。
- desktop `nuxt typecheck`: exit 0、型エラー 0。
- Playwright: 204 では動かないため未実行（spec と mock のみ）。

## 実測（204）

- center を `--transport http --port 7931` で token 付き起動。
- curl で initialize: 誤った Bearer は 401、Authorization 無しは 401、正しい Bearer は 200。
- Rust client（token 付き）: 正しい token で initialize から tools/call まで通り、`rc_list: []`、`server_list: []`。誤った token では「http://127.0.0.1:7931/mcp が token を受け付けない (HTTP 401)。token が違う可能性がある」で失敗。
- kill 後、7931 の LISTEN なし、プロセス消滅を確認。sandbox による妨害は無し。

## 判断した点

- token が空・短い時: Cork `src-tauri/src/mcp.rs` に合わせた（`MIN_TOKEN_LEN = 12`、`validate_token` が 12 文字未満を拒否、保存値が不正なら起動時に作り直す）。desktop は `load_settings` と `center_set_settings` で空または 12 文字未満なら生成して保存。center は http で token 無し・12 文字未満なら起動しない。認証なしで動く経路は作っていない。
- 接続設定の URL: bind が loopback（`127.0.0.1` / `::1` / `localhost`）なら `127.0.0.1`。wildcard（`0.0.0.0` / `::` / 空）なら UDP socket を既定経路へ `connect` して得た外向きアドレス（パケットは送らない、取れなければ `127.0.0.1`）。それ以外の bind はその値（IPv6 は `[...]`）。
- 旧 `remoteUrl`: 読み捨て。旧値には token が無く移行しても 401 になるだけなので自動移行しない。次の保存で消える。
- loopback 以外の bind: Host / Origin 検査を外し Bearer だけで守る。
- token 欄: 編集可（Cork と同じ）。12 文字未満はエラー表示で保存不可。再生成は即保存・即反映（実行中の center を再起動）。
- 貼り付け解析結果: 編集中の `remote` に入り「保存」で確定。解除ボタンで消せる。

## 未解決

- Playwright は未実行。mac200 での実行が必要。mock の `parseConnect` は Rust 解析の簡易版なので、差があれば spec を調整する。
- Tauri 実機での clipboard 書き込みと `UTabs` の見た目は未確認。
- 複数 NIC / VPN の機では接続設定の URL が意図と違う可能性がある（貼り付け後に URL を直す）。
- TLS は center にも desktop の reqwest にも無く、token は平文で流れる。LAN 外への公開は想定外。
- center `bun test` の `remote-control.test.ts` タイムアウト（既存）。
