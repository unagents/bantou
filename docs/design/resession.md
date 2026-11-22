# リセッション（session の自律的な後始末と再起動）の設計

- 作成: 2026-11-22
- 基点: `develop`（`git log -1` の時点）
- 範囲: 設計だけ。code・DB・設定は変えていない。動いている外部記憶（memory）には触れていない（読み書きなし）。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。code は `packages/center/src/` からの相対でなく repo root からの path で書く）。【推測】は確かめていない解釈。【未確認】は実測が要る事。
- 他 branch の参照: `origin/docs/session-ondemand-design`（以下「休止の設計」。`docs/history/20261120-2240-session-ondemand-design/design.md`。develop に未 merge）の節番号で引く。行番号ではなく節番号。

## 0. 利用者の指示（原文）

> セッションclose可能に至った際の自律的な後始末の対応。今引継ぎファイルを作ってcompact見たいな指示を出してるが、セッションclose可能な状態や何もやることが無くなった時点で、引き継ぎをメモリで保存。新規にtoolかbantouのプラットフォーム側で用意する形で、リセッションを自立実行。リセッションはセッション再起動の実行までやる。セッションは再起動したら、引き継ぎをメモリから引っ張って来て、ユーザーとの応対は持続的に継続可能な状態を保持する。で、これは出来ればだけどリセッション後の画面には、リセッション前迄のやり取りを表示としてはロードさせたい。ロードした最終行からが、リセッション後のセッションとしては真実の内容になる。

この文書では、この動作を「リセッション」と呼ぶ。

## 1. 要点

- リセッション = 「引継ぎを外部記憶に保存 → session の claude を `--continue` 無しで起動し直す（新しい会話） → 起動した session が引継ぎを外部記憶から読んで応対を続ける」を、center が 1 つの操作として実行する事。
- 実行は center に新しい tool `session_resession`（session 自身が呼ぶ。session 向けの窓口 `/mcp/session`）を足して行う。tool は引継ぎを受けて即座に返り、再起動は **session の turn が終わってから** center が行う（tool の途中で自分の claude を止めない）。
- 引継ぎの保存は center が memory へ書く（今の「session は memory に書かない」決まりを守る。書く主体は今と同じく center）。memory 側に引継ぎの種別と、そのまま読み出す口が要る（別 task の設計と合わせる。7 節）。
- 画面は、center の出力キュー（core）が session の再起動をまたいで残る事【事実】を使い、リセッション前の表示をそのまま残し、再起動の直前に center が区切りの行を 1 行積む。区切りより後が新しい session の内容。center の再起動をまたぐ保持は別の手当てが要る（U5）。
- 分かれ目は U1〜U7（8 節）。

## 2. 今の仕組み（調べた事）

### 2.1 session の起動・停止・スリープ・続き

- 【事実】session の実体は、center が pty wrapper 経由で動かす対話型 `claude --remote-control <名前>`。引数は `buildWrapperArgs` が組む。会話の続きは `resume` が true の時だけ `--continue` を付ける（`packages/center/src/wrapper.ts:117-153`、`:151`）。`--append-system-prompt`（`:147`）、`--mcp-config`（`:149`）、`--settings`（`:150`）も同じ所で付く。
- 【事実】起動の入口は supervisor の `start(name, { resume? })`。`resume: true` なら `--continue` で起動し、接続前（30 秒以内）に落ちたら素の起動へ fallback する。`resume` 無しなら新しい会話になる（`packages/center/src/remote-control.ts:133-136`、`:862-887`、`:293`、`:806-815`）。
- 【事実】停止は `stop(name)`。wrapper に stop メッセージを送り、猶予の後 SIGKILL（`packages/center/src/remote-control.ts:890-918`）。
- 【事実】center の再起動で session を戻す `restore()` は `start(name, { resume: true })`（`packages/center/src/sessions.ts:568-574`）。自動の再起動（claude が落ちた時）も既定は `--continue`（`continueOnRestart: true`、`packages/center/src/config.ts:20`、再起動は `packages/center/src/remote-control.ts:819-823`）。
- 【事実】スリープは `sessions.sleep(name)` = 停止 + `sleeping` の記録。起床は `sessions.wake(name)` = `start(name, { resume: true })`（`packages/center/src/sessions.ts:851-905`）。公開の tool は `session_sleep` / `session_wake`（`packages/center/src/tools.ts:125-143`）。統括の道具は自分自身を眠らせない（`packages/center/src/coordinator.ts:149`）。
- 【事実】スリープ中、同名の messenger の身代わりが message を預かり、起床後に渡す。止めた直後の送りは古い登録に届いて消える事があるため、起床後の渡しは「新しい peer」だけに送る（`packages/center/src/sleep-gate.ts:1-8`、`:40-42`）。
- 【事実】`--continue` で戻るのは「その作業 dir の最新の会話」。center の session は session ごとの dir を持つ（`packages/center/src/sessions.ts:66` の `path`）。
- 【事実】session 名は再起動でも変わらない。memory の Agent ID = session 名（`docs/design/external-memory.md:17`）、messenger の peer 名 = `capSessionName(session)`（`packages/center/src/wrapper.ts:80`）。remote（cap）の記録も session 名で持つ（`docs/design/master-cap-session.md` の「session と remote-cap を 1 対 1 にする」）。
- 【事実】休止の設計（他 branch）は 2.4 で「会話 id を覚えて `--resume <id>` で起こす」案を持ち、2.2 で「止める条件」を表にしている。リセッションは「続きを戻さない」ので `--resume` / `--continue` を付けない点で逆の操作。止める条件の表は 3.1 で参考にする。

