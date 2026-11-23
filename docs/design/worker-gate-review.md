# review の仕組みと、server を worker の起動だけにする変更（設計）

- 作成: 2026-11-23
- 基点: `develop` 4d98817（server 0.6.12）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file`。repo root からの path。行は変わりうるので関数名・定数名を主に書く）。【推測】は確かめていない解釈。【openspec-mcp 待ち】は openspec-mcp の project が決める事で、この設計書では決めない。決まっていない点は「未決 #N」（8 節）。
- 関係する設計: `docs/design/guardrail-schema-server.md`（`origin/docs/guardrail-schema-server`。guardrail の設定と schema の MCP server。進行中）、`docs/design/cap-orchestration.md`（今の remote-cap のルール）、`docs/design/center-tools.md`、`docs/architecture.md`。

## 0. 利用者と決まった事（原文つき）

1. server の仕組みの方向。
   > serverをworkerを起動するだけの仕組みに集約し、workerコントロールはcenter側のcapが受け持つ

   remote-cap（server 側の判断の層）は無くす。「center側のcap」は center 側の cap。**master-cap を指すと読んでいる（推測）が、利用者への確認が要る**（未決 #7）。本書の 3.2 などは、未決 #7 の推奨案（master-cap と読む）を前提にした記述になっている。
2. 門（ゲート）の持ち方。
   > 直しと再review部分をopnespec−mcpのschemaで担保するような構造にし、serverはopenspec-mcpを機械的に実行させる事で、server側のworker起動をゲートクリアで賄わせる
3. review の置き方。
   > reviewについては、openspecのschemaのtasksの終了条件にreview 指摘0件を条件化して置いておく。wokrkerセッションはopenspecのインストラクションに従って作業するので、tasksのreview 指摘0件を終了ステータスにする前に、サブエージェントでreviewerを起動する形
4. 指摘の数え方（利用者が「一旦それでok」）。重さ（high / medium / low）ではなく、機械的に判定できる基準に当たる指摘が 0 件で完了。基準は次の 3 つ。
   - 仕様・決定と食い違う
   - test が落ちる、または足した test が変異で落ちない
   - 指示した範囲の外を変えている

   それ以外は報告に残すだけ（完了を止めない）。この基準は bantou の仕組みではなく、**schema 定義の中身**（5 節の例に入る物）。server は解釈しない（未決 #5 の推奨案を前提にした記述）。
5. schema 定義の足し方。bantou の guardrail の設定で足し、bantou の schema の MCP server から openspec-mcp に渡る。設計は `docs/design/guardrail-schema-server.md`。openspec-mcp の側の設計の出典は、vault のノート（名前は利用者の言葉のとおり。本書では参照しない）。プロトコルは openspec-mcp の project が決める。
6. 順番。
   > reviewの仕組みの話は、gardrail機能の実装が終わって、schema定義を、bantou上で保守管理出来るようにしてからの話

   実装はその後。設計は並行で進める（この設計書がそれ）。

### 利用者の決定と、この設計書の案の区別

- **利用者の決定は、上の 1〜6 の原文だけ**。それ以外は、この設計書の案・推奨・読みで、利用者の決定ではない。
- 次の worker を起こすのは server、は0 節の 2 の言葉（「server側のworker起動をゲートクリアで賄わせる」）のとおり。
- 8 節の未決 #1〜#7 は全て未決（各案と推奨つき。推奨は決定ではない）。本文の一部は推奨案を前提に書いてあり、そこには「未決 #N の推奨案を前提にした記述」と明記した。
- server が openspec-mcp を実行する契機・門が開かなかった時の扱いは、openspec-mcp のプロトコルが決める（【openspec-mcp 待ち】）。
- 直しと再 review の往復は、0 節の 3 のとおり worker が schema の instruction に従って行う。server が行うのは、門の確認（openspec-mcp の実行）と、開いた時の次の worker の起動だけ（0 節の 2・3 の読み）。

### この設計書の範囲

- 1〜4 を、今の code の上でどう置き換えるかを書く。5 の guardrail 側の設計は上記の別設計書に任せ、ここでは「そこに足す定義の例」だけを書く。
- **openspec-mcp のプロトコルの中身（呼び出しの形式・返り値の形・門が開いた事の通知の形・header など）は決めない。openspec-mcp が決める**。本書で「門が開く」「openspec-mcp を実行する」と書く所は、その形が出てから具体にする（【openspec-mcp 待ち】）。
- 利用者が話に出していない事は、仕様にも未決にも足さない。

## 1. 今の形

### 1.1 server（`packages/server/`）が持つ物

【事実】server の実行層は `packages/server/server/utils/bantou/` にある。責務は `docs/architecture.md` の「server の実行モデル」に 5 つ書かれ（center との窓口、cap の起動と resume、cap の依頼による worker の起動・状態・停止、worker からの報告の受け口、生存・進捗の通知）、code では次に分かれる。

| 責務 | 置き場（`packages/server/server/utils/bantou/`） |
|---|---|
| remote-cap の起動・resume・会話 | `agents.ts`（`createAgentManager`）、`claude.ts`、`conversation.ts`、`lane-meta.ts` |
| cap の指示文 | `prompts.ts`（`CAP_GUIDE`、`buildTaskPrompt`、`extractTaskResult`、`buildTaskResult`）、`packages/server/instructions/remote-cap.md`（`[役割]` `[自分の層で直し切る]` `[完了の判定]` `[見張り]` `[残った問題]` `[窓口を預かっている時]`）、`packages/center/instructions/common.md`（cap と worker に共通） |
| task の受け・並行 | `tasks.ts`（`createTaskScheduler`。task ごとに cap の指揮の run を持つ。上限は config の `session.maxParallelTasks`） |
| worker の起動・状態・停止 | `workers.ts`（`createWorkerHub`。`readOwnerRecord` / `writeOwner` で worker の持ち主 cap と task を `logs/owner.json` に残す）、`reservations.ts`（`createReservationQueue`。`worker_start` の `reserve: true`） |
| worker の report の受け口 | `reports.ts`（`createReportHub`、`buildReportPrompt`、`REPORT_KINDS` = progress / ask / approve / done） |
| worker が終わった時の cap の再開 | `worker-exit.ts`（`createWorkerExitWatcher`、`buildExitPrompt`） |
| cap・worker に出す MCP | `mcp.ts`、`server/routes/mcp.ts`（Nitro の `/mcp`。header `x-bantou-cap-id` / `x-bantou-worker-id`） |
| 生存・掲示板 | `activity.ts`、`board.ts`、`resources.ts` |
| 掃除・更新・退役 | `cleanup.ts`、`update.ts`、`retire.ts` |

### 1.2 worker の起動・停止・依存・報告の流れ

【事実】

1. 利用者 → master-cap → center の `remote_send`（`packages/center/src/tools.ts`。入力は `remoteSendSchema`、処理は `remotes.send`）。center が `task_id` を採番し、protocol の `task`（`packages/protocol/src/server.ts`）を server に送る。
2. server の `createTaskScheduler().submit` が task を受け、`buildTaskPrompt`（`prompts.ts`）で remote-cap の最初の指示を組み立て、cap（`claude -p`。`CAP_GUIDE` を system prompt に付ける）を task ごとの指揮として動かす。
3. **cap が判断する**: cap は `CAP_GUIDE`（`prompts.ts`。正本は `docs/design/cap-orchestration.md` の「決まり本文」）に従って分担を判断し、`mcp__bantou__worker_start` で worker を起動する。`worker_start` は `registerWorkerTools`（`mcp.ts`）にあり、`createWorkerHub().start` が worker（`claude -p --output-format stream-json`）を起こして `{worker_id, accepted}` をすぐ返す。同じ `worker_id` を渡せば続きの指示（`--resume`）。`reserve: true` なら `reservations.ts` の待ち行列に入り、worker が 1 本終わるたびに先頭から起こす。
4. 停止・状態: `worker_stop`（`createWorkerHub().stop`）、`worker_status`、`peer_status`（host の負荷・件数。server は閾値を持たず、cap が判断する）。
5. **依存（`depends_on`）は server が強制していない**: `depends_on` は protocol の `TaskWorkerItem`（`packages/protocol/src/server.ts`）の項目で、`buildTaskPrompt` が `depends_on=<id,...>` を cap の指示文に文字で書くだけ（`prompts.ts` の `[分担]`。「依存がある worker は、その完了を確認してから起動する」）。完了を確認して次を起こすのは cap の判断。
6. review: `CAP_GUIDE` の `[分担]` が「最小の分担は 2 体。実装 worker と review worker」「review の指摘は、実装 worker に同じ worker_id で worker_start して戻す。直るまで回す。実装と review の往復は最大 3 回」と cap に指示する（`cap-orchestration.md`）。review worker も server 側の worker。
7. 報告: worker は `report`（`kind`: progress / ask / approve / done、`text`）を呼ぶ（`mcp.ts`）。`createReportHub` が受けて、(a) cap を `--resume` で起こし（prompt は `buildReportPrompt` = `worker <id> から <kind>: <text>`）、(b) center に `worker_report` 通知を送る。worker が report せずに終わった時は `createWorkerExitWatcher` が cap を起こし直す。
8. 完了: cap の最終返答を `extractTaskResult` / `buildTaskResult`（`prompts.ts`）が `task_result`（worker ごとの branch / commit / tests、`review` の `verdict` と `items[].severity`（`ReviewSeverity` = high / medium / low。`packages/protocol/src/server.ts` の `review` 配下）、`remaining`）にして center に返す。
9. center 側の返答: ask / approve には `worker_reply`（`tools.ts` の `worker_reply`、処理は `tools.ts` の `workerReplyHandler`）。protocol の `worker_reply`（server）が同じ `worker_id` で worker を起動し直して text を渡す。

### 1.3 center が持つ物（`packages/center/src/`）

【事実】

- master-cap（center の session。`packages/center/instructions/master-cap.md`）は center の `/mcp/session` の tool を使う。worker に関わる物は全部 **remote-cap（server 側）を宛先にしている**:
  - `remote_send`（別名 `remote_create`）: server の remote-cap に task を送る（`remotes.send`）。
  - `remote_list` / `task_status`（`buildTaskStatus`）/ `remote_wait`: cap と task の状態・結果・report・pending。
  - `worker_reply`: worker への返答（cap 経由でなく server の worker に直接）。
  - `remote_delete`: cap を閉じる（protocol の `stop_cap`）。
  - `worker_resume`: center から server の worker を直接 resume する（protocol の `resume_worker`、`server-link.ts` の `resumeWorker`）。結果が返るまで待つ。
  - `server_list` / `server_peers` / `server_status` / `server_retire`: server の発見・版・状態・退役。
- 【事実】center → server の worker を直接動かす経路が、今すでに 1 本ある（`resume_worker`。`worker_resume` tool）。ただし task の run の管理（`task_id` の紐づけ、report の受け口）は cap 経由の `task` の上にしか無い。

### 1.4 今の形の特徴（変える動機に関わる所）

- 「どの worker をいつ起こすか」「review の指摘が直ったか」の判断が、server 側の cap（LLM）の判断に任されている（1.2 の 3・5・6）。依存は文字の指示で、強制する物が無い。
- review の終了は cap の裁量（往復は最大 3 回。指摘の重さ high / medium / low を `task_result.review.items` に書く）。機械的な終了条件ではない。

## 2. 変えた後の形（全体）

```
利用者 ↔ master-cap（center）
            │  何を作るかの指示・方針の伝達・止める／続きの指示を直接持つ（3.2）
            ▼
        center ──────────────► server（worker を起動するだけ）
            │                      │  ① worker を起動する
            │                      │  ② openspec-mcp を機械的に実行する（【openspec-mcp 待ち】）
            │                      │  ③ 門が開いたら次の worker を起こす
            │                      ▼
            │                  worker（claude -p）… openspec のインストラクションに従う
            │                      └ tasks を「review 指摘 0 件」にする前に reviewer のサブエージェントを起動（5 節）
            ▼
   guardrail の設定 ─ schema の MCP server ─► openspec-mcp（schema を読む。tasks の終了条件を持つ）
