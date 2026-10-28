# 報告: desktop にアップデートチェックとアップデータを入れる

- 日付: 2026-10-29 / 実行: 204 remote cap（worker: sonnet）
- 指示書: `task.md`（同 dir）

## 実施内容

1. updater 本体
   - JS: `@tauri-apps/plugin-updater` 2.10.1 / `plugin-process` 2.3.1 / `plugin-opener` 2.5.4（Cork と同版）。
   - Rust: `tauri-plugin-updater` =2.10.1 / `tauri-plugin-process` =2.3.1 を `lib.rs` で登録。
   - `src/composables/useUpdater.ts`: Cork の useUpdater 相当の状態機械。`main` ウィンドウのみ起動時に自動チェック（更新なし・失敗時は無言）。
   - `src/components/UpdaterToast.vue`（`app.vue` に配置）: Nuxt UI トースト。「再起動して更新」「リリースノート」、進捗、エラー表示。
   - `menu.rs`: アプリメニューに「アップデートを確認...」。`menu:check-for-updates` を emit。手動チェックで最新なら「bantou は最新です」を表示。
   - `src/api/updater.ts` / `src/types/index.ts`（`UpdaterState`）。
2. 設定
   - `tauri.conf.json`: `bundle.createUpdaterArtifacts: true`、`plugins.updater`（endpoint・pubkey は指示書どおり）。
   - `capabilities/default.json`: `updater:default` / `process:default`。
3. release
   - `desktop/scripts/make-latest-json.sh <version> <sig-file> [out]`: platform `darwin-aarch64`、URL `https://github.com/unagents/bantou/releases/download/v<ver>/bantou.app.tar.gz`。
   - `desktop/CLAUDE.md` Release 手順 3・4 を更新（`TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/bantou-updater.key)"`、PASSWORD 空、`.app.tar.gz` / `.sig` / `latest.json` を添付）。
   - `desktop/Casks/bantou.rb`: `auto_updates true`。
4. テスト
   - `e2e/mock/bantou.ts`: `plugin:updater|check` / `download_and_install` / `plugin:process|restart` をモック。
   - `e2e/updater.spec.ts`: 更新ありで通知が出てボタンで download・restart が呼ばれる / 更新なしで通知が出ない。
   - Rust: updater 設定が plugin Config として読めること、capabilities の確認（2 件）。
5. `desktop/README.md` に「アップデート」節。

## 追加修正（指示外だが必要）

- `tauri-plugin-updater` が `reqwest/rustls-no-provider` を有効にするため、`reqwest::Client` 生成時に crypto provider 未設定で panic する（`cargo test` で center_mcp 系が FAILED、アプリも `CenterClient::default()` で起動時 panic）。
- 対策: `rustls` =0.23.46（ring）を追加し、`ensure_crypto_provider()` を `run()` と `broker.rs` / `center_mcp.rs` の Client 生成前に追加。

## 証跡

- `cargo check -j 2`（`CARGO_BUILD_JOBS=2`）: 成功（既存 warning 4 件のみ）。
- `cargo test -j 2`: 207 passed / 0 failed / 5 ignored。
- `bun run typecheck`: TS エラー 0。
- e2e（204、sandbox off、chromium_headless_shell-1243 を一時 config で指定）: 全通し 26 件中 22 passed / 4 failed。
  - `updater.spec.ts` 初回版の 1 件は修正後の再実行で 2 件 pass。
  - `settings.spec.ts` 3 件: `getByText('設定を保存した')` がトーストの aria-live 要素と本体に二重一致する strict-mode 違反。変更前状態での再現確認は未実施。
  - 修正後の全 spec 通しは未実施。

## 未解決・要判断

- `publish-cask.sh` のガード衝突: `auto_updates true` で正本が 2 行増え、行数一致ガード（`line count changed`）と差分 2 行ガードで次回 publish が中止される見込み。tap 側へ手で一度反映するか、ガードを緩めるかの判断が必要（スクリプトは未変更）。
- `settings.spec.ts` 3 件の失敗が既存か本変更起因か未確認。
- `make-latest-json.sh`: `bash -n` のみ。実行テスト未実施。
- `bantou.app.tar.gz` が `bundle/macos/` に出る前提。Mac 実ビルド・実機更新動作は未確認。
- ダウンロード進捗表示は e2e 未検証。
- メニュー文言は日本語（他項目は英語）。
- 残置物: `desktop/e2e/zz-debug.spec.ts`（worker のデバッグ spec、未 commit）、`/tmp/claude-1002/pw.config.mts`（e2e 一時 config）。worker の削除が権限拒否され残っている。

## 範囲外として未実施

- version bump、release、main への push。秘密鍵には触れていない。
