# ctx 表示の窓を statusLine から取る（2026-11-04）

branch: `fix/context-window-from-statusline`（origin/develop 起点）

## 不具合

desktop の session の「ctx」が % にならず token 数だけになる。center は transcript の model 名に `[1m]` がある時だけ窓を 1,000,000 とし、それ以外は窓を `null` にしていた。bantou の session は model 名に `[1m]` が無いが 25 万 token 使えている。

## 取り方（実機）

- claude 2.1.317。tmux の中で対話型 claude を `--settings '{"statusLine":{"type":"command","command":"<tee するだけの sh>"}}'` で起動し、stdin を追記保存した。
- `CLAUDE_CONFIG_DIR` を渡さない最初の試行は未ログインで API が通らず、`context_window` が null の形だけ取れた。設定 dir を渡した 2 回目で、API 応答後の値が取れた。
- 同じ実行で確認できたこと:
  - `--settings` は併合: user 側の hook と output style は残った（1 回目の画面で hook の失敗表示と `Concise Plus` を確認）。center が渡すのは `statusLine` のキーだけ。
  - user の `settings.json` には `statusLine` がある（`grep -c` で 1）。それでも `--settings` のコマンドが呼ばれた = **`--settings` の statusLine が利用者設定に勝つ**。
  - statusLine の子プロセスは claude の env を継ぐ（`BANTOU_TESTVAR=secret123` を子が読めた）。token を env で渡せる根拠。
  - `model.id` は `claude-opus-5-5`（`[1m]` 無し）で `context_window_size` は 1000000。不具合の原因（model 名から窓は決められない）の裏付け。窓は最初の API 応答前から入る。

## stdin JSON の実際の形（`context_window` と `model` 部分、実測）

API 応答前:

```json
"model": {"id":"claude-opus-5-5","display_name":"Opus 5.5"},
"context_window": {"total_input_tokens":0,"total_output_tokens":0,"context_window_size":1000000,
  "current_usage":null,"used_percentage":null,"remaining_percentage":null}
```

API 応答後:

```json
"context_window": {"total_input_tokens":58789,"total_output_tokens":178,"context_window_size":1000000,
  "current_usage":{"input_tokens":2,"output_tokens":178,"cache_creation_input_tokens":44861,"cache_read_input_tokens":13926},
  "used_percentage":6,"remaining_percentage":94}
```

- `used_percentage` は**整数に丸められて来る**（58789/1,000,000 = 5.9 → 6）。
- `total_input_tokens` = input + cache_creation + cache_read（58789 = 2 + 44861 + 13926）。output は含まない（docs も同じ）。
- `used_percentage` / `current_usage` は初回の API 応答前と `/compact` 直後に null（docs 記載、前者は実測）。
- 他のキー: `session_id` / `cwd` / `workspace` / `version` / `output_style` / `cost` / `exceeds_200k_tokens` / `effort` / `thinking` / `vim` など。

## 設計と根拠

| 項目 | 比較した案 | 採用 | 根拠 |
|---|---|---|---|
| 窓の取得元 | (A) model 名から推測 / (B) 画面の `/context` を解析 / (C) statusLine の JSON | C | A は `[1m]` 無しで 1M の実例があり決められない。B は画面解析を採らない方針。C は claude 自身が窓を渡す |
| コマンド | (1) `/bin/sh` + `curl` / (2) 一時ファイルに token を書く / (3) center 自身のサブコマンド | 3 | (1) は curl の argv に token が出て `ps` で見える（`-H @file` なら避けられるが一時ファイルが要る）。Windows にも `/bin/sh` が無い（`resolveWrapperPath` は win32 の `.exe` を扱っており center は Windows 対象）。(2) は掃除が増える。(3) は compiled の center 1 本で動き、token は子が env から読む |
| token | env / 一時ファイル | env `BANTOU_SESSION_TOKEN` | `--mcp-config` と同じ起動ごとの使い捨て。argv にも設定にも載せない |
| route | 外向け token / session token | session token | `POST /sessions/<name>/status-line`。外向け token・他 session の token は 401。`/mcp/session` と同じ `SessionTokens.verify(name, …)` |
| 値 | `used_percentage` 利用 / 出し直す | 出し直す | 整数に丸められるため `total_input_tokens / context_window_size` を小数 1 桁。`usedTokens` は claude の式（output を含まない）。transcript 方式は最後の応答の output 分だけ多い（README に明記） |
| null の間 | (A) 全部 transcript / (B) 窓だけ statusLine、tokens は transcript | B | 窓が分からない問題そのものを、`--continue` 直後（過去の transcript はあるが API 応答前）でも解く |
| 優先 | — | statusLine > transcript | statusLine に使用量がある間は statusLine。無い間は transcript（予備） |
| 再起動 | — | statusLine の値も捨てる | 既存 tracker と同じく `startedAt` の変化で捨てる。POST 時に `startedAt` を記録するので、再起動直後の POST が掃除で消えない |

