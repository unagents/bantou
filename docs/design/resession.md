# リセッション（session の自律的な後始末と再起動）の設計

- 作成: 2026-11-22
- 基点: `develop`（`git log -1` の時点）
- 範囲: 設計だけ。code・DB・設定は変えていない。動いている外部記憶（memory）には触れていない（読み書きなし）。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。code は `packages/center/src/` からの相対でなく repo root からの path で書く）。【推測】は確かめていない解釈。【未確認】は実測が要る事。
- 他 branch の参照: `origin/docs/session-ondemand-design`（以下「休止の設計」。`docs/history/20261120-2240-session-ondemand-design/design.md`。develop に未 merge）の節番号で引く。行番号ではなく節番号。
- 他 branch の参照 2: 「spec」= `origin/docs/memory-requirement-spec`（commit `270f101`）の `docs/design/memory-requirement-spec.md`。`spec:行` はその file の行。6.2 で照合した。

## 0. 利用者の指示（原文）

> セッションclose可能に至った際の自律的な後始末の対応。今引継ぎファイルを作ってcompact見たいな指示を出してるが、セッションclose可能な状態や何もやることが無くなった時点で、引き継ぎをメモリで保存。新規にtoolかbantouのプラットフォーム側で用意する形で、リセッションを自立実行。リセッションはセッション再起動の実行までやる。セッションは再起動したら、引き継ぎをメモリから引っ張って来て、ユーザーとの応対は持続的に継続可能な状態を保持する。で、これは出来ればだけどリセッション後の画面には、リセッション前迄のやり取りを表示としてはロードさせたい。ロードした最終行からが、リセッション後のセッションとしては真実の内容になる。

この文書では、この動作を「リセッション」と呼ぶ。

## 1. 要点

- リセッション = 「引継ぎを外部記憶に保存 → session の claude を `--continue` 無しで起動し直す（新しい会話） → 起動した session が引継ぎを外部記憶から読んで応対を続ける」を、center が 1 つの操作として実行する事。
- 実行は center に新しい tool `session_resession`（session 自身が呼ぶ。session 向けの窓口 `/mcp/session`）を足して行う。tool は引継ぎを受けて即座に返り、再起動は **session の turn が終わってから** center が行う（tool の途中で自分の claude を止めない）。
- 引継ぎの保存は center が memory へ書く（今の「session は memory に書かない」決まりを守る。書く主体は今と同じく center）。memory 側に引継ぎの種別と、そのまま読み出す口が要る（`docs/design/memory-requirement-spec.md` の #1・#10 の決定待ちの提案。6.2・7 節）。
- 画面は、center の出力キュー（core）が session の再起動をまたいで残る事【事実】を使い、リセッション前の表示をそのまま残し、再起動の直前に center が区切りの行を 1 行積む。区切りより後が新しい session の内容。center の再起動をまたぐ保持は別の手当てが要る（U5）。
- 分かれ目は U1〜U9（8 節）。

## 2. 今の仕組み（調べた事）

### 2.1 session の起動・停止・スリープ・続き

- 【事実】session の実体は、center が pty wrapper 経由で動かす対話型 `claude --remote-control <名前>`。引数は `buildWrapperArgs` が組む。会話の続きは `resume` が true の時だけ `--continue` を付ける（`packages/center/src/wrapper.ts:117-153`、`:151`）。`--append-system-prompt`（`:147`）、`--mcp-config`（`:149`）、`--settings`（`:150`）も同じ所で付く。
- 【事実】起動の入口は supervisor の `start(name, { resume? })`。`resume: true` なら `--continue` で起動し、接続前（30 秒以内）に落ちたら素の起動へ fallback する。`resume` 無しなら新しい会話になる（`packages/center/src/remote-control.ts:133-136`、`:862-887`、`:294`、`:806-815`）。
- 【事実】停止は `stop(name)`。wrapper に stop メッセージを送り、猶予の後 SIGKILL（`packages/center/src/remote-control.ts:890-918`）。
- 【事実】center の再起動で session を戻す `restore()` は `start(name, { resume: true })`（`packages/center/src/sessions.ts:568-574`）。自動の再起動（claude が落ちた時）も既定は `--continue`（`continueOnRestart: true`、`packages/center/src/config.ts:20`、再起動は `packages/center/src/remote-control.ts:819-823`）。
- 【事実】スリープは `sessions.sleep(name)` = 停止 + `sleeping` の記録。起床は `sessions.wake(name)` = `start(name, { resume: true })`（`packages/center/src/sessions.ts:851-905`）。公開の tool は `session_sleep` / `session_wake`（`packages/center/src/tools.ts:125-143`）。統括の道具は自分自身を眠らせない（`packages/center/src/coordinator.ts:149`）。
- 【事実】スリープ中、同名の messenger の身代わりが message を預かり、起床後に渡す。止めた直後の送りは古い登録に届いて消える事があるため、起床後の渡しは「新しい peer」だけに送る（`packages/center/src/sleep-gate.ts:1-8`、`:40-42`）。
- 【事実】`--continue` で戻るのは「その作業 dir の最新の会話」。center の session は session ごとの dir を持つ（`packages/center/src/sessions.ts:24`（保存する session の `path`）と `:35`（`SessionInfo` の `path`））。
- 【事実】session 名は再起動でも変わらない。memory の Agent ID = session 名（`docs/design/external-memory.md:17`）、messenger の peer 名 = `capSessionName(session)`（`packages/center/src/wrapper.ts:80`）。remote（cap）の記録も session 名で持つ（`docs/design/master-cap-session.md` の「session と remote-cap を 1 対 1 にする」）。
- 【事実】休止の設計（他 branch）は 2.4 で「会話 id を覚えて `--resume <id>` で起こす」案を持ち、2.2 で「止める条件」を表にしている。リセッションは「続きを戻さない」ので `--resume` / `--continue` を付けない点で逆の操作。止める条件の表は 3.1 で参考にする。

