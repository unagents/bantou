# 報告: 「セッション追加」に統一する

- 日付: 2026-10-31 / 実行: 204 remote cap（worktree `wt-session-add`、branch `feature/session-add`）
- worker: sonnet 1 本。cargo は `CARGO_BUILD_JOBS=2` / `-j 2`、逐次実行。develop には触れていない。

## commit

- `452bea1` desktop: keep sessions added from the center in memory and reconcile them with session_list（Rust 側。`PmDialog.vue` と `pm.spec.ts` の削除も誤ってこちらに入っている）
- `e25f767` desktop: unify "PM を立てる" into "セッション追加"（フロントと e2e）
- 本 report と task.md の commit（push 時の HEAD）

## 確定事項への対応

1. メニュー統一: `AppHeader.vue` のボタンを「セッション追加」1 つに統一。`PmDialog.vue` を削除。フォルダ未選択でも表示し、center OFF かつ remote 未設定なら無効化して理由を表示。
2. 送り先: `center_mcp.rs` の `select_target` をそのまま使用（無改変）。
3. `AddSessionDialog.vue`: 送り先 center の `session_list` から選んで追加、一覧に無いものは名前を付けて `session_create`。
4. `session.rs`: 追加した session はメモリのみで保持（`sessions.json` を書かない）。
5. 取り直し（`useSessionRefresh.ts`、`index.vue`、`useBoard.ts`）: 画面操作の前（毎回）、スリープ復帰（5 秒後に再取得 1 回）、ネットワーク変化（2 秒で集約）、設定ダイアログを閉じた時（接続先変更・貼り付けを含む）、5 分ごとの保険。同時実行は 1 本。
6. 判定は純関数 `reconcile`: 一覧にある＝状態更新して残す / 一覧から消えた＝「ロスト」/ 問い合わせ不可＝「つながらない」。`SessionColumn.vue` にバッジ追加。
7. messenger peer 登録（`list_peers`、`register_sessions`、登録通知文、不在 TTL / `drop_absent`）を廃止。`instruct_add_task` と `bantou-core` の task / ask / ping は無改変。

## OS 通知の crate

- ネットワーク変化: `netwatcher =0.8.0`。1 crate で Windows（`NotifyIpInterfaceChange` / `NotifyUnicastIpAddressChange`）、Linux（netlink）、macOS（routing socket `PF_ROUTE`）。**macOS は NWPathMonitor ではなく routing socket**（使える Rust binding が無いため置き換え）。
- macOS スリープ復帰: 既存依存 `objc2-app-kit` に `NSWorkspace` feature を追加し `NSWorkspaceDidWakeNotification` を受ける（`workspace.rs` の既存パターン流用）。
- Windows スリープ復帰: `windows-sys =0.61.2`（lock 既出）の `PowerRegisterSuspendResumeNotification`、`PBT_APMRESUMEAUTOMATIC` のみ通知。
- Linux は復帰通知なし（5 分の保険のみ）。

## テスト（204 実測）

- `cargo test -j 2`: 212 passed / 0 failed / 5 ignored（`session::` `os_events::` 16 本、netlink watcher 実起動を含む）。
- `bun run typecheck`: error なし。
- e2e 47 本: `session-add.spec.ts` 13 本は全 pass（一覧から追加、新規作成、ロスト、つながらない、操作前の取り直し）。全体 44 pass / 2 flaky / 1 failed。failed・flaky は `settings.spec.ts`「設定を保存した」の strict-mode 違反で、変更前 HEAD（`23c8eaa`）でも同じ失敗を再現（今回と無関係）。
- e2e は 204 では Chrome 無し・sandbox で nuxt dev の unix socket 不可のため、`nuxt generate` の静的出力を TCP で配信し headless-shell で実行（一時設定はリポジトリ外 or 未 commit）。mac200 での実行は未実施。
- e2e 変更: `pm.spec.ts` を `session-add.spec.ts` に置換。mock を `reconcile` と同挙動に。`board` / `ping` / `session-instruct` spec は center ON の seed（`boardSeed`）で実行。旧 `board.spec` の peer 登録系 3 本を削除。

## 要確認・未解決

- **mac / Windows の `#[cfg]` 部分は 204 でコンパイル未確認**。mac200 が初回コンパイルになる。
- **guardrail が効かなくなる**: `plugin/bantou/scripts/guard.mjs` が `~/.local/share/bantou/*/sessions.json` を読むが、確定事項 4 で書かなくなった。`docs/guardrail.md` `docs/protocol.md` の記述も古い。いずれも未編集（方針判断が要る）。
- 作業 session が「登録済み」と知る手段（messenger の登録通知）がなくなった。登録通知文 `protocol_message` は削除（復元は git 履歴から）。
- 取り直しは操作の前に走らせるだけで、完了を待たずに操作を通す。
- 範囲外の変更: `desktop/README.md` の PM 節を新仕様に差し替え（旧記述が誤りになるため）。
- 別 URL で同じ center と見なす識別子（未実装、案）: center が起動ごとに持つ ID を `session_list` か `initialize` で返し、desktop はその ID で突き合わせる（center 側の変更が要る）。

## 並行作業（develop）との衝突

- `SettingsDialog.vue`、`center.rs`、`center_snippet.rs`、`packages/center/src/http.ts`、`center_mcp.rs` は無改変。
- 衝突しそうな箇所: `src-tauri/src/lib.rs`（`mod` / `manage` / `setup`）、`Cargo.toml` / `Cargo.lock`（develop 側が watcher 類を足す場合）、`src/pages/index.vue`（設定ダイアログ close の監視）。

## 後始末

- 停止: 静的サーバー（bun `:1420`）、playwright は停止済み。`static.ts` `nuxt` `playwright` `cargo` `rustc` の残存なし、`:1420` listen なし。`bun.lock` の変更は戻した。
- **残存（削除が権限で拒否された）**:
  - `desktop/playwright.tmp.config.ts`（untracked、e2e 一時設定）。worker と cap の `rm` 単独実行ともに拒否。
  - 比較用 worktree `/tmp/claude-1002/base`（detached `23c8eaa`、`.nuxt` / `.output` 生成物、`node_modules` への symlink 2 本＝リンク先は `wt-session-add` 実体）。共有 `.git` に worktree 登録あり。削除時は symlink 2 本を先に外し、`git worktree remove --force` 後 `git worktree prune`。
  - `$TMPDIR`（`/tmp/claude-1002`）配下: `ch`（cargo registry 複製）、`bunc`、`ex`、`static.ts`、`run-e2e.sh`、`*.log`、`*.pid` ほか一時ファイル。
- gitignore 済み生成物（残置）: `desktop/src-tauri/target`、`desktop/src-tauri/binaries/bantou-center-x86_64-unknown-linux-gnu`（約 80MB）、`desktop/.nuxt`、`desktop/.output`、`node_modules`、`packages/protocol/dist`。
- worktree 直下の 0 byte の `.bashrc` `.mcp.json` `.idea` 等は sandbox が置くマウント点で、作業物ではない。
