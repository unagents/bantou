# スリープを「起動しないリセッション」にする設計

- 作成: 2026-11-23
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。`packages/memory` は触れない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`、repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。
- 並行 task: `origin/feat/app-restart-check`（`docs/design/app-restart-check.md`、399c5b0）と同じ file を触る。関係は 6 節。
- 既存の流儀: `docs/design/resession.md`（リセッション）と同じ形。保存・取り出し・最初の入力はリセッションの部品をそのまま使う。

## 0. 利用者の指示と、決めてある事

利用者の指示（原文）:

> スリープは起動しないリセッションにして欲しい

> 起こした時に状況確認は不要。引き継ぎを渡されてそれを見るのが状況確認と同じでしょ

決めてある事（変えない）:

- 眠らせる時: その session のエージェントに引継ぎを書かせ、リセッションと同じ保存（外部記憶。届かない時は決まった file）をしてから、会話を止める。新しい会話は立ち上げない。
- 起こした時: 新しい会話（`--continue` 無し）で起動し、最初の入力で引継ぎを渡す。渡し方はリセッションと同じ（center が保存先から取り出して渡す。取り出せなかった時は、その事・理由・置き場を書く）。
- 起こした時に、別の「状況の確認」の入力は送らない。引継ぎを読む事がその確認にあたる。
- app の再起動では、スリープ中の session は今どおり起こさない。

この設計は、上の 4 点に上限・時間・回数・除外・独自の仕様を足さない。決められない点は 5 節の未決にした。

## 1. 今の仕組み（調べた事）

### 1.1 スリープと起こす処理

- 【事実】入口は 3 つあり、どれも最後は `SessionManager.sleep(name)` に行く。`session_sleep`（center の外向けの窓口 `/mcp`、`packages/center/src/tools.ts:126-134`）、`coordinator_session_sleep`（統括の MCP。`packages/center/src/coordinator.ts:144-163`。裏は center の `session_sleep` を呼ぶ `centerBackend.sleepSession`、`packages/center/src/coordinator-mcp.ts:137-140`）、desktop の操作（【推測】`session_sleep` を呼ぶ。`packages/desktop/e2e/session-sleep.spec.ts`。code は読んでいない）。
- 【事実】`sleep`（`packages/center/src/sessions.ts:859-885`）は、serial の中で、(1) 保存した記録に `sleeping = true` を書いて persist（止めている途中で center が落ちても眠ったまま復帰する為、先に書く）、(2) `supervisor.stop(name)`、(3) 止められなかったらフラグを戻して投げる、(4) 身代わりの登録（`notifySleep(name, true)`）と `events` の `sleep` の通知。**エージェントには何も頼まない。会話は止めるだけで、引継ぎは作らない**。
- 【事実】`wake`（`sessions.ts:887-913`）は `sleeping` を消して persist → `notifySleep(name, false)` → `supervisor.start(name, { resume: true })`（`--continue`）。起動に失敗したら `sleeping` を戻して身代わりも戻す。
- 【事実】`wake` の呼び出し元は 3 つ。`session_wake`（`tools.ts:136-144`）、`rc_start` が眠っている session を見つけた時（`tools.ts:312`）、sleep-gate（眠っている session 宛の messenger の message が来た時と desktop で開いた時。`packages/center/src/sleep-gate.ts:96-115`、`daemon.ts:194-199`）。全て `sessions.wake` を通る。
- 【事実】`restore()`（center の起動時、`sessions.ts:558-`）は `s.sleeping === true` なら `notifySleep(s.name, true)` して `continue`（起こさない。`:576-578`）。`sleeping` は保存した記録（`SavedSession.sleeping`、`:29-30`）に載り、center の再起動をまたぐ。
- 【事実】`restartFresh`（`sessions.ts:917-`）は `supervisor.start(name)`（`resume` 無し = 新しい会話）で、失敗したら `--continue` で元の会話を起こし直す。眠っている session には使えない（`:920`）。

### 1.2 リセッション（流用する部品）

- 【事実】`createResessioner`（`packages/center/src/resession.ts:111-`）:
  - `request(session, handoff)`（`:174-`）: 安全確認 `check`（`session_create` の session だけ・動いている・`needs-input` でない・remote の未完了と未返答が無い。`:146-`）→ `saveToMemory`（届かなければ file に書く。`stored` は `memory` | `file`）→ 印 `marks` を `waiting-stop` で付けて即返す。
  - `onHook`: `Stop` で印が `waiting-stop` なら `defer` の後に `run`（`:239-`）。`SessionStart`（`source === "startup"`）で印が `awaiting-start` なら `deliver`（`:269-271`）。
  - `run`（`:158-`）: 見直し `check(session, true)` → 区切りの行を積む → `fetchHandoff` を再起動と並行に始める → `deps.restartFresh(session)`。
  - `deliver`（`:193-`）: 印を消す（1 回だけ）→ `mark.fetched`（取り出し）を待つ → `firstInputText` → bracketed paste → `submitDelayMs` 置いて `\r`。取り出せなければ `firstInputText` が「取り出せなかった事・理由・置き場」を 1 行で書く（`:92-103`）。本文は file に残し `deliveredAt` を書く。
  - 取り出し `fetchHandoff`（`:117-`）: `stored` の側 1 つから読む（memory は `readFromMemory`、file は `fileOf(session)` で id 一致を確かめる）。投げない。
- 【事実】リセッションの印 `marks` は center の process 内の Map で、center の再起動で消える（`resession.md` U8 の B）。
- 【事実】`session_resession` は session 自身が呼ぶ tool（session 向けの窓口 `/mcp/session`）。agent に「いつ・何を書くか」を教えるのは system 指示（`packages/center/src/system-instructions.ts`）と tool の description（`resession-description.test.ts` が文面を守る）。
- 【事実】system 指示（`packages/center/instructions/*.md`・`system-instructions.ts`）にスリープの記述は無い。スリープの説明は tool の description（`tools.ts:131`、`coordinator.ts:149`）にあり、「元の会話のまま起き直す」と書いてある。これは変わる（4 節）。

### 1.3 今スリープ中の session

- 【事実】今眠っている session には引継ぎが無い（スリープは会話を止めるだけ）。保存した記録は `sleeping: true` だけで、起こすと `--continue`（元の会話）で起きる。この session をどう起こすかは U4。

## 2. 設計

全体: スリープ = 「リセッションの前半（引継ぎを書かせて保存し、turn の終わりを待つ）→ 後半を再起動でなく**停止**に置き換える」。起こす = 「新しい会話で起動 → 最初の入力で引継ぎを渡す（リセッションの `deliver` と同じ）」。

### 2.1 眠らせる流れ

1. 入口（`session_sleep` / `coordinator_session_sleep` / desktop）が呼ぶのは、`SessionManager.sleep` の前に置く新しい入口 `resession.requestSleep(name)`（daemon が配線。4 節）。眠っている session・存在しない session・config 由来の session の扱いは今のまま（`sleep` が拒否・何もしない）。
2. `requestSleep` は安全確認（`check`）を通し、session の入力に「引継ぎを書いて tool で渡す。渡したら短く眠ると言って turn を終える」旨の 1 行を貼る（リセッションの `deliver` と同じ bracketed paste + `\r`）。印を `kind: "sleep"`, `phase: "asking"` で付ける。これは **書かせる形** で、書けない時は U2、書かせ方は U1。
3. エージェントが引継ぎを渡す tool（U1 の推奨: 既存の `session_resession`）を呼ぶと、`request` は印が `asking` の `sleep` なら、リセッションと同じ保存（memory、届かなければ file。`stored`・`id` を得る）をして、印を `waiting-stop`（`kind: "sleep"`）にする。再起動の印と違い、この呼びは**会話を止める**印になる。
4. `Stop` hook で印が `waiting-stop` の `kind: "sleep"` なら、`run` と同じ見直し `check(session, true)` の後、`restartFresh` の代わりに `sessions.sleep(name, { handoff: { id, stored } })` を呼ぶ。会話は止める。**新しい会話は立ち上げない**（区切りの行も積まない。起こした時に積む。2.2）。
5. `sessions.sleep` は、今と同じ順（先にフラグと引継ぎの参照を persist → `supervisor.stop` → 失敗したらフラグと参照を戻す → `notifySleep(true)` → `events` の `sleep`）で動く。違いは、保存した記録に `sleeping: true` と並べて **`sleepHandoff: { id, stored }`** を書く事だけ。center が落ちても、起こす時に取り出せる（リセッションの印は process 内だが、眠りは center の再起動をまたぐ為、参照を保存した記録に載せる必要がある。file の記録は `stored === "file"` の時だけ有り、memory の時は `id` が無いと取り出せない）。
6. 申告の後に利用者の入力が来て会話が進んだ時は、リセッションと同じく印を戻して見送る（`onHook` の `UserPromptSubmit`）。見送りは `sleep` の呼び出し元に分かる形で返す（U2・U3）。
7. center が再起動すると印は消え、フラグはまだ付いていないので、session は眠らず動いたまま（眠りの途中の状態を保存した記録に持たない。`sleeping` は止めた後にだけ付く）。

### 2.2 起こす流れ

1. `wake` は、保存した記録に `sleepHandoff` があれば、`supervisor.start(name)`（`resume` 無し = 新しい会話）で起動する。**`--continue` は使わない**。`sleepHandoff` が無い記録（今眠っている session）は U4。
2. `wake` は起動の前に、リセッションの印 `awaiting-start`（`kind: "wake"`）を `{ id, stored }` で付ける（`SessionStart` を取りこぼさない為、先に付ける。`run` が `awaiting-start` を先に立てるのと同じ理由。`resession.ts:177-179`）。取り出し `fetchHandoff` は起動と並行に始める。
3. 新しい claude の `SessionStart`（`source === "startup"`）で `deliver` が走り、最初の入力で引継ぎを渡す。**文面はリセッションと同じ形**（`firstInputText`。先頭の語は「リセッション」でなく「スリープから起こした」に変える。取り出せなかった時の 1 行も同じ形）。別の「状況の確認」の入力は送らない。
4. 区切りの行（`RESESSION_DIVIDER`）は起こした時に出力キューへ積む（以前のやり取りの表示と新しい会話の境目。リセッションと同じ）。文言は「スリープから起こした」に合わせる。
5. 起動に失敗したら、今と同じく眠ったままに戻す（フラグ・`sleepHandoff`・身代わり・印を元に戻す。引継ぎは保存済みなので次の起こしでまた渡せる）。
6. 渡し終えたら、`sleepHandoff` を保存した記録から外す（二度目の起こしで古い引継ぎを渡さない）。file の記録は残し `deliveredAt` を書く（リセッションと同じ）。取り出せなかった時（本文を渡していない時）に `sleepHandoff` を残すか外すかは U5。
7. 起こす入口は全て `sessions.wake` を通る（1.1）ので、`session_wake`・`rc_start`・desktop で開く・messenger の宛先、のどれで起きても同じ（新しい会話 + 引継ぎ）。

### 2.3 app の再起動

`restore()` は今のまま、スリープ中の session を起こさない（`sessions.ts:576-578`）。`sleepHandoff` は保存した記録に残り、後で起こした時に使う。

## 3. 変更点（file・関数単位。実装は別の task）

| file | 変更 |
|---|---|
| `packages/center/src/sessions.ts` | `SavedSession` に `sleepHandoff?: { id: string; stored: "memory" \| "file" }`。`sleep(name, opts?: { handoff })` を、止めて参照を保存する primitive にする（`opts` 無しの呼びは U4 の扱い）。`wake` は `sleepHandoff` があれば `resume` 無しで起動し、前後に `onWake?: (name, handoff) => void` を呼ぶ（印を付ける）。起動失敗の戻しに `sleepHandoff` を含める。`restore()` は変えない |
| `packages/center/src/resession.ts` | `Mark` に `kind: "restart" \| "sleep" \| "wake"` と、`asking` の phase。`requestSleep(session)`（2.1 の 1〜2）と `armWake(session, handoff)`（2.2 の 2）を足す。`request` は `asking` の印があれば `sleep` として受ける。`onHook` の `Stop` は `kind` で `restartFresh` か `sleepNow`（`deps`）に分ける。`deliver` / `firstInputText` は `kind` で先頭の語だけ変える。`pending` は `asking`・`wake` も true |
| `packages/center/src/daemon.ts` | `createResessioner` に `sleepNow: (name, ref) => sessions.sleep(name, { handoff: ref })` を足す。`createSessionManager` の `onWake` を `resession.armWake` に繋ぐ。tool 群の `sleep` を `resession.requestSleep` 経由にする（`session-sleep` の配線） |
| `packages/center/src/tools.ts` | `session_sleep` が `requestSleep` を呼び、返す形が変わる（U3）。description を「引継ぎを書かせてから止める。起こすと新しい会話で引継ぎを渡す」に直す。`session_wake` の description も「元の会話のまま」を直す |
| `packages/center/src/coordinator.ts` / `coordinator-mcp.ts` | `coordinator_session_sleep` の description と返り値を `session_sleep` の変更に合わせる |
| `packages/center/src/system-instructions.ts` / `instructions/*.md` | 眠らせる依頼が来た時にエージェントが引継ぎを渡す tool を呼ぶ事（U1 の推奨なら `session_resession` の description に 1 文）を書く。system 指示の部品を足す場合は版（`instructions.generated.ts`）の更新が要る |
| `packages/center/src/sleep-gate.ts` | 変更なし（`opts.wake` を呼ぶだけ）。起こした後の message の渡し順は U6 |
| `packages/desktop` / `packages/ui` / `packages/memory` | 変更なし（【未確認】desktop が「眠らせる」の返り値の形に依存している場合は U3 で合わせる） |
| `docs/design/resession.md` | 1 行の追記（スリープとの関係。実装の時に） |

## 4. test 方針

既存の `packages/center/test/session-sleep.test.ts`（偽の supervisor・`createSleepGate`）、`resession.test.ts`（偽の claude・実の SessionManager / core）、`sessions.test.ts`、`tools.test.ts`、`coordinator.test.ts`、`resession-description.test.ts` の作りに合わせる。実装 worker は test を足した後、各変異を 1 つずつ入れて落ちる事を確かめる（落ちない test は不十分）。

| # | test | 変異（入れると落ちる） |
|---|---|---|
| T1 | `requestSleep` で session の入力に引継ぎを頼む 1 行が入り、tool（引継ぎ）の後、`Stop` で `supervisor.stop` が呼ばれる。`supervisor.start` は呼ばれない（新しい会話を立ち上げない）。`sleeping` と `sleepHandoff` が保存される | `Stop` で `restartFresh` を呼ぶ / `start` を呼ぶ / `sleepHandoff` を書かない |
| T2 | 引継ぎは memory に保存（`stored=memory`）。届かない時は file（`stored=file`、本文は file にある） | `request` が `sleep` の時に保存を飛ばす |
| T3 | 引継ぎを受けるまで `sleeping` は付かない・止めない（`asking` の間 / tool の呼び出しの後で `Stop` の前） | tool の時点で止める / `asking` で止める |
| T4 | 書けない場合（U2 の推奨に合わせた各場合）: `needs-input`・remote 未完了・session が動いていない・申告の後に利用者の入力 → 止めない・理由が呼び出し元に返る・印が残らない | `check` を外す / `UserPromptSubmit` の見送りを外す |
| T5 | `wake` は `resume` 無しで `start` する（`--continue` が付かない）。`SessionStart`（`startup`）で最初の入力に引継ぎの本文が入る（paste → 待ち → `\r`）。「状況の確認」の別の入力は送られない（入力は合計 1 回） | `wake` が `resume: true` を渡す / 確認の入力を足す / `deliver` が本文を入れない |
| T6 | 取り出せない時（memory に無い・file の id 違い）は、本文を渡さず、事・理由・置き場を書いた 1 行を送る | 失敗時に本文の代わりに空を送る / 理由を書かない |
| T7 | 起動失敗で眠ったままに戻る（`sleeping`・`sleepHandoff` が残り、次の `wake` でまた渡せる） | 戻しで `sleepHandoff` を消す |
| T8 | center の再起動（新しい `createSessionManager` + `restore`）: スリープ中は起こされず、`sleepHandoff` が残り、その後の `wake` で渡る | `restore` が `sleepHandoff` を落とす / スリープを起こす |
| T9 | 渡した後は `sleepHandoff` が外れ（U5 の推奨）、2 回目の `wake` で古い引継ぎを渡さない | 外さない |
| T10 | `sleep-gate` 経由（messenger 宛・desktop）の `wake` でも同じ（新しい会話 + 引継ぎ）。起こした後の message が引継ぎの最初の入力より前に入らない（U6 の推奨） | 順を逆にする |
| T11 | 今眠っている session（`sleepHandoff` 無し）の `wake`（U4 の推奨に合わせる） | 分岐を外す |
| T12 | `session_sleep` / `coordinator_session_sleep` の返り値と description（U3）。description が「元の会話のまま」を含まない | description を戻す |
| T13 | `session_resession`（再起動）の既存 test が全て通る（`kind` の追加でリセッションが壊れない）。`restart` の印は `restartFresh`、`sleep` の印は停止 | `kind` を見ずに全て同じ分岐にする |
| T14 | `resession.pending` が `asking`・`wake` でも true になり、app-restart-check の「リセッションと重ねない」判定（6 節）に効く | `pending` が `restart` だけ見る |

実測（実装の後。この task では行っていない）:

- S1: 実際の claude に引継ぎを頼む 1 行を貼ると、引継ぎを渡す tool を呼んで turn を終えるか（作業中・長い turn の途中・`needs-input` の時の入力の扱い）。
- S2: `resume` 無しで起動した claude の `SessionStart` の `source` の値（`startup`）。リセッションの S1・S3 と同じ確認。
- S3: 起こした直後の最初の入力が確定されるか（リセッションと同じ）。

## 5. 未決

### 決定（利用者、2026-11-23）

下の U1〜U6 の決定。ここに無い未決は、各項の推奨のとおり。

- U1: A。既存の `session_resession` を再利用し、center が印（`kind` / `asking`）で区別する。
- U2: A。書けない時は、どの場合も眠らせず理由を返す。`working` も `Stop` まで待たずに断る。待ちの上限は置かない（上の「推奨」の C 案のうち `working` を待つ部分は採らない）。
- U3: A。受理して即返す。受理前の拒否は同期で返す。
- U4: A。今スリープ中で `sleepHandoff` が無い session は、従来どおり `--continue` で起こす。
- U5: B。取り出せなかった時は `sleepHandoff` を外す。
- U6: A。`sleep-gate` を変えない。S3 は release の後の実測で見る。
- スリープのボタン（画面）: 作業中は押せない。作業中かどうかは今ある状態の表示（作業が続いているか／master-cap が busy か）で判断する。U2 の「眠らせない場合」と、画面の押せない条件が食い違わない事。ボタン以外の入口（`session_sleep` / `coordinator_session_sleep`）で作業中に眠らせようとした時は、U2 のとおり理由を返して断る。

### U1 エージェントに引継ぎを書かせる形

- A: 眠らせる依頼が来たら、center が session の入力に「引継ぎを書いて既存の `session_resession` で渡し、turn を終える」旨の 1 行を貼る（2.1）。tool は既存の物。center は印（`asking`）で「この呼びは眠らせる為」と分かる。利点: tool が増えない。保存・安全確認・即返りがそのまま使える。欠点: 同じ tool が「再起動」と「眠る」の 2 通りに効く（印で区別。tool の返り値の `restart` の文も印で変える）。
- B: 新しい tool（例 `session_sleep_handoff`）を session 向けの窓口に足し、眠らせる依頼の 1 行はそれを指す。利点: 意図が tool 名に出る。欠点: tool・description・system 指示・test が増え、保存の経路が 2 つになる。
- C: 引継ぎを依頼せず、center が会話の末尾などから自動で作る。**利用者の指示（エージェントに書かせる）に反する。却下**。
- 推奨: A。

### 決定: 作業中は眠らせない（旧 U2 のうち「作業中で引継ぎを書けない時」）

利用者の指示（原文）: 「スリープのボタンを押せる時と押せない時を作って。作業中は押せない」

- 決定: 画面のスリープのボタンは、その session が作業中の間は押せない（disabled。title に理由を出す）。作業が終われば押せる。眠らせる前に「作業が終わるのを待つ」「引継ぎ無しで眠らせる」事はしない。
- 「作業中」の判定は、side menu の「作業進行中」の印と同じ（`sessionProgress`、`packages/ui/composables/sessionStatus.ts`）。cap 自身が busy、subagent・background の実行中、remote の task が走っている、のどれか。新しい状態・上限・値は足さない。
- 押せない条件は `sleepBlock`（同 file）の 1 か所。作業中に加え、center が U2 で断る場合（動いていない・needs-input・remote 未完了・remote 未返答・スリープ中）と同じ条件にして、画面と center の判定が食い違わないようにした。
- 実装: `packages/ui/composables/sleepButton.ts`（`sleepButtonState` と `clickSleep`。条件は `sleepBlock`）。ボタンは `packages/desktop/src/pages/index.vue`。test は `packages/ui/test/sleep-button.test.ts`。
- 旧 U2 の残り（応答しない・needs-input・remote 未完了・止まっている）の扱いは、下の U2 と U7 のまま。ここで決めたのは作業中の「画面のボタン」の入口だけ。

### U2 書けない時（応答しない・needs-input・remote 未完了・止まっている）

指示は「エージェントに引継ぎを書かせる」まで。作業中は上の決定（眠らせない）で決まった。それ以外の書けない時の扱いは決まっていない。

- A: **眠らせない**。理由を呼び出し元に返し、session は動いたまま（今の `session_sleep` が「止められなかったら眠った事にしない」のと同じ向き。`sessions.ts:870-877`）。利点: 引継ぎ無しで会話を捨てない。欠点: 応答しない session は眠らせられない。
- B: 引継ぎが書けなくても止める（`sleepHandoff` 無し。起こした時は U4 と同じ扱い）。利点: 必ず眠れる（メモリを空ける目的）。欠点: 引継ぎが無い。
- C: 書けない場合ごとに分ける。作業中（`working`）は turn の終わり（`Stop`）まで待って頼み、`needs-input`・remote 未完了は A、動いていない（`stopped` 等）は B。利点: 場合に合う。欠点: 場合の数だけ分岐。
- 待ちの上限（応答しない session をいつ諦めるか）は利用者の決める値で、この設計では置かない。A・C を採るなら、上限を置くか（置く時の値）、`asking` のまま待ち続けて呼び出し元が別に取り消すか、を利用者が決める。
- 推奨: C のうち、`working` は `Stop` まで待つ・`needs-input`・remote 未完了・申告の後に利用者の入力は A（眠らせず理由を返す）。動いていない session（すでに止まっている・起動中）は B ではなく A（動いていない session に引継ぎは頼めず、すでに止まっているなら止める物が無い）。上限の有無は利用者の決定待ち。

### U3 `session_sleep` が何を返すか（待つか、受理して返すか）

今は止めてから `SessionInfo` を返す。新しい形は、エージェントが書き終わり turn が終わるまで時間がかかる。

- A: 受理して即返す（`{ accepted: true, sleeping: false, pending: true }`）。眠った事は `events` の `sleep` 通知（今も出す）と `session_list` の `sleeping` で分かる。利点: 呼び出し元の MCP が長く待たない（リセッションの `session_resession` も即返り）。欠点: 返り値の形が変わる。呼び出し元（統括・desktop）が非同期に対応する必要。
- B: 眠るまで待って `SessionInfo` を返す（今の形）。利点: 呼び出し元は変わらない。欠点: tool 呼び出しが長く塞がる。MCP の待ちの上限に当たりうる（【未確認】）。
- 推奨: A。見送り・失敗は、呼び出し元に届かないので `events`（`sleep` の取り消しの通知）で分かる形にするか、U2 の A の拒否をその場で返す（受理の前の拒否は同期で返せる）。

### U4 今スリープ中の session（引継ぎが無い）を起こした時

保存した記録に `sleepHandoff` が無い session。

- A: 今まで通り `--continue`（元の会話）で起こす。引継ぎは渡さない。利点: 会話を失わない。移行の時に壊れない。欠点: 起こした session は、新しい仕組みで眠った session と違う動き（古い眠りだけの例外。新しく眠る session では起きない）。
- B: 新しい会話で起こし、引継ぎが無い事を最初の入力に書く（取り出せなかった時の形に合わせる。置き場は「無い」）。利点: 起こし方が 1 通り。欠点: 元の会話を使わず、引継ぎ無しで始まるので文脈を失う。
- C: 起こす前に、一度 `--continue` で起こして引継ぎを書かせ、そこから新しい会話にする。利点: 失う物が無い。欠点: 起こす操作が 2 段になる。「起こした時に起動しない」ではなくなる。
- 推奨: A（移行の時だけ。会話を失わない）。

### U5 引継ぎを渡せなかった時（取り出し失敗）、`sleepHandoff` を残すか

- A: 残す（次の起こしでも同じ参照で取り出しを試す）。利点: 一時的な失敗なら次で渡せる。欠点: 新しい会話はすでに始まっており、2 回目の起こしは次の眠りの後（その眠りで `sleepHandoff` は新しく上書きされる）。取り出せない物を参照し続けない。
- B: 外す（リセッションと同じ。渡せなかった事は最初の入力に書いた）。利点: 状態が残らない。欠点: 一時的な失敗でも引継ぎの参照が消える（本文は memory・file に残るので、置き場を最初の入力に書いてある）。
- 推奨: B（リセッションは取り出せなくても印を消す。同じ扱いに揃える）。

### U6 起こした後の messenger の message と最初の入力の順

眠っている session 宛の message は身代わり peer が預かり、起こした後に渡す（`sleep-gate.ts:96-115` の `deliverAll`）。

- A: 変えない（`wake` が戻ってから message を渡す。起動直後は `SessionStart` の前かもしれない）。利点: sleep-gate が変わらない。欠点: message が引継ぎの最初の入力より先に届きうる（【未確認】S2・S3）。
- B: 引継ぎを渡し終えてから message を渡す（`deliver` の完了を待つ）。利点: 引継ぎが最初の入力になる。欠点: sleep-gate と resession の間に待ちの繋ぎが要る（待ちの上限などの値を決める必要がある）。
- 推奨: A で実測（S3）し、先に届いて入力が壊れるなら B。

### U7 ボタン以外の入口（`session_sleep`・`coordinator_session_sleep`）で、作業中に眠らせようとした時

画面のボタンは作業中は押せない（上の決定）。ただし入口は 3 つあり（1.1）、統括の MCP や center の `session_sleep` は作業中でも呼べる。今の code は、どの入口も作業中かを見ない（実装は未決のままなら現状維持。この task では code を変えていない）。

- A: 拒否してエラーを返す。session は動いたまま。利点: ボタンと同じ向き（作業中は眠らせない）に揃う。引継ぎ無しで会話を捨てない。欠点: 呼び出し元（統括）が拒否を扱う必要がある。作業が終わるまで眠らせられない。
- B: 引継ぎ無しで眠らせる（`sleepHandoff` 無し。起こした時は U4 と同じ扱い）。利点: 必ず眠れる。欠点: 作業中の文脈が引継ぎに残らない。ボタンの決定と食い違う。
- C: 作業が終わる（`Stop`）まで待って、引継ぎを書かせてから眠らせる。利点: 引継ぎが残る。欠点: 呼び出しが長く待つ（U3 の返し方と、待ちの上限の扱いが要る。上限は利用者の決める値）。
- 推奨: A（ボタンの決定と同じ向き。新しい待ち・値を足さない）。U2 の `working` の扱い（推奨 C）とは食い違うので、U2 と合わせて利用者が決める。
- **決定済み（利用者、2026-11-23）: A。U2 の決定のとおり、`working` も `Stop` まで待たずに理由を返して断る。**

## 6. app-restart-check（`feat/app-restart-check`）との関係

`docs/design/app-restart-check.md`（399c5b0）は、app の再起動で `restore()` が起動し直した session に、最初の入力で状況の確認を 1 回送る。

- **起こした時は app の再起動の確認の対象外**。向こうの設計も「スリープ中の session は今どおり起こさない（後で起こした時も対象外）」「`wake` は呼ばない」と決めている（同 2.1）。こちらの `wake` は `restore()` を通らず、印（`arm`）は付かない。起こした時に送る最初の入力は引継ぎだけで、状況の確認は送らない（0 節）。2 つの設計で、起こした時に「状況の確認」が送られる経路は無い。
- **スリープ中の session は両方で起こさない**。`restore()` の `sleeping` の `continue`（`sessions.ts:576-578`）より後に向こうの `onRestoreStart` が来るので、眠っている session に印は付かない。こちらも `restore()` を変えない。
- **印の重なり（防衛）**: 向こうは「`resession.pending(session)` が true なら確認を送らない」を持つ。こちらは `pending` を `asking`・`wake` の印でも true にする（T14）ので、万一 `restore()` の起動と同時に眠りの印が立っていても、確認の入力は送られない。
- **眠った時の印の取り消し**: 向こうは `events` の `sleep`（眠った時）で `restartCheck.cancel` を呼ぶ。こちらは `sleep` の通知を止めた後にだけ出す（2.1 の 5。`asking`・`waiting-stop` の間は出さない）ので、眠る途中で確認の印が取り消されて失われる事は無く、止まって初めて取り消される。起こしの失敗（眠ったままに戻す）でも `sleep` を出す（今と同じ）。向こうの `cancel` は印が無ければ何もしない前提。
- **同じ file を触る所（衝突の見込み）**:
  - `sessions.ts`: 向こうは `restore()` に `onRestoreStart` / `onRestoreFail` を足す。こちらは `sleep` / `wake` と `SavedSession`、opts に `onWake`。関数が違うので機械的な衝突は小さい。opts の型の追記が隣り合う程度。
  - `daemon.ts`: 向こうは `createRestartChecker` の生成・`onHook` で `restartCheck.onHook` を `resession.onHook` より先に呼ぶ・`events.subscribe` の配線。こちらは `createResessioner` の `sleepNow` と `onWake`、tool の `sleep` の配線。`onHook` の呼び順は向こうのまま（こちらは変えない）。
  - `resession.ts`: 向こうは `ResessionDeps.cancelRestartCheck` と、`deliver` の paste 部分の共通関数化（向こうの U3 の A）。こちらは `Mark.kind`、`requestSleep`・`armWake`、`Stop` の分岐、`firstInputText` の先頭の語。向こうが共通関数 `submitFirstInput` を出すなら、こちらの `deliver` はそれを使う（どちらが先に merge されても、後の側が追従する）。`run` の中の `cancelRestartCheck` の呼びは `kind: "restart"` の時だけ（眠る時は再起動しないので不要）。
- **merge の順**: どちらが先でもよい。後に merge する側が `deliver` の共通関数化と `onHook` の呼び順に合わせて直す。実装 worker は、相手の branch が先に develop に入っているかを確かめてから `resession.ts` を直す。
- **向こうの未決との整合**: 向こうの U1（`SessionStart` の `source`）は `startup` と `resume`。こちらは `resume` 無しの起動だけなので `startup` を待つ（S2 で確かめる）。向こうの U4（center だけの再起動も対象）は、スリープ中の session に影響しない（`restore()` が眠りを飛ばす）。

## 7. 実装の分け方（並行できる単位）

| 単位 | 所 | 内容 | 並行 |
|---|---|---|---|
| I1 | `sessions.ts` + `sessions.test.ts` / `session-sleep.test.ts`（T7〜T9・T11 の一部） | `sleepHandoff` の保存・`sleep(name, { handoff })`・`wake` の `resume` 無し・失敗の戻し・`onWake` | I2 と並行（`onWake` と `sleep` の opts の形だけ先に合わせる） |
| I2 | `resession.ts` + `resession.test.ts`（T1〜T6・T13・T14） | `kind`・`requestSleep`・`armWake`・`Stop` の分岐・`deliver` の語 | I1 と並行 |
| I3 | `daemon.ts`・`tools.ts`・`coordinator*.ts`・system 指示 + test（T10・T12） | 配線・入口・description | I1・I2 の後 |
| I4 | 確認 | 変異の確認（4 節）。S1〜S3 の実測の依頼（実機）。app-restart-check との merge の整合（6 節） | I3 の後 |

## 8. 確かめ方（設計書の記述と code の一致）

この設計書が引く物: `sessions.ts` の `sleep` / `wake` / `restore` / `restartFresh` / `SavedSession`、`resession.ts` の `createResessioner` / `request` / `onHook` / `run` / `deliver` / `fetchHandoff` / `firstInputText` / `pending`、`sleep-gate.ts`、`tools.ts` の `session_sleep` / `session_wake` / `rc_start`、`coordinator.ts` / `coordinator-mcp.ts` の `coordinator_session_sleep`、`daemon.ts` の配線、`docs/design/resession.md`、`origin/feat/app-restart-check:docs/design/app-restart-check.md`（399c5b0）。実装の時は、行番号でなく関数名で引き直す。