### 2.2 hook（作業状態と、発言・応答の本文）

- 【事実】center は全 session に hook を付ける。対象は `SessionStart`・`UserPromptSubmit`・`PreToolUse`・`PostToolUse`・`PostToolUseFailure`・`PermissionRequest`・`PermissionDenied`・`Notification`・`Stop`・`StopFailure`（`packages/center/src/session-activity.ts:8-19`）。`Stop` は同期（`:22`）。
- 【事実】`Stop` / `StopFailure` → `idle`、`UserPromptSubmit` 等 → `working`、`PermissionRequest` 等 → `needs-input`（`packages/center/src/session-activity.ts:34-59`）。`SessionStart` の `source=compact` は状態を変えない（`:41`）。`SessionStart` の payload に `source` がある事の根拠はこの行。
- 【事実】hook の受け口は `POST /sessions/<name>/hook`（`packages/center/src/http.ts:31`、`:396`、`:453`）。受けた payload は作業状態・最後の応答（desktop へ）・memory の 3 か所へ渡る（`packages/center/src/daemon.ts:290-297`）。
- 【事実】`UserPromptSubmit` の `prompt` と `Stop` の `last_assistant_message` が、memory の event（`user_prompt` / `assistant_message`）になる（`packages/center/src/memory-events.ts:121-141`）。

### 2.3 外部記憶（memory）の読み書き

- 【事実】memory は MCP server。center の設定 `memory` があれば、全 session の `--mcp-config` に `memory` が足され、session は `mcp__memory__*` を直接呼べる（`docs/design/external-memory.md:31-35`、許可は `packages/center/src/wrapper.ts:104-110`）。
- 【事実】**書き込みは center だけ**。session は書き込みの tool を呼ばない（system 指示の部品 `memory`: 「記憶への書き込みは bantou が会話と cap 間の往復から自動で渡す。自分では書き込みの tool を呼ばない」、`packages/center/src/system-instructions.ts:173-186`）。書く記憶は master-cap のものだけ（`docs/design/external-memory.md:39-45`）。送信は非同期のキュー（失敗は再試行、上限超えは古い分から捨てる。`:57`）。
- 【事実】memory の `event` tool が受ける種別は `user_prompt` / `assistant_message` / `task` / `result` / `report` / `reply` の 6 つ（`packages/memory/server/utils/events.ts:4`）。本文は 65536 文字まで（`:20`）。
- 【事実】memory が公開する tool は `context` / `event` / `explain` / `recall` / `status`（`packages/memory/server/mcp/tools/`）。`context` は「判断用の要約（利用者の方針、直近の決定、未回答の質問、進行中の task）」（`packages/memory/server/mcp/tools/context.ts:6`）。引継ぎをそのまま返す口は無い。
- 【事実】event の抽出（記憶への昇格）は非同期で、実機では 1 分以内（`docs/design/external-memory.md:111`）。
- 【事実】`docs/design/external-memory.md:68,94` は「session の制御（`--continue` をやめて memory から文脈を組み立て直す、compact の代替）」を今回の範囲外・別設計と書いている。本設計がその別設計に当たる。

### 2.4 記録（引継ぎ）の今の決まり

- 【事実】common.md の [記録]: 状態の正本は file。記録は 3 つ（引継ぎ = 仕掛かり・止まっている事・次の一手 / 決定と番号つきの未決 / 今の窓口）。置き場は project の設定、無ければ repo の `docs/`（`packages/center/instructions/common.md:12-15`）。master-cap は記録を「引継ぎ → 状態 → 決定と未決 → 既知の問題 → 直近の報告」の順に読んでから動く（`packages/center/instructions/master-cap.md:15`）。
- 【事実】利用者の言う「引継ぎファイルを作って compact」は、この記録の file を人が指示して作らせる運用。center にそれを自動で行う code は無い（`compact` で検索して、hook の `source=compact` の扱いと context 使用量の注記だけ）。

