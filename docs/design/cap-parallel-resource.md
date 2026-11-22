# cap の並行: 固定の上限をやめ、host のリソースと掲示板で決める（設計）

状態: 決定済み（下の「決定」）。実装は branch `feat/cap-parallel-resource`。決める人は利用者と master-cap。5 章の「未決」は、決定を書き込んだ後も案の記録として残す。

## 0. 決定（利用者・master-cap）

- **U1 = C**: 同じ branch の task も server は待たせない。cap に「同じ branch の task が動いている」事を知らせ、cap が判断する。
- **U2 = B**: 並行の上限 `session.maxParallelTasks` は既定「上限なし」。利用者が設定に置いた時だけ効く。
- **U3**: server は負荷・メモリ・worker の数・ディスクを測って掲示するだけ。閾値を持たず、資源が足りるかを判定しない。判断は cap。
- **U4 = B**: 資源の単位は worker。task は受けたらすぐ指揮を始める。
- **予約**: 資源が足りないと判断した cap が、`worker_start` に予約のフラグ（`reserve: true`）を付けて出す。server が足りないと決めて予約にはしない。server は来た順に queue に貯め、同じ server の worker が 1 本終わるたびに先頭から 1 本ずつ起こす。動いている worker が 0 本の時に予約が来たら、すぐ起こす。予約中の worker はその task の「動いている」に数える（3.5）。
- **U5**: 推奨どおり（B: 予約・通知の依頼をファイルに残す）。**U6 = A**。**U7 = A**。**U8 = A**。**U9**: 推奨どおり（A）。**U11 = A**。
- **U10**: 周期の再測定は掲示のためだけ。予約の起動の契機は、worker の終了と、動いている worker が 0 本の時の予約の到着。周期の値は設定 `resource.sampleMs`（既定は実装時に 30 秒とした。設計書に値の推奨は無かったため。要確認）。
- center の `remote_list` と `task_status` の「待ち（同時実行の上限）」の表示を新しい形に合わせ、desktop にも server の掲示板（cap・worker の数・資源・予約の件数）を出す。

## 1. 利用者の方針（原文の要点）

- 勝手に cap の作業の並行の上限を入れない。設計を見直す。
- remote-cap は、基本、可能な限り task を並行させる。**これは鉄の掟**。
- ただし remote-cap が動く host のリソースは常に気にする。
- 同じ host の複数の remote-cap は、host のリソースの状況と、他の cap が動かす worker の実行数を見て、何本並行させるかを判断する。
- 同じ host の cap 同士は、後続の待ち task の有無を問い合わせ、worker の完了の通知を依頼できる。
- bantou-server が、管理する cap と稼働中の全 worker を見える化する掲示板を持つかもしれない。リソースの解放待ちは、フラグだけの簡易な次の予約として bantou-server が queue に貯めるかもしれない。

## 2. 今の作り（server 0.6.11 = `packages/server/package.json:3` / 調査した repo の develop `4bf3751`）

調べたのは repo の develop。desktop の package version は 0.1.60（依頼の 0.1.58 とは異なる。並行の作りは同じ決まりのまま確認した）。

### 2.1 固定の上限（既定 2）

- config `session.maxParallelTasks`、既定 2、1 以上の整数。`packages/server/server/utils/bantou/config.ts:44`（既定）、`:75`（型）、`:284-286`（検証）。
- daemon が `tasks` の scheduler に渡す: `daemon.ts:383-387`。起動時に「task の同時実行の上限: cap ごとに N」を log: `daemon.ts:415`。
- 数えるのは **cap ごと**。`tasks.ts:171` `mine.filter(running).length >= maxParallel` で `limit` 待ち。`mine`（`tasks.ts:164`）は `ofCap`（`:158`）で得た同じ cap の entry。別の cap の task は数えない。
- 既定 2 の由来は「運用の重い処理は同時 2 本まで」に合わせたもの。「既存の設定に重い処理の上限は無かったので新設した」と書いてある: `docs/design/cap-orchestration.md:105`。つまり利用者が決めた値ではない。