### 2.2 hook（作業状態と、発言・応答の本文）

- 【事実】center は全 session に hook を付ける。対象は `SessionStart`・`UserPromptSubmit`・`PreToolUse`・`PostToolUse`・`PostToolUseFailure`・`PermissionRequest`・`PermissionDenied`・`Notification`・`Stop`・`StopFailure`（`packages/center/src/session-activity.ts:11-21`）。`Stop` は同期（`:24`）。
- 【事実】`Stop` / `StopFailure` → `idle`、`UserPromptSubmit` 等 → `working`、`PermissionRequest` 等 → `needs-input`（`packages/center/src/session-activity.ts:36-60`）。`SessionStart` の `source=compact` は状態を変えない（`:41`）。`SessionStart` の payload に `source` がある事の根拠はこの行。
- 【事実】hook の受け口は `POST /sessions/<name>/hook`（`packages/center/src/http.ts:31`、`:396`、`:453`）。受けた payload は作業状態・最後の応答（desktop へ）・memory の 3 か所へ渡る（`packages/center/src/daemon.ts:290-297`）。
- 【事実】`UserPromptSubmit` の `prompt` と `Stop` の `last_assistant_message` が、memory の event（`user_prompt` / `assistant_message`）になる（`packages/center/src/memory-events.ts:121-141`）。

### 2.3 外部記憶（memory）の読み書き

- 【事実】memory は MCP server。center の設定 `memory` があれば、全 session の `--mcp-config` に `memory` が足され、session は `mcp__memory__*` を直接呼べる（`docs/design/external-memory.md:31-35`、許可は `packages/center/src/wrapper.ts:104-110`）。
- 【事実】**書き込みは center だけ**。session は書き込みの tool を呼ばない（system 指示の部品 `memory`: 「記憶への書き込みは bantou が会話と cap 間の往復から自動で渡す。自分では書き込みの tool を呼ばない」、`packages/center/src/system-instructions.ts:173-186`）。書く記憶は master-cap のものだけ（`docs/design/external-memory.md:39-45`）。送信は非同期のキュー（失敗は再試行、上限超えは古い分から捨てる。`:57`）。
- 【事実】memory の `event` tool が受ける種別は `user_prompt` / `assistant_message` / `task` / `result` / `report` / `reply` の 6 つ（`packages/memory/server/utils/events.ts:4`）。本文は 65536 文字まで（`:20`）。
- 【事実】memory が公開する tool は `context` / `event` / `explain` / `recall` / `status`（`packages/memory/server/mcp/tools/`）。`context` は「判断用の要約（利用者の方針、直近の決定、未回答の質問、進行中の task）」（`packages/memory/server/mcp/tools/context.ts:6`）。引継ぎをそのまま返す口は無い。
- 【事実】event の抽出（記憶への昇格）は非同期で、実機では 1 分以内（`docs/design/external-memory.md:111`）。
- 【事実】`docs/design/external-memory.md:70,94` は「session の制御（`--continue` をやめて memory から文脈を組み立て直す、compact の代替）」を今回の範囲外・別設計と書いている。本設計がその別設計に当たる。

### 2.4 記録（引継ぎ）の今の決まり

- 【事実】common.md の [記録]: 状態の正本は file。記録は 3 つ（引継ぎ = 仕掛かり・止まっている事・次の一手 / 決定と番号つきの未決 / 今の窓口）。置き場は project の設定、無ければ repo の `docs/`（`packages/center/instructions/common.md:12-15`）。master-cap は記録を「引継ぎ → 状態 → 決定と未決 → 既知の問題 → 直近の報告」の順に読んでから動く（`packages/center/instructions/master-cap.md:15`）。
- 【事実】利用者の言う「引継ぎファイルを作って compact」は、この記録の file を人が指示して作らせる運用。center にそれを自動で行う code は無い（`compact` で検索して、hook の `source=compact` の扱いと context 使用量の注記だけ）。

### 2.5 画面（会話の表示）

- 【事実】desktop の画面は xterm.js で、pty の**生の byte** を描く。会話の構造（発言単位）は持たない（`packages/ui/components/TerminalView.vue:149-154`、`scrollback: 5000` は `:171` 付近）。
- 【事実】center は session ごとに出力のキュー（core）を持ち、wrapper の出力を chunk として積む。上限は 8 MiB（`packages/center/src/core.ts:7`、積む処理は `packages/center/src/remote-control.ts:726`）。購読は SSE（`GET /sessions/<name>/output`、`packages/center/src/http.ts:328-345`）。続きの chunk ID が残っていれば続き、無ければ `reset` の後に積んである全部（`packages/center/src/core.ts:107-120`）。
- 【事実】キューは session を `add` した時に作られ、`remove`（session の削除）でだけ消える（`packages/center/src/remote-control.ts:925`、`:948`）。claude の停止・起動（スリープ・再起動）では消えず、`detach` / `attach` が wrapper の口を付け外しするだけ（`:746`、`:764`）。**つまり再起動の前後で、同じキューに出力が続けて積まれる**。
- 【事実】desktop 側にも session ごとの再生用の buffer がある（上限 2 MiB。`packages/ui/composables/terminalBuffer.ts:4`）。画面を開くと reset してから buffer を流し直し、続きを購読する（`packages/ui/composables/useTerminalStore.ts:64`）。
- 【事実】キューは center の process の中だけ（file に出さない）。center が再起動するとキューは空になる（`packages/center/src/core.ts:58`）。
- 【推測】再起動の時に積み残しが無ければ、新しい claude の最初の画面は前の続きに追記される。claude の TUI が画面の消去・alt-screen を使う場合、前の表示が見えなくなる事がある。【未確認】実測が要る（9 節 S1）。

