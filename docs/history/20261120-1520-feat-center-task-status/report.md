# feat/center-task-status（W2）report

基点: origin/develop 5be8e7427157c02e4e998ef2c40ca27a409d6eca

## 作った物
- packages/center/src/task-status.ts: `buildTaskStatus`（task_status の 1 行）、`limitRemoteList`（session 向け remote_list の上限）
- packages/center/src/tools.ts: session 向けに `task_status` を登録。session 向け `remote_list` を `limitRemoteList` 経由に。外向け（/mcp）の `remote_list` は無変更
- packages/center/test/task-status.test.ts

## 採った判断
- task_status 返り値: `{ at, tasks: [{task_id, remote_id, line}], truncated, omitted }`。line は設計書 3.12 の形から「見込み」を除いたもの（見込みの材料が記録に無いため）。上限は設計書どおり 40 行・6000 文字・1 行 200 文字。古い task から並べ、越えた分は落として truncated=true、omitted=落とした行数。
- 対象は pending（未完了）の task だけ。include_done（完了済み 24 時間）は作らず: 完了後の履歴を center が持っていない（設計書の 3.15 の完了の定義の前）。
- 他 session 遮断は二重: remotes.list の owner 絞り + buildTaskStatus 内で v.session と pending.owner を再確認。
- remote_list（session 向け）: 配列の形は維持（既存の呼び手を壊さないため）。report 本文 300 文字、result / task_result.summary 2000 文字で切る。全体（pretty JSON）が 20000 文字を越えたら、いちばん report を多く持つ cap から古い report を落とし、それでも越えたら result を 200 文字に。切った cap には `truncated { reports_total, reports_dropped, report_texts_cut, result_cut, note }` を付ける（切らない cap は無印）。切った本文には「…(N 文字中)」を付ける。
## 設計書との食い違い
- 設計書の remote_list は `full: true` / `offset` で全文を取れる。指示に無いので作っていない（全文は今は取れない）。
- 設計書の「見込み」欄、include_done は上記の理由で無し。
- remote_list の truncated は設計書の「返り値に truncated」でなく cap ごとの印（配列を保つため）。
- 「完了」状態は pending が残る間は done でも出るが、pending が消えた task は出ない。

## 確認 — 未実施
- bun install が 2 回（各 240〜280 秒）とも `Terminated`（timeout）で node_modules が入らず、typecheck / test / 変異は回せなかった。IPv4 限定の CONNECT 中継を使用。他 worker の bun install も同時に走っていた。
- 従って test は書いたが一度も実行していない。typecheck も未実施。コードの誤りが残っている可能性がある。変異（上限を外す、owner 絞りを外す）も未実施。
## 残り
- install が通る状態で `bun run typecheck` / `node --import tsx --test test/*.test.ts`（packages/center）と変異 2 つ。
