# 報告書: center の sidecar 化と desktop からの起動（Cork 方式）

- 日付: 2026-10-28
- 作成: 204 の remote cap
- 指示書: `docs/history/20261028-1100-center-sidecar/task.md`
- worker: 実装 sonnet（d1-center、d2-desktop、d4-center-fix、d5-desktop-fix）、レビュー opus（d3-review）

## 変更ファイル

- `packages/center/`
  - 新規: `src/args.ts`、`src/http.ts`、`src/parent-watch.ts`、`scripts/build-bin.ts`、`test/args.test.ts`、`test/http.test.ts`、`test/parent-watch.test.ts`
  - 変更: `src/cli.ts`、`src/config.ts`、`src/daemon.ts`、`src/remote-control.ts`、`test/remote-control.test.ts`、`package.json`、`.gitignore`、`README.md`
- `desktop/`
  - 新規: `scripts/build-sidecar.ts`、`src-tauri/src/center.rs`、`src/api/center.ts`、`src/components/SettingsDialog.vue`、`e2e/settings.spec.ts`
  - 変更: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src/api/index.ts`、`src/components/AppHeader.vue`、`src/pages/index.vue`、`src/types/index.ts`、`e2e/mock/bantou.ts`、`README.md`、`CLAUDE.md`
- root `CLAUDE.md`（Map に 1 行）

## コマンド結果

- `packages/center`: `npm run typecheck && npm run build && npm test` → pass 75 / fail 0
- `packages/center`: `npm run e2e`（stdio、stub remote-control + 本物の bantou-server + claude -p）→ exit 0
- `packages/center`: `npm run build:bin`（linux）→ 成功（約 82MB）。repo 外にコピーした binary を `--transport http --port 0` で起動し、SDK Client から `tools/list` で 8 tool を取得、SIGTERM で終了（`file:../protocol` を含む依存の取り込みを確認）
- root: `bun install` → 成功（bun の tempdir が read-only のため `BUN_TMPDIR` / `BUN_INSTALL_CACHE_DIR` を `$TMPDIR` に向けた）
- `desktop`: `bun run build:sidecar` → `src-tauri/binaries/bantou-center-x86_64-unknown-linux-gnu`
- `desktop/src-tauri`: `cargo check` → 成功（警告 4 件は既存ファイル由来）。`cargo test --lib center` → 8 passed。`~/.cargo` が read-only のため `CARGO_HOME=$TMPDIR/cargo-home` で実行
- `desktop`: `bun run typecheck` → exit 0（`vue-router/volar/sfc-route-blocks` の解決失敗の警告のみ）
- `desktop`: `bun run generate` → 成功（sandbox で font 取得先を許可して実行）
- Playwright（`e2e/settings.spec.ts`）: 未実行（mac200 で実行する）

## commit

- `21a0317` Bundle bantou-center as a desktop sidecar (Cork style)
- 本報告書は別 commit。

## 判断した点

- Cork との差: Cork の sidecar は cargo 製の CLI で、アプリからは起動しない（MCP はアプリ内の Rust）。今回 Cork に倣ったのは置き方（`scripts/build-sidecar.ts`、`binaries/<name>-<triple>`）、`externalBin`、`beforeBuildCommand`、設定の持ち方（store の key と status 表示）。
- center CLI: `--port` / `--bind` は stdio でも受け付けて無視する。不正値・不明引数は exit 2。`--port 0` を許可し実ポートをログに出す。
- http: endpoint は `/mcp`。session ごとに McpServer と transport を作り、supervisor と server-link は共有する。認証は無し（README に明記）。
- http の保護（レビュー HIGH の対応）: SDK の DNS rebinding 保護を有効にし、Host を `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`（と非 wildcard の bind）に限定。Origin が付く場合は同じ Host のみ許可。wildcard bind 時は LAN IP 宛の Host が 403 になる。
- http の資源管理: idle 30 分で session を掃除（処理中・GET SSE 中は除外）、上限 32 で超過時 503、body 上限超過は 413。
- http mode は stdin を見ない。親プロセスの消滅（ppid の変化、2 秒間隔）で graceful に終了する。desktop の強制終了で center と remote-control が残る問題への対応。
- env の合成順は `process.env` < `remoteControl.env` < `projects[].env`。合成後に `ANTHROPIC_API_KEY` と `TMUX` を削除する（注入不可）。
- 設定の持ち主は Rust。`@tauri-apps/plugin-store` の JS は依存に無いので、`center_get_settings` / `center_set_settings` / `center_status` の command でやり取りする。保存先は既存 store の key `center`。
- center の config は desktop が `~/.local/share/bantou/center.json` に書き出す。project は全て `autostart: true`（desktop 起動時に remote-control を起動するため）。
- `tauri-plugin-shell` は `=2.3.6`。2.4.0 以降は `tauri ^2.12` を要求し、`=2.11.2` 固定と衝突する。
- shell の capability は追加しない。sidecar は Rust から起動し、webview からは呼ばないため不要（攻撃面も増やさない）。
- 停止: `CommandChild::kill()` は SIGKILL で待機なし（plugin ソースで確認）。そのため pid に SIGTERM、最大 15 秒待って kill。center 自身の停止（子への猶予 5 秒 + 5 秒）より長くした。
- 再起動は enabled / port / bind / projects が変わった時のみ。`remoteUrl` だけの変更では再起動しない。旧プロセスの終了を待ってから起動する。
- build-sidecar の triple は `--target` > `TAURI_ENV_TARGET_TRIPLE` > `rustc -vV` の host。rust triple から bun target へ対応表で写し、表に無いものは error。protocol は毎回 build する。
- bind が loopback 以外の時、設定ダイアログに「認証なしで LAN に公開される」を表示する（入力は受け付ける）。
- `remoteUrl` は保存と表示のみ。

## Mac / mac200 で検証が必要な項目

- `bun run build:sidecar`（`aarch64-apple-darwin`）と `tauri build`。universal build では darwin の 2 triple の binary が要る。
- `tauri dev` の前に `bun run build:sidecar` が必要（externalBin の binary が無いと build script が失敗する）。
- `TAURI_ENV_TARGET_TRIPLE` を tauri CLI が beforeBuildCommand に渡すか（tauri-build のソースでは読まれているが、CLI 側は未確認）。
- sidecar が capability 無しで Rust から起動できること。
- 設定 on で起動時に center が立ち、`http://127.0.0.1:7910/mcp` に MCP client で繋がること。設定変更で再起動、off で停止、アプリ終了で停止すること。
- アプリの強制終了で center が親の消滅を検知して終了し、remote-control の子も止まること。
- 本物の `claude remote-control` の起動（mac の GUI アプリは PATH が最小限で `claude` が見つからない可能性がある。その場合は `remoteControl.claude` に絶対パスを渡す設定が要る）。
- Playwright: `e2e/settings.spec.ts`（`desktop/CLAUDE.md` の手順）。
- 設定ダイアログの見た目と、保存後の status 表示（1 秒間隔で 5 回更新）。

## 既知の問題

- Windows では graceful stop が無く center を即 kill する（README に記載）。
- binary 内の center の version は `0.0.0` になる（package.json を読めないため、README に記載）。
- 歯車ボタンは AppHeader にあるため、workspace 未選択のウェルカム画面からは設定を開けない。

## 片付け

- 削除は permission で拒否されたため未実施。残っている一時ファイルは次の通り。
  - `/tmp/claude-1002/cork`、`/tmp/claude-1002/cargo-home`、`/tmp/claude-1002/bun-cache`、`/tmp/claude-1002/shell`、`/tmp/claude-1002/bin-verify`、`/tmp/claude-1002/readme-edit.cjs`、`/tmp/claude-1002/edit*.mjs`、`/tmp/claude-1002/sc-e2e*.log`、`/tmp/claude-1002/tc.log`、`/tmp/claude-1002/gen.log`
  - 前回分: `/tmp/claude-1002/center-smoke`、`rc-real`、`bantou-center-e2e-pw7lPO`、`e2e.log`、`y.txt`、`center-e2e.log`、`center-e2e2.log`
- 起動したプロセスの残存は無し。