## 3. 設計

### 3.1 close 可能・やる事が無くなった事の判定（原文: 自律判定）

判定の材料（center が持っている物）:

| 材料 | 出どころ |
|---|---|
| 作業状態 `idle`（turn が終わった） | hook `Stop`（`packages/center/src/session-activity.ts:56-58`）。`working` / `needs-input` の間は idle でない |
| 未完了の指示・返答待ちが無い | その session の remote の記録の `pending`（休止の設計 1.4 / 2.2 の表の「未完了の指示が無い」と同じ元） |
| session が「終わった」と言った | 新しい tool の呼び出し（3.3） |

機械だけでは決まらない点: 【事実】`idle` は turn が終わった事を示すだけで、「やる事が無い」と「利用者の返事を待っている」を区別しない（どちらも `Stop`）。なので「やる事が無い」を center が自力で断定する code の元は無い【事実: 上の 3 行しか材料が無い】。

案（U1）:
- A: session の自己申告だけ（session が「close 可能」と判断して tool を呼ぶ）。
- B: center の機械判定だけ（idle が続き、pending が 0 なら実行）。
- C: 自己申告を起点にし、center が安全確認（`working` / `needs-input` でない、pending が 0、すでに別のリセッション中でない）を通った時だけ実行する。

推奨: C。理由は原文の「close 可能な状態や何もやることが無くなった時点」を一番近く満たすのが、判断できる当人（session）の申告で、B は利用者の返事待ちの session まで対象にしうる（`idle` が区別できない）ため。A は center が安全を見ないので pending の途中で再起動しうる。

注（原文の制約ではない）: C の安全確認の 3 条件（`working` / `needs-input` でない・pending が 0・別のリセッション中でない）は、利用者が言っていない。動いている最中の再起動で作業を失わないための、設計の提案。利用者が「申告だけで実行」を望むなら A になる。

session が申告する決まりは system 指示の部品に足す（`packages/center/src/system-instructions.ts` の部品の仕組み。どの条件で付けるかは U7）。

### 3.2 引継ぎの保存（原文: 引き継ぎをメモリで保存）

内容は common.md の記録の 3 つ（引継ぎ・決定と未決・今の窓口。`packages/center/instructions/common.md:14`）に合わせ、新しい項目は足さない。書くのは session（何が仕掛かりか知っているのは session だけ）。

保存の形（U2）:
- A: session が tool の引数に引継ぎの本文を渡し、**center が** memory に書く（新しい event の種別 `handoff`。memory 側の変更が要る。spec の #1・#10 の決定待ちの提案。6.2）。「session は memory に書かない」の決まりを保つ。
- B: session が memory の書き込み tool を直接呼ぶ。今の決まり（`system-instructions.ts:186`）を変える。memory 側の書き込みの tool の公開範囲も変わる。
- C: file（記録の置き場。common.md:15）に書き、memory には書かない。原文の「メモリで保存」と合わない。

推奨: A。理由は原文どおり memory に残し、今の決まり（書くのは center だけ）を変えないため。memory が使えない（設定なし・届かない）時は center の状態置き場に file で残す（再起動後の読み出しも同じ file から。U3 の経路で拾う）。これは原文の制約ではなく、memory に届かない時に引継ぎを失わないための扱い。

保存が済んでから再起動する（順序の約束）: 【事実】memory への送信は非同期のキューで、再試行で遅れうる（`docs/design/external-memory.md:57`）。再起動の前に、引継ぎの event が memory に受理された（または file に書けた）事を確かめる。受理されない間は再起動しない（失敗は session に tool の結果で返す）。

### 3.3 リセッションの実行（原文: 新規に tool か platform 側、再起動の実行まで）

新しい center の tool `session_resession`（session 向けの窓口 `/mcp/session`。呼んだ session は header `X-Bantou-Session` で決まる。`packages/center/src/http.ts:20`、`packages/center/src/tools.ts:51-66` の `resolveOwner`）。引数は引継ぎの本文。他の session を指定する引数は持たない（自分自身だけ）。※「自分自身だけ」は原文の制約ではなく設計の提案（統括の道具が自分を眠らせない `packages/center/src/coordinator.ts:149` と同じ形に揃えた。他の session を再起動する用途は、原文に無いので範囲外）。

