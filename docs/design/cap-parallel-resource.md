# cap の並行: 固定の上限をやめ、host のリソースと掲示板で決める（設計）

状態: 設計のみ（実装・config・protocol は変えていない）。決める人は利用者と master-cap。この文書の「未決」は利用者の決定待ち。

## 1. 利用者の方針（原文の要点）

- 勝手に cap の作業の並行の上限を入れない。設計を見直す。
- remote-cap は、基本、可能な限り task を並行させる。**これは鉄の掟**。
- ただし remote-cap が動く host のリソースは常に気にする。
- 同じ host の複数の remote-cap は、host のリソースの状況と、他の cap が動かす worker の実行数を見て、何本並行させるかを判断する。
- 同じ host の cap 同士は、後続の待ち task の有無を問い合わせ、worker の完了の通知を依頼できる。
- bantou-server が、管理する cap と稼働中の全 worker を見える化する掲示板を持つかもしれない。リソースの解放待ちは、フラグだけの簡易な次の予約として bantou-server が queue に貯めるかもしれない。

## 2. 今の作り（server 0.6.11 / 調査した repo の develop `4bf3751`）

調べたのは repo の develop。desktop の package version は 0.1.60（依頼の 0.1.58 とは異なる。並行の作りは同じ決まりのまま確認した）。

### 2.1 固定の上限（既定 2）

- config `session.maxParallelTasks`、既定 2、1 以上の整数。`packages/server/server/utils/bantou/config.ts:44`（既定）、`:75`（型）、`:284-286`（検証）。
- daemon が `tasks` の scheduler に渡す: `daemon.ts:383-387`。起動時に「task の同時実行の上限: cap ごとに N」を log: `daemon.ts:415`。
- 数えるのは **cap ごと**。`tasks.ts:171` `mine.filter(running).length >= maxParallel` で `limit` 待ち。`mine` は同じ cap の entry（`tasks.ts:158`）。別の cap の task は数えない。
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

### 3.1 固定の上限をやめる（要件 1）

- `session.maxParallelTasks` の固定の上限（既定 2）による待ちをやめる。task は、host の資源が許す限り、受けたらすぐ始める。
- 「待たせる理由」は次の 2 つだけに整理する（数値の上限は置かない）:
  1. host のリソースが足りない（3.2）
  2. 同じ branch の前の task（今の決まり。扱いは U1）
- `waiting_for` の値 `limit` の意味は「固定の上限」から「host のリソース待ち」に変わる。protocol は additive に保つため、新しい値（例 `resource`）を足し、旧 `limit` を読む側は未知の文字列を許す（`CapTaskState` と同じ「reader must accept other strings」の流儀。`protocol/src/server.ts:577`）。
- `maxParallelTasks` の設定項目の扱い（廃止 / 上限なしの既定 / 利用者が任意で置く上限として残す）は **U2**。

### 3.2 host のリソースを見て並行の本数を決める（要件 2）

役割: 「何本まで」を固定値で持たず、**起動の都度、host の今の状態と全 cap の worker の実行数を見て、始めてよいかを判断**する。

測る対象（候補。どれを採るかは **U3**）:

- CPU: 負荷（`os.loadavg()` と論理 CPU 数 `os.cpus().length`）。
- メモリ: 空き（`os.freemem()` / `/proc/meminfo` の MemAvailable）。
- 実行中の worker 数（掲示板。3.4）。実測の資源の値は worker 数が増えた結果として現れるまで遅れるので、数も併用する。
- ディスクの空き（worker の clone・node_modules が溜まる。`cap-orchestration.md:118`）。

測り方の方針:

- 測るのは server が持つ host の値だけ。外部の記憶・DB は使わない。
- 判断の入口は 1 つ（server の scheduler）。task の開始（`tasks.ts` の `blockedBy`）と worker の開始（`workers.ts` の `start`）の両方で「host に空きがあるか」を問う。
- 「空きがあるか」の**閾値は決めない**（U3）。

task の開始と worker の開始の違い:

- 今の上限は task（lane）の数を数える。しかし資源を食うのは worker（clone・ビルド・テスト・claude の子 process）。task の lane 自体は会話 1 つ。**何を資源の単位として数えるか（task か worker か）は U4**。

### 3.3 同じ host の cap 同士の問い合わせと完了の通知の依頼（要件 3）

利用者の例: session-A の cap が session-B の cap に「後続の待ち task はあるか」と問い、無い（など）なら、B の worker の完了で A に通知してほしい、と依頼できる。

