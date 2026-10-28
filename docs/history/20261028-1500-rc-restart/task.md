# 指示書: center の remote-control 再起動の修正（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-1500-rc-restart/task.md`

お前は remote cap。worker（実装 sonnet、Fable 禁止）に委譲。質問するな。

## 事実（mac200 実機、claude 2.1.312）
- center は再起動時に `claude remote-control --name <p> --spawn same-dir --permission-mode auto --continue` を起動し、`Error: --session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.` で即終了する。再起動が全て失敗して error になる。
- center は project の path を cwd にして起動している。`--spawn` の既定は `same-dir`。

## 要件
1. `packages/center/src/remote-control.ts`: spawn が未指定または `same-dir` の時は `--spawn` を付けない。`--capacity` も未指定なら付けない。この時の再起動は `--continue` を付ける。
2. spawn が `worktree` / `session`、または capacity 指定がある project は `--spawn` / `--capacity` を付け、再起動は `--continue` 無しで起動する（README に理由を書く）。
3. 設定ファイル（center.json）が無い・project が 0 件などで何もしない時も、起動ログに理由を 1 行出す。desktop 側 `center.rs` の autostart で設定が読めない・enabled=false の時、解決したパスと理由を eprintln する。
4. unit test を追加・更新。center の typecheck/build/test、desktop の `cargo check` と `cargo test --lib center`。
5. version を 0.1.8 に（desktop/package.json、src-tauri/Cargo.toml、Cargo.lock）。commit（英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`）、`origin develop` へ push。main は触らない。
6. 報告 `docs/history/20261028-1500-rc-restart/report.md`（commit・push）。

禁止: server/・plugin/、本番 broker、sudo、python、質問。
