# session-activity-remote（center 側）作業メモ

## 目的
master-cap が remote-cap に仕事を預けて待つ間の状態を、`session_list` の `remote` で desktop に渡す。

## 設計
- `session_list[].remote = { running, waitingReply }`（`RemoteSummary`、remotes.ts の `summary(session)`）。
  - running = session の cap で pending がある server の数。理由: 記録が session × server で 1 件（pending は task ごとに増える）。「どの server が仕事中か」が session 単位の状態として安定し、task を積み増しても表示が増減しない。
  - waitingReply = ask / approve で `replied_at` が無いものの数。動いている cap（pending あり or state running）のみ。止まった cap の未返答を残さないため。
- session と cap の対応の鍵: `RemoteRecord.session`（remote_id = `c-<center-id>-<session>`）。session 無しの旧共有 cap は数えない。
- 返答済み: `workerReply` 成功時、同じ記録・同じ worker_id の未返答 ask/approve に `replied_at`（ISO）を付けて persist（remotes.json）。再起動後も復元。
- SSE: `createRemoteManager({ onSummaryChange })`。`persist()` のたびに全 session の集計を前回通知値と比べ、変わった session だけ呼ぶ。daemon.ts で `events.publish({ reason: "remote", name })`。新しい polling なし。

## 変更ファイル
src/remotes.ts / src/sessions.ts / src/events.ts / src/daemon.ts / README.md / test/remotes.test.ts / test/sessions.test.ts

## テスト
`cd packages/center && npm run typecheck`（OK）、`npm test`（491 pass / 0 fail。追加 6 件）。bun が無いので npm + protocol を tsc で build して代替。

## 未確認・限界
- 実 server・desktop・実 center 常駐との結合は未確認（unit test のみ）。
- worker_reports は 20 件上限。progress 等で押し出された古い未返答 ask は数えなくなる。
- 返答なしで worker が先へ進んだ場合は未返答のまま残る（推測で消さない）。
- 集計の再計算は persist ごとに全 session を走査（記録は少数の前提）。
