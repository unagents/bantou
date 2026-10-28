# 指示書: desktop にアップデートチェックとアップデータを入れる

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。
- 参考実装: Cork（`/home/vagrant/work/repos/Cork`）の `tauri-plugin-updater`、`src-tauri/tauri.conf.json` の `updater` / `createUpdaterArtifacts`、`src/hooks/useUpdater.ts`、`src/components/organisms/shell/UpdaterToast.tsx`。Cork の挙動に合わせる。

## 内容

1. `tauri-plugin-updater`（Rust と JS）を入れ、Cork 同様に起動時チェックと更新適用（ダウンロード → 再起動）を実装。UI は Cork の UpdaterToast 相当（Nuxt UI で）。メニューにも「アップデートを確認」を置く。
2. 設定:
   - endpoint: `https://github.com/unagents/bantou/releases/latest/download/latest.json`
   - pubkey: `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0OUQ2OTU5QTMyMjg1RjQKUldUMGhTS2pXV21kUk8wZHJ2bkNwMWxxMVlNMWN6N2xaa0JYM2tFWnUzdVU3djBLdXFYb1AwOWYK`
   - `bundle.createUpdaterArtifacts: true`
   - capabilities に updater / process（relaunch）の権限。
3. release 用の手順と script:
   - 署名鍵は Mac の `~/.tauri/bantou-updater.key`（パスワード無し）。build 時に `TAURI_SIGNING_PRIVATE_KEY` に中身を渡す（`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` は空）。
   - `latest.json` を生成する script（`desktop/scripts/`）を作る。入力: version、`bantou.app.tar.gz` の `.sig`、GitHub release の download URL。platform は `darwin-aarch64`。
   - `desktop/CLAUDE.md` の Release 手順を更新（build 時の鍵、release に `.app.tar.gz` / `.sig` / `latest.json` を添付）。
   - `desktop/Casks/bantou.rb` に `auto_updates true` を足す（アプリ自身が更新するため。publish-cask.sh で tap 側にも反映される）。
4. テスト: 既存テストを壊さない。e2e mock に updater の command を足し、更新ありの時に通知が出る spec。Rust は設定の読み込みが通ること。
5. `desktop/README.md` に更新の仕組みを追記。

## 範囲外

- version bump、release、main への push。秘密鍵は 204 に置かない・読まない。

## 報告

- 同 dir に `report.md`。develop に commit・push（push まで必ず）。
