# change 単位の step 消化・門・資源管理（設計）

- 作成: 2026-11-23
- 基点: `develop` 4d98817（server 0.6.12）。code の記述は branch `docs/worker-gate-review`（ecd96f9）の tree を開いて確かめた。
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file`。repo root からの path。行は変わりうるので関数名・定数名を主に書く）。【推測】は確かめていない解釈。【利用者の見立て】は利用者が言った事で、確かめていない物。【openspec-mcp 待ち】は openspec-mcp の project が決める事、または確かめられない事で、この設計書では決めない。決まっていない点は「未決 #N」（9 節）。
- 関係する設計: `docs/design/guardrail-schema-server.md`（`origin/docs/guardrail-schema-server`。guardrail の設定と schema の MCP server。進行中）、`docs/design/cap-orchestration.md`（今の remote-cap のルール）、`docs/design/center-tools.md`、`docs/architecture.md`。

## 0. 利用者と決まった事（原文つき）

1. server の仕組みの方向。
   > serverをworkerを起動するだけの仕組みに集約し、workerコントロールはcenter側のcapが受け持つ

   remote-cap（server 側の判断の層）は無くす。以下、「center 側の cap」は **master-cap**（決定 14）。
2. 門（ゲート）の持ち方。
   > 直しと再review部分をopnespec−mcpのschemaで担保するような構造にし、serverはopenspec-mcpを機械的に実行させる事で、server側のworker起動をゲートクリアで賄わせる
3. review の置き方。
   > reviewについては、openspecのschemaのtasksの終了条件にreview 指摘0件を条件化して置いておく。wokrkerセッションはopenspecのインストラクションに従って作業するので、tasksのreview 指摘0件を終了ステータスにする前に、サブエージェントでreviewerを起動する形
4. 指摘の数え方（利用者が「一旦それでok」）。重さ（high / medium / low）ではなく、機械的に判定できる基準に当たる指摘が 0 件で完了。基準は次の 3 つ。
   - 仕様・決定と食い違う
   - test が落ちる、または足した test が変異で落ちない
   - 指示した範囲の外を変えている

   それ以外は報告に残すだけ（完了を止めない）。この基準は bantou の仕組みではなく、**schema 定義の中身**（5 節の例に入る物）。server は解釈しない。
5. schema 定義の足し方。bantou の guardrail の設定で足し、bantou の schema の MCP server から openspec-mcp に渡る。設計は `docs/design/guardrail-schema-server.md`。openspec-mcp の側の設計の出典は、vault のノート（名前は利用者の言葉のとおり。本書では参照しない）。プロトコルは openspec-mcp の project が決める。
6. 順番。
   > reviewの仕組みの話は、gardrail機能の実装が終わって、schema定義を、bantou上で保守管理出来るようにしてからの話

   実装はその後。設計は並行で進める（この設計書がそれ）。
7. 往復の上限について（master-cap の問い「直しと再 review の往復に回数の上限を置くか」への返事）。
   > それはschemaの責務じゃないの？
8. worker の役割。
   > workerは基本tasks.mdとかで規定されてる作業実行が普段の役割
   >
   > 極論だけど、一旦server側のworkerはtasksステップを実行すると仮定する
   >
   > workerの作業範囲は、1 step範囲内が基本
9. cap が server に頼む形。
   > 正確にはworker起動の依頼ではなく、changes単位でのstep消化をserverに登録する？みたいなイメージ
10. 登録と門。
    > serverに対してchangesを登録する時に、消化stepをscopeとして登録する。
    > schemaの組み方で、ゲートクリアの仕様はどのようにも組める想定。
    > 1. tasksの中でreviewのサブエージェントの実行をタスクとしてインストラクション指示にする。reviewのサブエージェントによる、tasksの中の1作業に完了フラグを付けるには、インストラクション指示による条件クリアが居る。クリアできるまでworkerは継続して作業する
    > 2. stepをscopeで渡す場合、serverは、step1をworkerに作業させる。終わったらstep2をworkerに作業させる。openspecはvalidateを使って、stepの終了とかは判定できたはず。これを、serverが実行して終わりの判定をserverが機械的に制御できるようにする。
11. worker の質問と状態。
    > workerによる質問等のメッセンジャー返答は、今の仕組みをそのまま使える想定。serverがやる事として、workerがどういう状態で今居るのかをserver自信が状態管理を保つ必要は出てくる。workerが質問をcapに投げた際、workerセッションは一時的にcloseして、質問がcapに変える。capが質問に回答したら、serverはそれを受け取って、対応するworkerセッションを再起動。stepの位置はworkerのsession−idと紐付けて持ってる必要がある。
12. 資源の管理。
    > serverが管理するもう一つ重要な責務として、リソース管理がさらに必須になる。serverはメモリやプロセス状況を保持して、workerの並行実行に対して責任を保つ必要がある。capからのworker依頼はキューに溜めて処理する必要も出てくる

13. server の変更。
    > さらにserverへの変更点。serverもopenspec-mcpを追加として入れ、schema-serverのheader指定で、centerを指定するように全serverで変更が必要になる

    master-cap の問い（各 server の上でそれぞれ openspec-mcp を動かすか、1 つを全 server が共有するか）への返事は「B」。openspec-mcp は **1 つ**で、全 server がその 1 つにつなぐ。
14. 「center 側の cap」は何か、への返事。
    > 1はAの想定。但しセッション起動の仕組みとかを変更する予定

    A = 各 project の master-cap が、change の登録と worker の質問への返答を直接受け持つ。
15. session の起動の仕組み（設計はまだ落としきれていない、と利用者が断った上での話）。
    > remote-controlとの兼ね合いがあるからまだ設計落としきれてないが、セッションを起動し続けるという仕様は変更するつもり。projectを管理するcapが対応するという基本形は維持しつつ、セッション作業を毎回クリーンコンテキストをスタートで開始する方向に変える予定
16. openspec-mcp を使った作業の流れ。
    > 仕組みの仕様変更は後でいいとしても、openspec-mcpを使っての作業フローの確立は必要になると踏んでる。master-capがやらなければ行けない作業範囲に、proposal, design, tasksの作成等が入ってくる。対応としては、並行セッションに分解して進めるという方針で良いのだが、openspec-mcp基盤での仕様・設計の知見の永続化が今の基盤に乗ってくる形になるはず。
17. 進め方の例（master-cap の問い「master-cap は proposal まで書き、design と tasks は code を読める並行の session に書かせるか（A）、master-cap が design と tasks まで書くか（B）」への返事）。
    > Aかな。さっきのserverにstepを渡す形で、designとtasksまで1回踏む。帰ってきたらcapが中身をreview。内容が問題なければ、もう一度serverに、tasksの実行をstepで渡すとかか？
18. 17 への補足。
    > 弱冠の補足が居る。まず、proposal自体もremote-capに対応させるっていうのはNGではない。artifactの中身のreviewやチェックタスクをMaster−capが絶対にやらなければいけない事にもしない。サブエージェントを使う等は選択肢にある。master-capの決めで重要な事はどの作業を誰がどこでやるのが適切か？どこまでをどう進めるのが効率的化？の作業全体の設計への注力が重要。また小さな直しへの答えとして、schemaに何を選ぶかをchangeの作成段階でmaster-capが判断する事も作業全体の設計によりうまく進むかを決める重要なファクターになる

### 前提（決定 15）

session の起動の仕組みは変える予定で、毎回きれいな context から始める方向にある。設計は未確定で、この設計書では扱わない。状態を会話の外（server の change の記録・openspec-mcp の change）に持つ今の設計は、その方向と合う。

### 利用者の決定と、この設計書の案の区別

- **利用者の決定は、上の 1〜18 の原文だけ**。それ以外は、この設計書の案・推奨・読みで、利用者の決定ではない。
- 決定から出る形（本文に書く）: master-cap（14）は worker を起こさず、change に消化する step の範囲（scope）を付けて server に登録する（9・10）。server は登録を queue に溜め、資源を見て並行の数に責任を持って worker を起こし、worker は 1 step を実行し（8）、step の終わりは server が機械的に判定して次の step の worker を起こす（10・12）。門の中身（review・往復の上限・指摘の数え方）は schema の組み方で、bantou の仕組みは持たない（2・3・4・7・10）。worker の質問は今の messenger の仕組みで、server が worker の状態と、session-id に結び付けた step の位置を持つ（11）。全 server が 1 つの openspec-mcp につなぐ（13）。master-cap の仕事に proposal・design・tasks の作成が入り、並行の session に分けて進める（16〜18。8 節）。
- 10 の 1 と 2 は「schema の組み方で作れるゲートの形」として並べられている。**どちらかを選ぶ事も、どちらかに決める事もしない**。併存できる物として書く（3.4）。
- 「step の終わりを validate で判定できたはず」は利用者の見立て。今の openspec と openspec-mcp で何が出来るかは 3.4 に書く（この設計を書いた環境では確かめられなかった）。
- server が openspec-mcp を実行する契機・形式・門が開かなかった時の openspec-mcp 側の扱いは、openspec-mcp のプロトコルが決める（【openspec-mcp 待ち】）。

### この設計書の範囲

- 1〜18 を、今の code の上でどう置き換えるかを書く。5 の guardrail 側の設計は上記の別設計書に任せ、ここでは「そこに足す定義の例」だけを書く。
- **openspec-mcp のプロトコルの中身（呼び出しの形式・返り値の形・header・step の指し方の形式など）は決めない。openspec-mcp が決める**。本書で「openspec-mcp を実行する」「終わりを判定する」と書く所は、その形が出てから具体にする（【openspec-mcp 待ち】）。
- 利用者が話に出していない事は、仕様にも未決にも足さない。

## 1. 今の形

### 1.1 server（`packages/server/`）が持つ物

【事実】server の実行層は `packages/server/server/utils/bantou/` にある。責務は `docs/architecture.md` の「server の実行モデル」に 5 つ書かれ（center との窓口、cap の起動と resume、cap の依頼による worker の起動・状態・停止、worker からの報告の受け口、生存・進捗の通知）、code では次に分かれる。

| 責務 | 置き場（`packages/server/server/utils/bantou/`） |
|---|---|
| remote-cap の起動・resume・会話 | `agents.ts`（`createAgentManager`）、`claude.ts`、`conversation.ts`、`lane-meta.ts` |
| cap の指示文 | `prompts.ts`（`CAP_GUIDE`、`buildTaskPrompt`、`extractTaskResult`、`buildTaskResult`）、`packages/server/instructions/remote-cap.md`（`[役割]` `[自分の層で直し切る]` `[完了の判定]` `[見張り]` `[残った問題]` `[窓口を預かっている時]`）、`packages/center/instructions/common.md`（cap と worker に共通） |
| task の受け・並行 | `tasks.ts`（`createTaskScheduler`。task ごとに cap の指揮の run を持つ） |
| worker の起動・状態・停止 | `workers.ts`（`createWorkerHub`。`readOwnerRecord` / `writeOwner` で worker の持ち主 cap と task を `logs/owner.json` に残す）、`reservations.ts`（`createReservationQueue`。`worker_start` の `reserve: true`） |
| worker の report の受け口 | `reports.ts`（`createReportHub`、`buildReportPrompt`、`REPORT_KINDS` = progress / ask / approve / done） |
| worker が終わった時の cap の再開 | `worker-exit.ts`（`createWorkerExitWatcher`、`buildExitPrompt`） |
| cap・worker に出す MCP | `mcp.ts`、`server/routes/mcp.ts`（Nitro の `/mcp`。header `x-bantou-cap-id` / `x-bantou-worker-id` / `x-bantou-task-id`） |
| 生存・掲示板・資源 | `activity.ts`、`board.ts`、`resources.ts` |
| 掃除・更新・退役 | `cleanup.ts`、`update.ts`、`retire.ts` |

### 1.2 worker の起動・停止・依存・報告の流れ

【事実】

1. 利用者 → master-cap → center の `remote_send`（`packages/center/src/tools.ts`。入力は `remoteSendSchema`、処理は `remotes.send`）。center が `task_id` を採番し、protocol の `task`（`packages/protocol/src/server.ts` の `TaskCommand`）を server に送る。
2. server の `createTaskScheduler().submit` が task を受け、`buildTaskPrompt`（`prompts.ts`）で remote-cap の最初の指示を組み立て、cap（`claude -p`。`CAP_GUIDE` を system prompt に付ける）を task ごとの指揮として動かす。
3. **cap が判断する**: cap は `CAP_GUIDE`（`prompts.ts`。正本は `docs/design/cap-orchestration.md`）に従って分担を判断し、`mcp__bantou__worker_start` で worker を起動する。`worker_start` は `registerWorkerTools`（`mcp.ts`）にあり、`createWorkerHub().start` が worker（`claude -p --output-format stream-json`）を起こして `{worker_id, accepted}` をすぐ返す。同じ `worker_id` を渡せば続きの指示（`--resume`）。
4. 停止・状態: `worker_stop`（`createWorkerHub().stop`）、`worker_status`、`peer_status`（host の負荷・件数の掲示。1.5）。
5. **依存（`depends_on`）は server が強制していない**: `depends_on` は `TaskWorkerItem` の項目で、`buildTaskPrompt` が `depends_on=<id,...>` を cap の指示文に文字で書くだけ（`prompts.ts` の `[分担]`）。完了を確認して次を起こすのは cap の判断。
6. review: `CAP_GUIDE` の `[分担]` が「review の指摘は、実装 worker に同じ worker_id で worker_start して戻す。直るまで回す。実装と review の往復は最大 3 回」と cap に指示する（`prompts.ts`）。review worker も server 側の worker。
7. 報告: worker は `report`（`kind`: progress / ask / approve / done、`text`）を呼ぶ（`mcp.ts`。tool の説明は「すぐ accepted を返す。呼んだら turn を終える」）。`createReportHub` が受けて、(a) cap を `--resume` で起こし（prompt は `buildReportPrompt`）、(b) center に `worker_report` 通知を送る。worker が report せずに終わった時は `createWorkerExitWatcher` が cap を起こし直す。
8. 完了: cap の最終返答を `extractTaskResult` / `buildTaskResult`（`prompts.ts`）が `task_result`（worker ごとの branch / commit / tests、`review` の `verdict` と `items[].severity`（`ReviewSeverity` = high / medium / low）、`remaining`）にして center に返す。
9. center 側の返答: ask / approve には `worker_reply`（`tools.ts`、処理は `workerReplyHandler`）。protocol の `worker_reply` を server の `daemon.ts` が受け、**`workers.start(cmd.cap_id, { worker_id, prompt: text })` を呼ぶ**（持ち主の cap でなければ「別の cap の worker」で失敗）。

### 1.3 center が持つ物（`packages/center/src/`）

【事実】

- master-cap（center の session。`packages/center/instructions/master-cap.md`。節は `[利用者とのやりとり]` `[判断の材料]` `[始める時]` `[委譲]` `[待ち方]` `[窓口を預ける時・戻す時]`）は center の `/mcp/session` の tool を使う。worker に関わる物は全部 **remote-cap（server 側）を宛先にしている**:
  - `remote_send`（別名 `remote_create`）: server の remote-cap に task を送る（`remotes.send`）。
  - `remote_list` / `task_status`（`buildTaskStatus`、`task-status.ts`）/ `remote_wait`: cap と task の状態・結果・report・pending。`remote_wait` は「cap が idle で、配下の worker が running / stalled でない」まで待つ。
  - `worker_reply`: worker への返答。
  - `remote_delete`: cap を閉じる（protocol の `stop_cap`）。
  - `worker_resume`: protocol の `resume_worker` を送る tool（`server-link.ts` の `resumeWorker`）。**ただし server は受けない**: `daemon.ts` の `execute` は `resume_worker` を `throw new Error("resume_worker は未対応")` で拒否する（「worker は cap の依頼（/mcp の worker_start）で起動する。型は protocol に残るが center からの指示としては処理しない」とコメントがある）。center から server の worker を直接動かす経路は、今は無い。
  - `server_list` / `server_peers` / `server_status` / `server_retire`: server の発見・版・状態・退役。

### 1.4 今、cap に依っている物

【事実】cap が無くなる時に付け替えが要る物。

- `workers.ts` の `createWorkerHub`: `start` / `status` / `stop` が `capId` を取り、`requireCap`（`<workspace>/caps/<cap_id>/` が無いと投げる）・`requireOwned`（`logs/owner.json` の `cap_id` で持ち主を確かめる）・cap / task の `worker_model` の既定（`readModelRecord`）・予約（`Reservation.capId`）が cap に依る。
- `reports.ts`: `report(capId, workerId, ...)`、`laneOf`、通知先 center の記録（`rememberCenter`、cap の dir の `logs/center.json`）が cap に依る。
- `mcp.ts` の `report` tool: header `x-bantou-cap-id` と `x-bantou-worker-id` の両方が無いと拒否する。`worker_start` 等は「cap（cap-id があり worker-id が無い接続）」にだけ載る。
- protocol: `AgentActivity.cap_id`（必須。「cap 自身、worker では持ち主の cap」）、`WorkerReportNotice.cap_id`、`TaskCommand` / `WorkerReplyCommand` / `StopCapCommand` の `cap_id`。
- 通知先の center は、cap の dir に結び付いて覚えられている（`rememberCenter` / `noteCenter`）。

### 1.5 今の資源と並行の扱い

【事実】

- `resources.ts` の `createResourceMonitor`: host の load・メモリ・disk を測って掲示するだけ。「閾値を持たず、足りるかを判定しない（判断は cap）」とコメントにある。測定は周期（`sampleMs`）でも行うが、予約の起動の契機ではない。
- `reservations.ts` の `createReservationQueue`: cap が「資源が足りない」と判断して `reserve: true` を付けた `worker_start` だけが queue に入る。動いている worker が 0 本ならすぐ起こし、そうでなければ貯めて、worker が 1 本終わるたび（`workerEnded`）に先頭から 1 本起こす。ファイル（`<workspace>/reservations.json`）に残し、再起動後も有効。足りるかは判定しない。
- `tasks.ts` の `createTaskScheduler`: task の並行は **cap ごと**で、上限は利用者が config の `session.maxParallelTasks` を置いた時だけ効く（既定は上限なし）。worker の本数には上限が無い（`worker_start` の説明に「The server never limits how many workers run」）。
- `peer_status`（`mcp.ts`）と `board.ts`: host の worker の数・予約の数・資源・`max_parallel_tasks` を cap に見せる。判断は cap がする。

### 1.6 今の worker の session

【事実】

- worker ごとに `<workspace>/workers/<worker_id>/state.json`（`state.ts`。`session_id`・`state`・`last_started_at` など）がある。`agents.ts` の run は `mode = st.session_id ? "resume" : "new"` で、session があれば `--resume` で続きを起こす。
- worker は `report` を呼んだら turn を終える（`report` tool の説明）。つまり ask / approve を出した worker の process は、今すでに終わっていて、session_id だけが state.json に残る。返答（`worker_reply`）は、同じ `worker_id` で `workers.start` し、この session を起こし直す。
- 【事実】ask の経路は tool としては在るが、`packages/server/instructions/worker.md` の `[進め方]` は worker に「質問しない。止まらず最後まで進む。」と指示している。決定 11 は worker が質問を出す事を前提にしている。この設計書では解決しない（利用者が話に出していない）。
- server は「この worker は質問の返答待ちか」を状態として持っていない。持っているのは `activity.ts` の running / stalled / idle / done / failed / lost（process の生存と出力から）で、返答待ちは center の `waitingReply`（`worker_report` の ask / approve が未返答かどうか。`packages/center/src/coordinator.ts` など）が数える。step の位置を持つ物は無い。

### 1.7 今の形の特徴（変える動機に関わる所）

- 「どの worker をいつ起こすか」「review の指摘が直ったか」の判断が、server 側の cap（LLM）の判断に任されている（1.2 の 3・5・6）。依存は文字の指示で、強制する物が無い。
- review の終了は cap の裁量（往復は最大 3 回。指摘の重さ high / medium / low を `task_result.review.items` に書く）。機械的な終了条件ではない。
- 資源の判断は cap が行い、server は測って掲示するだけ（1.5）。並行の責任を持つ主体が server に無い。

## 2. 変えた後の形（全体）

```
利用者 ↔ master-cap（center）
            │  master-capが change を作り、消化する step の範囲（scope）を付けて登録する（9・10）
            ▼
        center ──────────────► server
            ▲                      │  ① 登録を queue に溜める
            │ 進み・質問・完了      │  ② 資源（メモリ・process）を見て、並行の数に責任を持って worker を起こす（12）
            │                      │  ③ worker は 1 step を実行する（8）
            │                      │  ④ 終わったら step の終わりを機械的に判定する（openspec の validate など。【openspec-mcp 待ち】）
            │                      │  ⑤ 通ったら次の step の worker を起こす
            │                      ▼
            │                  worker（claude -p）… openspec のインストラクションに従い、1 step を行う
            │                      └ review は tasks の中の作業。instruction に従い reviewer のサブエージェントを起動（5 節）
            ▼
   guardrail の設定 ─ schema の MCP server ─► openspec-mcp（schema を読む）