### 2.5 画面（会話の表示）

- 【事実】desktop の画面は xterm.js で、pty の**生の byte** を描く。会話の構造（発言単位）は持たない（`packages/ui/components/TerminalView.vue:149-154`、`scrollback: 5000` は `:171` 付近）。
- 【事実】center は session ごとに出力のキュー（core）を持ち、wrapper の出力を chunk として積む。上限は 8 MiB（`packages/center/src/core.ts:7`、積む処理は `packages/center/src/remote-control.ts:726`）。購読は SSE（`GET /sessions/<name>/output`、`packages/center/src/http.ts:328-345`）。続きの chunk ID が残っていれば続き、無ければ `reset` の後に積んである全部（`packages/center/src/core.ts:107-120`）。
- 【事実】キューは session を `add` した時に作られ、`remove`（session の削除）でだけ消える（`packages/center/src/remote-control.ts:925`、`:948`）。claude の停止・起動（スリープ・再起動）では消えず、`detach` / `attach` が wrapper の口を付け外しするだけ（`:746`、`:764`）。**つまり再起動の前後で、同じキューに出力が続けて積まれる**。
- 【事実】desktop 側にも session ごとの再生用の buffer がある（上限 2 MiB。`packages/ui/composables/terminalBuffer.ts:5`）。画面を開くと reset してから buffer を流し直し、続きを購読する（`packages/ui/composables/useTerminalStore.ts:64`）。
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

session が申告する決まりは system 指示の部品に足す（`packages/center/src/system-instructions.ts` の部品の仕組み。どの条件で付けるかは U7）。

### 3.2 引継ぎの保存（原文: 引き継ぎをメモリで保存）

内容は common.md の記録の 3 つ（引継ぎ・決定と未決・今の窓口。`packages/center/instructions/common.md:14`）に合わせ、新しい項目は足さない。書くのは session（何が仕掛かりか知っているのは session だけ）。

保存の形（U2）:
- A: session が tool の引数に引継ぎの本文を渡し、**center が** memory に書く（新しい event の種別 `handoff`。memory 側の変更が要る）。「session は memory に書かない」の決まりを保つ。
- B: session が memory の書き込み tool を直接呼ぶ。今の決まり（`system-instructions.ts:186`）を変える。memory 側の書き込みの tool の公開範囲も変わる。
- C: file（記録の置き場。common.md:15）に書き、memory には書かない。原文の「メモリで保存」と合わない。

推奨: A。理由は原文どおり memory に残し、今の決まり（書くのは center だけ）を変えないため。memory が使えない（設定なし・届かない）時は center の状態置き場に file で残す（再起動後の読み出しも同じ file から。U3 の経路で拾う）。これは原文の制約ではなく、memory に届かない時に引継ぎを失わないための扱い。

保存が済んでから再起動する（順序の約束）: 【事実】memory への送信は非同期のキューで、再試行で遅れうる（`docs/design/external-memory.md:57`）。再起動の前に、引継ぎの event が memory に受理された（または file に書けた）事を確かめる。受理されない間は再起動しない（失敗は session に tool の結果で返す）。

### 3.3 リセッションの実行（原文: 新規に tool か platform 側、再起動の実行まで）

新しい center の tool `session_resession`（session 向けの窓口 `/mcp/session`。呼んだ session は header `X-Bantou-Session` で決まる。`packages/center/src/http.ts:20`、`packages/center/src/tools.ts:51-66` の `resolveOwner`）。引数は引継ぎの本文。他の session を指定する引数は持たない（自分自身だけ）。

実行の順:
1. tool を受ける。3.1 の安全確認を通す。通らなければ理由を返して終わり（再起動しない）。
2. 引継ぎを保存する（3.2）。保存できなければ失敗を返して終わり。
3. 「リセッション待ち」の印を session に付けて、**即座に返す**（返り値: 受理した事と、turn が終わると再起動する事）。
4. その session の次の `Stop` hook（turn の終わり。`packages/center/src/daemon.ts:290` の hook の受け口）で、center が次を行う: 区切りの行を出力キューに積む（3.5）→ `stop(name)` → `start(name)`（`resume` 無し = `--continue` 無し = 新しい会話。`packages/center/src/remote-control.ts:886` は `resume === true` の時だけ続きにする）。
5. 起動の後、3.4 の手順で引継ぎを渡す。

tool の返り値を即座に返す理由: 【事実】tool の呼び出しは claude の turn の中にあり、claude を止めると結果が返らない。【事実】`Stop` hook は同期（`packages/center/src/session-activity.ts:23-24`）なので、turn の終わりに center が止めるタイミングを持てる。

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
| `packages/memory/` | event の種別 `handoff` の追加（`server/utils/events.ts:4`）と、引継ぎを返す読み出しの口 |
| `packages/center/src/system-instructions.ts` | 申告の決まりの部品（U7） |