### 2.2 同じ branch は待つ決まり

- 先に来て終わっていない task と `deliverables.branch` が同じ task は、前が終わるまで待つ。`tasks.ts:165-170`（`waiting_for = "branch"`）。
- 理由は「同じ branch への同時の push を避ける」: `cap-orchestration.md:106`、`tasks.ts:9`。
- 見るのは同じ cap だけ。別の cap・別の session は互いに待たない: `cap-orchestration.md:106`。
- 待っている task は来た順に始める: `tasks.ts:208-223`（`pump`）。

### 2.3 worker の起動

- cap（lane）が `worker_start`（MCP）で worker を起こす。`workers.ts:145-165` で `deps.manager.invoke("worker", workerId, …)` を呼び、完了を待たず `accepted: true` を返す。
- **worker の本数に上限・host 資源の確認は無い**。`workers.ts:130-170` と `agents.ts` を `concurr` / `maxConcurrent` / `semaphore` / `同時` で grep して該当なし（調べた範囲の事実。他の所に無いことの保証ではない）。
- 数の制約は、同じ worker_id は 1 つずつ（agent ごとの queue。`status` の `queued`: `protocol/src/server.ts:561`）だけ。
- host のリソース（CPU・メモリ・負荷）を読む処理は server に無い（`loadavg` / `freemem` / `os.cpus` を `server/utils/bantou/*.ts` で grep して該当なし）。

### 2.4 status

- `status_result` = `caps`（各 `AgentStatus`）+ `workers`、identity（`server_id` / `host` / `user` / `workspace`）付き: `daemon.ts:186`、`identity.ts:99-101`。
- cap の `tasks`（`CapTaskInfo[]`: `state` waiting/running/done/failed、`waiting_for` = `limit` | `branch`、`queued_at` ほか）: `protocol/src/server.ts:567-596`、組み立ては `daemon.ts:182-185`。
- 終わった task は 1 時間・cap あたり最大 20 件を保持（`tasks.ts:120-121`）。メモリのみで、server の再起動で消える（`docs/protocol.md:437`）。
- 見えるのは **その server の cap と worker だけ**。host 全体のリソース値と、他の server の cap・worker は出ない。

### 2.5 center・desktop の表示

- center: task の待ちを「待ち（同時実行の上限）」「待ち（同じ branch … の前の task）」と表示する。`packages/center/src/task-status.ts:51`。`maxParallelTasks` を前提にした説明が `packages/center/src/tools.ts:436` と `packages/center/README.md:231` にもある。
- desktop / ui: 選択中の session の cap だけを server ごとに 1 行で出す（`docs/architecture.md:44`）。`packages/ui/components/RemoteActivity.vue:125-166`（「待機中」/ 活動情報なし / agent 一覧）。host 全体の cap 数・worker 数・リソースを出す画面は無い（推測ではなく、`RemoteActivity.vue` と `desktop/src/pages/index.vue` の参照先で確認できた範囲）。
- cap は session × server に 1 つ（`docs/architecture.md:44`）。1 つの server に複数の session の cap が載る。

### 2.6 今の作りと方針のずれ

| 方針 | 今 |
|---|---|
| 可能な限り並行 | cap ごとに既定 2 で打ち止め。利用者が決めていない値 |
| host の資源を見る | 見ていない（worker 数にも資源にも制約なし） |
| 同じ host の cap 同士で判断 | cap どうしは互いを見ない。数えるのは自分の cap だけ |
| 見える化 | 他の cap・host 全体は見えない |

## 3. 設計

前提（U4 の推奨 B を、この設計の前提に置く）: **資源の単位は worker**。task（lane = 指揮の会話 1 つ）は受けたらすぐ指揮を始め、資源の判断で待たせない。資源の判断は worker の開始（`worker_start`）で行い、待ちの予約の対象も worker の開始の依頼 1 種類だけにする。U4 が A / C に決まった場合は、3.1・3.2・3.5 を直す。