```

- master-capは worker を起こさない。cap が見る単位は worker ではなく **change**（どの step まで進んだか）。
- 全 server は、1 つの openspec-mcp に client としてつなぐ（決定 13。7.5）。
- server は、change の step を 1 つずつ worker に実行させる。次の step を起こすのは server（0 節の 2・10 の 2）。
- 門の中身は schema の組み方で決まる（0 節の 10）。review・往復の上限・指摘の数え方は schema 定義の中身で、bantou の仕組み（server・guardrail）は持たない（0 節の 4・7）。

- session の起動の仕組みは変える予定で、毎回きれいな context から始める方向（決定 15。この設計書では扱わない）。この設計は状態を会話の外（change の記録・openspec-mcp）に持つので、その方向と合う。

## 3. 責務

### 3.1 server

**持つ**

| 責務 | 内容 | 今の置き場・メモ |
|---|---|---|
| 登録の受け付けと queue | change の登録（scope つき）を受け、worker 起動の依頼を queue に溜める。来た順に処理する（順序は未決 #2） | `reservations.ts` の `createReservationQueue` が土台になる（来た順・ファイルに残す・再起動後も有効）。今は「cap が `reserve: true` を付けた物だけ」が入る。変えた後は **全ての worker 起動の依頼が queue を通る**（0 節の 12） |
| 資源の管理と並行 | メモリ・process の状況を保持し、並行して動かす worker の数に責任を持つ。起こしてよい時だけ queue の先頭を起こす（3.6） | `resources.ts`（測定）・`activity.ts`（process の生存）が土台。今は測って掲示するだけで判定しない（1.5）。判定を server が持つのが新規 |
| step ごとの worker の起動 | change の現在の step について、1 step を担当する worker を起こす。worker は 1 step の範囲で作業する（0 節の 8） | `workers.ts` の `createWorkerHub` / `claude.ts` / `agents.ts` の worker の部分 |
| 終わりの判定 | worker の run が終わったら、step の終わりを機械的に判定する（3.4）。通れば次の step を queue に積む | 新規。【openspec-mcp 待ち】 |
| worker の状態と、session-id・step の位置の保持 | change ごとに、現在の step・各 step の worker_id・その worker の session_id・worker の状態を持つ（3.5） | 新規の記録（`<workspace>/changes/<change_id>/` 以下を案とする。置き場は実装の task）。session_id は今の `workers/<id>/state.json` の物を指す |
| 質問で閉じて、返答で起こし直す流れ | worker の ask / approve を受けたら状態を「返答待ち」にして center へ通知し、返答が来たら同じ session で worker を起こし直す（3.5） | `reports.ts` の受ける部分、`worker_reply` の処理（`daemon.ts`）が土台 |
| worker の report の受け口 | `report` tool（worker 向け）。受けて center に通知する。cap を起こす所は無くなる | `mcp.ts` / `reports.ts` |
| worker の停止・孤児回収・process group kill | 変わらない | `workers.ts`、`processes.ts`、`daemon.ts` |
| path 分離・clone・掃除・更新・退役・identity | 変わらない | `paths.ts`、`workspace.ts`、`cleanup.ts`、`update.ts`、`retire.ts`、`identity.ts` |
| openspec-mcp への接続 | 全 server が、1 つの openspec-mcp に client としてつなぐ。つなぐ時、schema-discovery の header で、schema の取り先として center（center が内蔵する schema の MCP server）を指す（決定 13）。header の名前・中身の形は openspec-mcp のプロトコルの話で、決めない | 新規。【openspec-mcp 待ち】 |
| 生存・進捗・掲示の通知 | change の進みを足して center に送る（4.3） | `activity.ts`、`board.ts` |

**捨てる（remote-cap の判断の層）**

| 物 | 置き場 | 捨てる理由 |
|---|---|---|
| cap の起動・resume・会話の管理 | `agents.ts` の cap の部分、`conversation.ts`、`lane-meta.ts` | remote-cap が無くなる（0 節の 1） |
| cap の指示文 | `prompts.ts` の `CAP_GUIDE`・`buildTaskPrompt`・`extractTaskResult`・`buildTaskResult`、`instructions/remote-cap.md`、`docs/design/cap-orchestration.md` | 分担・往復・最終返答は、step の登録（scope）と schema に移る |
| task の指揮（task ごとの cap の run） | `tasks.ts` | 単位は change になる（0 節の 9）。cap ごとの `session.maxParallelTasks` も、資源の管理（3.6）に置き換わる |
| report 起因の cap の再開・worker 終了時の cap の再開 | `reports.ts` の cap を起こす部分、`worker-exit.ts` の cap を起こす部分 | 起こす相手の cap が無い。worker が report せずに終わった・失敗した事は、change の状態として center に通知する（4.3） |
| cap 向けの `worker_start` / `worker_status` / `worker_stop` / `peer_status`（`/mcp`、header `x-bantou-cap-id`） | `mcp.ts` の `registerWorkerTools`、`server/routes/mcp.ts` | master-capは worker を起こさない（0 節の 9）。worker 向けの `report`・`bash` は残る |

【推測】捨てる範囲の細部（`agents.ts` の worker 部分との切り分け）は実装の task で決める。

### 3.2 master-cap

- change を作り、消化する step の範囲（scope）を付けて server に登録する（0 節の 9・10。4.2 の `change_register`）。change の作り方の形（openspec の書式）は openspec 側の話で、この設計書は決めない。change の作成（proposal・design・tasks）を誰がどこでやるかは master-cap が決める（8 節）。
- change の進み（どの step まで進んだか・返答待ちか・止まっているか）を見る（`change_status`）。止める・続きを頼む（`change_stop`）。worker の質問に返答する（`worker_reply`）。
- worker を起こさない。分担を決めない。資源を見て起こすかを判断しない（server が持つ。3.6）。
- code の実装などの実作業をしない（体制のルール）。proposal・design・tasks の作成は master-cap の作業範囲に入るが、並行の session に分けてよい（8 節）。
- 【推測】master-cap の指示文（`packages/center/instructions/master-cap.md` の `[委譲]` `[待ち方]`）に、change の登録と見方、8 節の役割を移す改訂が要る。実装の task。session の起動の仕組みの変更（決定 15）はこの設計書の外。

### 3.3 worker

- 普段の役割は、tasks（`tasks.md` など）で規定されている作業の実行（0 節の 8）。server の worker は、tasks の step を実行すると仮定する（0 節の 8。「極論だけど、一旦」と利用者が言っている）。
- 作業範囲は 1 step の中が基本（0 節の 8）。次の step には進まない。次を起こすのは server。
- openspec のインストラクションに従って作業する（0 節の 3）。review を tasks の作業として含む場合は、そのインストラクションに従って reviewer のサブエージェントを起動する（5・6 節）。
- 質問・承認依頼は `report`（ask / approve）で出す（今の仕組みのまま。0 節の 11）。出したら turn を終える（今の `report` tool のとおり）。
- `worker.md` の `[進め方]`（「質問しない。止まらず最後まで進む。」）との関係は未確認で、実装 task で扱う（決定 11 は worker が `report(ask)` で質問を出す前提。未決には足さない。利用者が話に出していないため。1.6）。
- `packages/server/instructions/worker.md` は今の worker 共通のルール（`[範囲]` `[進め方]` `[終わる時]`）。review の手順は入れない。【推測】「1 step の範囲」を worker に伝える所は、server が起動時に渡す prompt（どの change のどの step か）に書く。実装の task。

### 3.4 step の消化と門

0 節の 9・10 を、流れとして書く。**openspec / openspec-mcp とのやり取りの形は【openspec-mcp 待ち】**。以下は「何が何を判断するか」だけを置く。

1. master-capが `change_register` で change と scope（消化する step の範囲）を server に登録する。server は登録を保存し、先頭の step を `queued` にして worker の起動の依頼を queue に積み（3.6）、残りの step は `pending` にする。change は `in_progress`。
2. server が資源を見て起こせる時に、worker を起こす。worker は現在の step を実行する（1 step の範囲内。0 節の 8）。
3. worker の run が終わったら、server が step の終わりを機械的に判定する（0 節の 10 の 2。利用者の見立ては「openspec は validate を使って、step の終了とかは判定できたはず」）。
4. 判定が通れば、server は次の step を `pending` から `queued` にして worker の起動を queue に積む（step 2 → step 3 …）。scope の最後の step が通れば change は完了で、server が center に通知する。
5. 判定が通らない時に何をするかは、未決 #4。

**今の openspec / openspec-mcp で何が出来るか**: この設計を書いた環境には openspec の CLI も openspec-mcp も無く（`which openspec openspec-mcp` が何も返さない。global の npm package・`~/.npm/_npx` の cache にも無い）、repo の中にも、openspec の CLI・openspec-mcp の実体は無かった（`openspec` の語は、demo の fixture と e2e の seed の task 名に出るだけ）。**「validate で step の終了を判定できる」は利用者の見立てのままで、事実として確かめていない。** validate の引数・出力・何を見て終了とするかも、確かめていないので書かない。確かめられない所・足りない所は openspec-mcp の側の話で、openspec-mcp の project が決める（【openspec-mcp 待ち】）。この設計書が bantou 側で前提にするのは、「server が openspec / openspec-mcp を機械的に実行し、結果が通った / 通らないかを受け取れる」だけ。

**門の形（併存する。選ばない）**: 0 節の 10 の 2 つは、schema の組み方で作れるゲートの形として並んでいる。

- **形 1（worker の中で完了が条件づけられる）**: tasks の中に「reviewer のサブエージェントを実行する」作業を instruction として置く。その作業に完了の印を付けるには、instruction の条件のクリアが要る。**クリアできるまで worker は継続して作業する**（0 節の 10 の 1）。
- **形 2（server が step を順に回し、終わりを判定する）**: step を scope で渡すと、server が step 1 を worker にさせ、終わったら step 2 をさせる。終わりの判定を server が機械的に行う（0 節の 10 の 2）。

【推測】2 つは同じ仕組みの上で併存できる。server の動きは 1 つで、「step の worker を起こす → worker の run が終わる → 終わりの判定を実行する → 通れば次の step」。形 1 の schema では、条件を満たすまで worker の run が終わらないので、worker の run が終わった時には判定が通る。形 2 の schema では、判定が門になる。どちらの形を使うか・組み合わせるかは schema の組み方で、bantou は選ばない・解釈しない。

**往復の上限・指摘の数え方**: 0 節の 7 のとおり schema の責務。bantou の仕組み（server・guardrail の設定）は、往復の上限も、指摘の基準も、重さの扱いも持たない。

### 3.5 worker の状態、質問、session-id と step の位置

0 節の 11 を、今あるものと足すものに分けて書く。

**今ある物（1.6）**: worker は `report`（ask / approve）を呼んだら turn を終える。process は終わっていて session_id は `state.json` に残る。返答（`worker_reply`）が来ると、同じ `worker_id` で起こし直すと `--resume` で続く。center へ `worker_report` 通知が行く。これが 0 節の 11 の「今の仕組みをそのまま使える」所で、worker の session を一時的に閉じる動作は、今の仕組みが既にそうなっている。

**足す物**:

> **この節の状態名・記録の項目・置き場は、設計書の案であり、利用者の決定ではない。名前は仮。** 決定に出ているのは、server が worker の状態を持つ事と、step の位置を worker の session-id と結び付けて持つ事だけ（0 節の 11）。

1. server が状態を持つ。change の step ごとに、`worker_id`・`session_id`（worker の `state.json` の値）・step の状態を change の記録に持つ。状態は **change の状態** と **step の状態** の 2 つに分ける（名前は仮）。

   change の状態（change 全体）:

   | 状態 | 意味 |
   |---|---|
   | `in_progress` | 登録済みで、下の 3 つのどれでもない（登録直後も含む。最初の step は `queued`） |
   | `completed` | 今の scope の最後の step が通った（change 全体の完了ではない。次の scope を登録できる。決定 17） |
   | `stopped` | 止めた。`stop_change`（master-capの指示）で止めた |
   | `blocked` | 判定が通らず止まった。server が止めた（終わりの判定が通らない、worker が失敗して終わった、など。理由を持つ。未決 #4） |

   step の状態:

   | 状態 | 意味 |
   |---|---|
   | `pending` | scope に入っているが、まだ queue に積まれていない（前の step が通るのを待つ） |
   | `queued` | queue に積まれ、まだ起きていない（資源待ちを含む） |
   | `running` | worker が動いている |
   | `waiting_reply` | worker が ask / approve を出し、session を閉じて、cap の返答を待っている |
   | `checking` | worker の run が終わり、server が終わりの判定を実行している |
   | `passed` | 判定が通った |
   | `blocked` | 判定が通らない・worker の失敗で止まった（change の `blocked` の原因になった step） |
   | `stopped` | `stop_change` で止めた（`pending` / `queued` の step も `stopped`） |

   「止めた」（`stopped`。cap の指示）と「判定が通らず止まった」（`blocked`。server の判定）は別の状態として持つ。理由・次の動きが違う（`blocked` は未決 #4）。
2. step の位置と session-id の結び付き: change の記録に「現在の step の番号」と、各 step の `worker_id` / `session_id` を持つ（0 節の 11「stepの位置はworkerのsession−idと紐付けて持ってる必要がある」）。server が再起動しても、この記録から続きを起こせる（今の `reservations.ts` と `owner.json` と同じく、ファイルに残す）。
3. 流れ:
   - worker が `report`（ask / approve）→ server は step の状態を `waiting_reply` にして、center へ通知（`worker_report` の形を change つきにしたもの。4.3）。worker の process は終わっている（session は閉じている）。この間、process が無いので資源を使わない。
   - master-capが `worker_reply` → server が受け取り、`waiting_reply` の step の worker を、記録している session_id で起こし直す（`--resume`）。step の状態は `queued` → `running`（起こすのも queue と資源の判定を通る。順序は未決 #2）。
   - `worker_reply` は、返答先の worker の step が `waiting_reply` でない時は error を返す（4.1）。

### 3.6 資源の管理と queue

0 節の 12 を、今ある物と足す物に分けて書く。

**今ある物（1.5）**: 測定（`resources.ts`）、予約の queue（`reservations.ts`）、host の worker 数（`activity.ts` / `manager.activeCount()`）。判定はしない。並行の上限は cap ごとの task の数（利用者が置いた時だけ）。

**足す物**:

1. server が、メモリ・process の状況を保持する（今の測定 + 動いている worker の process の数・生存）。0 節の 12 の「メモリやプロセス状況を保持」。
2. server が、worker の並行実行に責任を持つ: queue の先頭の worker を起こしてよいかを、資源の状況から server が判定し、よい時だけ起こす。今のように「cap が足りないと判断して予約を付ける」のではない。
3. queue: 全ての worker 起動の依頼（change の step の worker の起動、返答での起こし直し）が queue を通る。来た順に処理する（順序は未決 #2）。queue は再起動後も残す（今の `reservations.ts` と同じ）。
4. 判定に使う値（並行の上限、メモリの下限など）は未決 #3。
5. master-capは、起こすかどうかを判断しない。見るだけ: step の状態に `queued`（資源待ちを含む）が出る（3.5・4.1・4.3）。今の `peer_status` / `server_board` は、掲示として残せる（center から見る材料）。

## 4. server が出す道具と、center と server の間のやり取り

> **この節は設計書の案であり、利用者の決定ではない。メッセージ名・tool 名・引数・状態名・置き場は仮。** 決定に出ているのは、cap が change を scope つきで server に登録する事、進みを見る事、質問に返答する事、server が資源と queue と状態を持つ事まで（0 節の 9〜12）。以下は、それを今の protocol と center の tool の上に置いた時の一案。状態名は 3.5 の 2 つの表（change の状態と step の状態）に従う。

master-capは center の tool（4.2）を使い、center が protocol（messenger の `bantou`。今の `task` / `status` / `worker_reply` と同じ経路）で server に送る。server は cap 向けの MCP を持たない（3.1）ので、server の「出す道具」は protocol のメッセージ（4.1）。

### 4.1 server が受けるメッセージ（center → server）

失敗の返し方は今の規約に揃える: protocol の `ErrorReply`（`{ type: "error", ok: false, message, command, ... }`）。再送で通る失敗は今の `ErrorCode`（`updating` = 更新待ち、`version_mismatch` など）をそのまま使う。新しい `ErrorCode` は足さない（足す必要が出たら実装の task で決める）。

| メッセージ（名前は仮） | 引数 | 返り値（成功） | 失敗（`ErrorReply.message` の内容） |
|---|---|---|---|
| `register_change`（change の登録） | `change_id`（AGENT_ID_PATTERN と同じ文字）、`scope`（消化する step の範囲。形は未決 #1）、`repo`、`branch?`、`worker_model?`（MODEL_PATTERN。step の worker の `--model` の既定）、通知先の鍵（今の `cap_id` と同じ形の id。center が付ける） | `{ type: "register_change_result", ok: true, change_id, accepted: true, state: "in_progress" }`（`state` は **change の状態**。登録直後は最初の step が `queued`）。受けて保存したら、worker の完了は待たずにすぐ返す（今の `worker_start` と同じ） | `change_id` が不正 / 登録済みで change の状態が `completed` でない（`completed` の change には次の scope を登録できる。決定 17） / `scope` が空 / `repo` が不正 / 更新中（`ErrorCode` の `updating`）・退役中（`ErrorReply.retiring`） |
| `change_status`（進みの照会） | `change_id?`（省略で全ての change） | `{ type: "change_status_result", ok: true, changes: [{ change_id, state（**change の状態**）, step（現在の step の番号）, steps: [{ ref, worker_id, session_id, state（**step の状態**） }], reason?（`blocked` / `stopped` の理由）, updated_at }] }`。あわせて server の掲示（`board`。今の `status_result.board`）に queue の長さと資源を載せる | `change_id` が無い |
| `stop_change`（止める） | `change_id` | `{ type: "stop_change_result", ok: true, change_id, stopped: boolean }`。動いている worker を止め（今の `stop` と同じく process group kill）、queue の依頼を取り下げ、change を `stopped`（**止めた**。server の判定で止まった `blocked` とは別）にし、動いていた step を `stopped` にする | `change_id` が無い / 動いている worker を止められなかった（`ErrorReply.message` に `worker_id` と理由。change の状態は変えない） |
| `worker_reply`（質問への返答の受け口。今ある物の変更） | `worker_id`、`text`、`change_id`（今の `cap_id` の代わり） | `{ type: "worker_reply_result", ok: true, change_id, worker_id, accepted: true }`。同じ session で起こし直す依頼を queue に積んで、すぐ返す | `worker_id` が change の step の worker でない / step の状態が `waiting_reply` でない / `change_id` が違う |
| `status` / `hello` / `update_server` / `retire_server`（今ある物） | 変えない。`status` の結果に change と queue・資源を足す（4.3） | — | — |

- 続きの指示（change の scope に step を足す・step をやり直させる）は、利用者が話に出していないので、メッセージとして足さない。
- step の worker の `worker_id` は server が採番する（change と step から決まる形。形式は実装の task）。cap は `change_id` で指す。

### 4.2 center の tool（`/mcp/session`。今の tool がどう変わるか）

| 今 | 変えた後 | 引数・返り値・失敗 |
|---|---|---|
| `remote_send`（別名 `remote_create`） | `change_register` に置き換わる | 引数: `server`（今のまま）、`change_id`、`scope`、`repo`、`branch?`、`worker_model?`。返り値: server の `register_change_result` + center の記録（受付を確かめられたか）。失敗: server の `error` はそのまま `isError` で返す（今の `remote_send` と同じく、受付を確かめられなかった時は `{ delivered: false, ... }` を `isError` で） |
| `remote_list` | `change_list` に置き換わる | change の一覧と、server の `server_board`・`reachability`・`server_version_state`（残す）。cap の項目（`cap_state` / `cap_last_error` / `conversation`）は無くなる |
| `task_status`（`buildTaskStatus`） | `change_status` に置き換わる | change ごとの 1 行表示（step の位置・状態・返答待ちの有無） |
| `remote_wait` | `change_wait` に置き換わる | 今の `remote_wait`（cap が done / failed になるまで待つ）に対応させただけの案。待つ対象: change の状態が `completed` / `stopped` / `blocked` になる、または現在の step が `waiting_reply` になるまで（「完了」= change の `completed`。待ちの道具の形は今のとおり center の tool で待つ。shell の loop は作らない）。`timeout_sec` を残す |
| `remote_delete`（`stop_cap`） | `change_stop` に置き換わる | 今の `remote_delete`（cap を閉じる）に対応させただけの案。`stop_change` を送る。「閉じた cap は起き直さない」の仕組みは不要 |
| `worker_reply` | 残る。宛先を `change_id` + `worker_id` にする | `remote_id`（cap）で絞る所は `change_id` で絞る形に変わる。center の `waitingReply`（返答待ちの数）は、step の状態 `waiting_reply` から数える |
| `worker_resume`（`resume_worker`） | 無くなる | 1.3 のとおり server が受けない経路 |
| `server_list` / `server_peers` / `server_status` / `server_retire` | 残る | `server_status` の cap の部分は change の部分になる |
| `session_*` / `center_settings_*` / `rc_*` | 変えない | guardrail の設定は `docs/design/guardrail-schema-server.md` が `center_settings_update` に載せる |

### 4.3 center と server の間に足すメッセージ（通知）

- `activity` 通知: 今の `AgentActivity` は `cap_id`（必須）を持つ（1.4）。change つきの形にする: worker の項目に `change_id` と `step` を足し、`cap_id` は通知先の鍵として残す案（未決 #5）。
- `worker_report` 通知: 今の `cap_id` / `task_id` に代えて `change_id` / `step` を持つ。worker の `report` ごとに送る（今と同じ。ask / approve も同じ形）。
- `change_progress` 通知（新規）: change または step の状態が変わった時（step の開始・通過・`waiting_reply`・`blocked`・`stopped`、change の `completed`）に `{ change_id, step, change_state, step_state, at, reason? }` を送る（`change_state` は change の状態、`step_state` は step の状態。「完了」= change の `completed`）。center はこれで `change_wait` を解き、`waiting_reply` の数を数える。
- `status_result` の `board`: queue の長さ（`queued`）・資源（今の `resources`）・動いている worker の数・並行の上限（未決 #3 の値）を載せる。

## 5. review を入れた schema 定義の例

> **注記**: 以下は、bantou 側が guardrail の設定（`docs/design/guardrail-schema-server.md`）で足す schema 定義の**例**で、0 節の 3・4・10 の 1 を tasks の中の作業として書いたもの。openspec の schema の書式・項目名・完了の印の語・インストラクションの渡し方は、openspec-mcp の側のプロトコルが決める。**形は openspec-mcp 側で変わりうる**。bantou は中身を解釈せず、そのまま保存して返すだけ（guardrail-schema-server の 3.3）。以下の項目名は説明のための仮の物。

```text
# guardrail の設定に足す schema 定義の例（名前: bantou-review）。書き方は仮。
schema: bantou-review
tasks の instruction:
  作業は tasks に分けて行う。
  review の作業（reviewer のサブエージェントの実行）を、tasks の 1 作業として行う。
  この作業に完了の印を付けるには、次の条件を満たす事:
    reviewer が次の 3 つの基準に当たる指摘を数え、0 件である。
      (a) 仕様・決定と食い違う
      (b) test が落ちる、または足した test が変異で落ちない
      (c) 指示した範囲の外を変えている
    それ以外の指摘は、数えずに報告に書く（完了を止めない）。
  数えた指摘が 1 件以上なら、直して、reviewer を起動し直す。条件を満たすまで作業を続ける。
