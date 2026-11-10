# session-activity: center 側メモ

## 方式と理由
- 第一候補の hooks で実装。center が wrapper 経由の session 起動時に渡す `--settings`（statusLine と同じ JSON）へ `hooks` を足す。利用者の設定ファイルは触らない（hooks は併合）。
- hook の実体は center のサブコマンド `hook`（statusLine の `status-line` と同じ作り）。session token は env から読む。受け口は `POST /sessions/<name>/hook`。
- 状態は center のメモリのみ。起動時刻ごと。停止・起動し直し・center 再起動は unknown。

## 変更点（packages/center）
- 新規 `src/session-activity.ts`（event→状態、tracker）。`status-line.ts`（hook コマンド・設定 JSON・runHook）、`cli.ts`（`hook` サブコマンド）、`http.ts`（`/hook`）、`remote-control.ts`（--settings に hooks）、`sessions.ts`（`activity` / `activityAt`）、`daemon.ts`（配線）、`events.ts`（`reason: "activity"`）、`tools.ts`（説明）、README。
- `session_list`: `activity`: working|needs-input|idle|unknown、`activityAt`: ISO|null。

## テスト
- typecheck 通過、`node --import tsx --test test/*.test.ts` 全通過（bun が無い環境のため script の中身を直接実行）。
- 追加: session-activity.test.ts、http.test.ts（hook の token 認証）、sessions.test.ts（list 反映）、remote-control-wrapper.test.ts（--settings に hooks）。
- 実 claude（2.1.317, `-p`）で center を別 port・別 data dir に一時起動し（pty wrapper の代わりに claude -p を起動する偽 wrapper）、session_list が unknown → idle（SessionStart）→ working（UserPromptSubmit/PreToolUse）→ idle（Stop）と変わるのを確認。

## 確認できなかった項目 / 残課題
- 対話モードでの needs-input（permission 確認 UI・AskUserQuestion・plan 承認）と Notification の `notification_type` 実値。対話 claude は初回の trust ダイアログで進められなかった。-p では PermissionRequest が発火し PreToolUse(Bash) → PermissionRequest を確認。
- 本物の bantou-pty-wrapper（cargo が無く未ビルド）経由の確認。
- Esc 中断では Stop が来ず、working のまま残りうる。
- 一時 center は messenger の discovery で本物の broker に peer 登録し、server へ hello を送った（起動時の通常動作）。数十秒で停止。
- desktop 側: thread ask(waiting) の needs-input 合成、`reason: "activity"` の SSE 受信での再取得。