```

- 0 節の 1: remote-cap（server 側の判断の層）を無くす。worker の操作（指示・方針の伝達・止める・続きの指示）は master-cap が持つ。次の worker を起こすのは server（0 節の 2）。
- 0 節の 2: 「直し → 再 review」の往復は、openspec-mcp の schema（tasks の終了条件）が担保する。server は openspec-mcp を機械的に実行し、門が開いた結果で次の worker を起こす。server は「いつ起こすか」を判断しない。
- 0 節の 3・4: review の合格条件（指摘 0 件）は schema の tasks の終了条件に置く。worker が openspec のインストラクションに従い、終了ステータスにする前に reviewer のサブエージェントを起動する。数え方は 6 節の 3 つの基準。

## 3. server が持つ物と捨てる物、center が持つ物

### 3.1 server

**持つ（worker を起動するだけの仕組み）**

| 物 | 今の置き場 | メモ |
|---|---|---|
| worker の起動・続き（resume） | `workers.ts`（`createWorkerHub`）、`claude.ts`、`runner.ts` | **作り直しが要る**: `createWorkerHub` の `start` / `status` / `stop` は `capId` を引数に取り、`requireCap`（cap の dir が無いと投げる）・`requireOwned`（`logs/owner.json` の `cap_id` で持ち主を確かめる）・cap / task の `worker_model` の既定（`readModelRecord`）・予約（`reservations.ts` の `capId`）が cap に依る。cap が無くなるので、持ち主の鍵を何にするか（task か worker か）を実装で決める。口は center から呼べる形にする（3.2、未決 #1 の推奨案 A を前提にした記述） |
| worker の停止・孤児回収・process group kill | `workers.ts`、`processes.ts`、`daemon.ts` | 停止（`stop`）は上と同じく cap の鍵に依るので付け替える。孤児回収・process group kill は変わらない |
| worker の path 分離・state・clone・掃除 | `paths.ts`、`state.ts`、`workspace.ts`、`cleanup.ts` | そのまま |
| worker の report の受け口 | `reports.ts` の受ける部分、`mcp.ts` の `report` tool | 受けて center に送る所までは残る。cap の再開は捨てる（下）。ただし `createReportHub` の `laneOf`・`owner.json` の `cap_id` は cap の鍵なので、`workers.ts` と同じく付け替える |
| 生存・進捗の通知 | `activity.ts`、`board.ts`、`resources.ts` | center が worker を見る材料として残る |
| 資源の掲示板・予約 | `reservations.ts`、`peer_status` | 部品は残る。`Reservation` が `capId` を持つので、持ち主の鍵の付け替えが要る（上）。資源を見て予約するか決める主体は master-cap に移る【推測】 |
| 更新・退役・identity | `update.ts`、`retire.ts`、`identity.ts` | 変えない |
| openspec-mcp を機械的に実行する層（新規） | 無い | 0 節の 2。実行の形・門の読み方は【openspec-mcp 待ち】。置き場は新しい module（細部は実装の task） |

**捨てる（remote-cap の判断の層）**

| 物 | 置き場 | 捨てる理由 |
|---|---|---|
| cap の起動・resume・会話の管理 | `agents.ts` の cap の部分、`conversation.ts`、`lane-meta.ts` | cap が無くなる（0 節の 1） |
| cap の指示文 | `prompts.ts` の `CAP_GUIDE`・`buildTaskPrompt`・`extractTaskResult`・`buildTaskResult`、`instructions/remote-cap.md`、`docs/design/cap-orchestration.md` | cap が無くなる。分担・往復・最終返答の決まりは master-cap の側と schema に移る（3.2、5 節） |
| task の指揮（task ごとの cap の run） | `tasks.ts`（`createTaskScheduler`） | task の単位は center が持つ（未決 #2 の推奨案 A を前提にした記述）。server は worker の持ち主の記録（`owner.json` の `task_id`）だけ残す |
| report 起因の cap の再開・worker 終了時の cap の再開 | `reports.ts` の cap を起こす部分、`worker-exit.ts` の cap を起こす部分 | 起こす相手の cap が無い。center へ通知を送る所だけ残る |
| cap 向けの `worker_*` MCP の口（header `x-bantou-cap-id`） | `mcp.ts` の `registerWorkerTools`、`server/routes/mcp.ts` | cap が無い。worker 向け（`report`・`bash`）は残る。center から叩く口は 3.2 |

【推測】捨てる範囲の細部（`agents.ts` の worker 部分との切り分け）は実装の task で決める。

### 3.2 center の cap（master-cap）が直接持つ worker の操作

0 節の 1 の「workerコントロールはcenter側のcapが受け持つ」の「center側のcap」は master-cap と読む（推測。未決 #7 の推奨案を前提にした記述）。以下は、master-cap が持つ物を次の 3 つに限る案（利用者の決定ではない）: **何を作るかの指示、方針の伝達、止める・続きの指示**。今 remote-cap が持つ操作のうち、この 3 つに当たる物を、master-cap の tool（`/mcp/session`）が server の worker に直接行う形にする。**次の worker を起こす事は master-cap の仕事にしない**（0 節の 2。3.3、server が門で行う）。

| 操作 | 今 | 後 |
|---|---|---|
| worker の起動・続きの指示 | cap が server の `worker_start`（`mcp.ts`） | master-cap が center の tool で、何を作るかを指示して起動し、続きを指示する（口は未決 #1 の推奨案 A を前提にした記述: center ↔ server の protocol にメッセージを足す） |
| worker の状態 | cap が `worker_status` / `peer_status` | master-cap が center の tool で見る（`remote_list` / `task_status` の置き換え先。4 節） |
| worker の停止 | cap が `worker_stop` | master-cap が center の tool で止める |
| ask / approve への返答 | `worker_reply`（center → server が同じ `worker_id` で起こし直す） | 同じ（宛先は今も worker のまま） |
| 次の worker をいつ起こすか | cap の判断（`depends_on` は文字の指示） | **server** が openspec-mcp を実行し、門が開いたら起こす（3.3）。master-cap は起こさない |
| 方針の伝達 | cap が worker への指示に書く | master-cap が worker への指示・続きの指示で伝える |
| review の往復 | cap が review worker を別に起動し、指摘を戻す（最大 3 回） | **worker の中で回る**: worker が reviewer のサブエージェントを起動し、直し、再 review する。tasks の終了条件で担保（5 節）。master-cap も server も指摘を戻さない |

- master-cap は「方針を担う」層のままで、実作業はしない（`docs/concept.md` / 体制のルール）。worker の操作の tool を持つ事と、実装をする事は別。【推測】master-cap の指示文（`packages/center/instructions/master-cap.md` の `[委譲]` `[待ち方]`）に、worker の操作の決まりを移す改訂が要る。実装の task。
- center → server の worker の口: 【事実】今ある center → server の経路は protocol の `resume_worker`（`worker_resume` tool）と `worker_reply`、`status`。worker の起動・停止・状態を center から直接行うメッセージを、この経路に足す（未決 #1 の推奨案 A を前提にした記述）。

### 3.3 server が openspec-mcp を機械的に実行して、門が開いたら次の worker を起こす流れ

0 節の 2 を、流れとして書く。**openspec-mcp とのやり取りの形は【openspec-mcp 待ち】**。以下は「何が何を判断するか」だけを置く。

1. master-cap（center）が、worker を起動する。起動した worker は openspec のインストラクションに従って作業する（0 節の 3）。
2. server が openspec-mcp を実行する。**実行する契機（worker の報告・終了・一定間隔など、何を引き金にするか）は決めない**。openspec-mcp のプロトコルが決まってから決める【openspec-mcp 待ち】。何を渡して何を受けるか（呼び出しの形式・返り値）も openspec-mcp が決める。
3. openspec-mcp の判断（schema の tasks の終了条件が満たされたか＝ review 指摘 0 件か）で、「門が開いた / 開いていない」が決まる。判断するのは schema と openspec-mcp。**server は門の条件を解釈しない・判断しない**（機械的に実行して結果に従うだけ）。
4. 門が開いたら、server は次の worker を起こす（0 節の 2）。門が開いていない時に server が何をするか（待つ・再実行するなど）は、openspec-mcp のプロトコルが決める【openspec-mcp 待ち】。直しと再 review の往復は、**worker 自身が**行う（0 節の 3: worker が schema の instruction に従い、tasks を終了ステータスにする前に reviewer のサブエージェントを起動し、指摘 0 件になるまで直す）。server が行うのは、門の確認（openspec-mcp の実行）と、開いた時の次の worker の起動だけ。
5. 「次の worker」が何か（依存を誰がどこに持つか）は、未決 #3 の問い。この流れ（server が門の結果で次を起こす）は、#3 のどの案でも変わらない。今の `depends_on`（1.2 の 5。文字の指示）は、server が強制していない。

## 4. 今の機能との対応表

| 今の機能（実在） | 置き場 | 変えた後 |
|---|---|---|
| `remote_send`（別名 `remote_create`） | center `tools.ts`、`remotes.ts` の `send` | master-cap が worker を起動する tool に置き換わる（remote-cap へ task を送る形は無くなる）。`goal` / `deliverables` / `verify` / `constraints` は master-cap が worker への指示に書く（未決 #2 の推奨案 A を前提にした記述）。`workers.items` の `depends_on` は、門に置き換わる案（未決 #3 の推奨案 A）がある。置き場は未決 |
| `remote_list` | center `tools.ts` | cap の一覧でなく、worker の一覧・状態を返す物に置き換わる（cap の項目 `cap_state` / `cap_last_error` / `conversation` は無くなる）。`server_board`・`reachability`・`server_version_state` は残る |
| `task_status` | center `tools.ts`（`buildTaskStatus`） | task の単位を残す（未決 #2 の推奨案 A を前提にした記述）ので、worker・門の状態の 1 行表示に置き換わる |
| `remote_wait` | center `tools.ts` | 「cap が done / failed」を待つ物でなくなる。待つ対象（worker の完了か、門が開く事か）に付け替える（待ちの道具の形は実装の task） |
| `remote_delete`（protocol `stop_cap`） | center `tools.ts` | cap が無いので無くなる。worker の停止は 3.2 の停止の tool に移る。cap の「閉じた cap は起き直さない」の仕組みも不要 |
| `worker_reply` | center `tools.ts` の `workerReplyHandler` | 残る。宛先は今も worker（server が同じ `worker_id` で起こし直す）。remote_id（cap）で絞る部分は、cap が無いので worker / task で絞る形に変わる |
| `worker_resume`（protocol `resume_worker`） | center `tools.ts`、`server-link.ts` の `resumeWorker` | 3.2 の worker 起動の tool と重なる。起動の tool に寄せる（未決 #1 の推奨案 A を前提にした記述） |
| `server_list` / `server_peers` / `server_status` / `server_retire` | center `tools.ts` | 残る。`server_status` の cap の部分は無くなり、worker の部分だけになる |
| `session_*` / `center_settings_*` / `rc_*` | center `tools.ts` | 変えない（guardrail の設定は `docs/design/guardrail-schema-server.md` が `center_settings_update` に載せる） |
| `worker_start` / `worker_status` / `worker_stop` / `peer_status`（cap 向け MCP） | server `mcp.ts`（`registerWorkerTools`） | cap 向けの口としては無くなる。同じ機能は 3.2 のとおり center の master-cap が持つ（口は未決 #1 の推奨案 A を前提にした記述: protocol にメッセージを足す） |
| `report`（worker 向け MCP） | server `mcp.ts` | 残る。worker が進捗・質問・承認依頼・完了を送る口。送る先は cap の再開でなく center への通知 |
| task_result の `review.items[].severity`（`review` 配下の `ReviewSeverity` = high / medium / low） | `packages/protocol/src/server.ts`、`prompts.ts` の `buildTaskResult` | 0 節の 4 により、完了の判定には使わない（重さでなく 3 つの基準で数える）。形式は旧メッセージとして当面残す（未決 #4 の推奨案 B を前提にした記述） |
| `kick_cap` / `cap_result` | protocol / center `remotes.ts` | cap が無いので不要。旧メッセージは当面残し、受けても cap を起こさず `error` を返す（未決 #4 の推奨案 B を前提にした記述） |

## 5. review を入れた schema 定義の例

> **注記**: 以下は、bantou 側が guardrail の設定（`docs/design/guardrail-schema-server.md`）で足す schema 定義の**例**で、0 節の 3・4 を tasks の終了条件として書いたもの。openspec の schema の書式・項目名・「終了ステータス」の語・インストラクションの渡し方は、openspec-mcp の側のプロトコルが決める。**形は openspec-mcp 側で変わりうる**。bantou は中身を解釈せず、そのまま保存して返すだけ（guardrail-schema-server の 3.3）。以下の項目名は説明のための仮の物。

```text
# guardrail の設定に足す schema 定義の例（名前: bantou-review）。書き方は仮。
schema: bantou-review
tasks の instruction:
  作業は tasks に分けて行う。
  tasks を終了ステータスにする前に、必ず reviewer のサブエージェントを起動する。
  reviewer は次の 3 つの基準に当たる指摘だけを数える:
    (a) 仕様・決定と食い違う
    (b) test が落ちる、または足した test が変異で落ちない
    (c) 指示した範囲の外を変えている
  それ以外の指摘は、数えずに報告に書く（完了を止めない）。
  数えた指摘が 1 件以上なら、直して、reviewer を起動し直す。
