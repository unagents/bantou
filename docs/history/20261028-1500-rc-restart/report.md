# 報告書: center の remote-control 再起動の修正（204）

- 日付: 2026-10-28 / 作成: 204 remote cap
- worker: sonnet 1 本

## commit

- `f98e43b` Fix center remote-control restart under claude 2.1.312 and prepare 0.1.8（9 files, +80 / -16）
- 本報告書と task.md は別 commit。main は触っていない。

## 変更

| file | 内容 |
|---|---|
| `packages/center/src/remote-control.ts` | `buildRcArgs`: spawn 未指定 / `same-dir` かつ capacity 未指定なら `--spawn` / `--capacity` を付けず、`--continue` を許す。`worktree` / `session` または capacity 指定ありなら `--spawn` / `--capacity` を付け、`--continue` は付けない |
| `packages/center/src/daemon.ts` | projects 0 件、または autostart の project 0 件の時、理由を 1 行ログ（config が読めない場合は従来どおり致命エラーに理由が出る） |
| `packages/center/test/remote-control.test.ts` | buildRcArgs を 2 test に分割（same-dir / 未指定、worktree / session / capacity）。fixture の `capacity: 2` を外し、再起動の `--continue` test が通常 project で走るようにした |
| `packages/center/README.md` | 引数組み立ての理由（claude 2.1.312 のエラー文）、起動時ログ、`continueOnRestart` 表の注記 |
| `desktop/src-tauri/src/center.rs` | autostart で設定が読めない / `enabled=false` の時、解決した settings store のパス（`app_data_dir/SETTINGS_FILE`）と理由を `eprintln!`。メッセージ生成を `autostart_skip_message` に切り出し unit test 追加 |
| `desktop/package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `bun.lock` | 0.1.7 → 0.1.8（0.1.7 の bump と同じ 4 ファイル。Casks は触っていない） |

## 検証

- `packages/center`: `npm run typecheck && npm run build && npm test` → pass 85 / fail 0
- `desktop/src-tauri`: `cargo check` → 成功（警告 4 件は既存）。`cargo test --lib center` → 11 passed

## 判断した点

- capacity 指定ありで spawn 未指定の場合は `--spawn same-dir` を付ける（`--capacity` と併用のため）。
- `continueOnRestart: true` でも、worktree / session / capacity の project は再起動で `--continue` を付けない（常時 `--continue` 無しの新規起動）。
- desktop の center 設定は capacity を持たないため、desktop 経由の project は spawn 未指定 / same-dir なら `--continue` 再起動になる。

## 環境メモ

- 検証のため `bun install`（sandbox 外）、`packages/protocol` の build、`bun run build:sidecar`（`src-tauri/binaries/`）を実行した。いずれも gitignore 対象で commit していない。

## mac200 で確認が要る項目

- 本物の claude 2.1.312 で、same-dir project の再起動が `--continue` 付きで接続できること。
- worktree / session project の再起動が `--continue` 無しで起動すること。
