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
- 集計の再計算は persist ごとに全 session を走査（記録は少数の前提）。

## 追加: 返答なしで先へ進んだ ask / approve の解消（superseded_at）
- 規則: onWorkerReport で、同じ記録（= 同じ cap）の同じ worker_id の未返答（replied_at / superseded_at 無し）の ask / approve に、progress 以外の report（done・新しい ask / approve）が来たら `superseded_at`（center の時刻、ISO）を付ける。waitingReply は replied_at も superseded_at も無い ask / approve だけ数える。
- progress・別 worker・別 cap(別記録)は解消しない。返答済み(replied_at)には付けない。
- 注意: protocol の WorkerReportKind は progress / ask / approve / done の 4 種で failed は無い。条件を「progress 以外」にしてあるので、failed 相当が done で来る場合も、将来 kind が増えても解消になる。test は未知 kind "failed" でも確認。
- 保存: worker_reports の一部として remotes.json に保存（再起動後も保たれる。test 済み）。remote_list の worker_reports にも出る。
- SSE: 解消で集計が変わる時だけ persist 経由で reason "remote" が 1 回。変わらない時（既に解消済みの後の done など）は流れない。
- 20 件上限との関係: 古い順に捨てるので、押し出された ask は記録ごと消え数えない(解消の有無に関係なく)。progress が 20 件続くと未返答の ask が押し出される限界は残る(上限のロジックは変えていない)。解消済みの ask が先に押し出される分には集計に影響しない。
- テスト: test/remotes.test.ts に 4 件追加。

## 追加: review 指摘の反映
- 「動いている cap」の判定: `r.state === "running"` をやめ、`remote_list` と同じ `stateOf(r) === "running"`（inflight / settling / activityBusy を含む）に揃えた。`pending.length > 0` との OR は残す（running の数え方は pending のまま）。揃えなかった点: `running` は stateOf ではなく pending の有無（session の「預けて待っている」を表す。stateOf は cap の turn が終わった後も worker が動く間 running になるが、その時点で pending が残っていれば同じ。pending が空で stateOf だけ running の場合は running には数えず、waitingReply のみ数える）。
- 通知漏れ: activity / settling / inflight の変化は persist を通らないため、`wake()`（変化点で呼ばれる）の中でも集計を再評価し、前回通知値と違う session にだけ onSummaryChange を呼ぶ（restore 中は飛ばす）。変化が無ければ流れない。inflight / settling は pending が非空の時にしか立たないので、pending が空のまま stateOf が running になる経路は activity だけ（test はこれ）。
- worker_reply の競合: 送る前に返答待ちの ask / approve を確定し、成功後はその分だけ replied_at を付ける（送信中に解消された分には付けない）。送信中に届いた新しい ask は返答待ちのまま。
- restore 時の一斉通知: 直さない。restore は http 起動後に非同期で走り、起動直後に接続済みの受け手は復元前の 0/0 の一覧を持っているので、復元後に集計が 0 から変わった session へ `remote` を 1 回流す方が正しい（基準値を通知済みにすると取り直されず古いまま）。通知は session ごとに 1 回で、test で確認。
- テスト: typecheck OK、npm test 498 件。ホスト負荷が高い時（load 7 前後）に core SSE の test と remotes の timing 依存の test が落ちることがあるが、変更前（stash）でも core SSE は落ち、負荷が下がった再実行で全件 pass した。