### 3.1 固定の上限をやめる（要件 1）

- `session.maxParallelTasks` の固定の上限（既定 2）による `limit` 待ちをやめる。task は受けたらすぐ指揮を始める（上の前提）。
- 待たせる理由は、**U1 の結果で決まる**。整理すると次のとおり（数値の上限は置かない）:
  1. task を待たせる理由: 同じ branch の前の task（U1 が A の時だけ残る。B なら無くなる）。
  2. task を待たせる理由: `closing`（`stop_cap` の close の最中。`tasks.ts:163`）。資源・並行の判断ではなく停止の手順なので、今のまま残す。今は `waiting_for` に `limit` と読み替えて載せている（`tasks.ts:217`）。`limit` の廃止後はこの読み替えを直す（直し方は実装時に決める）。
  3. worker の開始を待たせる理由: host のリソース待ち（3.2）。task の待ちではなく worker の予約の待ち（3.5）として現れる。
- `waiting_for` の値 `limit` は、task の待ちとしては出なくなる。protocol は additive に保ち、旧 `limit` を読む側は未知の文字列を許す（`CapTaskState` と同じ「reader must accept other strings」の流儀。`protocol/src/server.ts:576`）。worker の予約の状態は 3.5 に書く。
- `maxParallelTasks` の設定項目の扱い（廃止 / 上限なしの既定 / 利用者が任意で置く上限として残す）は **U2**。

### 3.2 host のリソースを見て並行の本数を決める（要件 2）

役割: 「何本まで」を固定値で持たず、**worker を起動する都度、host の今の状態と全 cap の worker の実行数を見て、始めてよいかを判断**する。

測る対象（候補。どれを採るかは **U3**）:

- CPU: 負荷（`os.loadavg()` と論理 CPU 数 `os.cpus().length`）。
- メモリ: 空き（`os.freemem()` / `/proc/meminfo` の MemAvailable）。
- 実行中の worker 数（掲示板。3.4）。実測の資源の値は worker 数が増えた結果として現れるまで遅れるので、数も併用する。
- ディスクの空き（worker の clone・node_modules が溜まる。`cap-orchestration.md:118`）。

測り方の方針:

- 測るのは server が持つ host の値だけ。外部の記憶・DB は使わない。
- 判断の入口は 1 つ（server の `workers.ts` の `start`）。ここで「host に空きがあるか」を問う。task の開始（`tasks.ts` の `blockedBy`）は資源を問わない（上の前提）。
- 「空きがあるか」の**閾値は決めない**（U3）。

再測定（待っている worker の予約を、いつ・誰が見直すか）:

- 資源の値は、worker の完了だけでは変わらない（外部の process が host を塞ぐこともある）。待っている予約があり、動いている worker が 0 本でも、**server 自身が**予約の先頭を見直す。cap は待ちの間は再開されない（cap は report でしか再開しない。`cap-orchestration.md:142`）ので、cap には任せない。
- 見直しの契機: (a) worker の完了・停止、(b) 周期の再測定。周期の値は設計で決めない（**U10**）。
- 外部 process が塞ぎ続ける間は、予約が待ち続ける。掲示板（3.4）に「リソース待ちの予約の件数と、最後に測った値・時刻」を出し、center・desktop から見えるようにする。待ちの打ち切り（期限）は、値を利用者が決めていないので設計しない（U10 に含める）。

### 3.3 同じ host の cap 同士の問い合わせと完了の通知の依頼（要件 3）

利用者の例: session-A の cap が session-B の cap に「後続の待ち task はあるか」と問い、無い（など）なら、B の worker の完了で A に通知してほしい、と依頼できる。

方式（設計）:

- cap 同士は直接やり取りしない。**bantou-server を仲介**にする（指示は層を飛ばさない決まり）。
- cap が server に頼む手段は、**cap 専用の MCP tool**（今の `worker_start` / `worker_status` / `worker_stop` と同じ経路。cap だけに登録する。`mcp.ts:31,103`）。protocol の command（center → server）にはしない。理由: 頼むのは center でなく cap の claude で、今の worker の操作と同じ経路に載せれば、cap の id・task の id（`x-bantou-cap-id`、lane の `taskId`）が server に届く。center を経由すると 1 層増える（推測: center に中継を足す変更が要る。実装時に確認）。tool の名前は仮で、決めるのは実装時。
- 問い合わせ tool（仮名 `peer_status`）:
  - 入力: なし（同じ server の他の cap 全部）。
  - 出力: 他の cap ごとに `{cap_ref, running_workers, waiting_tasks, reserved_workers, no_followers}`。`cap_ref` は不透明な参照で、cap_id（session 名を含む）をそのまま返すかは **U6**。goal などの指示・結果の中身は返さない（`architecture.md:44` の session の分離を守る）。
  - `no_followers`（後続なし）: server が持つ事実だけで計算する。**待ち task が 0 件、かつ worker の予約が 0 件、かつその cap の task の指揮の run が動いていない**（run が動いていれば新しい worker を起こしうる）。この基準でよいか、他の cap の claude に実際に尋ねるかは **U9**。
- 完了通知の依頼 tool（仮名 `notify_when_done`）:
  - 入力: 対象（`cap_ref` と、worker_id か「その cap の全 worker」）。
  - 出力: `{request_id, accepted: true}`（今の `worker_start` と同じく、すぐ返す）。
  - 動き: server が依頼を覚え、対象が完了（worker の done・停止・失敗）した時に、依頼した cap の task の指揮を再開して知らせる。
- 通知の届け方: cap は report でしか再開しないので、server が依頼した cap の lane を再開する。今の `[worker 終了通知]`（`worker-exit.ts:35-38`）と同じ形の prompt（仮: 先頭行 `[他 cap の完了通知]`）で resume する（推測: 既存の再開の入口を流用できるはず。実装時に要確認）。
- 通知の依頼の寿命・件数・server 再起動をまたぐか（今の `tasks` はメモリのみ）は **U5**。
- 通知の再開は、worker 終了の再開の上限（`session.exitResumeMax`、既定 3。`config.ts:42`）に**数えるか**を決めていない（**U11**）。今の上限は、cap・task ごとに「worker が done 無しで終わった再開」を数え、超えると再開せず task を failed にする（`worker-exit.ts:180-191`、`tasks.ts` の `fail`）。
- 他の cap の worker を止める・順序を変える権限は与えない（問い合わせと通知の依頼だけ）。
- 同じ server の中の cap だけが対象。同じ host の別 server の cap へは届かない（U7 の案 A の場合。限定は U7 に明記）。

### 3.4 bantou-server の掲示板（要件 4）

server が、**自分が管理する cap と稼働中の全 worker の数**を 1 か所で見えるようにする。

載せる内容（案。載せる項目の最終は **U6**）:

- cap の一覧: cap_id、state、動いている task の数、待っている task の数と理由。
- 稼働中の worker の数（全 cap 合計と cap ごと）。
- host のリソースの測定値（3.2。測った時刻付き）。
- 予約（3.5）の件数と、最後に測った値・時刻。

見え方:

- protocol: `status_result` に additive の欄として足す（`caps` / `workers` は今のまま。追加の欄は旧 peer が無視する。`docs/protocol.md:188` の `tasks` と同じ流儀）。版を上げるかは protocol 定義の決まりに従う（`cap-orchestration.md:135`）。
- center: `remote_list` に host 全体の掲示板の値を足して返す。待ち表示の文言（`task-status.ts:51`）を「host のリソース待ち」に更新する。`tools.ts:436` と `README.md:231` の「`maxParallelTasks` 既定 2」の説明を改める。
- desktop: 今は選択中 session の cap だけ（`architecture.md:44`）。host 全体の掲示板は、他の session の cap の中身を出さず、**数と資源だけ**を出す欄（例 host ごと 1 行: cap 数・worker 数・資源の状況・待ち数）にする。session の分離は崩さない。
- 範囲: 1 つの server の掲示板は、その server の cap と worker だけ。**同じ host に複数の server がある場合**（`server_id` が別、workspace が別。`identity.ts:99-101`）は、server どうしの掲示板の共有が要る。やり方は **U7**。

