# worker の progress report を session へ push しない

branch: fix/no-progress-push（基点 origin/develop 829c3c9）

## 依存の確認結果（結論: 依存なし。直した箇所なし）

- push 分岐は `packages/center/src/remotes.ts` の `onWorkerReport` の末尾だけ。記録（`worker_reports` 積み、`superseded_at`、`persist()`、`wake()`）は push より前に実行され、今回変えていない。
- `waitingReply` / `running`（`summary()`）は `r.worker_reports` の ask / approve（`isOpenAsk`）と `pending` / `stateOf` から計算。push の有無を見ない。progress は元から数えない。
- SSE `reason: "remote"` は `persist()` → `emitSummaryChanges()`（集計が変わった時だけ）。progress は集計が変わらないので元から流れない（test 既存）。push 抜きで保たれる。
- 「未返答（unanswered）」は `isOpenAsk` の `replied_at` / `superseded_at` で判定。progress は superseded を起こさない（既存規則）。push と無関係。
- activity（`agents[].state`）と到達性は `onActivity` / status の経路。worker_report の push とは別経路。`resolveRecord` による受信は変更なし（受信は常に cap 宛の応答として扱う）。feat/remote-visibility の last_ok_at との矛盾なし（受信処理に手を入れていない）。
- desktop は center の記録・summary を読むだけで、messenger push を受けて表示を作る経路は無い（desktop 未変更）。

## 設定

- 名前: config.json の `remotes.pushProgress`（boolean、既定 `false`）。既存の config の流儀（`servers[]` と同じ zod schema、`configPath` からの読み直し）に合わせた。env での上書きは既存の流儀に無いので足していない。
- progress を受けるたびに config を読み直す（読めない時は直前の値、無ければ起動時の `opts.pushProgress`）。true の時は従来どおり同じ worker から 60 秒に 1 回の間引き。
- center の設定のみ。desktop の設定画面・`center_settings` には出さない。

## 変更点

- `src/config.ts`: `remotes` 節（`pushProgress`）。`Config.remotes`。
- `src/remotes.ts`: `pushProgress` opts、`currentPushProgress()`、progress の push を既定で `return`。
- `src/daemon.ts`: `pushProgress: config.remotes.pushProgress` を渡す。
- `src/system-instructions.ts`: master-cap-role を version 1 → 2。「progress は push されない。進捗は remote_list で見る」。
- docs: `packages/center/README.md`（設定表・読み直し・worker_reports・push の説明）、`docs/design/center-tools.md`、`docs/design/system-instructions.md`。
- test: config（既定・指定・不正）、remotes（既定で progress 非 push／ask・approve・done は push／task_result の完了通知は不変／remote_list に progress が残る／true で push＋間引き／config 読み直しで false に戻る／opts 経由）、system-instructions（version 2・文面）、remote-control-wrapper（`master-cap-role@2`）。

## テスト

- `cd packages/center && npm run typecheck`: OK。
- `env -u BANTOU_SESSION_TOKEN npm test`: 560 件中 559 pass、1 fail。
- fail は `rc-orphan`（center を SIGKILL すると rc が孤児で残り…、`タイムアウト: stub A が ppid=1 で残る`）。環境起因。develop 単体（変更を stash）でも同じ 1 件が落ちることを確認。
- desktop は未変更（型変更なし）。version bump・protocol 版・packages/server・bun.lock は触っていない。

## 判断

- 設定の置き場は新設の `remotes` 節（既存に remotes 関連の設定が無かったため）。
- 文面は既定（push しない）に合わせた。true にした利用者には「push されない」と書いた文面が実態と合わなくなる（残課題）。

## 残課題

- `pushProgress: true` の時の master-cap 文面の出し分けは未対応（必要なら `SystemInstructionContext` に足す）。
