# no-progress-push の merge（merge/no-progress-push）

- 基点 origin/develop = 5976dd3ca1e3a744513ae7d9428391e3626e272f、fix/no-progress-push = aef7e5cd9c834b263c45d28b1a9c50e64f530ed2（どちらも想定どおり）。
- `git merge --no-ff origin/fix/no-progress-push`。merge commit を残した（rebase なし）。

## 衝突と解消

- 衝突は `packages/center/src/remotes.ts` の 1 か所（`createRemoteManager` の opts 型）だけ。develop 側の `ackTimeoutMs`〜`reachRequestDelayMs` 群と、branch 側の `pushProgress` を両方残した。
- `onWorkerReport` は自動 merge。結果は「`markOk(r)` → task_id の `markObserved` → superseded → 記録積み・persist・wake → progress の push 判定 → 通知」の順。

## (a)〜(d)

- (a) progress の push 停止（`currentPushProgress()` が false なら return）は `markOk` と `markObserved(…, "task_id")` の後ろ。push しなくても到達性（last_ok_at）と delivery（delivery_basis: task_id）は更新される。test 追加: `remote-visibility.test.ts`「progress の worker_report は push されない既定でも…」（観測・last_ok_at 更新・worker_reports に残る・push 0 件）。
- (b) opts 型に両方残った。daemon.ts も自動 merge で `pushProgress` 追加が残っている。
- (c) 間引きの時計を `Date.now()` から `nowMs()`（`opts.now ?? Date.now`）に変更。test 追加: `remotes.test.ts`「progress の間引きは opts.now の時計で動く」。
- (d) 既存 test の期待値は変更していない（追加のみ）。

## テスト

- `npm run typecheck`: OK。
- `env -u BANTOU_SESSION_TOKEN npm test`: 577 件中 576 pass、1 fail = rc-orphan（環境起因。develop 単体でも落ちる）。
- test 関数数（packages/center/test, `^\s*(test|it)\(`）: merge-base 557 / origin/develop 572 / fix/no-progress-push 560 / merge 後 577。develop 572 + branch の増分 3 + 本 merge の追加 2 = 577。消失なし。
- `git grep` の衝突マーカー: コード・docs/design には無し（過去 report の文言のみ）。
- numstat: README 4+/2-、docs/design 各 1〜2 行の置換のみ。不自然な削除なし。packages/desktop・server・protocol・bun.lock は差分に含まれない。

## 残課題

- `pushProgress: true` の時の master-cap 文面の出し分けは未対応（前回 report と同じ）。
