# app 再起動後の状況確認（起動し直した session への最初の入力）の設計

- 作成: 2026-11-23
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。`packages/memory` は触れない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`、repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測が要る事。
- 既存の流儀: `docs/design/resession.md`（リセッション）と同じ形（事実 → 設計 → 変更点 → 未決 → 確かめ方）。最初の入力の経路はリセッションの `deliver` と同じ形を使う。

## 0. 利用者の指示と、決めてある事

利用者の指示（原文）:

> アプリが再起動された時の最初の一回目の時に、エージェントが一度状況を確認するのを入れて欲しい。

決めてある事（変えない）:

- 対象: app の再起動で、center が起動し直した全ての session。スリープ中の session は今どおり起こさない（後で起こした時も対象外）。
- 形: center が、起動し直した session の最初の入力で「app が再起動した事」を知らせ、状況の確認を促す。最初の入力を渡す経路は、リセッションの最初の入力（`packages/center/src/resession.ts` の `deliver`、`SessionStart` の後）と同じ形を使う。
- 確認の中身: [始める時]（記録を読む順）、remote の状態（`remote_list` / `task_status`）、未読の知らせ。止まっている物・届いた結果があれば続きを進め、無ければ短く状態を報告して待つ。
- 1 回だけ: 同じ再起動で 2 回以上送らない。リセッションの再起動（引継ぎを渡す最初の入力）とは重ねない。

この設計は、上の 4 点に上限・時間・回数・除外を足さない。足りない点は 5 節の未決にした。

## 1. 今の仕組み（調べた事）

### 1.1 app の再起動で session が起動し直される流れ

- 【事実】center は起動の最後に `sessions.restore()` を 1 回呼ぶ（`packages/center/src/daemon.ts:354`）。同じ所で config の `projects`（`autostart`）を `supervisor.start(p.name)` で起こす（`:355-360`）。
- 【事実】`restore()`（`packages/center/src/sessions.ts:558`）は保存済みの session を順に `supervisor.add(toProject(s), { wrapper: true, … })`（`:572`）で載せ、`restored` を通知し（`:574`）、`s.sleeping === true` なら `notifySleep(s.name, true)` して `continue`（起こさない。`:576-578`）、それ以外は `supervisor.start(s.name, { resume: true })` で起動する（`:582`）。失敗は log に出して次の session へ進む。
- 【事実】`start(name, { resume: true })` は `--continue` で前の会話に復帰を試み、接続前（30 秒以内）に落ちたら素の起動へ fallback する（`packages/center/src/remote-control.ts:133-136`、`:864-888`）。`start` は起動の指示を出して戻る（接続・`SessionStart` を待たない）。
- 【事実】`restore()` と同じ `resume: true` の起動をする経路が他に 2 つある。スリープからの `wake`（`packages/center/src/sessions.ts:887-902`）と、claude が落ちた時の自動の再起動（`continueOnRestart`、`packages/center/src/remote-control.ts:819-824`）。リセッションの `restartFresh`（`sessions.ts:917`）は `resume` 無しの起動。つまり「`resume: true` で起動した」だけでは app の再起動と区別できない。**app の再起動で起動し直した事を知っているのは `restore()` の呼び出しだけ**。
- 【事実】wrapper 経由（hook が付く）で起動するのは `session_create` で作った session だけ（`wrapper: true` は `sessions.ts:572`、`:618`、`:807`、`:835`）。config 由来の `projects` は wrapper 無しで、hook も最初の入力も届かない（【推測】`supervisor.add` の既定は従来の `claude remote-control`。`remote-control.ts:139-141`）。この設計の対象は `session_create` で作った session。
- 【事実】app（desktop）が center を起動し直す仕組みは、この設計では読んでいない。【推測】center は desktop の sidecar（`CLAUDE.md` の Map）で、app の再起動 = center の process の起動なので、center が `restore()` を呼ぶ。center だけが落ちて起動し直した時も同じ流れになり、center からは区別できない（U4）。

### 1.2 hook の経路と、リセッションの最初の入力

- 【事実】全 session に hook が付く（`SessionStart` を含む。`packages/center/src/session-activity.ts:11-21`）。受けた payload は `daemon.ts:308-317` の `onHook` で、作業状態・最後の応答・外部記憶・リセッション（`resession.onHook(name, payload)`、`:316`）の順に渡る。hook を渡すのは session が `starting` / `connected` の間だけ。
- 【事実】`SessionStart` の payload の `source` は、`startup` 以外に `compact` が実在する（`session-activity.ts:46`。`compact` は状態を変えない）。`--continue` で起動した時の `source` の値の根拠は repo に無い（【推測】`resume`。【未確認】S1）。
- 【事実】リセッションの最初の入力（`packages/center/src/resession.ts`）: `onHook` が `SessionStart` かつ印が `awaiting-start` かつ `source === "startup"` の時に `deliver` を呼ぶ（`:269-271`）。`deliver`（`:193-`）は最初に `marks.delete(session)` で印を消し（1 回だけ）、本文を bracketed paste（`\u001b[200~…\u001b[201~`）で `core.input` に入れ、`submitDelayMs`（既定 400ms）置いて `"\r"` を別に送る（`:200-202`）。入力を渡せなければ（`core.input` が false）log に出して終わる。投げない。
- 【事実】リセッションの印は process 内の Map（`marks`）で、center の再起動で消える（U8 の B。`resession.md` 3.3）。`pending(session)` は印があり古くない時に true（`resession.ts` の `pending`、`isStale` は `AWAIT_START_STALE_MS` = 5 分。`:23`、`:150`）。
- 【事実】休止の設計の実測（自己申告）で、起動直後の入力が確定されず入力欄に残った事がある。リセッションも `SessionStart` を待ってから送る（`resession.md` 3.4）。この設計も同じ。

### 1.3 確認の中身がどこに書いてあるか

- 【事実】[始める時]（「記録を読んでから動く。順は、引継ぎ → 状態 → 決定と未決 → 既知の問題 → 直近の報告」）は `packages/center/instructions/master-cap.md:14-15` にある。指示の「common の [始める時]」は、実際は **master-cap の節**（`common.md` には `[記録]`・`[権限]` などがあり、`[始める時]` は無い）。system 指示には `MASTER_CAP_ROLE` が `masterSection("始める時")` で取り込む（`packages/center/src/system-instructions.ts:114`、`masterSection` は `:42`）。`MASTER_CAP_ROLE` は `when` を持たず、`session_create` の全 session に付く（`SYSTEM_INSTRUCTION_PARTS`、`:234`）。common.md の [記録] の順は `common.md:12-15`。
- 【事実】状態を読む道具は `remote_list` と `task_status`（`system-instructions.ts:166`、`packages/center/src/tools.ts:494`・`:512`）。完了通知・worker の report は messenger の push で届く（`system-instructions.ts:124`）。未読を読む messenger の道具名は center の code に無い（【推測】skill messenger の `check_messages`。実装の時に session に付く道具名を確かめる）。
- 【事実】再起動した session は `--continue` で前の会話の文脈を持つ事が多いが、素の起動へ fallback した時は新しい会話になり、[始める時] の読み直しが要る。

## 2. 設計

### 2.1 「再起動」の検出

- 検出は `restore()` の中で行う。非スリープの session を `supervisor.start(s.name, { resume: true })`（`sessions.ts:582`）で起こす **直前** に、`onRestoreStart(name)` を呼び、印を付ける（`SessionStart` はその後に来るので、先に付ける。リセッションが「先に待ちの状態にする」のと同じ理由。`resession.ts:179`）。
- 呼ばない所（対象外）: スリープ中の session（`:576-578` の `continue` より後に呼ぶので届かない）、`wake`（`:887`）、自動の再起動（`remote-control.ts:819-824`）、`restartFresh`（`:917`）、`session_create`（新規）。
- `start` が投げたら（`:582` の `catch`、`:584-586`）、印を外す（`onRestoreFail(name)`）。
- `daemon.ts:354` の `sessions.restore()` は center の process で 1 回だけ呼ばれる。印は process 内の Map なので、center が次に再起動すれば、その起動で改めて付く（= 次の「app の再起動」の最初の 1 回目）。

### 2.2 印と 1 回だけの保証

- 新しい部品 `createRestartChecker`（`packages/center/src/restart-check.ts`。名前は仮）。印は `Map<session, { since }>`。center の process 内だけ（再起動をまたいで残さない。リセッションの U8 の B と同じ）。
- `onHook(session, payload)`: `hook_event_name === "SessionStart"` かつ印があり、`source` が `startup` または `resume`（U1）の時に、**最初に印を消してから**（`deliver` と同じ順。`resession.ts:194`）最初の入力を送る。`compact`・`clear` など他の `source` は無視して印を残す。
- 1 回だけの根拠（同じ再起動で 2 回以上送らない）:
  1. 印は `deliver` の頭で消す。同じ session の 2 回目の `SessionStart`（`compact`・`clear`・自動の再起動の後）に印は無い。
  2. 印を付ける所は `restore()` だけで、`restore()` は center の process で 1 回。
  3. 入力が届かなかった時（`core.input` が false）も再送しない（U8）。「1 回だけ」を「最大 1 回」とする。
- 付けたまま `SessionStart` が来ない印（その後に利用者が session を止めた・眠らせた・消した・リセッションの再起動をした）が、後の起動の `SessionStart` で誤って発火しないように、印を外す（U2）。

### 2.3 リセッションとの非重複

- リセッションの最初の入力と重なる事があるのは、1 つの `SessionStart` を両方の印が待つ時だけ。`restore()` の印は `SessionStart` を待ち、リセッションの印は session が `session_resession` を呼んだ後に付く（`resession.ts` の `request`）ので、通常は時間が重ならない。ただし防ぐ（防衛）:
  1. `deliver` の直前に `resession.pending(session)` が true なら、送らずに印を消して log に出す（リセッションの最初の入力が「記録の順に読んでから続ける」を既に促す。`resession.ts:96-103`、`resession.md` 10.4）。
  2. リセッションが `restartFresh` を呼ぶ直前（`run`、`resession.ts` の再起動の所）に、`restartChecker.cancel(session)` を呼ぶ（`ResessionDeps` に `cancelRestartCheck` を足す）。
  3. `daemon.ts` の `onHook` で、`restartChecker.onHook` を `resession.onHook` より **先** に呼ぶ（`resession` の `deliver` は印を同期で消すので、後に呼ぶと 1 の判定が false になって両方送りうる）。
- 取り決め: 重なったらリセッションの最初の入力だけを送る（この設計の確認は送らない）。

### 2.4 最初の入力を渡す経路

- `SessionStart` の後、bracketed paste で本文を `core.input` に入れ、`submitDelayMs` 置いて `"\r"`（`resession.ts:200-202` と同じ）。本文は 1 行（改行を含めない）。
- 同じ形を 2 か所に書かないために、貼り付けと Enter の送りを共通の関数（例: `submitFirstInput(core, session, text, delayMs)`）にするか、リセッションの code に手を入れずに同じ手順を書き写すか（U3）。

### 2.5 入力文面の案

1 行（改行なし）。session 名・路径・秘密は入れない。

```
[bantou] app が再起動した（center が起動し直した。会話の続きとは限らない）。状況を一度確かめる。1) system 指示の [始める時] の順に記録を読む。2) remote_list と task_status で remote・task の状態を見る。3) 未読の知らせ（messenger）を読む。止まっている物・届いた結果があれば続きを進める。無ければ短く状態を報告して待つ。
```

- 「会話の続きとは限らない」は、`--continue` が失敗して素の起動へ fallback した時（`remote-control.ts:133-136`）も同じ文で足りるようにするため（U5）。
- 「[始める時]」は master-cap の節（1.3）。common.md の節ではない。文面は節の名前だけを引き、`common.md`・`master-cap.md` の中身は変えない。
- 文面の定数は `restart-check.ts` に置く（`firstInputText` のように関数にして test が文面の要点を検査できるようにする）。

## 3. 変更点（file・関数単位。実装は別の task）

| file | 変更 |
|---|---|
| `packages/center/src/restart-check.ts`（新規） | `createRestartChecker(deps)`: `arm(session)` / `cancel(session)` / `onHook(session, payload)` / `pending(session)`。`deps` = `core`（`input`）・`resessionPending`（`resession.pending`）・`log`・`submitDelayMs?`。`RESTART_CHECK_TEXT`（2.5）。`deliver` は印を先に消し、`resessionPending` なら見送り、paste → 少し置く → `\r` |
| `packages/center/src/sessions.ts` | `createSessionManager` の opts に `onRestoreStart?: (name) => void` / `onRestoreFail?: (name) => void` を足す。`restore()` の `supervisor.start(s.name, { resume: true })`（`:582`）の直前に前者、`catch`（`:584-586`）で後者を呼ぶ。スリープの `continue`（`:576-578`）より後に置く |
| `packages/center/src/daemon.ts` | `createRestartChecker({ core, resessionPending: (n) => resession.pending(n), log })`。`createSessionManager` に `onRestoreStart: (n) => restartCheck.arm(n)` / `onRestoreFail: (n) => restartCheck.cancel(n)`。`onHook`（`:308-317`）で `restartCheck.onHook` を `resession.onHook` より先に呼ぶ。印の取り消し（U2 の A）: `events.subscribe`（`packages/center/src/events.ts:21`）で `sleep`（眠った時）・`deleted`・`restarted` の通知を受けて `restartCheck.cancel` |
| `packages/center/src/resession.ts` | `ResessionDeps` に `cancelRestartCheck?: (session) => void` を足し、`run` が `restartFresh` を呼ぶ直前（区切りの行を積む前後）に呼ぶ。`deliver` の paste 部分を共通関数に出す場合は U3（出さなければ他は変えない） |
| `packages/center/src/system-instructions.ts` / `instructions/*.md` | **変更なし**。文面は最初の入力が持つ。system 指示の部品（版）は増やさない |
| `docs/design/resession.md` | 1 行の追記（関係。実装の時に） |
| `packages/desktop` / `packages/ui` / `packages/memory` | **変更なし** |

## 4. test 方針（実装 worker が足し、各変異で落ちる事を確かめる）

実装 worker は、各 test を足した後、下の「変異」を 1 つずつ code に入れ、その test が落ちる事を確かめて元に戻す（落ちない test は不十分）。test は既存の `packages/center/test/resession.test.ts`（偽の claude・実の supervisor / SessionManager / core）と `sessions.test.ts` の作りに合わせる。

| # | test | 変異（この変更を入れると落ちる） |
|---|---|---|
| T1 | `restore()` で復帰した非スリープ session が、`SessionStart`（`startup`）の後に最初の入力を 1 回受ける。入力は paste（`\u001b[200~…\u001b[201~`）→ 待ち → `\r` の順 | `restore()` の `arm` 呼び出しを消す / `deliver` が入力を送らない / `\r` を paste の前に送る |
| T2 | スリープ中の session は印が付かず、`wake` で起こして `SessionStart` が来ても送らない | `arm` を `s.sleeping` の `continue` より前に移す / `wake` で `arm` する |
| T3 | 同じ session の 2 回目の `SessionStart`（`compact`・`clear`・`startup` をもう 1 回）で送らない | `deliver` が印を消さない（または消すのを送信の後にして 2 件目が割り込める） |
| T4 | `source` が `compact`・`clear` の `SessionStart` は無視し、印を残す。その後の `startup` で 1 回送る | `source` を見ずに全 `SessionStart` で発火する |
| T5 | `--continue` の起動を想定した `source: "resume"` の `SessionStart` でも 1 回送る（U1 の推奨） | `source === "startup"` だけで発火する |
| T6 | `resession.pending(session)` が true の時に `SessionStart` が来ても、確認の入力を送らない（印は消える） | `resessionPending` の判定を外す |
| T7 | リセッションの `run` が `restartFresh` を呼ぶ前に確認の印が取り消され、再起動後の `startup` で送る最初の入力が引継ぎだけ（合計 1 回）になる | `run` の `cancelRestartCheck` を消す（確認と引継ぎで 2 回） |
| T8 | daemon 相当の配線（`onHook` の呼び順）: 同じ payload を `restartCheck.onHook` → `resession.onHook` の順に渡して、両方の印があっても入力が 1 回 | 呼び順を逆にする |
| T9 | `restore()` で `start` が投げた session は印が外れ、後の `SessionStart` で送らない | `onRestoreFail` を呼ばない |
| T10 | 印を付けた後に session を眠らせる・削除する・`restartFresh` した時、印が外れ、後の `startup` で送らない（U2 の A） | `events` の取り消しを外す |
| T11 | `core.input` が false（session が止まっている）でも投げず、印は消え、再送しない | 失敗時に例外を投げる / 印を戻して再送する |
| T12 | 自動の再起動（`continueOnRestart`）後の `SessionStart` で送らない（印が無いので） | `start` の中で `arm` する（`restore` 以外で付く） |
| T13 | 新しい `createRestartChecker`（= center の再起動）で `arm` し直すと、また 1 回送る | 印を module の外（process 全体の static）に持つ |
| T14 | 文面に `[始める時]`・`remote_list`・`task_status`・未読の知らせ・「app が再起動した」を含み、改行を含まない | 文面の語を削る / 改行を足す |
| T15 | `sessions.restore()` が `onRestoreStart` を、非スリープ・成功の session だけに、`start` の前に呼ぶ（呼び順の記録） | 呼び順を `start` の後にする / スリープにも呼ぶ |

実測（実装の後。この task では行っていない）:

- S1: `--continue` で起動した claude の `SessionStart` の `source` の値（`resume` か `startup`）。T5・U1 の前提。
- S2: 最初の入力が確定されるか（休止の設計 2.6 の実測と同じ。リセッションの S3 と同じ確認）。
- S3: `--continue` が失敗して素の起動に fallback した時の `SessionStart`（`startup`）でも、1 回だけ送られるか。

## 5. 未決

### U1 どの `SessionStart` で送るか

- A: `source` が `startup` または `resume`（`compact`・`clear` は無視）。利点: `--continue` の起動（`resume` と想定）と素の fallback（`startup`）の両方で送れる。欠点: `resume` の値は未確認（S1）。`clear`・`compact` を除く一覧は claude の仕様に依る。
- B: `startup` だけ（リセッションと同じ）。利点: 既存と同じ。欠点: `--continue` の起動が `resume` なら、通常の復帰で送られない（本件の目的を満たさない）。
- C: `source` を見ずに最初の `SessionStart` で送る（印は 1 回だけで消える）。利点: 値に依らない。欠点: 他の `source`（`compact`・`clear`）が最初に来た時に誤って送る。
- 推奨: A（S1 で `resume` を確かめ、違えば値を直す）。

### U2 印が残った時の取り消し（`SessionStart` が来ないまま、session が止まった・眠った・消えた・リセッション）

- A: 眠った・削除・`restartFresh` の時に印を外す（`events` の通知と `cancel`）。利点: 時間などの新しい値が要らない。欠点: 取り消しの経路が複数ある。
- B: 取り消さない（最初に来た `SessionStart` で送る）。利点: 単純。欠点: 止めた後に利用者が手で起動した時などに、「同じ再起動」でない起動に送りうる。
- C: 印に時間の上限を付ける（値は利用者が決める）。利点: 経路を数えなくてよい。欠点: 新しい上限が増える。
- 推奨: A。

### U3 paste と Enter の送りを共通にするか

- A: 共通の関数に出し、`resession.ts` の `deliver` もそれを使う。利点: 重複が無い。欠点: 既存のリセッションの code を直す（既存の test が通る事の確認が要る）。
- B: `restart-check.ts` に同じ手順を書き写す。利点: リセッションの code に触れない。欠点: 2 か所に同じ手順（貼り付けの形が変わると両方直す）。
- 推奨: A（変更は小さく、リセッションの test で守れる）。ただし `resession.ts` を触りたくなければ B。

### U4 center だけが再起動した時も対象にするか

- A: 対象にする（center の起動 = app の再起動と扱う。center からは区別できない）。利点: 実装が増えない。欠点: desktop が動いたままの center の再起動（例: 更新・落ちた後の再起動）でも送る。
- B: desktop が「app の起動」を center に知らせる口を足し、その時だけ送る。利点: 指示の字義に近い。欠点: desktop と center の間に新しい口が要る（protocol・Rust の変更）。
- 推奨: A（区別する材料が center に無く、再起動の後に状況を確かめる目的は同じ）。

### U5 文面を起動の種類で変えるか

- A: 1 つの文面（「会話の続きとは限らない」と書く。2.5）。利点: 単純。`source` に依らない。欠点: 続きの時にも「続きとは限らない」と書く。
- B: `source` で 2 つに分ける（`resume` = 続き / `startup` = 新しい会話）。利点: 文が正確。欠点: `source` の値に依る（S1）。
- 推奨: A。

### U6 確認で session が読む「[始める時]」の所在

- A: 文面は節の名前だけを引く（system 指示に入っている）。`common.md`・`master-cap.md` は変えない。利点: 文面が `[始める時]` の中身と食い違わない。
- B: 文面に読む順を全部書く。欠点: `master-cap.md:14-15` と二重になり、直した時に食い違う。
- 推奨: A。指示の「common の [始める時]」は、実際は master-cap の節（1.3）で、全 session に付く。

### U7 session が今何かをしている時（`working`・`needs-input`）の扱い

- A: リセッションと同じく見ない（`SessionStart` の直後に送るだけ）。利点: 決めてある形のまま。復帰した直後の claude は通常 `idle`。欠点: 起動直後の確認ダイアログなどが出ている時は、入力が入力欄に残る事がある（S2）。
- B: 作業状態が `idle` になってから送る。利点: 入力が確定しやすい。欠点: `idle` を待つ仕組みが増える（待ちの上限などの値を決める必要）。
- 推奨: A（利用者が決めた形）。S2 で問題が出たら B を再検討する。

### U8 入力が届かなかった時の再送

- A: 再送しない（log に出して終わる）。「同じ再起動で 2 回以上送らない」に合う。
- B: 印を戻して次の `SessionStart` で送り直す。欠点: 「1 回だけ」の字義と合わない。
- 推奨: A。

## 6. 実装の分け方（並行できる単位）

| 単位 | 所 | 内容 | 並行 |
|---|---|---|---|
| I1 | `packages/center/src/restart-check.ts` + 単体 test（T1・T3〜T6・T11・T13・T14） | `createRestartChecker`。`arm` / `cancel` / `onHook` / `pending` の形（3 節）だけを先に合わせれば、I2・I3 と並行できる | I2 と並行 |
| I2 | `packages/center/src/sessions.ts` + `sessions.test.ts`（T2・T9・T15） | `onRestoreStart` / `onRestoreFail`。スリープ・`wake` の扱い | I1 と並行 |
| I3 | `packages/center/src/daemon.ts`・`resession.ts` + 結合 test（T7・T8・T10・T12） | 配線・呼び順・`cancelRestartCheck`・`events` の取り消し。U3 の共通関数もここ | I1・I2 の後 |
| I4 | 確認 | 変異の確認（4 節）。S1〜S3 の実測の依頼（実機） | I3 の後 |

## 7. 確かめ方（設計書の記述と code の一致）

この設計書が引く file・関数: `sessions.ts` の `restore` / `wake` / `restartFresh`、`daemon.ts` の `sessions.restore()` と `onHook`、`resession.ts` の `deliver` / `onHook` / `pending` / `AWAIT_START_STALE_MS` / `ResessionDeps`、`remote-control.ts` の `start` / `continueOnRestart`、`session-activity.ts` の `SessionStart`、`system-instructions.ts` の `masterSection("始める時")` / `MASTER_CAP_ROLE`、`instructions/master-cap.md` の `[始める時]`、`events.ts` の `subscribe`。これらは grep で確かめる（作成時に確認済み）。