コマンドの実体: `'<center>' 'status-line' '--url' '<center>/sessions/<name>/status-line'`（各引数を quote。node / bun で動かす dev では script と execArgv も付く）。stdout には何も出さず（statusLine 表示は空）、失敗は stderr に 1 行、終了コードは常に 0、タイムアウト 2 秒。compiled バイナリでの実測は 1 回約 150ms（claude は 300ms の debounce で呼ぶ）。

利用者の statusLine 設定より center のものが master-cap で優先される旨は `packages/center/README.md`（「context 使用量」の「statusLine 方式」・「master-cap の起動（wrapper）」）と `docs/design/master-cap-session.md` 決定 17 に書いた。

## 利用者から見える副作用

- master-cap の端末では、statusLine を設定していなかった利用者でも、footer の `esc to interrupt` や `? for shortcuts` などの hint が消える（docs 記載の claude の仕様。実機では未確認）。

## 変更しなかったもの

- desktop（表示・Rust・型）。center は `contextUsage.model`（statusLine 由来の時だけ）を足すが、desktop の Rust は未知のキーを読み捨てる（`deny_unknown_fields` 無し）ので混在しても動く。「1M」の表示は今のまま。
- protocol。version。config の項目（statusLine の設定は足していない）。

## テスト

| 対象 | 結果 |
|---|---|
| center `bun run test` | 331 件 pass（変更前 320 件。+11: status-line 6、http route 3、tracker 2。既存の wrapper テスト 2 件は期待値を更新し `--settings` の組み立てを足した） |
| center `bun run typecheck` | 通過 |
| server `npm test` | 204 件 pass |
| server `npm run typecheck`（nuxt prepare + tsc） | 通過 |
| desktop `bun run build:sidecar` | 成功（rustc は `~/.cargo/bin` を PATH に足して実行） |
| `src-tauri` `cargo test` | 261 件 pass、5 ignored、0 failed |
| desktop e2e（`context-usage.spec.ts` のみ） | 4 件 pass |
| compiled の center で `status-line` サブコマンド単体 | モックサーバーに `POST` + `Bearer` + 本文が届くことを確認 |
| 実機の通し（claude → statusLine の quote 済みコマンド → compiled center のサブコマンド → モックへ POST） | claude を `--settings` の statusLine（`'<center>' 'status-line' '--url' '<mock>'`）と env `BANTOU_SESSION_TOKEN` で起動し、モックに `Bearer <env の token>` 付きで JSON が届いた。`--remote-control` は付けていない（Linux のみ） |

追加したテスト（center）:

- JSON 受信で更新: `POST /sessions/<name>/status-line` が 204 で `onStatusLine` に渡る / `tracker.applyStatusLine` が値を更新し、変わった時だけ onChange。
- 401: A の token で B、外向け token、token 無し、不正 token、token の無い session 名。
- 壊れた JSON / object 以外は 400、`center.log` に `statusLine の JSON が不正: session=<name>`、反映しない。
- statusLine が無い間は transcript（窓は不明）。`used_percentage` null の間は窓だけ補う。値が入れば statusLine が優先。再起動で捨てる。
- `buildWrapperArgs` の `--settings`（位置・無指定で付かない）、wrapper 起動の引数（`--settings` は `statusLine` のキーだけ、token は argv に無い）、窓口が無い時は付けない。
- サブコマンドの quote（空白・`'`・win32）、`runStatusLine` の POST / 失敗時の終了コード 0。

e2e は center の変更が desktop に影響しない（desktop 無変更）ため最小限（ctx 表示の spec のみ）。center デーモンを実際に起動して claude の statusLine から受ける通しは行っていない（claude → サブコマンドは上の実機で、サブコマンド → route は http テストで、それぞれ確認）。Windows での statusLine の実行・quote は未検証。

e2e の実行方法（204 は Chrome が無く nuxt dev が sandbox で動かない）: `bun run generate` の `.output/public` を簡易 node 静的サーバー（127.0.0.1:14999）で配信し、一時の `pw.config.mts`（`baseURL` と ms-playwright の chromium を指定、`webServer` 無し）で実行した。config は作業 dir の `tmp/` に置き、commit していない。

## 残存物

- 一時物は作業 dir 内: `tmp/`（capture 用 tee.sh・stdin.jsonl・env.txt、compiled の center、mock / 静的サーバーの js と log、pw.config.mts）→ 最後に `find -delete` で削除。
- clone 内の ignore 済みの生成物: `packages/desktop/.output/`、`packages/desktop/node_modules/.cache/bantou-e2e/`（mock bundle・test-results）、`src-tauri/binaries/bantou-pty-wrapper-*`、`src-tauri/target/`、`packages/pty-wrapper/target/`、各 `node_modules`、`packages/protocol/dist`。
- clone の外: capture 用に起動した claude が作った transcript dir `$CLAUDE_CONFIG_DIR/projects/-home-vagrant-work-bantou-server-ws-workers-w-ctx-tmp-proj/` （確認済み）。作業 dir の `tmp/proj` を trust したので、設定 dir の `.claude.json` に project の記録がある可能性がある（未確認、中身は読んでいない）。削除は cap に委ねる。
- プロセス: tmux session `ctxcap`、静的サーバー、モックサーバーは停止済み（ポート 14999 / 47911 解放確認）。