### 3.5 リソース待ちの次の予約（要件 5）

利用者の案: リソース解放待ちの worker の依頼は、フラグだけの簡易な「次の予約」にして、bantou-server が queue に貯める。

- **予約の対象は、worker の開始の依頼（`worker_start`）の 1 種類だけ**。task は予約しない（3 章の前提。task は受けたらすぐ指揮を始める）。
- `worker_start` が資源不足の時の返り: 今と同じく**待たずにすぐ返す**（`workers.ts:145-165` は完了を待たず `accepted: true` を返す）。返り値に additive の `reserved: true` を足し、`{worker_id, accepted: true, reserved: true}` とする。cap は「予約された」と分かり、ターンを終えてよい（今の `worker_start` の使い方と同じ）。worker は、空きが出たら server が自動で起動する。
- cap から見える形: `worker_status` で、その worker は新しい state `reserved`（additive の文字列。読む側は未知の state を許す）。始まれば今と同じ経路で進む（worker の report で cap の lane が再開する）。予約中の worker を止めたい時は `worker_stop` が予約を取り消す（設計。実装時に要確認）。
- **予約中の worker は、task が「動いている」ことに数える**（task の終わりの判定に足す）。理由: 3 章の前提では、cap は `reserved` を見てターンを終える。その時点で指揮の run も worker の run も無い。今の終わりの判定は、指揮の run・worker の run（`manager.laneBusy`。`agents.ts:1073-1076`）と report 起因の処理（`hub.pendingFor`。`reports.ts:372`）だけを数える（`daemon.ts:389` の `busy`）。予約を数えないと、task が done / failed に見え、lane の `mcp.json` の削除（`cap-orchestration.md:108`）と lane の片付け（`workerKeepMs` 後）が、予約が始まる前に走りうる。設計: `busy` に「その task の worker の予約が 1 件以上ある」を足す（`busy: laneBusy || pendingFor > 0 || reservedFor(capId, taskId) > 0`。名前は仮）。予約が始まれば worker の run（`laneBusy`）が引き継ぐ。予約を取り消した（`worker_stop`・`stop_cap`）場合は数えなくなり、他に動く物が無ければ task は終わる。予約の件数は、再起動をまたいで残すか（U5）に従う。再起動後に予約を残さない案 A の場合は、予約と一緒に task の「動いている」も消える。
- 予約に載せるもの: フラグ（cap_id・task_id・worker_id・受けた時刻）だけを queue の見え方とする。起動に要る入力（prompt・repo・branch・model。`workers.ts:147-157`）は、今の agent の queue が持つ入力と同じ扱いで server が持つ（メモリか永続かは **U5**）。
- 貯める場所: bantou-server の queue（`tasks.ts` の waiting と同じ層）。今の「cap ごとの待ち」を「host 全体の待ち」に広げる形。
- 解放の契機: worker の完了・停止、周期の再測定（3.2。周期は U10）。契機で、予約の先頭から「始めてよいか」（3.2）を問い直す。
- 順序: 来た順（今の `pump` と同じ。`tasks.ts:208`）。他の順（cap 間の公平など）は **U8**。
- `stop_cap` は、その cap の予約も破棄する（今の `stop_cap` が待っている task を止めるのと同じ扱い。`tasks.ts:418-441`）。
- server の再起動時の予約の扱いは **U5**。
- 3.3 の完了通知の依頼は、この queue と同じ仕組み（契機で通知）に載せられる（推測。実装時に確認）。

## 4. 影響を受ける所（実装時の洗い出し。今回は変えない）