- 前提: 同じ server の中の cap（cap は session × server に 1 つ。2.5）は同じ process の中にいて、server が全部を知っている。cap 同士が直接やり取りするのではなく、**bantou-server を仲介**にする（指示は層を飛ばさない決まり。cap が別の cap に直接指示するのでなく、server の掲示板の機能として提供する）。
- 問い合わせ: 「他の cap の、待っている task の有無」。答えは掲示板（3.4）の公開情報から返す（待ち task の数・理由だけ。goal などの中身は返さない = 他の session の指示・結果を見せない `architecture.md:44` の趣旨を守る）。
- 通知の依頼: 「cap B の worker W（または cap B の task T）が終わったら cap A に知らせる」。server が覚え、終わった時に cap A へ通知する。
- 通知の届け方: cap A は report で再開する作り（`cap-orchestration.md:142`。cap は report でしか再開しない）。通知は A の指揮（lane）の再開として届ける（今の `[worker 終了通知]` の仕組み `worker-exit.ts:45` と同じ形が使える。推測: 既存の再開の入口を流用できるはずだが、実装時に要確認）。
- 通知の依頼の寿命・件数・server 再起動をまたぐか（今の `tasks` はメモリのみ）は **U5**。
- 他の cap の worker を止める・順序を変える権限は与えない（問い合わせと通知の依頼だけ）。

### 3.4 bantou-server の掲示板（要件 4）

server が、**自分が管理する cap と稼働中の全 worker の数**を 1 か所で見えるようにする。

載せる内容（案。載せる項目の最終は **U6**）:

- cap の一覧: cap_id、state、動いている task の数、待っている task の数と理由。
- 稼働中の worker の数（全 cap 合計と cap ごと）。
- host のリソースの測定値（3.2。測った時刻付き）。
- 次の予約の待ち（3.5）の件数。

見え方:

- protocol: `status_result` に additive の欄として足す（`caps` / `workers` は今のまま。追加の欄は旧 peer が無視する。`docs/protocol.md:188` の `tasks` と同じ流儀）。版を上げるかは protocol 定義の決まりに従う（`cap-orchestration.md:135`）。
- center: `remote_list` に host 全体の掲示板の値を足して返す。待ち表示の文言（`task-status.ts:51`）を「host のリソース待ち」に更新する。`tools.ts:436` と `README.md:231` の「`maxParallelTasks` 既定 2」の説明を改める。
- desktop: 今は選択中 session の cap だけ（`architecture.md:44`）。host 全体の掲示板は、他の session の cap の中身を出さず、**数と資源だけ**を出す欄（例 host ごと 1 行: cap 数・worker 数・資源の状況・待ち数）にする。session の分離は崩さない。
- 範囲: 1 つの server の掲示板は、その server の cap と worker だけ。**同じ host に複数の server がある場合**（`server_id` が別、workspace が別。`identity.ts:99-101`）は、server どうしの掲示板の共有が要る。やり方は **U7**。

### 3.5 リソース待ちの次の予約（要件 5）

利用者の案: リソース解放待ちの worker の依頼は、フラグだけの簡易な「次の予約」にして、bantou-server が queue に貯める。

- 予約の中身: 「cap X の task T（または worker W）は、資源が空いたら始めたい」のフラグだけ。依頼の本文は予約に持たせず、今の作り（task は `tasks.ts` の entry が cmd を持つ）の持ち物のまま、予約はその参照とする。
- 貯める場所: bantou-server の queue（`tasks.ts` の waiting と同じ層）。今の「cap ごとの待ち」を「host 全体の待ち」に広げる形。
- 解放の契機: worker の完了・host の資源の回復。契機で、予約の先頭から「始めてよいか」（3.2）を問い直す。
- 順序: 来た順（今の `pump` と同じ。`tasks.ts:208`）。他の順（cap 間の公平など）は **U8**。
- 3.3 の完了通知の依頼は、この queue の予約と同じ仕組み（契機で通知）に載せられる（推測。実装時に確認）。

## 4. 影響を受ける所（実装時の洗い出し。今回は変えない）

- server: `config.ts`（maxParallelTasks）、`tasks.ts`（`blockedBy` の `limit`）、`daemon.ts:383-415`、`workers.ts`（worker 起動前の確認）、`daemon.ts:182-186`（status）。
- protocol: `CapTaskInfo.waiting_for`、`status_result` の追加欄、docs/protocol.md、版。
- center: `task-status.ts:51`、`tools.ts:436`、`remotes.ts`、`README.md:231`。
- desktop / ui: `RemoteActivity.vue`、host の掲示板の欄。
- 文書: `cap-orchestration.md`「task の並行」（105 行の「既定 2」の記述）、`docs/protocol.md:188,437`、`docs/architecture.md:46`、`packages/server/README.md:96`。
- テスト: `tasks.test.ts:289`、`config.test.ts:158-163` は上限の前提で書かれている。

## 5. 未決（利用者の決定待ち）

数値の上限・閾値はここに案として出すだけで、決めていない。

### U1. 同じ branch の task を待たせる今の決まり

- 案 A: 残す（同じ branch は順に。`tasks.ts:165-170`）。利点: 同じ branch への同時の push の衝突を避けられる。欠点: 「可能な限り並行」に反する。
- 案 B: やめる（待たせない）。利点: 鉄の掟に忠実。欠点: 同じ branch への同時の push が衝突して失敗・上書きの恐れ。衝突の扱いを worker に任せることになる。
- 案 C: 待たせずに、同じ branch の task を知らせる（cap に警告・通知し、cap が判断する）。利点: 並行を保ちつつ cap が衝突を避けられる。欠点: 判断を cap（claude）に委ねる。確実性は A より低い。
- 推奨: A。理由: 鉄の掟は「可能な限り」であり、同じ branch への同時の push は並行できない作業（可能でない）に当たると読める。ただしこの読みは推測で、利用者の決定が要る。