実行の順:
1. tool を受ける。3.1 の安全確認を通す。通らなければ理由を返して終わり（再起動しない）。
2. 引継ぎを保存する（3.2）。保存できなければ失敗を返して終わり。
3. 「リセッション待ち」の印を session に付けて、**即座に返す**（返り値: 受理した事と、turn が終わると再起動する事）。
4. その session の次の `Stop` hook（turn の終わり）を受けたら、center は **hook の応答（204）を先に返し、その後で**非同期に次を行う: 区切りの行を出力キューに積む（3.5）→ `stop(name)` → `start(name)`（`resume` 無し = `--continue` 無し = 新しい会話。`packages/center/src/remote-control.ts:886` は `resume === true` の時だけ続きにする）。
   - 理由（【事実】）: `Stop` は同期の hook（`packages/center/src/session-activity.ts:24` の `SYNC_HOOK_EVENTS`）で、claude は hook の POST の応答を待つ。受け口は `sink(name, body)`（= `daemon.ts:290` の `onHook`）を呼んでから 204 を返す（`packages/center/src/http.ts:296-298`）。`stop()` は呼ばれた時点で同期的に wrapper へ stop メッセージを書く（`packages/center/src/remote-control.ts:890` 以降の `stop`）ので、`onHook` の中で呼ぶと、止められる側の claude が自分の hook の応答待ちのまま止められる。応答を待たれた claude が終了しない間は猶予（`stopGraceMs`、`remote-control.ts` の `stop` の SIGKILL 待ち）を使い切って SIGKILL になりうる【推測】。
   - 形: `onHook` は「止めてよい」の印を立てるだけにし、`stop` / `start` は応答が済んだ後の別の処理（`setImmediate` 以降）で行う。実装の細部は実装の時に決める。
   - 止める直前に、その session の作業状態が `idle` のままか（利用者の入力が来て `working` になっていないか）を center が見直す。変わっていたら印を戻して見送る（設計の提案。原文の制約ではない）。
5. 起動の後、3.4 の手順で引継ぎを渡す。

「リセッション待ち」の印の保持（U8）: 印は center の process 内だけに持つ想定。【事実】スリープの記録 `sleeping` は session の保存の状態（`packages/center/src/sessions.ts:29-30` の `SavedSession.sleeping`）に残り、center の再起動後も眠ったまま（`:568-572`）。リセッションの印は、この保存の状態には入れない案を基本にする。center が印のある間（tool を受けてから turn が終わるまで）に再起動すると、印は消え、`restore()` は `--continue` で起動する（`sessions.ts:574`）。その結果は「引継ぎは保存されたが、再起動は起きず、元の会話が続く」で、引継ぎは使われないまま残る。session が次に「終わった」と申告すれば、もう一度 tool を呼べる。この窓は短い（turn の終わりまで）ので落ちても害が小さい、とみなす【推測】。

tool の返り値を即座に返す理由: 【事実】tool の呼び出しは claude の turn の中にあり、claude を止めると結果が返らない。【事実】`Stop` hook は同期なので、turn の終わりに center が止めるタイミングを持てる（ただし上のとおり、応答を返した後に止める）。

案（U4）:
- A: 上の形（tool は印だけ。実際の再起動は次の `Stop`）。
- B: tool の中で直ちに再起動する（tool の応答が失われる。claude が止まる直前に返ると不定）。
- C: tool は引継ぎを保存するだけで、再起動は別の tool（利用者または統括が呼ぶ）。原文の「自立実行」と合わない。

推奨: A。

platform 側ではなく tool にする理由（原文の「toolかプラットフォーム側」の選択）: 判定の起点が session の申告（3.1 の C）なので、呼び口は tool が自然。再起動の実行そのもの（stop / start / 区切りの行 / 引継ぎの渡し）は center（platform）が持つ。つまり両方使う。

再起動の間の message: 【事実】停止から新しい peer の登録までの間、messenger の message は古い登録に届いて消える事がある（`packages/center/src/sleep-gate.ts:40-42`）。【推測】スリープと同じ身代わり（`sessions` の `onSleepChange` → `sleepGate.sync`、`packages/center/src/daemon.ts:188-192`）を再起動の間だけ置けば取りこぼしを防げる。身代わりは message を受けると session を `wake`（`--continue`）で起こすので、再起動の最中の起こし方との衝突の扱いが要る【未確認】。範囲は実装の時に決める（U6）。

### 3.4 再起動後に引継ぎを引いて応対を続ける（原文: メモリから引っ張って来て、応対の継続）

- 【事実】session の名前・memory の Agent ID・messenger の peer 名・remote の記録は再起動でも変わらない（2.1）。応対の継続に要る「状態」のうち、新しい会話に無いのは claude の会話だけ。引継ぎがそれを補う。
- 引き方（U3）:
  - A: center が、起動後に session へ最初の入力を 1 通送る。内容は「リセッションで始めた。引継ぎを memory から読んで続ける」旨と引継ぎの識別（id）。session が `mcp__memory__*` の読み出しの tool で引継ぎを引く（原文の「メモリから引っ張って来て」どおり、引くのは session）。
  - B: center が memory（または file）から引継ぎの本文を読み、最初の入力にそのまま入れる。
  - C: 起動のたびに system 指示で「最新の引継ぎを引く」と常に案内する（`--append-system-prompt` は再起動・`--continue` でも同じ値で、1 回きりにできない。`packages/center/src/remote-control.ts:315-318`）。
