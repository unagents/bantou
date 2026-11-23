# review の仕組みと、server を worker の起動だけにする変更（設計）

- 作成: 2026-11-23
- 基点: `develop` 4d98817（server 0.6.12）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file`。repo root からの path。行は変わりうるので関数名・定数名を主に書く）。【推測】は確かめていない解釈。【openspec-mcp 待ち】は openspec-mcp の project が決める事で、この設計書では決めない。決まっていない点は「未決 #N」（8 節）。
- 関係する設計: `docs/design/guardrail-schema-server.md`（`origin/docs/guardrail-schema-server`。guardrail の設定と schema の MCP server。進行中）、`docs/design/cap-orchestration.md`（今の remote-cap の決まり）、`docs/design/center-tools.md`、`docs/architecture.md`。

## 0. 利用者と決まった事（原文つき）

1. server の仕組みの方向。
   > serverをworkerを起動するだけの仕組みに集約し、workerコントロールはcenter側のcapが受け持つ

   remote-cap（server 側の判断の層）は無くす。「center側のcap」は **master-cap**（session bantou の cap）を指す。利用者との会話で、master-cap が worker を直接動かす話として出た事を、master-cap が聞いて確かめた。
2. 門（ゲート）の持ち方。
   > 直しと再review部分をopnespec−mcpのschemaで担保するような構造にし、serverはopenspec-mcpを機械的に実行させる事で、server側のworker起動をゲートクリアで賄わせる
3. review の置き方。
   > reviewについては、openspecのschemaのtasksの終了条件にreview 指摘0件を条件化して置いておく。wokrkerセッションはopenspecのインストラクションに従って作業するので、tasksのreview 指摘0件を終了ステータスにする前に、サブエージェントでreviewerを起動する形
4. 指摘の数え方（利用者が「一旦それでok」）。重さ（high / medium / low）ではなく、機械的に判定できる基準に当たる指摘が 0 件で完了。基準は次の 3 つ。
   - 仕様・決定と食い違う
   - test が落ちる、または足した test が変異で落ちない
   - 指示した範囲の外を変えている

   それ以外は報告に残すだけ（完了を止めない）。
5. schema 定義の足し方。bantou の guardrail の設定で足し、bantou の schema の MCP server から openspec-mcp に渡る。設計は `docs/design/guardrail-schema-server.md`。openspec-mcp の側の設計は vault のノートで、プロトコルは openspec-mcp の project が決める。
6. 順番。
   > reviewの仕組みの話は、gardrail機能の実装が終わって、schema定義を、bantou上で保守管理出来るようにしてからの話

   実装はその後。設計は並行で進める（この設計書がそれ）。

### master-cap の決定（2026-11-23。レビューの指摘への直しとして）

利用者の決まり 1〜6 を、master-cap が次のとおり具体にした。本書は以下に揃える。

- 次の worker を起こすのは **server**（決まり 2「server側のworker起動をゲートクリアで賄わせる」）。master-cap が持つのは、何を作るかの指示、決定の伝達、止める・続きの指示だけ。
- 未決 #1 は A、#2 は A、#3 は A、#4 は B、#6 は A で**決定済み**（8 節）。#5（review の往復の上限）は、master-cap が利用者に聞いている最中なので未決のまま。
- server が openspec-mcp を実行する契機は、openspec-mcp のプロトコルが決まるまで決めない（【openspec-mcp 待ち】）。
- 直しと再 review の往復は、worker の中で回る。server は門が開いたかを見るだけで、worker に直しを戻さない。

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
3. **cap が判断する**: cap は `CAP_GUIDE`（`prompts.ts`。正本は `docs/design/cap-orchestration.md` の「決まり本文」）に従って分担を決め、`mcp__bantou__worker_start` で worker を起動する。`worker_start` は `registerWorkerTools`（`mcp.ts`）にあり、`createWorkerHub().start` が worker（`claude -p --output-format stream-json`）を起こして `{worker_id, accepted}` をすぐ返す。同じ `worker_id` を渡せば続きの指示（`--resume`）。`reserve: true` なら `reservations.ts` の待ち行列に入り、worker が 1 本終わるたびに先頭から起こす。
4. 停止・状態: `worker_stop`（`createWorkerHub().stop`）、`worker_status`、`peer_status`（host の負荷・件数。server は閾値を持たず、cap が判断する）。
5. **依存（`depends_on`）は server が強制していない**: `depends_on` は protocol の `TaskWorkerItem`（`packages/protocol/src/server.ts`）の項目で、`buildTaskPrompt` が `depends_on=<id,...>` を cap の指示文に文字で書くだけ（`prompts.ts` の `[分担]`。「依存がある worker は、その完了を確認してから起動する」）。完了を確認して次を起こすのは cap の判断。
6. review: `CAP_GUIDE` の `[分担]` が「最小の分担は 2 体。実装 worker と review worker」「review の指摘は、実装 worker に同じ worker_id で worker_start して戻す。直るまで回す。実装と review の往復は最大 3 回」と cap に指示する（`cap-orchestration.md`）。review worker も server 側の worker。
7. 報告: worker は `report`（`kind`: progress / ask / approve / done、`text`）を呼ぶ（`mcp.ts`）。`createReportHub` が受けて、(a) cap を `--resume` で起こし（prompt は `buildReportPrompt` = `worker <id> から <kind>: <text>`）、(b) center に `worker_report` 通知を送る。worker が report せずに終わった時は `createWorkerExitWatcher` が cap を起こし直す。
8. 完了: cap の最終返答を `extractTaskResult` / `buildTaskResult`（`prompts.ts`）が `task_result`（worker ごとの branch / commit / tests、`review` の `verdict` と `items[].severity`（high / medium / low）、`remaining`）にして center に返す。
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
            │  何を作るかの指示・決定の伝達・止める／続きの指示を直接持つ（3.2）
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

- 決まり 1: remote-cap（server 側の判断の層）を無くす。worker の操作（指示・決定の伝達・止める・続きの指示）は master-cap が持つ。次の worker を起こすのは server（決まり 2）。
- 決まり 2: 「直し → 再 review」の往復は、openspec-mcp の schema（tasks の終了条件）が担保する。server は openspec-mcp を機械的に実行し、門が開いた結果で次の worker を起こす。server は「いつ起こすか」を判断しない。
- 決まり 3・4: review の合格条件（指摘 0 件）は schema の tasks の終了条件に置く。worker が openspec のインストラクションに従い、終了ステータスにする前に reviewer のサブエージェントを起動する。数え方は 6 節の 3 つの基準。

## 3. server が持つ物と捨てる物、center が持つ物

### 3.1 server

**持つ（worker を起動するだけの仕組み）**

| 物 | 今の置き場 | メモ |
|---|---|---|
| worker の起動・続き（resume） | `workers.ts`（`createWorkerHub`）、`claude.ts`、`runner.ts` | **作り直しが要る**: `createWorkerHub` の `start` / `status` / `stop` は `capId` を引数に取り、`requireCap`（cap の dir が無いと投げる）・`requireOwned`（`logs/owner.json` の `cap_id` で持ち主を確かめる）・cap / task の `worker_model` の既定（`readModelRecord`）・予約（`reservations.ts` の `capId`）が cap に依る。cap が無くなるので、持ち主の鍵を何にするか（task か worker か）を実装で決める。口は center から呼べる形にする（3.2、決定済みの #1 A） |
| worker の停止・孤児回収・process group kill | `workers.ts`、`processes.ts`、`daemon.ts` | 停止（`stop`）は上と同じく cap の鍵に依るので付け替える。孤児回収・process group kill は変わらない |
| worker の path 分離・state・clone・掃除 | `paths.ts`、`state.ts`、`workspace.ts`、`cleanup.ts` | そのまま |
| worker の report の受け口 | `reports.ts` の受ける部分、`mcp.ts` の `report` tool | 受けて center に送る所までは残る。cap の再開は捨てる（下）。ただし `createReportHub` の `laneOf`・`owner.json` の `cap_id` は cap の鍵なので、`workers.ts` と同じく付け替える |
| 生存・進捗の通知 | `activity.ts`、`board.ts`、`resources.ts` | center が worker を見る材料として残る |
| 資源の掲示板・予約 | `reservations.ts`、`peer_status` | 部品は残る。`Reservation` が `capId` を持つので、持ち主の鍵の付け替えが要る（上）。資源を見て予約するか決める主体は master-cap に移る【推測】 |
| 更新・退役・identity | `update.ts`、`retire.ts`、`identity.ts` | 変えない |
| openspec-mcp を機械的に実行する層（新規） | 無い | 決まり 2。実行の形・門の読み方は【openspec-mcp 待ち】。置き場は新しい module（細部は実装の task） |

**捨てる（remote-cap の判断の層）**

| 物 | 置き場 | 捨てる理由 |
|---|---|---|
| cap の起動・resume・会話の管理 | `agents.ts` の cap の部分、`conversation.ts`、`lane-meta.ts` | cap が無くなる（決まり 1） |
| cap の指示文 | `prompts.ts` の `CAP_GUIDE`・`buildTaskPrompt`・`extractTaskResult`・`buildTaskResult`、`instructions/remote-cap.md`、`docs/design/cap-orchestration.md` | cap が無くなる。分担・往復・最終返答の決まりは master-cap の側と schema に移る（3.2、5 節） |
| task の指揮（task ごとの cap の run） | `tasks.ts`（`createTaskScheduler`） | task の単位は center が持つ（決定済みの #2 A）。server は worker の持ち主の記録（`owner.json` の `task_id`）だけ残す |
| report 起因の cap の再開・worker 終了時の cap の再開 | `reports.ts` の cap を起こす部分、`worker-exit.ts` の cap を起こす部分 | 起こす相手の cap が無い。center へ通知を送る所だけ残る |
| cap 向けの `worker_*` MCP の口（header `x-bantou-cap-id`） | `mcp.ts` の `registerWorkerTools`、`server/routes/mcp.ts` | cap が無い。worker 向け（`report`・`bash`）は残る。center から叩く口は 3.2 |

【推測】捨てる範囲の細部（`agents.ts` の worker 部分との切り分け）は実装の task で決める。

### 3.2 center の cap（master-cap）が直接持つ worker の操作

決まり 1 の「workerコントロールはcenter側のcapが受け持つ」の「center側のcap」は master-cap（0 節）。master-cap が持つのは次の 3 つだけ: **何を作るかの指示、決定の伝達、止める・続きの指示**。今 remote-cap が持つ操作のうち、この 3 つに当たる物を、master-cap の tool（`/mcp/session`）が server の worker に直接行う形にする。**次の worker を起こす事は master-cap の仕事にしない**（3.3、server が門で行う）。

| 操作 | 今 | 後 |
|---|---|---|
| worker の起動・続きの指示 | cap が server の `worker_start`（`mcp.ts`） | master-cap が center の tool で、何を作るかを指示して起動し、続きを指示する（口は決定済みの #1 A: center ↔ server の protocol にメッセージを足す） |
| worker の状態 | cap が `worker_status` / `peer_status` | master-cap が center の tool で見る（`remote_list` / `task_status` の置き換え先。4 節） |
| worker の停止 | cap が `worker_stop` | master-cap が center の tool で止める |
| ask / approve への返答 | `worker_reply`（center → server が同じ `worker_id` で起こし直す） | 同じ（宛先は今も worker のまま） |
| 次の worker をいつ起こすか | cap の判断（`depends_on` は文字の指示） | **server** が openspec-mcp を実行し、門が開いたら起こす（3.3）。master-cap は起こさない |
| 決定の伝達 | cap が worker への指示に書く | master-cap が worker への指示・続きの指示で伝える |
| review の往復 | cap が review worker を別に起動し、指摘を戻す（最大 3 回） | **worker の中で回る**: worker が reviewer のサブエージェントを起動し、直し、再 review する。tasks の終了条件で担保（5 節）。master-cap も server も指摘を戻さない |

- master-cap は「方針を決める」層のままで、実作業はしない（`docs/concept.md` / 体制の決まり）。worker の操作の tool を持つ事と、実装をする事は別。【推測】master-cap の指示文（`packages/center/instructions/master-cap.md` の `[委譲]` `[待ち方]`）に、worker の操作の決まりを移す改訂が要る。実装の task。
- center → server の worker の口: 【事実】今ある center → server の経路は protocol の `resume_worker`（`worker_resume` tool）と `worker_reply`、`status`。worker の起動・停止・状態を center から直接行うメッセージを、この経路に足す（決定済みの #1 A）。

### 3.3 server が openspec-mcp を機械的に実行して、門が開いたら次の worker を起こす流れ

決まり 2 を、流れとして書く。**openspec-mcp とのやり取りの形は【openspec-mcp 待ち】**。以下は「何が何を決めるか」だけを置く。

1. master-cap（center）が、worker を起動する。起動した worker は openspec のインストラクションに従って作業する（決まり 3）。
2. server が openspec-mcp を実行する。**実行する契機（worker の報告・終了・一定間隔など、何を引き金にするか）は決めない**。openspec-mcp のプロトコルが決まってから決める【openspec-mcp 待ち】。何を渡して何を受けるか（呼び出しの形式・返り値）も openspec-mcp が決める。
3. openspec-mcp の判断（schema の tasks の終了条件が満たされたか＝ review 指摘 0 件か）で、「門が開いた / 開いていない」が決まる。判断するのは schema と openspec-mcp。**server は門の条件を解釈しない・判断しない**（機械的に実行して結果に従うだけ）。
4. 門が開いたら、server は次の worker を起こす。開いていなければ、server は何もしない（**server は worker に直しを戻さない**）。直しと再 review の往復は、worker の中で回る（決まり 3: worker が openspec のインストラクションに従い、tasks を終了にする前に reviewer のサブエージェントを起動する）。往復を schema が担保する（決まり 2）とは、終了条件が満たされるまで tasks が完了にならない事を指す。server は門が開いたかを見るだけ。
5. 「次の worker」は、**依存を schema の tasks の門で表す**（決定済みの #3 A）。今の `depends_on`（1.2 の 5。文字の指示）がこの門に置き換わる。master-cap は依存を渡さない。**openspec-mcp の schema が依存を表せるかは、openspec-mcp のプロトコル待ち**（【openspec-mcp 待ち】）。表せない事が分かったら、この決定を見直す（master-cap が決める）。

## 4. 今の機能との対応表

| 今の機能（実在） | 置き場 | 変えた後 |
|---|---|---|
| `remote_send`（別名 `remote_create`） | center `tools.ts`、`remotes.ts` の `send` | master-cap が worker を起動する tool に置き換わる（remote-cap へ task を送る形は無くなる）。`goal` / `deliverables` / `verify` / `constraints` は master-cap が worker への指示に書く（決定済みの #2 A）。`workers.items` の `depends_on` は門に置き換わる（#3 A） |
| `remote_list` | center `tools.ts` | cap の一覧でなく、worker の一覧・状態を返す物に置き換わる（cap の項目 `cap_state` / `cap_last_error` / `conversation` は無くなる）。`server_board`・`reachability`・`server_version_state` は残る |
| `task_status` | center `tools.ts`（`buildTaskStatus`） | task の単位を残す（決定済みの #2 A）ので、worker・門の状態の 1 行表示に置き換わる |
| `remote_wait` | center `tools.ts` | 「cap が done / failed」を待つ物でなくなる。待つ対象（worker の完了か、門が開く事か）に付け替える（待ちの道具の形は実装の task） |
| `remote_delete`（protocol `stop_cap`） | center `tools.ts` | cap が無いので無くなる。worker の停止は 3.2 の停止の tool に移る。cap の「閉じた cap は起き直さない」の仕組みも不要 |
| `worker_reply` | center `tools.ts` の `workerReplyHandler` | 残る。宛先は今も worker（server が同じ `worker_id` で起こし直す）。remote_id（cap）で絞る部分は、cap が無いので worker / task で絞る形に変わる |
| `worker_resume`（protocol `resume_worker`） | center `tools.ts`、`server-link.ts` の `resumeWorker` | 3.2 の worker 起動の tool と重なる。起動の tool に寄せる（決定済みの #1 A） |
| `server_list` / `server_peers` / `server_status` / `server_retire` | center `tools.ts` | 残る。`server_status` の cap の部分は無くなり、worker の部分だけになる |
| `session_*` / `center_settings_*` / `rc_*` | center `tools.ts` | 変えない（guardrail の設定は `docs/design/guardrail-schema-server.md` が `center_settings_update` に載せる） |
| `worker_start` / `worker_status` / `worker_stop` / `peer_status`（cap 向け MCP） | server `mcp.ts`（`registerWorkerTools`） | cap 向けの口としては無くなる。同じ機能は 3.2 のとおり center の master-cap が持つ（口は決定済みの #1 A: protocol にメッセージを足す） |
| `report`（worker 向け MCP） | server `mcp.ts` | 残る。worker が進捗・質問・承認依頼・完了を送る口。送る先は cap の再開でなく center への通知 |
| task_result の `review.items[].severity`（high / medium / low） | `packages/protocol/src/server.ts`、`prompts.ts` の `buildTaskResult` | 決まり 4 により、完了の判定には使わない（重さでなく 3 つの基準で数える）。形式は旧メッセージとして当面残す（決定済みの #4 B） |
| `kick_cap` / `cap_result` | protocol / center `remotes.ts` | cap が無いので不要。旧メッセージは当面残し、受けても cap を起こさず `error` を返す（決定済みの #4 B） |

## 5. review を入れた schema 定義の例

> **注記**: 以下は、bantou 側が guardrail の設定（`docs/design/guardrail-schema-server.md`）で足す schema 定義の**例**で、決まり 3・4 を tasks の終了条件として書いたもの。openspec の schema の書式・項目名・「終了ステータス」の語・インストラクションの渡し方は、openspec-mcp の側のプロトコルが決める。**形は openspec-mcp 側で変わりうる**。bantou は中身を解釈せず、そのまま保存して返すだけ（guardrail-schema-server の 3.3）。以下の項目名は説明のための仮の物。

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

- 終了条件は文で「review の指摘が基準で 0 件」と書くだけにする（構造化した項目にしない。項目の形は openspec-mcp が決める）。基準は (a)(b)(c)。重さ（high / medium / low）は条件に入れない（決まり 4）。
- 「0 件」の数え方を機械的にするため、reviewer には 3 つの基準だけを渡す。基準に当たるかの判定の手順（(b) の「変異で落ちない」を何で確かめるか）は、reviewer のサブエージェントの手順に書く（6 節）。
- 直しと再 review の往復は、終了条件が満たされるまで tasks を完了にしない事で担保する（決まり 2）。往復の上限を置くかは未決 #5（master-cap が利用者に聞いている）。

## 6. worker が reviewer のサブエージェントを起こす手順の置き場

決まり 3 は「worker セッションは openspec のインストラクションに従って作業する」ので、手順は**インストラクション（= schema 定義の tasks の instruction）に置く**のが一番自然。

| 置き場 | 内容 | メモ |
|---|---|---|
| schema 定義の tasks の instruction（guardrail の設定で保守。5 節の例） | 「完了にする前に reviewer のサブエージェントを起動する」「数える 3 つの基準」「0 件になるまで直して再起動する」 | bantou 上で保守管理できる（決まり 5・6）。schema ごとに変えられる。openspec が worker に渡す物 |
| reviewer のサブエージェントの定義（reviewer に渡す手順） | 3 つの基準の判定手順。例: (a) は仕様・決定の file との突き合わせ、(b) は test の実行と、足した test の変異の確かめ、(c) は指示された範囲と差分の突き合わせ | どこに置くか（schema の instruction の一部か、別の file か）は決定済みの #6 A（同じ schema 定義の instruction に書く）。変異の実行手段は決めない（利用者が決めていない） |
| `packages/server/instructions/worker.md` | 変えない（worker 共通の決まり。review の手順は入れない） | 【事実】今の `worker.md` は範囲・進め方・終わる時の決まりだけで、review の語は無い（`[範囲]` `[進め方]` `[終わる時]`） |

- worker の「終わる時」の報告（`worker.md` の `[終わる時]`）には、reviewer が数えた指摘の件数と、数えなかった指摘（報告に残すだけの物）を書く。これは `worker.md` の既存の項目（途中で分かった問題・判断が要る残件）の範囲で足りる【推測】。変えるかは実装の task。

## 7. 移行の段取り・並行できる単位・test の観点

### 7.1 順番（決まり 6）

1. **前提**: guardrail 機能の実装（`docs/design/guardrail-schema-server.md` の S1〜S5）が終わり、schema 定義を bantou 上で保守管理できる。
2. この設計の実装は、その後に始める。**設計（この書面と openspec-mcp 側）は今から並行で進める**。

### 7.2 実装の単位（前提 7.1 の後）

| 段 | 内容 | 前提 | 並行 |
|---|---|---|---|
| W1 | review を入れた schema 定義を guardrail の設定に足す（5 節の例を openspec-mcp のプロトコルの形に直して）。reviewer の手順を置く（6 節） | guardrail の実装完了、**openspec-mcp のプロトコル** | W2・W3 と別 file |
| W2 | center の master-cap の worker 操作の tool を足す（3.2。protocol にメッセージを足す）。`remote_list` / `task_status` / `remote_wait` の置き換え（4 節）。`master-cap.md` の改訂 | 決定済みの #1 A・#2 A | W3 と別 package（center と server） |
| W3 | server に openspec-mcp を機械的に実行する層を足し、門が開いたら次の worker を起こす（3.3）。`workers.ts` / `reservations.ts` / `reports.ts` の持ち主の鍵の付け替えを含む（3.1） | **openspec-mcp のプロトコル**（契機・門の読み方・依存を表せるか）。決定済みの #3 A | W2 と別 package |
| W4 | server の remote-cap の層を捨てる（3.1 の捨てる物）。`kick_cap` / `stop_cap` / `task` の protocol の扱い（決定済みの #4 B: 旧メッセージは残して error を返し、後の版で消す） | W2・W3 が動いた後 | 最後（W2・W3 の後） |
| W5 | docs の改訂（`docs/architecture.md` の server の実行モデル・`cap-orchestration.md` の廃止・`protocol.md`） | W1〜W4 | 最後 |

- W2 と W3 は、片方（center）と もう片方（server）の file が別で並行できる。W4 は両方が動いて、旧経路（cap 経由）と新経路を並走で確かめた後に行う（旧経路を先に捨てない）。

### 7.3 test の観点

- 起動の機械化: worker の起動・resume・停止・孤児回収が、cap 無しで center の指示だけで動く（`workers.ts` / `reservations.ts` の既存 test を cap 無しの経路に付け替える）。
- 門: 門が開いていない間は次の worker が起きない／開いたら 1 回だけ起きる（二重に起きない）。server が門の条件を解釈していない事（openspec-mcp の返りだけに従う事）。openspec-mcp が落ちている・遅い時に、次の worker を起こさず止まる事（起こして先へ進まない）。
- 数え方（決まり 4）: 3 つの基準に当たる指摘だけが数えられ、それ以外は数えずに報告に残る。重さ（high / medium / low）は終了条件に影響しない。「足した test が変異で落ちない」が検出される。「指示した範囲の外」の変更が検出される。
- 終了条件: 指摘が 1 件でもあれば tasks が完了にならない／0 件で完了になる。直しと再 review が往復する。
- 移行: 旧経路（cap 経由）の task がある間に新経路を入れても、動いている task が壊れない。protocol の版が合わない server の扱い（`docs/architecture.md` の 13「版が合わない server には `hello` / `update_server` 以外を送らない」）。
- center: `remote_list` / `task_status` / `remote_wait` の置き換えで、未返答の ask / approve（`waitingReply`）・到達性・版の状態が失われない。`resession.ts` の `worker_reply が未返答の ask / approve` の確認が cap 無しでも効く。
- 回帰: guardrail の schema の MCP server（別設計）と、この設計の schema 定義が同じ設定の項目を使って保守できる。

## 8. 未決（番号つき。各案と推奨）

決まった事 1〜6 から出てくる物だけを載せる。#1〜#4・#6 は master-cap が決定済み（推奨どおり。#3 は A）。未決として残るのは #5 だけ。

**決定済み #1 center の master-cap が server の worker を操作する口（決まり 1）**
- 案 A: center ↔ server の protocol（今の `resume_worker` / `worker_reply` / `status` と同じ経路）に、worker の起動・状態・停止のメッセージを足す。master-cap の tool は center の `/mcp/session` に足す。`worker_resume` はこの起動の tool に寄せる。
- 案 B: master-cap が server の `/mcp`（今の cap 向けの `worker_start` 等）を直接叩く。
- **決定済み（master-cap）: A**。推奨: A。理由: center → server の既存の経路（`server-link.ts`、messenger の protocol `bantou`）で足り、center が server の発見・版・到達性を既に持つ（1.3）。B は server の MCP listener が既定で `127.0.0.1` の bind（`docs/architecture.md` 6）で、別 host の center から叩く経路を足す事になる。

**決定済み #2 「task」の単位を残すか（決まり 1・2）**
今の center の `remote_send` は `task_id` を採番し、`task_status` / `task_result` / `worker_report` の `task_id` が task 単位の追跡になっている（1.2・1.3）。cap（task ごとの指揮）が無くなった後に task の単位を、
- 案 A: 残す。center が task の ID を持ち、worker に `task_id` を紐づける（`owner.json` の `taskId` は残る）。`goal` / `deliverables` / `verify` / `constraints` は master-cap が worker への指示に書く。
- 案 B: 残さない。worker 単位だけで追う。
- **決定済み（master-cap）: A**。推奨: A。理由: `worker_report` の `task_id`・`resession.ts`・`task_status` が既にこの単位で動いており、`server` の `owner.json` にも `taskId` がある。外せば center 側の追跡を作り直す事になる。

**決定済み #3 次の worker の依存（`depends_on`）の置き場（決まり 2）**
今は protocol の `TaskWorkerItem.depends_on` が文字の指示で cap に渡るだけ（1.2 の 5）。
- 案 A: 依存を schema の tasks の門として表し、門が開いたら **server** が次の worker を起こす。master-cap は依存を渡さない。
- 案 B: 依存は master-cap が持ち、master-cap が起こす順を決める。
- **決定（master-cap）: A**。理由: 次の worker を起こすのは server（決まり 2「server側のworker起動をゲートクリアで賄わせる」）。master-cap が持つのは、何を作るかの指示、決定の伝達、止める・続きの指示だけ。
- 残る条件: openspec-mcp の schema が依存を表せるかは、openspec-mcp のプロトコル待ち（【openspec-mcp 待ち】）。表せないと分かったら master-cap が見直す。

**決定済み #4 cap を無くす時の protocol と記録の扱い（決まり 1）**
protocol の `kick_cap` / `stop_cap` / `task` / `task_result` / `cap_result`、`task_result.review.items[].severity`、center の記録（remote の `pending` / `cap_state` / `server_version_state` 内の cap と worker の件数）、server の `<workspace>/caps/`・`logs/owner.json` の cap の項目が残る。
- 案 A: protocol の版を上げ、旧メッセージを廃止する。旧版の server・center との組は `hello` の版の確認（`docs/architecture.md` 13）で弾く。
- 案 B: 旧メッセージを当面残し（受けても cap を起こさず `error` を返す）、後の版で消す。
- **決定済み（master-cap）: B**。推奨: B。理由: server は desktop の版に揃う仕組み（`update_server`）で更新されるが、動いている cap・worker が終わるまで入れ替えを待つ（`docs/architecture.md` 13）ので、旧経路の task が残る間は壊さない方が安全。消すのは W4（7.2）。

**未決 #5 review の往復の上限（決まり 3・4）**
今の `CAP_GUIDE` は「実装と review の往復は最大 3 回。3 回で直らなければ残った問題として書いて止める」（`cap-orchestration.md`）。終了条件が「指摘 0 件」だと、0 件にならなければ完了しない。
- 案 A: 上限を置く（今と同じ 3 回など）。超えたら「完了にしない」まま止まり、master-cap（と利用者）に上げる。
- 案 B: 上限を置かない。0 件になるまで回す。
- 推奨: A。理由: 無限に回る事を避ける。値（今は 3 回）は推奨欄の暫定で、決めない。上限を置くか・値・超えた時の扱いは、master-cap が今、利用者に聞いている。**未決のまま**。往復は worker の中で回る（3.3 の 4）ので、上限を置く時の数え手と止め方は、決まってから実装の task で詰める。

**決定済み #6 reviewer の手順の置き場の細部（決まり 3・4・5）**
6 節のとおり tasks の instruction に置く事は推奨だが、3 つの基準の判定手順（特に (b) の「足した test が変異で落ちない」を何で確かめるか）を、
- 案 A: 同じ schema 定義の instruction に全部書く。
- 案 B: reviewer 用の手順を別の定義（guardrail の設定に足す別の項目）に分け、instruction から参照する。
- **決定済み（master-cap）: A**。推奨: A。理由: guardrail の設定は schema 定義の一覧だけを持つ（guardrail-schema-server の 3.2）ので、別の項目を足すと設計が広がる。変異の実行手段は利用者が決めていないので、手順に手段を固定せず、実装の task で決める。

## 9. この設計書を書く時に確かめた事・code と食い違った点

- 【事実】今の `depends_on` は server が強制する物ではない（`buildTaskPrompt` が cap の指示文に書くだけ）。「server の remote-cap と worker の依存（depends_on）の流れ」を、cap の判断として書いた（1.2 の 5）。
- 【事実】server の code は `packages/server/server/utils/bantou/` にある（`packages/server/src/` ではない）。
- 【事実】`docs/design/guardrail-schema-server.md` は `origin/docs/guardrail-schema-server`（develop には未 merge）。本書はそれを参照する。
- 【事実】center → server の worker を直接動かす経路は、今も `resume_worker`（`worker_resume`）として在る（1.3）。完全に新しい経路ではない。
- 【事実】server の `createWorkerHub`（`workers.ts`）は `start` / `status` / `stop` とも `capId` を取り、`requireCap`・`requireOwned`・cap / task の `worker_model`・予約（`Reservation.capId`）が cap に依る。初版の 3.1 の「そのまま」は誤りで、持ち主の鍵の付け替えが要る（3.1 に直した）。`reports.ts` の `laneOf`・`owner.json` の `cap_id` も同じ。
- 【事実】初版は次の worker を起こす主体を master-cap と読める書き方（3.2・未決 #3 の暫定推奨 B）で、server が門で起こす（決まり 2）と食い違っていた。master-cap の決定で直した（0 節・3.2・3.3・#3）。
- 【事実】初版の 3.3 の 4 は「開いていなければ server が同じ worker に直しを戻す」と書いていたが、往復は worker の中で回る（決まり 3）。直した。
- 【事実】`task_status` の `buildTaskStatus` は `packages/center/src/task-status.ts` にある（`tools.ts` から呼ぶ）。