- server: `config.ts`（maxParallelTasks）、`tasks.ts`（`blockedBy` の `limit`）、`daemon.ts:383-415`、`workers.ts`（worker 起動前の確認・予約）、`mcp.ts`（cap 専用 tool の追加）、`daemon.ts:182-186`（status）、`daemon.ts:389`（task の終わりの判定 `busy` に予約を足す）、`worker-exit.ts`（通知の再開と `exitResumeMax`。U11）。
- protocol: `CapTaskInfo.waiting_for`、`status_result` の追加欄、`worker_start` の返り値・worker の state、docs/protocol.md、版。
- center: `task-status.ts:51`、`tools.ts:436`、`remotes.ts`、`README.md:231`。
- desktop / ui: `RemoteActivity.vue`、host の掲示板の欄。
- 文書: `cap-orchestration.md`「task の並行」（105 行の「既定 2」の記述）、`docs/protocol.md:188,437`、`docs/architecture.md:46`（「同時に動く数は server の `session.maxParallelTasks`」と書いてある）、`packages/server/README.md:96`。
- テスト（`packages/server/test/server/utils/bantou/` 配下）: `tasks.test.ts:289`、`config.test.ts:158-163`（上限の前提で書かれている）、`parallel-flow.test.ts:69`・`child-env-flow.test.ts:87`（`maxParallelTasks: 2` を設定に渡している）。`packages/center/test/parallel-tasks.test.ts`（`CapTaskInfo` の待ちを参照。中身は未確認）。

## 5. 未決（利用者の決定待ち）

数値の上限・閾値はここに案として出すだけで、決めていない。

### U1. 同じ branch の task を待たせる今の決まり

- 案 A: 残す（同じ branch は順に。`tasks.ts:165-170`）。利点: 同じ branch への同時の push の衝突を避けられる。欠点: 「可能な限り並行」に反する。
- 案 B: やめる（待たせない）。利点: 鉄の掟に忠実。欠点: 同じ branch への同時の push が衝突して失敗・上書きの恐れ。衝突の扱いを worker に任せることになる。
- 案 C: 待たせずに、同じ branch の task を知らせる（cap に警告・通知し、cap が判断する）。利点: 並行を保ちつつ cap が衝突を避けられる。欠点: 判断を cap（claude）に委ねる。確実性は A より低い。
- 推奨: A（弱い推奨）。理由: 同じ branch への同時の push は並行できない作業だ、と読めるため。**この読みは推測で、鉄の掟を利用者がどう解釈するかは分からない**。利用者が鉄の掟を「同じ branch も含めて」と考えるなら B か C。決定は利用者。

### U2. `session.maxParallelTasks` の扱い

- 案 A: 廃止する。利点: 方針（上限を勝手に入れない）に一致。欠点: 旧 config に書いた利用者の設定が無効になる（読むが無視 + log が要る）。
- 案 B: 既定を「上限なし」にして、設定は利用者が任意で置く上限として残す。利点: 既存の設定が効き、利用者が明示した時だけ制限できる。欠点: 設定項目が残る。
- 推奨: B。理由: 利用者が決めた上限だけが効く形で、方針に反しない。

### U3. host のリソースの何を・どう測るか、「空き」の判定

閾値（負荷が CPU 数のどれだけ・メモリ空きがどれだけで「満杯」か等）は、案 A・B のどちらでも利用者が決める値で、設計は決めない。

- 案 A: 測る対象 = CPU 負荷 + メモリの空き。利点: OS から読め、単純。欠点: ディスク満杯・worker の急増には遅れる。
- 案 B: 測る対象 = CPU 負荷 + メモリの空き + 実行中の worker 数 + ディスクの空き。利点: 取りこぼしが少ない。欠点: 閾値の数が増える（利用者が決める値が増える）。
- 推奨: B。ただし**測るだけ**にして、閾値が未設定の項目は「満杯」と判定しない。理由: 勝手に閾値を入れない決まりを守りつつ、測る項目と掲示板の表示は先に揃えられる。閾値が全部未設定の間は、予約は発生しない（常に空き）。

