# fix: worker の終了（失敗・時間切れ・報告なし）で server が cap を再開する（3a-1）

基点: origin/develop 80bd939110f0d1bc6f743f36d86fd10440ae59a6（clone 時点）。branch fix/server-worker-exit-resume。
実測（claude の resume 等）は別 worker の結果を cap が統合。

## 実装
- `worker-exit.ts`（新規）: 終了の判定・再開の回数・起動時の回収。`daemon.ts` で manager の observer（tracker）を包む。
- `agents.ts`: `finished` の outcome に `timedOut` / `stopped` / `startedAt` を足した（再試行が尽きた後に 1 回だけ呼ばれる）。
- `reports.ts`: `resumeCap`（report と同じ queue に乗る）/ `failTask` / `taskId` / `knownTask`。
- `activity.ts`: `holdCap` / `releaseCap`。`config.ts`: `session.exitResumeMax`（既定 3）, `session.exitRecoverMs`（既定 1 時間）。
- `prompts.ts`: CAP_GUIDE に `[worker 終了通知]` を受けた時の動き 2 行。通知は worker_id・終わり方・error・最後の report の時刻と種類・件数・再開の回数を含む。

## 守る事
1. 判定は finished（maxRetries 尽きた後の最終結果）でのみ行う。timedOut は最終の試行の結果。
2. 報告なし = その run（startedAt 以降）の report 件数。done / ask / approve があれば再開しない（report 側で cap は再開済み）。前の run の done は数えない（test あり）。
3. task ごとの回数（`exitResumeMax`、0 = 再開しない）。超えたら再開せず `failTask`（task_result state=failed + error。task が無ければ error 返信）。task が変われば数え直す。回数は cap の logs/exit-resumes.json に保存。輪の test あり。
4. `hub.resumeCap` → 既存の `deps.invoke`（manager の queue）。cap が turn の途中なら report と同じ順番待ち。
5. `wrap` は inner（tracker の activity 更新）より前に、同期で `holdCap`（cap を running で activity に出す）と resume の積みを行う。偽の center（今の center と同じく、cap・worker が running でなく指示が残っていれば完了を 1 回数える）で、再開あり: cap の turn 前 0 回・後 1 回、上限超過/上限 0: failed activity と task_result の両方が届いても 1 回。center は変更なし・protocol 変更なし。
6. 再起動: 起動時に workers/ を走査し、直近 `exitRecoverMs` 以内に終わった idle（done 無し）/ failed の worker を、保存した state・owner・cap の reports.jsonl から判定して 1 回だけ cap に知らせる。通知済みの印は worker の logs/exit-handled.json（started_at）。停止（STOP_MSG）・cap の会話が無い・古い物は拾わない。
7. protocol.json / PROTOCOL.md / versions.json は差分なし。protocol の test 43/43 pass。center の差分なし。

## 方針の選択（迷った所）
- ask / approve の report があれば「報告あり」とした（cap は既に report で再開されるため二重に起こさない）。
- stopped（stop_cap・worker_stop・server 終了）は再開しない。lost（server 以外の signal）は失敗扱いで再開する。
- 再開を積んだ後 cap の run が始まらず終わった場合は releaseCap で idle に戻す。

## 確認
- server typecheck: 新規の error 0（default-config.test.ts の既知 error のみ）。
- server test: 362 件 pass / 0 fail（新規 worker-exit 9 件 + config 1 件。既存 agents 3 件・config 1 件の期待値を新 field に合わせて更新）。
- 変異: holdCap を外す → center 競合の test が落ちる。`>=` を `>` → 上限 3 件が落ちる。報告なしの判定を外す → 2 件が落ちる。いずれも戻して pass。
- protocol test 43/43 pass。center の test は差分なしのため回さず。
- 偽の center は test 内の関数（実の server・center・broker は起動していない）。試験用 server は起動していない。

## 残った問題
- 実際の claude 経由での挙動確認（cap が通知で worker_start し直す等）は別 worker の結果を cap が統合。
- recover は server 再起動の度に走る。exit-handled が無い古い worker は `exitRecoverMs` 内なら 1 回拾う。

## review 往復 1 回目の対応
1. [medium] 上限超過の経路: `holdCap` → `failTask`（task_result(failed) を先に送る）→ 送り終えたら `releaseCap` の順にした。worker の failed の activity が出る時は cap が running なので center は完了にせず、task_result(failed) が届いた後の idle の activity で、failed の結果として 1 回だけ完了にする。採った理由: center を変えずに「成功扱いの完了が先に届く」余地を無くせるため。偽 center の test に、完了が 1 回で `failed` として届く事（成功扱いが先に届かない事）を追加。failTask の fake は実際の送信に近づけて 1 tick 遅らせた。変異: 上限超過の holdCap を外す → 上限 0 の test が落ちる（戻して pass）。
2. [low] 「再開しない」条件を done のみに揃えた（ask / approve の report だけの run は再開する）。前回は cap が report で再開済みと見て含めていたが、仕様どおり done のみ。test 追加（ask だけでは再開、done で再開しない）。変異（ask を含める）で落ちる事を確認して戻した。
3. [low] recover は state が running のまま残った worker（seedLost 経由で lost 登録される物）を拾わない。これは仕様の範囲の判断（終わった事が state に残っている物だけを対象にする）で、挙動は変えていない。
4. [low] holdCap と resumeCap の呼び出し順の入れ替えは、同期区間で同等のため test で区別されない。対応不要。

確認: server typecheck 新規 error 0 / server test 362 pass 0 fail / protocol test 43 pass。