終了条件: review の指摘が基準で 0 件
```

- 終了条件は文で「review の指摘が基準で 0 件」と書くだけにする（構造化した項目にしない。項目の形は openspec-mcp が決める）。基準は (a)(b)(c)。重さ（high / medium / low）は条件に入れない（0 節の 4）。
- 「0 件」の数え方を機械的にするため、reviewer には 3 つの基準だけを渡す。基準に当たるかの判定の手順（(b) の「変異で落ちない」を何で確かめるか）は、reviewer のサブエージェントの手順に書く（6 節）。
- 直しと再 review の往復は、終了条件が満たされるまで tasks を完了にしない事で担保する（0 節の 2）。往復の上限などの細部と、数える基準（(a)(b)(c)）は、この schema 定義の中身で、定義を書く側が定義ごとに決める。bantou の仕組み（server・guardrail）は持たず、server は解釈しない（未決 #5 の推奨案を前提にした記述）。

## 6. worker が reviewer のサブエージェントを起こす手順の置き場

0 節の 3 は「worker セッションは openspec のインストラクションに従って作業する」ので、手順は**インストラクション（= schema 定義の tasks の instruction）に置く**のが一番自然。

| 置き場 | 内容 | メモ |
|---|---|---|
| schema 定義の tasks の instruction（guardrail の設定で保守。5 節の例） | 「完了にする前に reviewer のサブエージェントを起動する」「数える 3 つの基準」「0 件になるまで直して再起動する」 | bantou 上で保守管理できる（0 節の 5・6）。schema ごとに変えられる。openspec が worker に渡す物 |
| reviewer のサブエージェントの定義（reviewer に渡す手順） | 3 つの基準の判定手順。例: (a) は仕様・決定の file との突き合わせ、(b) は test の実行と、足した test の変異の確かめ、(c) は指示された範囲と差分の突き合わせ | どこに置くか（schema の instruction の一部か、別の file か）は未決 #6 の推奨案 A を前提にした記述（同じ schema 定義の instruction に書く）。変異の実行手段は決めない（利用者が決めていない） |
| `packages/server/instructions/worker.md` | 変えない（worker 共通のルール。review の手順は入れない） | 【事実】今の `worker.md` は範囲・進め方・終わる時のルールだけで、review の語は無い（`[範囲]` `[進め方]` `[終わる時]`） |

- worker の「終わる時」の報告（`worker.md` の `[終わる時]`）には、reviewer が数えた指摘の件数と、数えなかった指摘（報告に残すだけの物）を書く。これは `worker.md` の既存の項目（途中で分かった問題・判断が要る残件）の範囲で足りる【推測】。変えるかは実装の task。

## 7. 移行の段取り・並行できる単位・test の観点

### 7.1 順番（0 節の 6）

0 節の 6 の順序を表にする。

| 段階 | 内容 | 状態・前提 |
|---|---|---|
| 0 | 設計（この書面、guardrail-schema-server、openspec-mcp 側） | **今。並行で進める** |
| 1 | guardrail 機能の実装（`docs/design/guardrail-schema-server.md` の S1〜S5） | 段階 2 の前提。S1（設定の項目）・S3（画面）・S5（docs）は openspec-mcp のプロトコルに依らない。**S2（schema の MCP server）・S4（openspec-mcp につなぐ）は openspec-mcp のプロトコル待ち** |
| 2 | schema 定義を bantou 上で保守管理できる（guardrail の設定に schema 定義を足す・見る・直す・消すが画面から出来る） | 段階 1 の完了。**S2・S4 が openspec-mcp のプロトコル待ちなので、段階 2 の完了もプロトコル待ちに連なる** |
| 3 | review の仕組みの実装（7.2 の W1〜W5） | 段階 2 の後（0 節の 6）。W3 も openspec-mcp のプロトコル待ち |

- 段階 1 の中で、プロトコルに依らない S1・S3・S5 は先に進められる。S2・S4 はプロトコルが出てから。段階 3 の W2（center 側）は、プロトコルに依らないが、0 節の 6 により段階 2 の後に始める。
- openspec-mcp のプロトコルが出る時期は、openspec-mcp の project が決める。この設計書は決めない。

### 7.2 実装の単位（前提 7.1 の後）

| 段 | 内容 | 前提 | 並行 |
|---|---|---|---|
| W1 | review を入れた schema 定義を guardrail の設定に足す（5 節の例を openspec-mcp のプロトコルの形に直して）。reviewer の手順を置く（6 節） | guardrail の実装完了、**openspec-mcp のプロトコル** | W2・W3 と別 file |
| W2 | center の master-cap の worker 操作の tool を足す（3.2。protocol にメッセージを足す）。`remote_list` / `task_status` / `remote_wait` の置き換え（4 節）。`master-cap.md` の改訂 | 未決 #1 の推奨案 A を前提にした記述・#2 A | W3 と別 package（center と server） |
| W3 | server に openspec-mcp を機械的に実行する層を足し、門が開いたら次の worker を起こす（3.3）。`workers.ts` / `reservations.ts` / `reports.ts` の持ち主の鍵の付け替えを含む（3.1） | **openspec-mcp のプロトコル**（契機・門の読み方・依存を表せるか）。未決 #3（依存の置き場） | W2 と別 package |
| W4 | server の remote-cap の層を捨てる（3.1 の捨てる物）。`kick_cap` / `stop_cap` / `task` の protocol の扱い（未決 #4 の推奨案 B を前提にした記述: 旧メッセージは残して error を返し、後の版で消す） | W2・W3 が動いた後 | 最後（W2・W3 の後） |
| W5 | docs の改訂（`docs/architecture.md` の server の実行モデル・`cap-orchestration.md` の廃止・`protocol.md`） | W1〜W4 | 最後 |

- W2 と W3 は、片方（center）と もう片方（server）の file が別で並行できる。W4 は両方が動いて、旧経路（cap 経由）と新経路を並走で確かめた後に行う（旧経路を先に捨てない）。

### 7.3 旧経路と新経路の切替・既存の cap と worker の扱い（段取り）

| 項目 | 内容 | 案が要るか |
|---|---|---|
| 切替の判定 | 旧経路（cap 経由の `task`）と新経路（center が直接 worker を起動）のどちらで動くかを、何で決めるか | 案が要る（#4 に含める） |
| 動いている cap・worker | server の更新は、動いている cap・worker が終わるのを待つ（`docs/architecture.md` 13）。旧経路の task が終わるまで旧経路を残す（#4 B） | 未決 #4 の推奨案 B を前提にした記述 の範囲 |
| `<workspace>/caps/<cap-id>/` の既存 dir | cap の会話・`state.json`・`logs/` が残っている。消すか残すか。`worker_status` 等が `requireCap` で cap の dir を要求する（3.1）ので、cap の dir を消す前に worker の持ち主の鍵を付け替える必要がある | 案が要る（#4 に含める） |
| `logs/owner.json`（worker の持ち主。`{ cap_id, task_id? }`） | 旧 worker の `owner.json` は `cap_id` を持つ。新しい持ち主の定義（task か worker か）に変える時、旧形式を読み続けるか、移すか | 案が要る（#4 に含める） |

### 7.4 test の観点

- 起動の機械化: worker の起動・resume・停止・孤児回収が、cap 無しで center の指示だけで動く（`workers.ts` / `reservations.ts` の既存 test を cap 無しの経路に付け替える）。
- 門: 門が開いていない間は次の worker が起きない／開いたら 1 回だけ起きる（二重に起きない）。server が門の条件を解釈していない事（openspec-mcp の返りだけに従う事）。openspec-mcp が落ちている・遅い時に、次の worker を起こさず止まる事（起こして先へ進まない）。
- 「足した test が変異で落ちない」を検出する手段は、reviewer の手順（6 節。schema の instruction）で決める。**設計書では決めない**。この検出の test は、reviewer の手順の側（schema 定義の例に対する確認）に置き、bantou の code の test（`packages/server/test/` など）には、手順を解釈する test を置かない（bantou は schema の中身を解釈しない。guardrail-schema-server の 3.3）。
- 数え方（0 節の 4）: 3 つの基準に当たる指摘だけが数えられ、それ以外は数えずに報告に残る。重さ（high / medium / low）は終了条件に影響しない。「足した test が変異で落ちない」が検出される。「指示した範囲の外」の変更が検出される。
- 終了条件: 指摘が 1 件でもあれば tasks が完了にならない／0 件で完了になる。直しと再 review が往復する。
- 移行: 旧経路（cap 経由）の task がある間に新経路を入れても、動いている task が壊れない。protocol の版が合わない server の扱い（`docs/architecture.md` の 13「版が合わない server には `hello` / `update_server` 以外を送らない」）。
- center: `remote_list` / `task_status` / `remote_wait` の置き換えで、未返答の ask / approve（`waitingReply`）・到達性・版の状態が失われない。`resession.ts` の `worker_reply が未返答の ask / approve` の確認が cap 無しでも効く。
- 回帰: guardrail の schema の MCP server（別設計）と、この設計の schema 定義が同じ設定の項目を使って保守できる。

## 8. 未決（番号つき。各案と推奨）

決まった事 1〜6 から出てくる物だけを載せる。**#1〜#7 は全て未決**。推奨は推奨であり、利用者の決定ではない。

**未決 #1 center の master-cap が server の worker を操作する口（0 節の 1）**
- 案 A: center ↔ server の protocol（今の `resume_worker` / `worker_reply` / `status` と同じ経路）に、worker の起動・状態・停止のメッセージを足す。master-cap の tool は center の `/mcp/session` に足す。`worker_resume` はこの起動の tool に寄せる。
- 案 B: master-cap が server の `/mcp`（今の cap 向けの `worker_start` 等）を直接叩く。欠点: 今の `/mcp` は header `x-bantou-cap-id`（`mcp.ts` の `CAP_ID_HEADER`）で呼び出し元を識別し、cap にだけ `worker_*` を載せる（x-bantou-cap-id があり x-bantou-worker-id が無い接続）。cap が無くなると、この識別が成り立たない。
- 推奨: A（推奨であり決定ではない）。理由: center → server の既存の経路（`server-link.ts`、messenger の protocol `bantou`）で足り、center が server の発見・版・到達性を既に持つ（1.3）。B は server の MCP listener が既定で `127.0.0.1` の bind（`docs/architecture.md` 6）で、別 host の center から叩く経路を足す事になる。

**未決 #2 「task」の単位を残すか（0 節の 1・2）**
今の center の `remote_send` は `task_id` を採番し、`task_status` / `task_result` / `worker_report` の `task_id` が task 単位の追跡になっている（1.2・1.3）。cap（task ごとの指揮）が無くなった後に task の単位を、
- 案 A: 残す。center が task の ID を持ち、worker に `task_id` を紐づける（`owner.json` の `taskId` は残る）。`goal` / `deliverables` / `verify` / `constraints` は master-cap が worker への指示に書く。
- 案 B: 残さない。worker 単位だけで追う。
- 推奨: A（推奨であり決定ではない）。理由: `worker_report` の `task_id`・`resession.ts`・`task_status` が既にこの単位で動いており、`server` の `owner.json` にも `taskId` がある。外せば center 側の追跡を作り直す事になる。

**未決 #3 依存（`depends_on`）の置き場（0 節の 2）**
問いは「依存を誰がどこに持つか」だけ。**次の worker を起こす主体は server（0 節の 2）で、この問いの対象ではない**。今は protocol の `TaskWorkerItem.depends_on` が文字の指示で cap に渡るだけ（1.2 の 5）。
- 案 A: 依存を schema の tasks の門として表す。依存が満たされた（門が開いた）結果で、server が次の worker を起こす。
- 案 B: 依存を center の task の指示（master-cap が書く）に持ち、server に渡す。server は依存が満たされたかを門の結果で確かめ、満たされたら次の worker を起こす。
- 推奨: A。理由: 門で賄う（0 節の 2）なら依存も同じ所にあるのが自然。
- 残る条件: openspec-mcp の schema が依存を表せるかは、openspec-mcp のプロトコル待ち（【openspec-mcp 待ち】）。表せなければ B。決まるのはプロトコルが出てから。

**未決 #4 cap を無くす時の protocol と記録の扱い（0 節の 1）**
protocol の `kick_cap` / `stop_cap` / `task` / `task_result` / `cap_result`、`task_result` の `review.items[].severity`（`ReviewSeverity`）、center の記録（remote の `pending` / `cap_state` / `server_version_state` 内の cap と worker の件数）、server の `<workspace>/caps/`・`logs/owner.json` の cap の項目が残る。特に `OwnerRecord { capId; taskId? }` と `writeOwner` / `readOwner`（`workers.ts`）、`WorkerHub.start` / `status` / `stop` の `capId` 引数は、cap が無くなると持ち主の鍵（task か worker か）の再定義が要る（3.1）。切替の判定・既存の `caps/` dir・旧形式の `owner.json` の扱い（7.3）も、この未決に含める。
- 案 A: protocol の版を上げ、旧メッセージを廃止する。旧版の server・center との組は `hello` の版の確認（`docs/architecture.md` 13）で弾く。
- 案 B: 旧メッセージを当面残し（受けても cap を起こさず `error` を返す）、後の版で消す。
- 推奨: B（推奨であり決定ではない）。理由: server は desktop の版に揃う仕組み（`update_server`）で更新されるが、動いている cap・worker が終わるまで入れ替えを待つ（`docs/architecture.md` 13）ので、旧経路の task が残る間は壊さない方が安全。消すのは W4（7.2）。

**未決 #5 往復の上限・指摘の数え方の基準を、どこに置くか（0 節の 3・4）**
今の `CAP_GUIDE` は往復に上限を置いている（`cap-orchestration.md`）。終了条件が「指摘 0 件」だと、0 件にならなければ完了しない。この上限と、数え方の基準（0 節の 4 の 3 つ）を、
- 案 A: schema 定義の中身に置く。往復の上限などの細部は、schema 定義を書く側が定義ごとに決める。bantou の仕組み（server・guardrail）は上限も基準も持たず、server は解釈しない（5 節の例に入る物）。
- 案 B: bantou の仕組み（server か guardrail の設定）が、上限や基準を持つ。
- 推奨: A。理由: bantou は schema の中身を解釈しない（guardrail-schema-server の 3.3）。基準は0 節の 4 で0 節の 4 の内容そのままを定義に書くだけで足りる。値（上限の数）は決めない。

**未決 #6 reviewer の手順の置き場の細部（0 節の 3・4・5）**
6 節のとおり tasks の instruction に置く事は推奨だが、3 つの基準の判定手順（特に (b) の「足した test が変異で落ちない」を何で確かめるか）を、
- 案 A: 同じ schema 定義の instruction に全部書く。
- 案 B: reviewer 用の手順を別の定義（guardrail の設定に足す別の項目）に分け、instruction から参照する。
- 推奨: A（推奨であり決定ではない）。理由: guardrail の設定は schema 定義の一覧だけを持つ（guardrail-schema-server の 3.2）ので、別の項目を足すと設計が広がる。変異の実行手段は利用者が決めていないので、手順に手段を固定せず、実装の task で決める。

**未決 #7 0 節の 1 の「center側のcap」は何を指すか（前提の確認。0 節の 1）**
- 案 A: master-cap と読む（今の center の session の cap）。
- 案 B: 別の層を新設する（worker 操作専用の cap など）。
- 推奨: A。理由: 利用者の言葉は「center側のcap」で、center の cap は今 master-cap だけ（`packages/center/instructions/master-cap.md`）。B は利用者が話に出していない層を足す事になる。ただし利用者への確認が要る（本書は A と読んで書いている）。

## 9. この設計書を書く時に確かめた事・code と食い違った点

- 【事実】今の `depends_on` は server が強制する物ではない（`buildTaskPrompt` が cap の指示文に書くだけ）。「server の remote-cap と worker の依存（depends_on）の流れ」を、cap の判断として書いた（1.2 の 5）。
- 【事実】server の code は `packages/server/server/utils/bantou/` にある（`packages/server/src/` ではない）。
- 【事実】`docs/design/guardrail-schema-server.md` は `origin/docs/guardrail-schema-server`（develop には未 merge）。本書はそれを参照する。
- 【事実】center → server の worker を直接動かす経路は、今も `resume_worker`（`worker_resume`）として在る（1.3）。完全に新しい経路ではない。
- 【事実】server の `createWorkerHub`（`workers.ts`）は `start` / `status` / `stop` とも `capId` を取り、`requireCap`・`requireOwned`・cap / task の `worker_model`・予約（`Reservation.capId`）が cap に依る。`reports.ts` の `laneOf`・`owner.json` の `cap_id` も同じ。worker の起動・停止は、cap が無くなると持ち主の鍵の付け替えが要る（3.1）。
- 【事実】`task_status` の `buildTaskStatus` は `packages/center/src/task-status.ts` にある（`tools.ts` から呼ぶ）。