### U4. 資源の単位（task か worker か）

3 章の設計は案 B を前提にしている。

- 案 A: task（lane）の開始を判断する。利点: 今の `tasks.ts` の入口 1 つで済む。欠点: 資源を食うのは worker で、1 task が worker を何本も起こすと見積りが外れる。
- 案 B: worker の開始を判断する（task は受けたらすぐ指揮を始める）。利点: 資源に直結する。欠点: worker が予約で待つ間、指揮（lane）は worker を待つ状態になる（3.5 の設計: cap は `reserved` を見てターンを終え、worker の report で再開。その間 task が終わりに見えないよう、予約を task の「動いている」に数える。`daemon.ts:389` の `busy` に足す）。
- 案 C: 両方（task は掲示板の状態を見て始める、worker は開始時に確認）。利点: 取りこぼしが少ない。欠点: 判断の入口が 2 つになる。
- 推奨: B。理由: 資源を消費するのは worker で、利用者の原文も「worker タスクの実行数」を見ると言っている。

### U5. 完了通知の依頼・worker の予約の寿命と、server 再起動時の扱い

対象は 2 つ: 完了通知の依頼（3.3）と、worker の予約（3.5。起動に要る入力を含む）。

- 案 A: メモリのみ（server 再起動で消える。今の `tasks` と同じ）。利点: 簡単。欠点: 再起動で消え、依頼した cap は「予約された」「通知が来る」と思って待ち続ける。
- 案 B: ファイルに残す（再起動後も有効。cap の `logs/` 配下など、既存の永続の置き場に寄せる）。利点: 取りこぼしが無い。欠点: 古い依頼・予約の掃除が要る。
- 案 C: メモリのみにし、再起動の後に失われた予約・依頼を cap へ知らせる（失敗として lane を再開）。利点: 簡単で、cap が待ち続けない。欠点: 知らせるためにも「何が失われたか」の記録が要る（結局、軽い永続が要る）。
- 件数・期限の値は決めない（必要なら利用者が決める）。
- 推奨: B。理由: 予約・依頼が消えると cap が止まるため。

### U6. 掲示板に載せる項目と、他の session への見せ方

- 案 A: 数・状態・資源だけ（中身は載せない。`peer_status` の `cap_ref` は不透明な参照）。利点: session の分離（`architecture.md:44`）を保つ。欠点: 他の cap が「何を待っているか」は分からない。
- 案 B: task の branch 名や cap_id も載せる。利点: 同じ branch の衝突を事前に避けやすい。欠点: 他の session の作業が見える。
- 推奨: A。理由: 指示・結果が混ざらないよう session を分けた決定（2026-11-04）を崩さない。

### U7. 同じ host に複数の server がある場合の掲示板

- 前提（推測）: server ごとに workspace が別なので、同じ host に複数の server が動きうる。実際にそう運用しているかは未確認。
- **限定（案 A の場合）**: 3.3 の問い合わせ・完了通知の依頼と、予約の公平（U8）は、**同じ server の cap の間だけ**で働く。同じ host の別 server の cap とは、問い合わせも通知の依頼もできない。利用者の原文（「ホストに同居する、remote-cap 同士」）が別 server の cap を含むなら、案 A では満たせない。
- 案 A: server ごとの掲示板のみ（server 間は見ない）。利点: 実装が最小。欠点: 上の限定。同じ host の別 server の worker が資源を食っても、判断に入るのは資源の実測だけ。
- 案 B: host 共有の置き場（host 上の共有ファイル等）を 1 つ決め、server 間で数・予約・通知の依頼を共有する。利点: 同じ host の全 cap が見える（利用者の原文どおり）。欠点: 共有の置き場の決め（host の共有一時領域を使わない決まりがある）と排他制御が要る。
- 案 C: 複数 server を同じ host に置くことを非対応とする。利点: 単純。原文どおりになる。欠点: 既存の運用を狭める。
- 推奨: まず A。ただし利用者が「別 server の cap とも問い合わせたい」なら B。理由: 同居の運用が実際にあるかが未確認なので、最小から始める。限定は上のとおり。