- 推奨: A。ただし memory が無い・引けない時は B（file から本文を入れる）。理由は原文の動作（session が memory から引く）を基本にしつつ、引継ぎを失わない最小の後ろ盾を持つため。C は引継ぎを「読み終えた」印が無い限り、普通の再起動のたびに古い引継ぎを引いてしまう。
- 最初の入力を送る時機: 【事実】core の入力は wrapper が繋がっていれば pty にそのまま流れる（`packages/center/src/http.ts:355-372` の `core.input`）。【事実】休止の設計 2.6 は、起動直後の入力が確定されず入力欄に残った実測（自己申告）を挙げ、「接続と `SessionStart` の hook を見るまで入力を断る」としている。本設計も、`SessionStart`（`source` が `startup`）の hook を受けてから送る。
- 読み出しの口: 【事実】今の memory に「引継ぎをそのまま返す」口が無い（2.3）。`recall` / `context` は抽出後の記憶を返すので、引継ぎの全文が欠ける事がある【推測】。memory 側に「種別と識別で event の本文を返す」口が要る（7 節）。
- 引継ぎは 1 回だけ使う: 渡した後、引継ぎに「渡し済み」を center が記録する（memory 側の印、または file の移動）。普通の再起動（`--continue`）では渡さない。
- 注（原文の制約ではない）: 「1 回だけ使う」と「memory が無い・引けない時の B（center が本文を入力に入れる）」は、利用者が言っていない。前者は古い引継ぎを後の再起動で誤って引かないため、後者は引継ぎを失わないための、設計の提案。B を採らない場合、memory に届かない構成では引継ぎが渡らず、新しい会話は引継ぎ無しで始まる。

### 3.5 リセッション前のやり取りを画面に残し、最終行から後を新しい session の内容にする（原文: 出来れば）

【事実】2.5 のとおり、出力のキューは再起動で消えない。何もしなければ、リセッション前の表示は画面に残り、続きに新しい claude の表示が積まれる。足すのは境目だけ。

- 再起動の直前に center が区切りの行（例: 「──── リセッション ここから新しい session。上は以前のやり取り（表示のみ） ────」）をキューに 1 chunk 積む。積み方は `core.push(name, data)`（`packages/center/src/core.ts:74-83`）。【事実】この形で既存の購読者（desktop・web）に変更なしで届く。
- 「最終行から後が真実」の意味: 新しい claude は前の会話を持たない（`--continue` 無し）ので、区切りの後ろの内容だけが新しい session の文脈になる。画面の上の部分は読み取り専用の過去の表示。入力は新しい claude にだけ届く。
- 保持の案（U5）:
  - A: 今のキュー（process 内）をそのまま使う。追加の保存なし。center の再起動で消える。上限は center が 8 MiB、desktop が 2 MiB。
  - B: 発言と応答の本文（hook の `prompt` / `last_assistant_message`。center がすでに受けている。`packages/center/src/daemon.ts:290-297`）を center が session ごとの file に追記し、リセッションの時に text として区切りの前に積む。center の再起動をまたぐが、tool の途中経過は載らない。
  - C: memory に書いた `user_prompt` / `assistant_message`（`packages/center/src/memory-events.ts:121-141`）から読み出す。memory が無い構成では使えない。
- 推奨: A。理由は原文が「出来れば」で、A は新しい保存先を作らず今の仕組みだけで動く。B は center の再起動をまたぐ必要が出たら足す。A の見え方（TUI の消去で前の表示が消える【推測】）は S1 で確かめる。確かめて前の表示が見えないなら B に切り替える。
- claude.ai（remote-control）側: 【事実】起動のたびに session URL は取り直される（`packages/center/src/remote-control.ts:588` 付近の `sessionUrl: null` の初期化）。【推測】claude.ai 側には新しい会話が現れ、前の会話の表示は持ち込まれない。この設計の範囲外（desktop / web の画面だけ）。

## 4. 原文の各項目との対応（確認表）

| 原文の項目 | 設計 | 節 |
|---|---|---|
| セッション close 可能・やる事が無くなった時点（自律判定） | session の申告 + center の安全確認 | 3.1 |
| 引き継ぎをメモリで保存 | center が memory に引継ぎの event を書く（届かなければ file） | 3.2 |
| 新規に tool か platform 側で用意 | tool `session_resession`（起点）+ center の実行（platform） | 3.3 |
| リセッションを自立実行 | session の申告で動く。利用者の承認を挟まない | 3.1 / 3.3 |
| セッション再起動の実行までやる | 次の `Stop` で `stop` → `start`（`--continue` 無し） | 3.3 |
| 再起動したら引き継ぎをメモリから引っ張って来る | 起動後の最初の入力で session が memory から引く | 3.4 |
| ユーザーとの応対は持続的に継続可能 | session 名・Agent ID・peer 名・remote の記録は不変。会話の分を引継ぎが補う | 3.4 / 2.1 |
| （出来れば）リセッション前までのやり取りを画面にロード | 出力キューが再起動をまたぐ事を使い、前の表示を残す | 3.5 |
| ロードした最終行からが新しい session の真実 | 区切りの行を積む。新しい claude は前の会話を持たない | 3.5 |

## 5. 変更が要る所（実装の時の見取り図。この task では変更しない）