```

- 往復の上限は、この定義に書くなら定義を書く側が決める（0 節の 7。「schemaの責務」）。例には値を書かない。bantou の仕組みは上限を持たない。
- 基準は (a)(b)(c)。重さ（high / medium / low）は条件に入れない（0 節の 4）。
- 上の例は形 1（3.4）。形 2 の schema（step を scope で渡し、server が終わりの判定をする）も同じ guardrail の設定に足せる。どちらを使うかは定義を書く側の選択。

## 6. worker が reviewer のサブエージェントを起こす手順の置き場

0 節の 3 は「worker セッションは openspec のインストラクションに従って作業する」ので、手順は**インストラクション（= schema 定義の tasks の instruction）に置く**。0 節の 10 の 1 も「reviewのサブエージェントの実行をタスクとしてインストラクション指示にする」。

| 置き場 | 内容 | メモ |
|---|---|---|
| schema 定義の tasks の instruction（guardrail の設定で保守。5 節の例） | review の作業の実行、数える 3 つの基準、満たすまで続ける事、reviewer の判定手順（例: (a) は仕様・決定の file との突き合わせ、(b) は test の実行と足した test の変異の確かめ、(c) は指示された範囲と差分の突き合わせ） | bantou 上で保守管理できる（0 節の 5・6）。schema ごとに変えられる。openspec が worker に渡す物。変異の実行手段は決めない（利用者が決めていない） |
| `packages/server/instructions/worker.md` | 変えない（worker 共通のルール。review の手順は入れない） | 【事実】今の `worker.md` は範囲・進め方・終わる時のルールだけで、review の語は無い |

- worker の「終わる時」の報告（`worker.md` の `[終わる時]`）には、reviewer が数えた指摘の件数と、数えなかった指摘を書く。`worker.md` の既存の項目（途中で分かった問題・判断が要る残件）の範囲で足りる【推測】。変えるかは実装の task。

## 7. 今の機能との対応・移行の段取り・並行できる単位・test の観点

> この節に出る `register_change` / `change_*` / `stop_change` などの名前と、`in_progress` / `pending` / `waiting_reply` などの状態名は、3.5・4 節の**案の名前**。名前が変われば、この節の記述もその名前に読み替える（利用者の決定ではない）。

### 7.1 今の機能との対応表

| 今の機能（実在） | 置き場 | 変えた後 |
|---|---|---|
| `remote_send`（別名 `remote_create`） | center `tools.ts`、`remotes.ts` の `send` | `change_register`（4.2）。`goal` / `deliverables` / `verify` / `constraints` / `workers.items` は、change の中身（openspec の change・tasks）と scope に移る（change を誰がどこで作るかは 8 節。書式は openspec 側の話で、この設計書は決めない）。`depends_on` は、step の順（scope の順）に置き換わる |
| `remote_list` / `task_status` / `remote_wait` | center `tools.ts` | `change_list` / `change_status` / `change_wait`（4.2） |
| `remote_delete`（protocol `stop_cap`） | center `tools.ts` | `change_stop`（protocol `stop_change`） |
| `worker_reply` | center `tools.ts`、server `daemon.ts` | 残る。宛先は今も worker。持ち主の鍵が cap から change になる（4.1） |
| `worker_resume`（`resume_worker`） | center `tools.ts`、`server-link.ts` | 無くなる。server は元から受けていない（1.3） |
| `worker_start` / `worker_status` / `worker_stop` / `peer_status`（cap 向け MCP） | server `mcp.ts` | 無くなる。起動は server が queue と資源で行い、状態は `change_status`、停止は `stop_change` |
| `report`（worker 向け MCP） | server `mcp.ts` | 残る。header の `x-bantou-cap-id` 必須の所は、worker の持ち主の記録（change）から引く形に変わる。送る先は cap の再開でなく center への通知 |
| `reserve: true` の予約 | `reservations.ts` | 全ての worker 起動の依頼が通る queue になる（3.6） |
| `session.maxParallelTasks`（cap ごとの task の上限） | `config.ts`、`tasks.ts` | server の資源・並行の判定（3.6。値は未決 #3）に置き換わる |
| `task_result` の `review.items[].severity` | `packages/protocol/src/server.ts`、`prompts.ts` | 完了の判定に使わない（0 節の 4）。形式は旧メッセージとして当面残す（未決 #5） |
| `kick_cap` / `stop_cap` / `task` / `task_result` / `cap_result` | protocol / center `remotes.ts` | cap が無いので不要。扱いは未決 #5 |

### 7.2 順番（0 節の 6）

| 段階 | 内容 | 状態・前提 |
|---|---|---|
| 0 | 設計（この書面、guardrail-schema-server、openspec-mcp 側） | **今。並行で進める** |
| 1 | guardrail 機能の実装（`docs/design/guardrail-schema-server.md` の S1〜S5） | 段階 2 の前提。S1・S3・S5 は openspec-mcp のプロトコルに依らない。**S2（schema の MCP server）・S4（openspec-mcp につなぐ）は openspec-mcp のプロトコル待ち** |
| 2 | schema 定義を bantou 上で保守管理できる | 段階 1 の完了 |
| 3 | change 単位の step 消化の実装（7.3 の W1〜W8） | 段階 2 の後（0 節の 6） |

### 7.3 実装の単位と並行

| 段 | 内容 | 前提 | 並行 |
|---|---|---|---|
| W1 | schema 定義を guardrail の設定に足す（5 節の例を openspec-mcp の形に直して） | guardrail の実装完了、**openspec-mcp のプロトコル** | 他と別 file |
| W2 | server の change の記録・登録の受け付け・queue（`register_change` / `change_status` / `stop_change`、`reservations.ts` の拡張、`workers.ts` の持ち主の鍵の付け替え） | 未決 #1・#2・#5 | W3 と別 file。center（W4）とは protocol の型が先に要る |
| W3 | server の資源の管理と並行の判定（`resources.ts` / `activity.ts` を使う） | 未決 #3 | W2 と別 file |
| W4 | center の tool の置き換え（`change_*`、`worker_reply`、master-cap の指示文（`master-cap.md`）の改訂）と protocol の型 | 4.1・4.3 の型 | server（W2・W3）と別 package |
| W5 | step の終わりの判定を server が実行する層と、次の step の起動 | **openspec-mcp のプロトコル**（実行の形・結果の読み方）、未決 #4 | W2 の後 |
| W8 | 全 server が openspec-mcp につながる（client。schema-discovery の header で center を指す。決定 13） | **openspec-mcp のプロトコル**、各 server から openspec-mcp の host に届く事（【未確認】。7.5） | W5 の前に要る。server の版上げと配り直し（7.5）の一部 |
| W6 | remote-cap の層を捨てる（3.1 の捨てる物）。旧メッセージの扱い（未決 #5） | W2〜W5 が動いた後 | 最後 |
| W7 | docs の改訂（`docs/architecture.md` の server の実行モデル・`cap-orchestration.md` の廃止・`protocol.md`） | W1〜W6・W8 | 最後 |

- W2 と W3 は server の中の別 file、W4 は center で、型を決めた後は並行できる。W6 は新旧の経路を並走で確かめた後に行う（旧経路を先に捨てない）。

### 7.4 旧経路と新経路の切替・既存の cap と worker の扱い

| 項目 | 内容 |
|---|---|
| 切替の判定 | 旧経路（cap 経由の `task`）と新経路（`register_change`）のどちらで動くかを何で決めるか（未決 #5 に含める） |
| 動いている cap・worker | server の更新は、動いている cap・worker が終わるのを待つ（`docs/architecture.md` の更新の節）。既に動いている旧経路の task が終わるまで、その経路は動かし続ける。新しく来る旧メッセージ（新しい `task` / `kick_cap` など）は `error` で断る（未決 #5 の案 B） |
| `<workspace>/caps/<cap-id>/` の既存 dir | cap の会話・`state.json`・`logs/` が残る。`requireCap` が cap の dir を要求する（1.4）ので、dir を消す前に worker の持ち主の鍵を付け替える（未決 #5 に含める） |
| `logs/owner.json`（`{ cap_id, task_id? }`） | 旧 worker の持ち主の記録。新しい持ち主（change）に変える時、旧形式を読み続けるか移すか（未決 #5 に含める） |

### 7.5 全 server の変更（決定 13）

- 全 server（remote の `bantou-server`）が、1 つの openspec-mcp に client としてつなぐ。つなぐ時、schema-discovery の header で center の schema の MCP server を指す。全 server で同じ変更が要る。
- 段取り: server の版を上げ（protocol の版の確認は 未決 #5）、全 server に配り直す（今の `update_server` の仕組み。`docs/architecture.md` の更新の節）。配った後に、各 server が openspec-mcp につながる事を確かめる。
- header の名前・中身の形、つなぎ方は openspec-mcp のプロトコルの話で、先取りしない。
- 【未確認】各 server から openspec-mcp の host に届くか（network の経路・認証）。この環境では確かめていない。届かない server が出た時の扱いは、openspec-mcp の置き場が決まってから。

### 7.6 test の観点

- 登録: `register_change` が保存して即返す／不正な `change_id`・重複・空の scope は `error`。
- queue: 来た順に処理される。再起動後も残る。`stop_change` で取り下げられる。
- 資源・並行: 判定が起こせない時は起きない／起こせる時に先頭だけ起きる。測定が取れない時の扱い（値が出た後に決める。未決 #3）。
- step の進行: step 1 が通るまで step 2 が起きない／通ったら 1 回だけ起きる（二重に起きない）。scope の最後で change が `completed` になる。`stop_change` で止めた change は `stopped`、判定が通らず止まった change は `blocked` で、区別される。server が判定の中身を解釈せず、結果だけに従う。openspec-mcp が落ちている・遅い時に、次の step を起こさず止まる。
- 質問: `report`（ask）で step の状態が `waiting_reply` になり、worker の process が終わっている。`worker_reply` で同じ session_id で起き直す。`waiting_reply` でない worker への返答は `error`。server を再起動しても、change の記録から step の位置と session_id を復元して続けられる。
- 数え方・門（schema の中身）: 0 節の 4 の 3 つの基準だけが数えられる、重さは影響しない、「足した test が変異で落ちない」の検出手段は reviewer の手順（schema の instruction）で決める。**これは schema 定義の側の確認で、bantou の code の test には、手順を解釈する test を置かない**（bantou は schema の中身を解釈しない）。
- 往復の上限が bantou の側に無い事: server・center に往復の回数を数える仕組みが入っていない。
- 移行: 旧経路の task がある間に新経路を入れても、動いている task が壊れない。protocol の版が合わない server の扱い（`docs/architecture.md` の「版が合わない server には `hello` / `update_server` 以外を送らない」）。
- center: `change_list` / `change_status` / `change_wait` の置き換えで、未返答の ask / approve（`waitingReply`）・到達性・版の状態が失われない。`resession.ts` の未返答の確認が cap 無しでも効く。
- 回帰: guardrail の schema の MCP server（別設計）と、この設計の schema 定義が同じ設定の項目を使って保守できる。

## 8. master-cap の役割と進め方（決定 14・16〜18）

> この節の「判断する事」の並べ方・進め方の例は、利用者の話（16〜18 の原文）を整理した物で、決まった手順ではない。

**中心の仕事**: 作業全体の設計。どの作業を、誰が、どこでやるのが適切か。どこまでを、どう進めるのが効率的か（決定 18）。

**master-cap が判断する事**:

- change を作る段で、どの schema を選ぶか（例: 小さな直しには軽い手順の schema。決定 18）。作業全体がうまく進むかを決める重要な要素。
- step の範囲を、どこで切って登録するか（`change_register` の scope。3.4）。
- 各 step を、誰に・どこでやらせるか。
- 確かめ（artifact の中身の review・チェック）を、誰にやらせるか。

**proposal・design・tasks の作成**:

- master-cap の作業範囲に入る（決定 16）。ただし並行の session（server の worker など）に分けて進めてよい。proposal を remote の側に書かせてもよい（決定 18）。
- artifact の中身の review や確かめを、master-cap が必ず自分でやる事にはしない。サブエージェントを使う、などを選べる（決定 18）。
- 範囲の注記: master-cap が自分でやらない事を選べる、という意味。体制のルール（master-cap は code の実装などの実作業をしない）は変わらない。

**進め方の例（決定 17。決まった手順ではなく、選べる形の 1 つ）**:

1. design と tasks までを step の範囲にして、server に 1 回登録する（`change_register`。proposal は master-cap が書く、または別の session に書かせる）。
2. 戻ってきたら（change の状態が `completed`）、中身を確かめる。確かめる人は master-cap が選ぶ（自分・サブエージェントなど）。
3. 問題なければ、tasks の実行を step の範囲にして、同じ change にもう 1 回登録する（4.1。`completed` の change には次の scope を登録できる）。

**知見の永続化**: 仕様・設計の知見は、openspec-mcp の change（proposal・design・tasks）に残り、会話に依らずに読める（決定 16。決定 15 の方向とも合う）。

**この設計書で決めない事**: どんな schema を用意するか（重さの違う手順の中身）は、利用者と schema 定義を書く側が決める。master-cap が選ぶ物はそこにある schema（5 節の例はその 1 つ）。

## 9. 未決（番号つき。各案と推奨）

決まった事 1〜18 から出てくる物だけを載せる。**全て未決**。推奨は推奨であり、利用者の決定ではない。

**未決 #1 scope の形（0 節の 9・10。bantou 側）**
cap が登録で渡す「消化する step の範囲」を、server がどう持つか。step の指し方（番号か見出しか）の形式は openspec / openspec-mcp が持つ形に合わせる（【openspec-mcp 待ち】）ので、ここで聞くのは、順序と範囲の持ち方だけ。
- 案 A: 順序つきの step の参照の配列で渡す（`["<step>", "<step>", ...]`）。server は配列の順に消化する。参照の中身は bantou は解釈せず、そのまま openspec-mcp に渡す。
- 案 B: 範囲（始点と終点）で渡し、中の列挙は openspec 側に聞く。
- 同じ change への再登録（決定 17。design・tasks の後に tasks の実行を登録する）: 前の scope が `completed` の change に、新しい scope（案 A なら新しい配列）を足す。step の記録は足し続け、前の scope の step は変えない。
- 推奨: A。理由: 順序が登録の時点で決まり、server が openspec に依らず「step 1 → step 2」を回せる（0 節の 10 の 2）。B は、列挙を openspec が返せるかに依る（【openspec-mcp 待ち】）。

**未決 #2 queue の順序（0 節の 12）**
queue に入る依頼（step の worker の起動・返答での起こし直し）の処理順。
- 案 A: 全て来た順（今の `reservations.ts` と同じ）。通った step の次の step は末尾に積む。
- 案 B: 実行中の change の次の step・返答での起こし直しを、新しい change の登録より先に処理する。
- 推奨: A。理由: 今の queue と同じで説明が要らず、決める事が増えない。B は、change の途中の待ちを短くできるが、順序の規則が増える。

**未決 #3 並行と資源の判定に使う値（0 節の 12）**
server が並行の数に責任を持つ（利用者の決定）。判定に使う値（並行の上限、メモリの空きの下限など）を、どこから得るか。利用者は値を話に出していない。
- 案 A: config の設定値（並行数の上限と、メモリの空きの下限）を server が持ち、測定値が下回る時は起こさない。値は利用者が置く。今の `session.maxParallelTasks` と同じ置き場の流儀。
- 案 B: 測定値だけで動的に決める（値を持たない）。
- 推奨: A。理由: 値を server の中に固定して持たずに済み、責任の根拠（上限）が明確になる。B は、何を根拠に起こすかの説明が難しい。なお質問待ち（`waiting_reply`）の worker は process が無いので並行の数に数えない（3.5。測定で数えているのは動いている process。1.5）。

**未決 #4 step の終わりの判定が通らなかった時（0 節の 10 の 2）**
worker の run が終わったが、終わりの判定が通らなかった時に、server が何をするか。往復の上限は schema の責務（0 節の 7）なので、bantou は回数を数えない。
- 案 A: change を `blocked`（理由つき）にして止め、center に通知する。次の step は起こさない。続けるかどうかは master-capが決める。
- 案 B: 同じ step の worker を、同じ session で続きとして起こし直す（queue を通る）。
- 推奨: A。理由: bantou が往復を持たない（0 節の 7）形に合う。B は、回数の上限を bantou が持たないと止まらない。形 1（3.4）の schema では、条件を満たすまで worker が終わらないので、この場面は起きにくい【推測】。

**未決 #5 cap を無くす時の protocol と記録の扱い（0 節の 1・9）**
protocol の `kick_cap` / `stop_cap` / `task` / `task_result` / `cap_result`、`task_result` の `review.items[].severity`、`AgentActivity.cap_id` / `WorkerReportNotice.cap_id`（通知先の鍵として残すか。4.3）、center の記録（remote の `pending` / `cap_state` / `server_version_state` 内の cap と worker の件数）、server の `<workspace>/caps/`・`logs/owner.json` の `cap_id` が残る（1.4）。切替の判定・既存の `caps/` dir・旧形式の `owner.json` の扱い（7.4）も、この未決に含める。
- 案 A: protocol の版を上げ、旧メッセージを廃止する。旧版の server・center との組は `hello` の版の確認（`docs/architecture.md` の「版が合わない server には `hello` / `update_server` 以外を送らない」）で弾く。
- 案 B: 旧メッセージの型を当面残す。既に動いている旧経路の task は、終わるまで動かし続ける。新しく来る旧メッセージ（新しい `task` / `kick_cap` など）は cap を起こさず `error` で断る。型は後の版で消す。
- 推奨: B。理由: server は更新の時、動いている cap・worker が終わるまで入れ替えを待つので、旧経路の task が残る間は壊さない方が安全。消すのは W6（7.3）。

## 10. この設計書を書く時に確かめた事・確かめられなかった事

**code と突き合わせて確かめた事**

- 【事実】server の code は `packages/server/server/utils/bantou/` にある（`packages/server/src/` ではない）。
- 【事実】server は `resume_worker` を受けない（`daemon.ts` の `execute` が「resume_worker は未対応」で拒否）。center の `worker_resume` は、server が拒否する経路を叩く（1.3）。center から server の worker を直接動かす経路は今は無い。
- 【事実】server の `worker_reply` の処理は `workers.start(cmd.cap_id, …)` で、cap に依る（`daemon.ts`）。`createWorkerHub` の `start` / `status` / `stop`・`reports.ts`・`mcp.ts` の `report` tool・`AgentActivity.cap_id`・`WorkerReportNotice.cap_id` も cap に依る（1.4）。
- 【事実】今の `depends_on` は server が強制する物ではない（`buildTaskPrompt` が cap の指示文に書くだけ。1.2 の 5）。
- 【事実】今の資源は、server は測って掲示するだけで判定しない。予約は cap が `reserve: true` を付けた時だけ。並行の上限は cap ごとの task の数（利用者が置いた時だけ）（1.5）。
- 【事実】worker は `report` で turn を終え、session_id は `state.json` に残り、同じ `worker_id` で起こすと `--resume` になる（`mcp.ts` の `report` の説明、`agents.ts` の `mode`、1.6）。server が持つ「返答待ち」の状態・step の位置は今は無い。
- 【事実】`task_status` の `buildTaskStatus` は `packages/center/src/task-status.ts` にある。
- 【事実】`docs/design/guardrail-schema-server.md` は `origin/docs/guardrail-schema-server`（develop には未 merge）。本書はそれを参照する。

**確かめられなかった事**

- 【openspec-mcp 待ち】openspec の CLI・openspec-mcp は、この環境に無かった。「validate で step の終了を判定できる」は利用者の見立てのまま。validate の引数・出力・何を見て終了とするか・scope の step の指し方の形式・openspec-mcp の呼び出しの形は、確かめていない。
- 【推測】3.4 の「形 1 と形 2 が同じ仕組みの上で併存できる」は、設計上の読み。openspec-mcp の側で、step ごとの終了条件と instruction を schema に持てるかは、openspec-mcp のプロトコルが出るまで分からない。
- 【未確認】各 server から openspec-mcp の host に届くか（決定 13。7.5）。
- 【推測】4 節のメッセージ名・引数は仮。実装の task で protocol の型に落とす時に決める。