### U8. 予約の順序

- 案 A: 来た順（今と同じ）。利点: 単純で説明しやすい。欠点: 1 つの cap が大量に予約すると他の cap が待たされる。
- 案 B: cap 間で交互（公平）。利点: 偏らない。欠点: 実装と説明が複雑。
- 推奨: A。理由: 今の決まりを変えず、偏りが問題になってから B を検討できる。

### U9. 「後続なし」の判断基準と、問い合わせの相手

利用者の原文は「後続なしとか何かしらの判断」。

- 案 A: server が持つ事実だけで判断する（待ち task 0 件・worker の予約 0 件・task の指揮の run が動いていない。3.3）。利点: 相手の cap を起こさず、すぐ答えが返る。欠点: cap の claude が次の worker を起こす予定かどうかは分からない（指揮の run が止まっている間に、report で再開されることもある）。
- 案 B: 他の cap の claude に実際に尋ねる（その cap の lane を再開して答えさせる）。利点: cap の意図が分かる。欠点: 相手の会話を再開する（費用と待ち）。相手が忙しいと答えが遅い。session の分離が崩れる。
- 案 C: A の結果に、「その cap で再開待ち（report を待つ worker）がいるか」を足す。利点: A より取りこぼしが少ない。欠点: 基準が増える。
- 推奨: A。理由: 層を飛ばさず、すぐ答えが返る。足りなければ C。

### U10. 資源の再測定の周期と、待ちの打ち切り

- 周期の値と、予約の待ちの期限は、利用者が決める値で、設計は決めない。
- 案 A: 契機は worker の完了・停止だけ（周期の再測定なし）。利点: 単純。欠点: 動いている worker が 0 本で外部 process が host を塞いだ後に空いても、予約が始まらない。
- 案 B: 契機に周期の再測定を足す（周期は利用者が決める）。利点: 外部 process が終わった後に自動で始まる。欠点: 周期の値を決める必要がある。
- 案 C: B + 一定時間待った予約を cap に知らせる（打ち切りはしない。期限は利用者が決める）。利点: cap・利用者が詰まりに気づける。欠点: 期限の値が増える。
- 推奨: B。理由: 動いている worker が 0 本の時に server 以外に再確認する担い手が無い（cap は report でしか再開しない）ため、周期の再測定が要る。C は、掲示板の表示（3.2）で足りるか利用者が判断した後。

### U11. 通知の再開を worker 終了の再開の上限に数えるか

今の上限（`session.exitResumeMax`、既定 3）は、cap・task ごとに worker が done 無しで終わった再開を数え、超えると task を failed にする（`worker-exit.ts:180-191`）。

- 案 A: 数えない。利点: 正当な通知が上限で止まらず、task も failed にならない。欠点: cap が通知の依頼を出し続ける限り、再開が増える（依頼は 1 件 1 通知で、依頼を出すのは cap の claude なので、暴走の歯止めは cap の判断だけ）。
- 案 B: 同じ上限に数える。利点: 再開の暴走を既存の上限で止められる。欠点: 通知が worker の失敗の再開と枠を食い合い、正当な通知が上限で止まって task が failed になりうる。
- 案 C: 通知用に別の上限を置く。利点: 食い合わず、暴走も止まる。欠点: 新しい上限の値が要る（利用者が決める値が増える）。
- 推奨: A。理由: 新しい上限の値を利用者が決めていない中で、既存の上限（worker の失敗用）の意味を変えない。暴走が実際に出たら C を検討する（その時の値は利用者が決める）。

## 6. この設計がしていない事

- 上限・閾値・周期・期限の値は決めていない（U2・U3・U5・U10・U11）。
- code・config・protocol・DB は変えていない。
- 動いている server・外部記憶には触れていない。