| 所 | 変更 |
|---|---|
| `packages/center/src/tools.ts`（session 向けの窓口） | `session_resession` を足す |
| `packages/center/src/sessions.ts` | `resession(name, handoff)`（安全確認・印・`Stop` 後の `stop` → `start`） |
| `packages/center/src/remote-control.ts` | 変更なし見込み。`start(name)`（`resume` 無し）がそのまま「新しい会話」。区切りの行は `core.push` |
| `packages/center/src/daemon.ts` | `onHook` の `Stop` / `SessionStart` でリセッション待ち・最初の入力を扱う |
| `packages/center/src/memory-events.ts` / `memory.ts` | 引継ぎの event を書く（種別 `handoff`）。受理の確認を待てる形 |
| `packages/memory/`（spec の #1・#10 の決定待ち） | event の種別 `handoff` の追加（`server/utils/events.ts:4` と `migrations/001_init.sql:25` の CHECK）と、引継ぎを返す読み出しの口 |
| `packages/center/src/system-instructions.ts` | 申告の決まりの部品（U7） |

## 6. 既存の別設計との関係

### 6.1 休止（`docs/session-ondemand-design`。未 merge）

- 休止は「止めて、同じ会話で起こす」（`--resume <id>`）。リセッションは「止めて、新しい会話で起こす」。共通の部品は「止める条件」「起床の時機（`SessionStart` を待つ）」「止めている間の message の扱い」。
- 休止の設計は center の session の状態に `dormant` を足す案。リセッションは状態を足さず、「リセッション待ち」の印だけを短く持つ（turn の終わりまで）。両方が入った時は、休止の判定がリセッション待ちの session を止めない（pending のある session を止めないのと同じ扱い）【推測。実装の時に合わせる】。

### 6.2 別 task の「外部記憶に作業指示（requirement）と仕様・設計の型を足す」設計（`docs/design/memory-requirement-spec.md`）

- 【事実】branch `origin/docs/memory-requirement-spec`（commit `270f101`、file `docs/design/memory-requirement-spec.md`。develop に未 merge）を `git fetch` して全文を読んだ。以下の `spec:行` はその file の行。なお spec が挙げる code の行（`001_init.sql:25` など）は spec が調べた別 branch（`feat/memory-graphiti`、spec:5）のもので、この設計書では develop の code で再確認した（`packages/memory/migrations/001_init.sql:25,46-47,59`、`packages/memory/server/utils/events.ts:4`）。
- 【事実】spec は 3 つの軸を区別している。
  1. event の種別 `kind`（素材。6 種 `user_prompt` / `assistant_message` / `task` / `result` / `report` / `reply`。spec:43、DB の CHECK は `001_init.sql:25`、zod は `events.ts:4`）。
  2. item の `memory_type`（認知の分類。`001_init.sql:46`。spec:52、:104）。
  3. spec が新しく足す案の軸 `record_type`（`requirement` / `spec_design`。名前は仮。spec:104-106、未決 #1 = spec:289-294）。
- 【事実】spec の §8（spec:275-285）は resession について「型と項目（#1）を先に決め、resession はその型に載せる。resession の中身を確認できた後に #1・#10 を両者で突き合わせる。確認前は決めない」としている（:285）。spec は、この設計書の branch が見つからなかったと書いている（:279）。**この設計書が出来たので、突き合わせの条件の「確認」は満たされた**。突き合わせの結果が下で、決めるのは spec の #1・#10 と合わせた利用者。この設計書は「`handoff` の event 種別を足す」案を**提案として置くだけで、spec の #1 が決まるまで確定としない**。

#### 照合（spec の軸と引継ぎ）

| 点 | spec の実物 | 引継ぎとの噛み合い |
|---|---|---|
| 引継ぎを足す軸 | spec の #1 は item の型（`record_type`）の持ち方。`kind` は #1 の対象外（spec:289-294） | 引継ぎを **event の `kind`**（素材）に足すのは、spec の `record_type` 軸と別の軸で、#1 の 3 案（`memory_type` に足す / `record_type` 列 / 別の表）のどれとも衝突しない。ただし DB の CHECK（`001_init.sql:25`）と `events.ts:4` の変更が要る。spec はその変更を書いていない |
| 引継ぎを item の型に足す案 | spec §8 の接点 2（spec:282）は「`record_type` に 3 つ目の値、または別の軸」を挙げている（推測） | **item に載せる案は採らない（この設計書の推奨）**。理由は 3 点。(a) item は LLM の抽出を通るので本文がそのまま残らない（spec:49、`extract.ts`）。(b) item の本文は 2000 文字まで、同文は畳まれる（spec:52、`001_init.sql:47,59`）。spec #12（spec:361-365）も長い仕様・設計が 2000 を超えうる事を課題にしている。引継ぎは 3 記録を含むので超えうる（推測）。(c) 本文を context に出すには `confirmed` が要る（spec:58）。引継ぎは session が書くので、出典が `user_prompt` だけという規則（spec:50、`extract.ts:184-186`）では `inferred` に落ちる |
| 読み出し | spec の #10 案 A は `recall` に `recordType` / `category` を足し、`context` に `openRequirements` / `specs` を足す（spec:351-353、:261-268） | 引継ぎは **id 指定でそのまま返す口**で読むので、#10 の `recall` / `context` の変更とは別の口。#10 がどの案でも干渉しない。ただし #10 が「別の tool」案（B）になると、tool が複数増えるので、口の名前の付け方を揃える必要がある（推測） |
| 抽出との関係 | spec の #5 案 A（推奨）は、抽出 worker が event から requirement / 仕様・設計の候補を作る（spec:174-183）。抽出は毎分、未処理の event を LLM に渡す（spec:49） | `handoff` の event を抽出に渡すかは未決 U9。渡すと、引継ぎに書かれた決定・仕掛かりが記憶（item）にもなりうる（利点）が、`inferred` の item が増える（欠点）。また event を保存すると同じ transaction で Graphiti 向けの outbox にも積まれる（spec:44、`events.ts:59-63`）。引継ぎの本文が Graphiti に入るかも、この時に決める |
| 引継ぎの内容 | spec §8 の接点 4（spec:284）は「引継ぎに仕掛かりの requirement・決めた設計が含まれるなら、木 A・木 B が引継ぎの元データになる」（推測）とする | 本設計の引継ぎの本文は common.md の 3 記録（引継ぎ・決定と未決・今の窓口。`packages/center/instructions/common.md:14`）。spec の #1・#5・#7 が決まった後で、本文に requirement / 仕様・設計の id を参照として載せる形にできる（推測。今は載せない） |