## 6. 既存の別設計との関係

### 6.1 休止（`docs/session-ondemand-design`。未 merge）

- 休止は「止めて、同じ会話で起こす」（`--resume <id>`）。リセッションは「止めて、新しい会話で起こす」。共通の部品は「止める条件」「起床の時機（`SessionStart` を待つ）」「止めている間の message の扱い」。
- 休止の設計は center の session の状態に `dormant` を足す案。リセッションは状態を足さず、「リセッション待ち」の印だけを短く持つ（turn の終わりまで）。両方が入った時は、休止の判定がリセッション待ちの session を止めない（pending のある session を止めないのと同じ扱い）【推測。実装の時に合わせる】。

### 6.2 別 task の「外部記憶に作業指示（requirement）と仕様・設計の型を足す」設計（branch `docs/memory-requirement-spec`）

- 【事実】`git fetch origin docs/memory-requirement-spec` は「couldn't find remote ref」で失敗した。`git ls-remote origin 'refs/heads/docs/*'` に無い（確認時点）。**その設計はまだ読めていない**。以下は推測。
- 【推測】その設計は memory に「型のある記録」（作業指示・仕様・設計）を足すもの。引継ぎも「型のある記録」の 1 つとして足せる形にすれば矛盾しない。
- 矛盾を避ける約束（推測に基づく。その設計が出たら照合する）:
  - 引継ぎは「event の 1 種別（`handoff`）」と「識別で引ける読み出し」の 2 つだけを memory に求める。作業指示・仕様・設計の型の仕組みが先にできていれば、引継ぎをその型の 1 つとして載せ替える。載せ替えても、session から見た tool（`session_resession`）と、center から見た「保存 → 受理を待つ → 再起動」は変わらない。
  - 引継ぎの本文の項目は common.md の 3 記録（引継ぎ・決定と未決・今の窓口）に合わせる。その設計が別の項目を決めたら、そちらを優先する。
  - 「書くのは center」の決まり（`system-instructions.ts:186`）はそのまま。その設計が session の直接の書き込みを許すなら、U2 の B が選べるようになる。
- 要確認（その設計が出た後）: 型の名前、識別の形、読み出しの口の名前。

## 7. memory 側に求める事（引継ぎの保存と読み出し）

- 種別 `handoff` の event を受ける（`packages/memory/server/utils/events.ts:4` の `EVENT_KINDS` に足す）。
- 識別（agent + 引継ぎの id）で本文をそのまま返す読み出しの口。抽出（LLM）を通さない。【推測】event の本文は DB に生で入っている（`packages/memory/server/utils/events.ts:34-36` の insert）ので、口を足せば返せる。
- 受理を center が待てる事（`event` tool の応答。`recorded` / `duplicate`、`:29`）。
- 引継ぎが「使用済み」かを持てる事（なければ center の側で持つ）。
- ここまでが memory の変更。bantou の center は、memory の設定が無い構成でも file で動く（3.2）。

## 8. 未決

### U1 close 可能の判定を誰が行うか

- A: session の自己申告だけ。利点: 判断できるのは当人で、原文の動作に近い。欠点: pending の途中でも呼べてしまう。
- B: center の機械判定だけ（idle + pending 0）。利点: session の決まりが要らない。欠点: `idle` は「利用者の返事待ち」と区別できない（`packages/center/src/session-activity.ts:56-58`）。待っているだけの session を再起動してしまう。
- C: 自己申告 + center の安全確認。利点: 当人の判断を使いつつ、動いている最中の再起動を防ぐ。欠点: 申告の決まりを system 指示に足す必要がある。
- 推奨: C。

### U2 引継ぎの保存の形

- A: session が tool の引数で渡し、center が memory に書く（種別 `handoff`）。利点: 「session は memory に書かない」を保つ。欠点: memory に種別の追加が要る。
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

- A: system 指示の部品（center が全 session に付ける）。利点: 確実に届く。欠点: 部品の追加（`system-instructions.ts`）。
- B: 利用者の指示（project の `instructions`）。利点: center の変更が要らない。欠点: project ごとに書く必要がある。
- 推奨: A。

## 9. 確かめ方（実装の前の実測。この task では行っていない）

- S1: `--continue` 無しで再起動した時、desktop の画面で前の表示が見えるか（TUI の消去・alt-screen の影響）。
- S2: `Stop` hook の後に `stop` → `start` した時の所要時間と、messenger の peer が現れるまでの時間。
- S3: 起動後の最初の入力を `SessionStart` を待って送った時、入力が確定されるか（休止の設計 2.6 の実測と同じ確認）。
- S4: 身代わり（U6 の A）と再起動の衝突。