### U2. `session.maxParallelTasks` の扱い

- 案 A: 廃止する。利点: 方針（上限を勝手に入れない）に一致。欠点: 旧 config に書いた利用者の設定が無効になる（読むが無視 + log が要る）。
- 案 B: 既定を「上限なし」にして、設定は利用者が任意で置く上限として残す。利点: 既存の設定が効き、利用者が明示した時だけ制限できる。欠点: 設定項目が残る。
- 推奨: B。理由: 利用者が決めた上限だけが効く形で、方針に反しない。

### U3. host のリソースの何を・どう測るか、「空き」の判定

- 測る対象: CPU 負荷 / メモリの空き / ディスクの空き / 実行中の worker 数（3.2）。どれを使うか。
- 判定の閾値（例: 負荷が CPU 数のどれだけ・メモリ空きがどれだけで「満杯」か）は、利用者が決める値で、設計は決めない。
- 案 A: 負荷とメモリの空きだけ（OS から読める。依存が増えない）。利点: 単純。欠点: ディスク満杯・worker の急増には遅れる。
- 案 B: A + worker 数 + ディスクの空き。利点: 取りこぼしが少ない。欠点: 閾値が増える（利用者が決める値が増える）。
- 推奨: B の構成要素を測るが、閾値は利用者が決めるまで空（閾値未設定の項目は「満杯」と判定しない）。理由: 勝手に閾値を入れない決まりを守りつつ、測る項目は先に揃えられる。

### U4. 資源の単位（task か worker か）

- 案 A: task（lane）の開始を判断する。利点: 今の `tasks.ts` の入口 1 つで済む。欠点: 資源を食うのは worker で、1 task が worker を何本も起こすと見積りが外れる。
- 案 B: worker の開始を判断する（task は受けたらすぐ指揮を始める）。利点: 資源に直結する。欠点: 指揮（lane）が worker 待ちで止まる間の扱い（cap が待つ・再開する）の設計が要る。
- 案 C: 両方（task は掲示板の状態を見て始める、worker は開始時に確認）。利点: 取りこぼしが少ない。欠点: 判断の入口が 2 つになる。
- 推奨: B。理由: 資源を消費するのは worker で、利用者の原文も「worker タスクの実行数」を見ると言っている。

### U5. 完了通知の依頼の寿命と件数

- 案 A: メモリのみ（server 再起動で消える。今の `tasks` と同じ）。利点: 簡単。欠点: 再起動で依頼が消え、依頼した cap は永久に待つ。
- 案 B: ファイルに残す（再起動後も有効）。利点: 取りこぼしが無い。欠点: 古い依頼の掃除が要る。
- 件数・期限の値は決めない（必要なら利用者が決める）。
- 推奨: B。理由: 完了を待つ依頼が消えると cap が止まるため。

### U6. 掲示板に載せる項目と、他の session への見せ方

- 案 A: 数・状態・資源だけ（中身は載せない）。利点: session の分離（`architecture.md:44`）を保つ。欠点: 他の cap が「何を待っているか」は分からない。
- 案 B: task の branch 名なども載せる。利点: 同じ branch の衝突を事前に避けやすい。欠点: 他の session の作業が見える。
- 推奨: A。理由: 指示・結果が混ざらないよう session を分けた決定（2026-11-04）を崩さない。

### U7. 同じ host に複数の server がある場合の掲示板

- 前提（推測）: server ごとに workspace が別なので、同じ host に複数の server が動きうる。実際にそう運用しているかは未確認。
- 案 A: server ごとの掲示板のみ（server 間は見ない）。利点: 実装が最小。欠点: 同じ host の別 server の worker が資源を食っても判断に入らない（資源の実測だけが頼り）。
- 案 B: host 共有の置き場（host 上の共有ファイル等）を 1 つ決め、server 間で数を共有する。利点: 同じ host の全 cap が見える（利用者の原文に近い）。欠点: 共有の置き場の決め（host の共有一時領域を使わない決まりがある）と排他制御が要る。
- 案 C: 複数 server を同じ host に置くことを非対応とする。利点: 単純。欠点: 既存の運用を狭める。
- 推奨: まず A（資源の実測は host 全体の値なので、他 server の分も間接的に反映される）。B は利用者が同居の運用を確認してから。

### U8. 予約の順序

- 案 A: 来た順（今と同じ）。利点: 単純で説明しやすい。欠点: 1 つの cap が大量に予約すると他の cap が待たされる。
- 案 B: cap 間で交互（公平）。利点: 偏らない。欠点: 実装と説明が複雑。
- 推奨: A。理由: 今の決まりを変えず、偏りが問題になってから B を検討できる。

## 6. この設計がしていない事

- 上限・閾値の値は決めていない（U2・U3・U5）。
- code・config・protocol・DB は変えていない。
- 動いている server・外部記憶には触れていない。