#### この設計書が spec に求める事・spec から受ける事

- spec の順序（spec:285、:376）に従い、引継ぎの `handoff` 種別と読み出しの口は **spec の #1・#10 の決定待ち**とする。この設計書の center 側（tool `session_resession`、保存の受理待ち、`stop` → `start`、最初の入力、区切りの行）は、memory 側の形が変わっても動かし方が変わらない。memory 側の形に依存するのは「保存の呼び方」と「読み出しの口の名前」だけ。
- 引継ぎが spec の #1 で item の型に入る結論になった場合: 上の表の 3 点（本文の欠落・長さ・`confirmed`）への対処が spec 側に要る。対処できない間は、event の `handoff` を素材として残し、item はそこから抽出に任せる形（U9 の「渡す」）で足りる。
- 「書くのは center」の決まり（`packages/center/src/system-instructions.ts:186`）はそのまま。spec は書き込みの担い手を #5 で扱うが（spec:174-183）、案 B（master-cap が tool で登録）が選ばれると session が memory に書く経路ができる。その時は U2 の B が選べるようになる。
- 要確認（利用者）: spec の #1 を先に決めるか、`handoff` の event 種別だけ先に足すか（U2 の選択に含める）。

## 7. memory 側に求める事（引継ぎの保存と読み出し。spec の #1・#10 の決定待ち。6.2）

- 種別 `handoff` の event を受ける。変更は 2 か所: zod の `EVENT_KINDS`（`packages/memory/server/utils/events.ts:4`）と、DB の CHECK（`packages/memory/migrations/001_init.sql:25` の `kind IN (…)`。migration が要る）。【事実】今の種別は 6 つで、どちらも固定の列挙。
- 識別（agent + 引継ぎの id）で本文をそのまま返す読み出しの口。抽出（LLM）を通さない。【推測】event の本文は DB に生で入っている（`packages/memory/server/utils/events.ts:34-36` の insert。本文の上限は `:20` の 65536 文字）ので、口を足せば返せる。item に載せない理由は 6.2 の表。
- 受理を center が待てる事（`event` tool の応答。`recorded` / `duplicate`、`events.ts:29`）。
- 引継ぎが「使用済み」かを持てる事（なければ center の側で持つ）。
- 抽出に渡すか・Graphiti の outbox に積むか（U9）。
- ここまでが memory の変更。bantou の center は、memory の設定が無い構成でも file で動く（3.2）。

## 8. 未決

### U1 close 可能の判定を誰が行うか

- A: session の自己申告だけ。利点: 判断できるのは当人で、原文の動作に近い。欠点: pending の途中でも呼べてしまう。
- B: center の機械判定だけ（idle + pending 0）。利点: session の決まりが要らない。欠点: `idle` は「利用者の返事待ち」と区別できない（`packages/center/src/session-activity.ts:56-58`）。待っているだけの session を再起動してしまう。
- C: 自己申告 + center の安全確認。利点: 当人の判断を使いつつ、動いている最中の再起動を防ぐ。欠点: 申告の決まりを system 指示に足す必要がある。
- 推奨: C。

### U2 引継ぎの保存の形

- A: session が tool の引数で渡し、center が memory に書く（event の種別 `handoff`）。利点: 「session は memory に書かない」を保つ。item でなく event に書くので、spec の `record_type`（#1）の決定を待たずに足せる（6.2）。欠点: memory に種別の追加（zod と DB の CHECK の migration）が要る。spec の #1・#10 が決まるまでは提案であり確定ではない。
- B: session が memory の書き込み tool を直接呼ぶ。利点: center の経路が要らない。欠点: 今の決まり（`system-instructions.ts:186`）を変える。memory の書き込みを session に開く。
- C: file だけ。利点: memory の変更が要らない。欠点: 原文の「メモリで保存」と合わない。
- 推奨: A（届かない時だけ file に残す）。

### U3 再起動後の引継ぎの引き方

- A: 最初の入力で「引継ぎを memory から読め」と知らせ、session が引く。利点: 原文どおり。session が中身を見て判断できる。欠点: memory の読み出しの口が要る。session が引き損ねる事がある【推測】。
- B: center が本文を最初の入力に入れる。利点: 確実。欠点: 本文が center を通る（長いと入力が大きい）。原文の「引っ張って来て」と少し違う。
- C: 常に system 指示で案内する。利点: 入力を送らない。欠点: 1 回きりにできない。普通の再起動でも引く。
- 推奨: A。memory が使えない時の後ろ盾に B。

