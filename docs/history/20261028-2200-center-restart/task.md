# 指示書: desktop が center の異常終了を検知して自動再起動する（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-2200-center-restart/task.md`

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止）に委譲。質問するな。

## 事実（mac200 実機、0.1.10）
- center（sidecar）を SIGKILL すると remote-control も止まり孤児は残らない。しかし desktop は center を起動し直さず、アプリを再起動するまで center も remote-control も止まったまま。

## 要件
1. `desktop/src-tauri/src/center.rs`: sidecar の終了を監視する（`CommandEvent::Terminated` 等）。desktop が意図して止めた時（設定 off、設定変更による再起動、アプリ終了）以外の終了は異常終了とみなし、遅延を置いて起動し直す（初回 2 秒、指数で最大 60 秒）。
2. 連続失敗の上限（例: 10 分以内に 5 回）を超えたら止めて status を error にし、設定画面に理由と最終ログ数行を出す。正常に一定時間（例: 5 分）動いたら失敗回数を戻す。
3. status に再起動回数と最終の終了理由（exit code / signal）を含める。
4. unit test（状態遷移、バックオフ、意図的停止との区別）。`cargo check`、`cargo test --lib center`、`bun run typecheck`。
5. version: desktop 0.1.11。commit（英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`）、`origin develop` へ push。main・release は触らない。
6. 報告 `docs/history/20261028-2200-center-restart/report.md`（commit・push）。mac200 で確認すべき項目を書け。

禁止: server/・plugin/・packages/center の変更、本番 broker、sudo、python、tmux、質問。
