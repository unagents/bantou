# session-activity: report

要望: 左サイドバーで、各 session の「作業中 / 判断待ち / 待機」を一覧で確認できるようにする。center 側の詳細は `center-notes.md`。

## 方式（hooks の理由）
- claude の hooks（SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / Notification / Stop など）を center が受ける。center が wrapper 経由の session 起動時に渡す `--settings` に hooks を足す（利用者の設定ファイルは触らない）。
- 画面出力の解析や polling と違い、claude 自身が状態変化を通知するので、誤判定と負荷が少ない。変化時だけ SSE `reason: "activity"` が流れる。
- 状態は center のメモリのみ。停止・error・起動直後・center 再起動直後・hook 未着・config 由来の project は `unknown`（表示しない）。

## 変更点
### center（impl-center, f95de5a）
`session_list` に `activity`（working|needs-input|idle|unknown）と `activityAt`。`GET /events` に `{reason:"activity", name}`。hook 受け口 `POST /sessions/<name>/hook`、サブコマンド `hook`。

### desktop（packages/desktop）
- `src-tauri/src/session.rs`: Session mirror に `activity` / `activity_at`（`Option<String>`、旧 center では None）。
- `src/types/index.ts`: `Session.activity` / `activityAt`、`SessionActivity`。
- `src/composables/useBoard.ts`: `SessionGroup.activity`。center の activity（unknown→null。center に問い合わせ不可・state が connected 以外の session は null）。その session のタスクに status `waiting` の thread があれば、activity に関わらず `needs-input`。`activityCounts`（session 数の集計）。
- `src/components/SessionActivityMark.vue`（新規）: 行の印。作業中=回る `i-lucide-loader-circle`（info）、判断待ち=`message-circle-question`（warning・太字）、待機=`circle-check`（success）。`data-testid="session-activity"` `data-activity`。
- `src/pages/index.vue`: サイドバー上部に集計 1 行（`session-activity-summary`、各 `-working|-needs-input|-idle`、`data-count`）。押すと絞り込み、再度押す／該当 session が 0 になると解除。判断待ち 1 以上は warning・太字。
- `e2e/mock/bantou.ts`: mock の session_list に activity/activityAt。`e2e/session-activity.spec.ts`（新規）。
- `README.md`: 状態の説明を追記。

### 更新経路と負荷
新しい polling は追加なし。既存の `center-sessions-changed`（SSE。reason で絞っていないので `activity` も取り込まれる）と、操作前の取り直し・5 分保険に載る。center からの SSE が届けば即時、届かなくても次の操作で反映。
header の「返答待ち N」は thread 件数、集計の「判断待ち N」は session 数で別物（集計の title にその旨を記載）。

## テスト
- `cd packages/desktop && npx nuxt typecheck`（bun 無し→script 中身を直接実行）: 通過。
- `npx playwright test e2e/session-activity.spec.ts --project=chrome`（bun 無し。`bun build` を esbuild に置換する shim を PATH に置いて実行）: 5/5 通過（3 状態の印、集計、unknown/停止は印なし、waiting thread 合成、SSE activity、絞り込みと自動解除、screenshot）。
- 全 e2e（`npx playwright test --project=chrome --retries=0`、bun 無しのため shim 経由）: **134/134 通過**（17 分、背景実行）。
- 切り分け: 途中の実行で attachment.spec が 5 件落ちたが、playwright を複数同時に走らせて負荷が高かった時の timeout（1 件 25 秒）。変更なし baseline（f95de5a の worktree）でも単独実行で 8/8 通過、変更後も単独で 8/8 通過、全件実行でも通過。この変更に起因しない。
- review 反映後の再確認（docs/コメントのみの変更）: center `tsc --noEmit` error 0、`node --import tsx --test test/*.test.ts` 456/456 通過（protocol を先にビルド）。desktop `nuxt typecheck` error 0、session-activity / board / context-usage の e2e 17/17 通過。
- `cargo test`: この環境に cargo が無く **未実施**。`session.rs` に追加したテスト（`activity_is_read_when_the_center_sends_it_and_none_otherwise`）は未実行。
- center: typecheck / test は impl-center が通過済み（center-notes 参照）。この worker では再実行していない。

## 画面
`sidebar.png`（同ディレクトリ）: 左サイドバー上部に「作業中 1 / 判断待ち 1 / 待機 1」の集計、各行の右に「作業中（回る icon）」「判断待ち（黄・太字）」「待機（緑 icon）」と context %。

## 補足（review 指摘の反映）
- 印を出す条件: center の activity 由来の印は state が connected の session だけ。**waiting thread による needs-input の合成は state に関わらず出す**（意図どおり。ユーザーへの質問が残っているのは session の接続と無関係なため）。
- 集計の「判断待ち」は session 数で、center の needs-input と thread の waiting を同じ 1 に畳む（両方ある session も 1）。ヘッダーの「返答待ち」は thread 件数で別物。
- 更新経路: README の誤記（「center からのイベントによる即時反映は無い」）を直した。SSE `sessions`（reason は created / deleted / restored / updated / context / activity。絞り込みなし）→ `center-sessions-changed` → `session_list` 取り直し。
- `tracker.forget()` は呼んでいない。状態は startedAt ごとに持ち、起動し直すと別物として扱う（get は startedAt 不一致・非 running で unknown）ので表示に影響せず、削除済み session の 1 件分のメモリが center 再起動まで残るだけ。削除経路へ配線する変更は範囲外として見送り（必要なら別 task）。
- center の typecheck / test 456/456 は review worker が再実行して通過。この worker でも center の typecheck / test を再実行した（結果は下記テスト節の末尾）。

## 残課題・確認できなかった項目
- **拒否・中断で状態が残る（実機の対話モード未確認）**: 公式 docs（https://code.claude.com/docs/en/hooks、2026-11-10 確認）では、PermissionDenied は auto mode の拒否のみ（手動拒否では動かない）、PostToolUseFailure は permission 拒否・キャンセルで発火しない、Stop は Esc で発火するか記述なし。拒否・中断の出口になる hook が見つからないため hook の対応表に足していない。影響: PermissionRequest 由来の **needs-input が拒否・中断後も残り**「判断待ち」が出続けうる。working も Esc 中断で残りうる。次の UserPromptSubmit などの hook か idle_prompt で戻る想定だが未確認。時間切れ表示のような仕組みは推測になるので足していない。center README と desktop README にも明記した。
- 対話モードでの needs-input（permission 確認 UI・AskUserQuestion・plan 承認）と Notification の `notification_type` 実値は未確認。
- background task（subagent 等）が Stop の後に動いて hook が来ると working に戻りうる（未確認）。
- 発火時刻が同一ミリ秒の event は到着順になる。
- PreToolUse / PostToolUse ごとに hook サブコマンドが 1 回起動する負荷は未計測。
- 本物の bantou-pty-wrapper 経由の確認（cargo 無し）、cargo test 未実施（session.rs の追加テスト未実行）。
- 実 Tauri アプリでの目視は未実施（Linux の chromium e2e のみ）。