### U4 再起動の時機

- A: tool は印だけ。実際の再起動は次の `Stop`。利点: tool の応答が返る。欠点: turn が終わらない間は再起動しない（長い turn で遅れる）。
- B: tool の中で直ちに再起動。利点: 速い。欠点: 応答が失われる。
- C: 再起動を別の tool に分ける。利点: 単純。欠点: 原文の「自立実行」「再起動まで」と合わない。
- 推奨: A。

### U5 リセッション前の表示の保持

- A: 今のキューのまま。利点: 追加の保存なし。欠点: center の再起動で消える。TUI の表示の崩れは未確認。
- B: 発言・応答の本文を center が file に残し、text として積む。利点: center の再起動をまたぐ。欠点: 新しい保存先。tool の途中経過は載らない。
- C: memory の `user_prompt` / `assistant_message` から読む。利点: 新しい保存先なし。欠点: memory が無い構成で使えない。
- 推奨: A（S1 で見え方を確かめ、崩れるなら B）。

### U6 再起動の間の message の扱い

- A: スリープの身代わりと同じ仕組みを再起動の間だけ置く。利点: 取りこぼしが無い。欠点: 身代わりの起こし（`wake` = `--continue`）が再起動と衝突しないようにする手当てが要る【未確認】。
- B: 何もしない。利点: 単純。欠点: 数秒〜十数秒の間に届いた message が消えうる（`sleep-gate.ts:40-42`）。
- 推奨: A。

### U7 申告の決まりをどこに書くか

【事実】system 指示は center が部品（id・版・`when(ctx)` の条件つき）として組み、条件に合う session に付ける（`packages/center/src/system-instructions.ts:173-186` の `memory` の部品は `when: ctx.memory === true`。設計は `docs/design/system-instructions.md`）。project の `instructions` は session ごとの設定で `--append-system-prompt` に渡る（`docs/design/project-settings.md`）。

- A: system 指示の部品（center が付ける。例: `resession@1`、`session_resession` が使える session だけに付ける条件）。利点: project の設定に依らず全 session に同じ文が届く。版が付くので文を直した時に center の更新だけで全 session に反映される。欠点: 部品の追加と test の更新（`system-instructions.ts`）。session の指示が長くなる。
- B: 利用者の project の `instructions`。利点: center の変更が要らない。欠点: project ごとに書かないと、tool があっても申告の決まりが無く呼ばれない。文を直す時も project ごとに直す。
- C: tool の description だけ（呼ぶ条件を description に書く）。利点: 指示を増やさない。tool が見える session には必ず届く。欠点: 「いつ呼ぶか」の判断を description だけで決めさせる事になり、system 指示の文より弱い可能性がある【推測。実測していない】。
- 推奨: A。理由は「何もやる事が無くなった時」という当人の判断の基準を、project の設定に依らず確実に全 session へ届けられるのが A だけ（B は書き忘れで届かず、C は届くが弱いかもしれない）。description には呼び方（引数）だけを書く。

### U8 「リセッション待ち」の印を center の再起動をまたいで残すか

- A: 保存の状態（`SavedSession`）に印を足し、center の再起動後も復帰する。利点: 引継ぎを保存した後の再起動が、center の再起動を挟んでも実行される。欠点: 保存の形の変更（`sleeping` と同じ形の項目が増える）。再起動後の `restore()` が `--continue` でなく新しい会話で起動する分岐が要る。
- B: process 内だけに持つ。center が再起動すると印は消え、元の会話が `--continue` で続く（引継ぎは使われずに残る。3.3）。利点: 保存の形を変えない。欠点: その窓（tool を受けてから turn の終わりまで）に center が再起動すると、リセッションが静かに起きない。session が次に申告すれば再実行できる。
- 推奨: B。理由は窓が短く、落ちても元の会話が続くので作業を失わないため（推測。center の再起動の頻度は測っていない）。

### U9 `handoff` の event を抽出と Graphiti に渡すか

6.2 の表のとおり、memory は event を保存すると同じ transaction で Graphiti 向けの outbox に積み、毎分の抽出が未処理の event を LLM に渡す（spec の :44、:49）。

- A: 渡す（既存の経路のまま）。利点: 引継ぎに書かれた決定・仕掛かりが記憶（item）としても残り、`recall` で引ける。欠点: session が書いた物なので `inferred` の item になる（spec:50）。引継ぎの本文が Graphiti に入る。
- B: 渡さない（`handoff` は素材として保存し、id で引く口だけで読む）。利点: 引継ぎが記憶の抽出・検索に混ざらない。欠点: memory 側に「抽出と outbox から外す」処理の追加が要る。
- 推奨: B。理由は、引継ぎの用途は「次の session が id で 1 回引く」事で、記憶の検索に出す事は原文に無いため（推測。原文は記憶への昇格に触れていない）。spec の #1・#5 が決まった後に見直す。

## 9. 確かめ方（実装の前の実測。この task では行っていない）

- S1: `--continue` 無しで再起動した時、desktop の画面で前の表示が見えるか（TUI の消去・alt-screen の影響）。
- S2: `Stop` hook の後に `stop` → `start` した時の所要時間と、messenger の peer が現れるまでの時間。
- S3: 起動後の最初の入力を `SessionStart` を待って送った時、入力が確定されるか（休止の設計 2.6 の実測と同じ確認）。
- S4: 身代わり（U6 の A）と再起動の衝突。
