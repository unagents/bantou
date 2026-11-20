# session の必要時起動・報告の受け口・窓口 1 つ（設計）

- 作成: 2026-11-20
- 基点: `develop` の `80bd939110f0d1bc6f743f36d86fd10440ae59a6`（Merge feat/web-5a-app-shell into develop）
- 範囲: 改善 2（使っていない session を止めて、必要な時に起こす）、改善 3（報告の受け口を center に移す）、改善 4（振り分けと状態の回答だけをする窓口を 1 つ足す）。改善 1（messenger の client の memory 増加）は範囲外。
- 書き方: 【事実】は code を読んで確かめた事（file:行。path は `packages/` からの相対）。【推測】は確かめていない解釈。【未確認】は実測か資料の確認が要る事。
- 成果物は docs だけ。code は変えていない。
- 改訂: 2026-11-20、review（verdict issues。high 3、medium 8、low 8）を反映した。反映の一覧は 13 節。

## 0. 要点

- 最初に出すのは 3a-1（server だけで、worker の失敗・時間切れ・報告なしの終了で cap を再開する。protocol の版は据え置き）。単独で「cap が待ち続ける」を消す。
- 改善 2: center が session ごとに「休止」を持つ。無操作が続き、画面で見られておらず、session に届けるべき物も、未完了の指示も、claude の中の background の作業も無い時に止める。利用者の入力、画面を開く操作、判断が要る通知で起こす。起こす時は claude の会話 id を指定して復帰し、止まっている間に center が受けた物を短い「不在中の要約」1 通で渡す。文脈が戻るかは、作る前に spike（S0）で確かめる。2a〜2c は 1 つの release 単位で、既定は 2d の測定まで無効。
- 改善 3: server からの報告（task_result、worker の report、新しく足す worker の終了通知）は、まず center の受け口（session ごとの file）に溜める。session には、判断が要る物だけを 1 行で知らせる。完了は短くまとめた 1 行で知らせる。本文は session が tool で取りに来た時だけ渡す。worker の終了の通知（3a-2）だけが protocol の版を上げる。
- 改善 4: 利用者の前に「受付」の session を 1 つ置く。受付は、どの project の話かを決め、その project の master-cap に指示を渡し、center が作った状態の要約を答え、判断が要る物を並べるだけをする。受付に messenger は付けず、使える tool は受付用の物だけに絞る（allowlist）。受付への知らせは、利用者が話しかけた時に hook の返り値で付ける pull 型にする。報告の本文は受付から読めない。作業の指揮は project ごとの master-cap に残す。
- 以前の失敗（1 つの session が全 project の報告に追われる）は、報告が session の会話に入らない事（改善 3）と、受付の tool が待たずに短く返る事（改善 4）で消す。
- 基盤仕様の案の「窓口は同時に 1 つ、既定は master-cap」と、言葉が衝突する。この設計では新しい session を「受付」と呼び、仕様の「窓口」（方針を持ち、worker への指示の元を出す者）は project ごとの master-cap のままにする（6 節の末尾と 10 節）。

## 1. 現状の整理

### 1.1 session の起動と維持

- 【事実】center の session（master-cap）は `SessionManager` が持つ。実体は pty wrapper 経由の対話型 `claude --remote-control <name>` で、supervisor の entry になる（center/src/sessions.ts:104-129）。保存先は center の状態 file `sessions.json`（center/src/daemon.ts:132）。
- 【事実】center の起動時、`restore()` が保存済みの session を全部 `supervisor.start(name, { resume: true })` で起動する（center/src/sessions.ts:197-215、center/src/daemon.ts:258）。保存済みの session は、使っていなくても全部が常駐する。
- 【事実】wrapper の引数は `buildWrapperArgs` が組む。`--remote-control <name>-cap`、`--permission-mode`、`--model`、`--append-system-prompt`、`--add-dir`、`--mcp-config`、`--settings`、resume の時だけ `--continue`（center/src/wrapper.ts:122-158）。
- 【事実】`--mcp-config` には、常に stdio の messenger client（`npx -y @unagents/messenger@0.12.2 mcp`）、center の MCP 窓口（`/mcp/session`、session ごとの使い捨て token）、設定があれば外部記憶が入る（center/src/wrapper.ts:51、71-98）。session 1 つにつき、claude の process に加えて messenger client の node process が 1 つ付く。
- 【事実】`launch()` は起動のたびに system 指示・追加指示・出力スタイル・hook・statusLine・許可規則を組み直す（center/src/remote-control.ts:448-500）。
- 【事実】子が止まった時、停止要求でなければ `maxRestarts`（既定 5）まで `restartDelayMs`（既定 5000）後に起動し直す。`continueOnRestart`（既定 true）なら `--continue` を付ける（center/src/remote-control.ts:718-750、center/src/config.ts:20-24）。
- 【事実】`--continue` で接続前に 30 秒以内に終わったら、素の起動へ切り替える（center/src/remote-control.ts:274-275、733-736）。interface の注記に「claude は約 4 時間以内の記録が無いと --continue で error exit する」とある（center/src/remote-control.ts:113-116）。【推測】長く止めた session を `--continue` で起こすと、会話が戻らず素の起動になる場合がある。
- 【事実】素の起動への fallback は `start(name, { resume: true })` の経路（`launch(e, true, true)`、center/src/remote-control.ts:808）だけに付く。子が落ちた時の自動の再起動は `launch(e, rc.continueOnRestart)` で、fallback を付けない（center/src/remote-control.ts:743-744）。起床は必ず `start` の経路を通す。
- 【事実】wrapper は子を process group ごと止める（pty-wrapper/src/main.rs:66-76 の `kill(-pid, sig)`）。claude の中で動いている background の command やサブエージェントも一緒に止まる。
- 【事実】`create` と `update` は起動後、接続（session URL の取得）か失敗まで最大 15 秒待つ（center/src/sessions.ts:131、175-185）。

### 1.2 session を止める・戻す既存の口

- 【事実】center の MCP（外向け）に `rc_start`（`resume: true` で `--continue`）、`rc_stop`、`rc_status`、`rc_list` がある（center/src/tools.ts:255-286）。`stop` は wrapper に stop を送り、`stopGraceMs`（既定 5000）で SIGKILL する（center/src/remote-control.ts:812-840）。
- 【事実】画面からの再起動は `sessionRestart`（`rc_stop` の後に `rc_start {resume:true}`）だけで、呼ぶのは設定の画面と login の画面（ui/api/center.ts:118-122、ui/components/ProjectSettingsDialog.vue:113,161、ui/components/LoginDialog.vue:109,193）。
- 【事実】`stopped` の session は、center の再起動で `restore()` されると、また起動する（center/src/sessions.ts:209）。「止めたまま」を覚える仕組みは無い。

### 1.3 完了通知と worker の report が session に届く経路

- 【事実】server の流れ: center の `task` を受け、cap を 1 turn 動かし、その返答から作った task_result を送り返す（server/server/utils/bantou/daemon.ts:118-126、412-426）。cap の指示書に「worker_start は完了を待たずに返る。起動したら turn を終えてよい」とある（server/server/utils/bantou/prompts.ts:34）。【推測】最初の task_result は、worker を起動した直後の cap の 1 turn から作られる。
- 【事実】worker から戻る経路は `report`（kind = progress / ask / approve / done）の 1 本だけ。server は `reports.jsonl` に追記し、center へ `worker_report` を送り、その本文を prompt にして cap を再開する。再開後の cap の返答から task_result（取れなければ cap_result）を center へ送る（server/server/utils/bantou/reports.ts:228-260）。
- 【事実】center は `onNotice` で `worker_report` を受け、`remotes.onWorkerReport` に渡す（center/src/daemon.ts:89-106、165）。記録に積み（最大 20 件）、progress 以外を、その session の messenger peer（`<session>-cap`）へ push で送る（center/src/remotes.ts:1856-1904）。
- 【事実】完了は、cap が idle で worker も動いていない時に `completeIfIdle` が未完了の指示を全部消し、owner ごとに 1 回 push する。本文は result の先頭 500 文字（center/src/remotes.ts:265-279、893-924）。
- 【事実】push は `link.notifyPeer`。broker の peer 一覧から同名を探し、最新の登録へ送る。いなければ `{ok:false}` を返し、呼び出し側はログに書くだけ（center/src/server-link.ts:883-900、center/src/remotes.ts:912-921）。session が止まっている間・起動し直している間の通知は再送されない。
- 【事実】止まった client の古い登録は heartbeat の失効（60 秒）まで broker に残る（center/src/server-link.ts:895 の注記）。【推測】この間に送ると、死んだ peer への送信が `{ok:true}` で返り、通知は失われたのに失敗として扱われない。止めた直後の通知は `ok:false` で拾えない。
- 【事実】server は worker の終了を待たない。終了時の処理はログだけ（server/server/utils/bantou/workers.ts:108-122）。時間切れは SIGKILL の後、再試行（`maxRetries` 既定 1）を経て state.json を failed にし、activity 通知で center に `failed` を出す（server/server/utils/bantou/claude.ts:221-224,293-294、agents.ts:413-473、activity.ts:256）。cap は起こされない。時間の上限は既定 30 分（server/server/utils/bantou/config.ts:35）で、設置の script は 20 分を書く（server/scripts/install-service.sh:168）。
- 【推測】既知の不具合「cap が待ち続ける」の実体: worker が失敗・時間切れ・報告なしで終わると、cap は二度と起こされず、最終の task_result が来ない。center 側は worker が failed になると「動いている物が無い」と見て、最初の turn の task_result のまま done にしうる（center/src/remotes.ts:691-698、834-844 の判定による）。
- 【事実】出力が 300 秒途絶えた worker は stalled と表示されるだけで、何も止めない（server/server/utils/bantou/activity.ts:8、194-196）。
- 【推測】既知の不具合「master-cap への完了通知が届かない事がある」の原因の候補: (1) session の再起動中で peer がいない（上の notifyPeer の失敗はログだけ）、(2) 同名の古い登録が残っている間の取り違え（docs/design/master-cap-session.md の 6.1）、(3) worker の failed で完了が早く確定し、本当の完了の通知が出ない。どれが起きているかは確かめていない。

### 1.4 remote_list / task_result の記録

- 【事実】center は session × server ごとに `RemoteRecord` を 1 件持ち、`remotes.json` に保存する。最新の `result`・`task_result`、直近 20 件の `worker_reports`、`pending`（未完了の指示）を持つ。履歴は持たない（center/src/remotes.ts:166-214、center/src/daemon.ts:149）。
- 【事実】server は task_result を file に残さない。残るのは logs の task.json、center.json、reports.jsonl、state.json（server/server/utils/bantou/reports.ts:80-82、194-206）。
- 【事実】`remote_wait` は cap が idle で worker が running / stalled でなくなるまで待つ（上限 1800 秒）（center/src/remotes.ts:1975-2018、center/src/tools.ts:436-445）。
- 【事実】protocol に、見込みの時刻（eta）の項目は無い。review は `TaskReview {verdict: ok|issues|unknown, items[{severity, text, resolved}], rounds}`（protocol/src/server.ts:356-377）。

### 1.5 外部記憶（memory）

- 【事実】書き込みは center が自動で行う。master-cap の利用者の発言と応答（hook の UserPromptSubmit / Stop）と、remote の往復（task / result / report / reply）を、非同期の queue で memory の `event` に送る（center/src/memory-events.ts:1-60、center/src/daemon.ts:140、225-230、center/src/remotes.ts:1863）。
- 【事実】読み出しは master-cap 自身が `context` / `recall` を呼ぶ（system 指示の部品 `memory`、center/src/system-instructions.ts:100-112）。`context` は LLM を使わず、方針・最近の決定・返答の無い report・結果の無い task を返す（memory/README.md:22,33）。

### 1.6 desktop の画面と session の生死

- 【事実】画面の `Session.state` は center の `stopped | starting | connected | error`（ui/types/index.ts:79,479）。Rust 側に写しがある（desktop/src-tauri/src/session.rs:130-156）。
- 【事実】center の `GET /events` の理由は `created | deleted | restored | updated | context | activity | remote | changed`（center/src/events.ts:1-5）。起動・停止・終了（state の変化）を知らせる理由は無い。supervisor から event を出すのは認証の変化だけ（center/src/daemon.ts:79）。画面は 5 分ごとの取り直しなどで拾う（ui/composables/useSessionRefresh.ts:6,84-99）。
- 【事実】サイドの行の作業状態は、claude の状態と remote の集計を `state === "connected"` の時だけ出し、`stopped` / `error` は出さない（ui/composables/useBoard.ts:116-132）。
- 【事実】terminal の画面は出力の stream の状態（再接続中・接続できない）だけを出し、pty の終了を出さない（ui/components/TerminalView.vue:234-246）。
- 【事実】画面の terminal は core の購読で出力を受ける。購読者の集合は core が session ごとに持つ（center/src/core.ts:53-81）。

### 1.7 hook と status line

- 【事実】center は `--settings` で statusLine と hook を渡す。hook は `SessionStart`・`UserPromptSubmit`・`PreToolUse`・`PostToolUse`・`PostToolUseFailure`・`PermissionRequest`・`PermissionDenied`・`Notification`・`Stop`・`StopFailure`（center/src/session-activity.ts:8-19、center/src/remote-control.ts:470-481）。
- 【事実】hook から作業状態（working / needs-input / idle）を決め、変わったら `activity` の event を出す（center/src/session-activity.ts:34-、center/src/daemon.ts:225-228）。`SessionStart` の `source=compact` は状態を変えない（同 40 行付近）。
- 【事実】context の使用量は statusLine の値を優先し、無ければ transcript の最後の usage から出す（center/src/context-usage.ts）。

## 2. 改善 2: 必要時起動（休止と起床）

### 2.1 状態

- session の状態に `dormant`（休止）を足す。`stopped` は利用者が止めた物、`error` は再起動の上限、`dormant` は center が止めた物で、いつでも起こせる。
- 休止の記録（休止した時刻、理由、最後の claude の会話 id、休止中に届いた物の数）を `sessions.json` の各 session に保存する。center の再起動の `restore()` は、休止中の session を起動しない（今は全部を起動する。1.1）。
- 休止中の session も `restore()` で `supervisor.add` まではする（core に register される）。しないと画面の output の購読が 404 になり、desktop は「接続できない」で再接続をやめ（desktop/src-tauri/src/terminal.rs:305-308）、開いても起こせない。
- 状態ごとの扱い:

| 操作 | `dormant` の時 | `stopped` の時 |
|---|---|---|
| center の再起動（`restore`） | 起こさない | 今は起こす。休止を入れても変えない（利用者が止めた物は、center の再起動で戻る今の動きを保つ。止めたままにしたい時は休止の `keepAwake` と逆の指定が要るが、この設計の範囲外） |
| `rc_start {resume:true}`（画面の再起動。web も許可） | 起床と同じ（2.4 の順で `--resume <id>` → `--continue` → 素） | 今と同じく `--continue`、記録した会話 id があれば `--resume <id>` を先に試す |
| `rc_stop` | `stopped` に変える（休止の記録を消す） | 変化なし |
| 画面を開く・入力 | 起こす | 起こさない（今と同じ） |

### 2.2 止める条件（全部を満たした時）

| 条件 | 判定の元 | 既定 |
|---|---|---|
| 無操作が続いた | 作業状態が `idle` になってからの時間（hook の Stop / SessionStart）。`working` / `needs-input` の間は数えない | 30 分 |
| claude の中で background の作業が動いていない | `idle`（Stop の hook）は「何も動いていない」と同じではない。master-cap は background の command やサブエージェントに作業を預け、`/loop` や schedule も claude の process の中で動く。休止は process group ごと止める（1.1）ので、これらを殺す。判定の方法は実測（12 節の R4）で決める。候補: (a) wrapper の子の process 木に、MCP の子（messenger・外部記憶など、center が付けた物）以外の process がある間は止めない、(b) hook（PreToolUse / PostToolUse の background の起動と完了）で数を持つ。決まるまで、判定できない時は止めない側に倒す | — |
| 画面で見られていない | 「最後に見た・入力した時刻」で決める。core の購読者の数だけでは決めない（desktop の terminal は開いたままだと自動で再接続し続ける。desktop/src-tauri/src/terminal.rs:281-321。web の tab も同じ）。画面は、表示されていて focus がある間だけ 60 秒ごとに「見ている」を center に送る（新しい command は作らず、`session_resize` と同じ口の軽い POST を足す。6 節）。`lifecycle.idleMinutes` の間、見ている知らせも入力も無ければ「見られていない」 | — |
| 未完了の指示が無い | その session の `remote.running` と `remote.waitingReply` が 0。改善 3 の後もこの条件を残す（完了で起こさない設計なので、remote の作業が動いている master-cap を眠らせると、完了の後に次の task に進めず project の流れが止まる） | — |
| session に届けるべき物が無い | 改善 3 の後: 受け口に「session に渡し済みでない判断が要る物」が無い | — |
| 常駐の指定が無い | session の設定 `lifecycle.keepAwake`（新設） | false |
| 受付の session でない | 改善 4 の受付は休止させない | — |

- 止め方は、center が休止を決めた時点で状態を `dormant` にし（以後の通知は messenger に通さず、2.5 の列に直接入れる）、その後に今の `stop`（wrapper へ stop、猶予の後 SIGKILL）を呼ぶ。止める直前の会話 id を記録しておく（2.4）。
- 止めた時に `state` の event（新しい理由、6 節）を出す。

### 2.3 起こす契機

| 契機 | 経路 |
|---|---|
| 利用者が画面でその session を開いた | 画面の「見ている」の知らせ（2.2）か、core の購読が 0 から 1 になった時 |
| 利用者の入力 | `session_input` が休止中の session に来た時。入力の byte は渡さずに捨て、起こす（2.6） |
| 判断が要る通知 | 改善 3 の受け口が「判断が要る物」を受けた時（9 節の分かれ目 D3） |
| 受付からの指示 | 改善 4 の `project_dispatch` |
| 明示の操作 | 新しい tool `session_wake`（外向けの MCP）と、画面の「起こす」 |

- claude.ai（remote-control）と mobile からの経路は無い。休止中の session は claude を止めているので、claude.ai と mobile の一覧から消え、そこからは起こせない。受付（改善 4）は休止させず remote-control で常駐するので、claude.ai と mobile から使う窓口は受付になる。受付の `project_dispatch` で眠っている project を起こせる。改善 4 の前に改善 2 を有効にすると、mobile から眠った project に届く手段が無くなる（2d で既定を有効にする時の判断材料。9 節の D1）。
- 同時に起きている session の上限 `lifecycle.maxAwake`（既定 0 = 上限なし）を持つ。上限を越えて起こす時は、止める条件を満たす物のうち最も長く無操作の物を先に休止させる。満たす物が無ければ起こすのを待たせ、理由を画面に出す。

### 2.4 起こした時に文脈を戻す

1. claude の会話: hook の共通項目にある `session_id`（Claude Code の hook の入力。bantou は今は使っていない）を center が session ごとに覚え、起こす時は `--resume <session_id>` で起動する。`--resume` が使えない・失敗した時は今の `--continue`、それも失敗したら素の起動（今の fallback）。【未確認】対話型の `--remote-control` と `--resume <id>` を併用できるか、4 時間を越えた会話を `--resume` で戻せるか。休止は 30 分で眠らせて何日も後に起こすのが普通になるので、休止の価値はここにかかる。2a の前に spike（S0。12 節の R1）で確かめる。戻らないと分かった時は、記録の file と不在中の要約だけで続ける形になり、D1 の既定を有効にするかを測り直す。
2. 記録の file: 状態の正本は file（引継ぎ、決定と未決、今の窓口）。master-cap は始める時にそれを読む（基盤仕様の案の決まり）。休止は会話の途中でなく `idle` の時だけ行うので、休止の前に特別な書き出しは要らない。
3. 不在中の要約: 起きた session への最初の入力として、center が「休止中に受けた物」の要約（改善 3 の受け口の、code で作った 1 行ずつ。上限 1500 文字）を 1 通だけ push する。改善 3 の前は、休止中に届かなかった完了通知・worker の report を center が session ごとの未配達の列に残し、同じ形で 1 通にまとめて渡す。
4. 外部記憶: 今の system 指示（起動時に context / recall を呼ぶ）のまま。

### 2.5 止まっている間に届いた物

- 改善 3 の前: center は、session が `dormant` か起床の途中（`starting`、または接続の後で新しい messenger の peer の登録を確かめる前）の間、完了通知と worker の report を messenger に通さず、`undelivered/<session>.jsonl` に直接入れる。`notifyPeer` の失敗に頼らない（止めた直後は古い登録に送って `ok:true` が返り、失敗として拾えない。1.3）。起床の後、center は peer 一覧に、起床の後の時刻で登録された同名の peer がある事を確かめてから 2.4 の 3 で渡して消す。ask / approve は判断が要る物なので、届いた時点で起こす（2.3）。
- 改善 3 の後: 全部が受け口に溜まるので、未配達の列は受け口の「未通知」の印に置き換える。
- 他の peer から session への messenger の message: session が止まっている間は peer がいないので、broker に宛先が無い。【未確認】broker が不在の peer 宛ての message を溜めるか。溜めない場合の扱いは改善 3 の 3.7 と分かれ目 D9。

### 2.6 起動にかかる時間と画面での見せ方

- 見込み【推測】: messenger client の npx の起動、claude の起動、remote-control の接続で、数秒から 20 秒程度。今の `create` は接続を最大 15 秒待つ（1.1）。実測は 2b で行い、8 節の値として残す。
- 画面:
  - サイドの行: 休止中は眠りの印（色は落とす）。起こしている間は「起動中」の印。
  - terminal: 休止中は「休止中。開くと起動します」を出し、開いた時点で起こす。起きるまで入力欄を止め、「起動中（n 秒）」を出す。起きたら core の `reset` で画面を出し直す（今の仕組み）。
  - 入力が休止中に来た時（web の別の画面など）: byte は捨て、画面に「起動中。入力は渡していません」を出す。入力を溜めて後で流す形は、claude の起動直後の画面（trust の確認など）に誤って流れる危険があるので採らない（分かれ目 D2）。
  - 起床の直後（`starting`）も同じ危険がある。今の core は wrapper が繋がっていれば入力を pty に流す（center/src/http.ts:360-367 の `core.input`）。起こした session は、接続と `SessionStart` の hook を見るまで、center が入力を 409（「起動中」）で断る。画面は 409 を「起動中」として出す。

### 2.7 設定

| 項目 | 置き場 | 既定 | 意味 |
|---|---|---|---|
| `lifecycle.enabled` | center 共通 | 2a〜2c の release では false、2d の測定の後に true（分かれ目 D1） | 休止を使うか |
| `lifecycle.idleMinutes` | center 共通、session で上書き | 30 | 無操作から休止までの分 |
| `lifecycle.keepAwake` | session | false | この session は休止させない |
| `lifecycle.maxAwake` | center 共通 | 0（上限なし） | 同時に起きている session の数の上限 |

- 置き場は今の center 共通の設定・session の設定（center/src/project-settings.ts）に項目を足す。未知の項目を保持する今の仕組みに乗る。

## 3. 改善 3: 報告の受け口を center に移す

### 3.1 center が受けて溜める物

| 種類 | 元 | 今 |
|---|---|---|
| `task_result` / `cap_result` / `error` | server の返信（遅れて届く物を含む） | 記録の最新 1 件だけ |
| `worker_report`（progress / ask / approve / done） | server の通知 | 直近 20 件、progress 以外を push |
| `worker_finished`（新設。失敗・時間切れ・報告なしの終了） | server の通知（3.6 の 3a-2） | 無い |
| `cap_lost` / 到達不能 | server の activity、center の到達性 | 記録の印だけ |
| `overdue`（見込みの時刻を過ぎた） | center の時計（3.4） | 無い |
| peer からの message | 3.7 | session に直接届く |
| master-cap の報告（改善 4 で足す `report_to_user`） | master-cap | 無い |

### 3.2 保存の形

- session ごとに `inbox/<session>.jsonl`（center の状態 dir。今の `sessions.json`・`remotes.json` と同じ dir）に 1 件 1 行で追記する。状態の正本は file という決まりに合わせる。
- 1 件の形:

```
{
  id: "i-<時刻>-<乱数>",
  at: ISO,
  session, remote_id?, server?, task_id?, worker_id?,
  kind: "task_result" | "cap_result" | "error" | "worker_report" | "worker_finished" | "cap_lost" | "unreachable" | "overdue" | "peer_message" | "master_report",
  attention: null | "ask" | "approve" | "failed" | "timeout" | "no_report" | "overdue" | "review_issues" | "lost" | "unreachable",
  line: "code で作った 1 行（上限 200 文字）",
  body: 元の本文（上限 64 KiB。越えた分は切って印を付ける）,
  notified_at?: ISO,   // session か受付に知らせた時刻
  read_at?: ISO,       // session が本文を読んだ時刻
  resolved_at?: ISO, resolved_by?: "reply" | "superseded" | "ack" | "result"
}
```

- 状態の変化（notified / read / resolved）は同じ file に変更の行を足す形にし、読み込み時に畳む。一定の大きさ（既定 8 MiB）を越えたら、resolved 済みの古い物を `inbox/<session>.<日付>.jsonl` に移す。
- `remotes.json` の `RemoteRecord` は今のまま残す（remote_list の互換）。受け口は記録の別の見方でなく、届いた物の列として持つ。
- 二重の持ち方を避ける: worker の ask / approve の「返答済み・解消済み」は、今の `RemoteRecord.worker_reports` の `replied_at` / `superseded_at`（center/src/remotes.ts:112-118）だけが書き手になる。受け口の該当の物の `resolved_*` は、読み出しの時にそこから導く（受け口の file には書かない）。受け口が自分で書く `resolved_*` は、`inbox_ack` と、受け口にしか無い物（`worker_finished`、`overdue`、`master_report`、`peer_message`）だけ。

### 3.3 要約の作り方

- code で作る（center、LLM を使わない）:
  - 1 件の `line`: 種類、project、task の goal の先頭、state、review の判定と未解決の high / medium の数、worker ごとの branch・commit・test の結果の有無、`remaining` の数、error の先頭。
  - session ごと・全体の集計: 未完了の task の数、判断が要る物の数と種類、最後に完了した物、見込みを過ぎた物。
  - 不在中の要約（2.4）と、受付への状態の回答（4 節）は、この集計と `line` を並べた物。
- model が要る物（center では作らない）:
  - 報告の本文の意味の要約、複数の報告をまたいだ判断（「これで完了と言えるか」「次に何をさせるか」）。これは master-cap が `inbox_read` で本文を読んだ時に、自分の turn の中で行う。
  - 理由: center を決定的に保ち、LLM の待ち・失敗・費用を center の受け口に持ち込まない。外部記憶の LLM を借りる案も、memory が無い構成で受け口が動かなくなるので採らない（分かれ目 D8）。

### 3.4 「判断が要る物」の基準

| attention | 条件 |
|---|---|
| `ask` / `approve` | worker_report の kind が ask / approve で、返答（worker_reply）も、同じ worker の後続の report（今の superseded の判定、center/src/remotes.ts:1868-1872）も無い |
| `failed` | task_result の state が失敗、`error` の返信、cap の failed |
| `timeout` / `no_report` | 新しい `worker_finished` の通知（3.6 の 3a-2）で、時間切れ、または報告なしの終了。3a-2 の前は、activity の worker の `failed` を代わりに使う |
| `review_issues` | task_result の review の verdict が `issues` で、未解決（`resolved: false`）の high か medium がある |
| `overdue` | 未完了の指示が、見込みの時刻を過ぎた。見込みは `remote_send` の新しい任意の引数 `expect_minutes`（無ければ center 共通の既定 90 分）。過ぎた時に 1 回、その後は 2 倍ごとに 1 回 |
| `lost` / `unreachable` | 今の集計の `lost` / `unreachable`（center/src/remotes.ts:122-131）が、作業中の cap に付いた |

- 判断が要らない物: progress、done の report、成功の task_result（review が ok か未解決の issues が low だけ）。これらは溜めるだけで、知らせは 3.5 の完了の 1 行にまとめる。
- 基盤仕様の案では worker は質問しない（ask / approve を勧めない）。ask / approve の口は残っているので基準に入れるが、件数は減る見込み。

### 3.5 session に渡す時の大きさの上限

- push は 1 通 1000 文字以内。判断が要る物は、届いた時に 1 行（`line` と `inbox_read` の id）で push する。最初の 1 件はすぐ送り、その後 30 秒の間に来た物だけを 1 通にまとめる（後ろ寄せにすると ask / approve / failed が最大 30 秒遅れるため）。
- 完了（判断が要らない物）は、60 秒の間に来た物を「完了 3 件（要確認 0）。inbox_list で見る」の 1 行にまとめる。progress は push しない（今と同じ）。
- tool の返り値の上限: `inbox_list` は 1 回 40 件・8000 文字まで（続きは cursor）。`inbox_read` は 1 件の本文を 16000 文字まで返し、越えた分は `offset` で続きを取る。
- 今の push の本文（result の先頭 500 文字、report の先頭 2000 文字。`NOTIFY_RESULT_MAX` は center/src/remotes.ts:252、`NOTIFY_REPORT_MAX` は同 42）より小さくする。本文は session が必要と判断した時だけ取りに来る。

### 3.6 server 側に要る変更と protocol の版

server 側の変更は、版を上げない部分（3a-1）と上げる部分（3a-2）に分ける。cap の再開は今の protocol だけで済むので、3a-1 は旧 center とも組める。版を上げる回数は少ない方がよい（【推測】center の follow は新旧を比べずに組の版へ更新を指示する（center/src/follow.ts:200-212 付近）ので、同じ broker に版の違う center が並ぶと server の版の取り合いになりうる）。

#### 3a-1: worker の終了で cap を再開する（server だけ。版は据え置き）

- server（`WorkerHub.start` の終了処理、server/server/utils/bantou/workers.ts:119-122）で、worker の終了を見る。終了が失敗（時間切れを含む）、または成功でもその run の間に report が 1 件も無かった時に、cap を「worker X が報告なしで終わった / 失敗した / 時間切れ」の prompt で再開する（今の report の再開と同じ `invoke(capId, { keepTask: true })`、server/server/utils/bantou/reports.ts:249-251）。再開後の返答は今と同じく task_result か cap_result で center に送る。
- これで基盤仕様の案の remote-cap の [見張り]（失敗・時間切れ・無応答で起こし直す）が、cap が起きている前提でなく働く。
- 実装の注意（この節は先に実装を始める担当の task に写す）:
  1. 判定は、時間切れの再試行（`maxRetries`、server/server/utils/bantou/config.ts:36）が尽きた後に行う。再試行の途中では再開しない。
  2. 「報告なし」は、その run の間の `reports.jsonl` の件数で数える。done の report があれば再開しない（report の側で既に再開している）。progress だけで終わった時は「報告なし」として扱う。
  3. task ごとに再開の回数の上限を持つ（同じ worker の起動し直し → 失敗の輪を止めるため）。既定 3 回。超えたら、cap を再開せず、error の task_result（未完了の理由と、失敗した worker の一覧）を center に送る。
  4. cap が turn の途中なら、今の report の再開と同じ並べ方（同じ cap への invoke は直列に待つ）に乗せる。
  5. center の `completeIfIdle` との競合: worker が failed になった activity が先に center に届くと、center は「動いている物が無い」と見て、最初の turn の結果で完了を通知し、pending を消す。その後に再開した cap の task_result が pending 無しで届く。server は、worker の failed の activity を出す前に、cap を running にしてから再開を始める（activity の順序を「cap running → worker failed」にする）。e2e で、center に完了が 2 回届かない事と、0 回にならない事を確かめる。
  6. server が再起動した時、再起動の前に終わっていた worker（state.json が failed か、報告なしで終わった物）の扱いを決める。推奨: 再起動の後の最初の status で、未処理の終了を 1 回だけ拾って再開する。拾った印を cap の logs に残し、二重に再開しない。
  7. protocol.json・PROTOCOL.md・versions.json に触れない（版を上げない）。
- center 側: 再開の後に届く task_result は、今の `applyLateReply` で記録に反映される（center/src/remotes.ts:1906-1917）。pending が消えた後に届いた物が通知に載るかは実測（12 節の R8）で確かめ、載らなければ center で「後から届いた結果」を通知する分岐を足す（3a-1 とは別の小さなまとまり。改善 3 の後は受け口に必ず載る）。

#### 3a-2: worker の終了の通知（版が上がる）

- server は 3a-1 と同じ契機で、center へ新しい通知 `worker_finished {bantou, type, cap_id, task_id?, worker_id, ok, timed_out, reported, error?, resumed, at}` を送る。center は受け口に `timeout` / `no_report` / `failed` として載せる。
- protocol: 通知の型 `worker_finished` を `ServerNotice` と `isServerNotice`（protocol/src/server.ts:1104-）に足す。messenger の版を上げる（今 `1.8.1`、protocol/src/server.ts:14 と packages/protocol/messenger/protocol.json:3。新しい版は `1.9.0` を想定）。`messenger/versions.json` に hash を足す（protocol/test/versions.test.mjs が検出する）。
- 版の一致: center は server の版が完全に一致しない時に指示を送らない（center/src/server-link.ts:312-318、423-427）。center と server を同じ release で出し、server を先に publish する（docs/history/20261111-0502-protocol-version-guard/report.md の手順）。center の follow が server の更新を指示する。
- 旧 center が新 server の `worker_finished` を受けた時: 旧 center の `isServerNotice` は未知の type を弾き、server-link は「無視」とログに出して捨てる（protocol/src/server.ts:1104-1122、center/src/server-link.ts:458-461）。旧 center 側に分岐は要らない。要るのは新しい center の `isServerNotice` に `worker_finished` を足す事。
- 版を上げる機会を減らすため、3a-2 は改善 3 の他の protocol の変更（あれば）とまとめて出す。

### 3.7 peer からの message

- 起きている session への peer の message は、今のまま messenger で session に直接届く。center の経路を通さない（center が全 peer の message を中継すると、center が messenger の負荷を背負い、改善 1 の範囲に触れる）。
- 休止中の session 宛て: center が、休止の間だけその session の名前で broker に代理の登録をし、受けた message を受け口に `peer_message` として溜める。push の message は判断が要る物として扱い、session を起こす。session を起こす前に代理の登録を外す。【未確認】messenger の client 1 つで、別の名前の登録を追加で持てるか。持てない場合は、代理の登録用の client をもう 1 本持つ。実測は 3e で行い、それまでは「休止中の session には peer の message が届かない」と画面と session_list に出す（分かれ目 D9）。

### 3.8 既存の tool との関係

| tool | 扱い |
|---|---|
| `remote_list` | 残す（画面の RemoteActivity と互換）。master-cap の system 指示からは「状態を見る時は `inbox_list`」に置き換え、`remote_list` は cap の細部（conversation の使用量など）を見る時だけにする |
| `remote_wait` | 残す。turn を塞ぐので、system 指示では使わない事を勧める（今の availability の部品と同じ方針）。受け口の判定（done / failed）とは独立に動く |
| `worker_reply` | 残す。返答の印は今どおり `RemoteRecord` に書き、受け口はそこから resolved を導く（3.2） |
| 新 `inbox_list` | session の受け口の `line` の列。引数: `attention_only`、`since`、`cursor` |
| 新 `inbox_read` | 1 件の本文。読んだ印を付ける |
| 新 `inbox_ack` | 判断が要る物を「対応済み」にする（返答以外の手段で片付けた時） |

- system 指示の部品 `master-cap-role` と `master-cap-availability` の「完了通知と worker の report は push で届く」を、「判断が要る物と完了の 1 行が届く。本文は inbox_read で読む」に書き換え、版を上げる（center/src/system-instructions.ts:53、91）。

## 4. 改善 4: 窓口（受付）を 1 つ足す

### 4.1 受付の session の役目

- 利用者が最初に話す相手。center が 1 つだけ起動する、特別な種類の session（名前は既定 `front`、変更可）。
- 役目は 4 つ:
  1. project の特定: 利用者の話がどの project（master-cap の session）の事かを決める。
  2. 指示の受け渡し: 利用者の言葉を、その project の master-cap に渡す。
  3. 状態の回答: center が code で作った集計で、「今どうなっているか」に答える。
  4. 判断が要る物の提示: 全 project の判断が要る物を短く並べ、利用者の答えをその project の master-cap に渡す。

### 4.2 してはいけない事

- 報告の本文を読まない: 受付の tool は `line` と集計だけを返し、本文を返す tool を受付に付けない（`inbox_read` を受付に出さない）。
- 作業の指揮をしない: `remote_send`、`worker_reply`、`remote_delete` を受付に付けない。worker や remote-cap に直接指示しない。
- 方針を決めない: 利用者の答えは、そのまま master-cap に渡す。受付が案を選ばない。
- 他の session に直接話さない: 受付に messenger の client を付けない。付けると、どの peer も push で受付の会話に本文を入れられ（4.5 の上限を迂回する）、受付も send_message で master-cap や remote-cap に直接指示できてしまう。受付から他への経路は center の受付用の tool だけにする。
- source を読まない、作業しない、記録の本文を読まない: deny（拒む物を並べる）では足りない。Read / Grep / Glob / WebFetch が残り、Read で center の状態 dir の受け口や `remotes.json` の本文を読める。user scope の MCP（`remote_send` や `worker_reply` を持つ物を含む）、plugin、skill、user の CLAUDE.md も読み込まれる（今の `buildWrapperArgs` は `--strict-mcp-config` を付けていない。center/src/wrapper.ts:122-158）。そこで受付は allowlist 方式にする:
  - 使える tool を受付用の MCP の tool だけにする（claude の起動の引数で使える tool を指定する。候補は `--tools` か `--allowedTools`）。組み込みの Read・Bash・Edit・Write・Grep・Glob・WebFetch・Agent は使えない。
  - MCP は center が渡す物だけにする（`--strict-mcp-config`）。
  - 設定の読み込みを絞る（`--setting-sources` で user / project の設定を読まない。plugin・skill・user の CLAUDE.md が入らない形）。
  - 受付の dir は code の無い専用の dir。
  - 【未確認】これらの引数の組で、使えない tool が確認待ち（needs-input）にならずに拒否で返るか、user scope の MCP と plugin が消えるか、対話型の `--remote-control` と一緒に使えるか。4a の前に実測する（12 節の R6）。引数で絞りきれない物が残った時は、その物を設計に書き足し、受付の system 指示の決まりで補う（code で保証できない物として残る危険に載せる）。

### 4.3 master-cap との受け渡し

- 受付 → master-cap: `project_dispatch(project, text)`。center が
  1. その session が休止なら起こし（改善 2）、
  2. 起きたら messenger の push で `[受付から] <text>` を 1 通送り、
  3. 受け渡しの記録（dispatch id、時刻、送達の結果）を受け口に残して、すぐ返る（起床を待たない。返り値は `{dispatch_id, state: "sent" | "waking"}`）。
- 受け渡しの記録には、受付の会話を起こし直しても続きが分かるよう、直近の渡し先（project と時刻と text の先頭）を center が持ち、`project_list` で返す（4.6）。
- master-cap → 利用者: 新しい tool `report_to_user(text, needs_decision?: {question, options[]})` を master-cap に足す。大きさの上限は text 1000 文字、question 300 文字、options 5 個 × 80 文字。越えた物は tool が error で断る（切り詰めない。master-cap に短くさせる）。center はそれを `master_report` として受け口に溜め、`needs_decision` があれば判断が要る物にする。受付は `attention_list` / `project_status` でそれを見て利用者に出す。master-cap は、利用者に伝えたい事を会話の文だけでなく、この tool でも出すよう system 指示に足す。
- 利用者の答え: `attention_answer(id, text)`。center は元の物の project の master-cap に `[受付から、#id への回答] <text>` を送り、その物を resolved にする。worker の ask / approve への答えも master-cap に渡す（受付が worker_reply しない。分かれ目 D6）。

### 4.4 利用者が master-cap に直接つなぐ逃げ道

- 画面のサイドの一覧は今のまま全 session を出し、どの master-cap の terminal も開ける（開けば起こす。改善 2）。受付を通さない話は、今と同じく直接できる。
- 受付は `project_open(project)` で「画面でその project を開く」案内（event の理由 `focus`。どの画面が受けるかは 6 節）を出せる。
- claude.ai と mobile からは、休止中の master-cap は見えない（2.3）。そこから使う窓口は受付で、直接つなぐ逃げ道は desktop と web の画面に限られる。
- 直接話した内容は受付に入らない。受付は状態を center の集計で答えるので、直接の会話で状態が変わっても、受付の答えは center の記録の分だけ正しい。

### 4.5 受付が詰まらない事の保証

| 仕組み | 効き方 |
|---|---|
| 受付の tool は待たない | 全部が center の記録を読むか、送って返るだけ。起床・完了・返答を待つ tool を受付に付けない |
| 返り値が小さい | `project_list` 4000 文字、`project_status` 3000 文字、`attention_list` 4000 文字が上限。本文を返さない |
| 報告が受付の会話に流れ込まない | 受付には push しない（messenger を付けない）。知らせは pull 型: 利用者が受付に話しかけた時、center が受ける UserPromptSubmit の hook の返り値（`additionalContext`）で「判断が要る物 n 件（project ごとの数）」の 1 行を付ける。受付の turn は利用者の入力でしか始まらない。利用者が受付に話しかけていない間の知らせは、画面（サイドの行の印と受け口の画面）で出す |
| 会話の大きさを区切る | 受付は状態を file（center の記録）から答えるので、会話を持ち越す必要が少ない。context が 40% を越えるか、起動から 24 時間で、idle の時に素の起動（`--continue` なし）で起こし直す（分かれ目 D7） |
| 1 応答が短い | system 指示で「1 回の応答で呼ぶ tool は 3 つまで。長い説明をしない。調べる事は master-cap に渡す」と決める |

- pull 型の hook の返り値: 今の hook は UserPromptSubmit を async で送り、返り値を使わない（Stop / StopFailure だけが sync。center/src/session-activity.ts:21-22）。受付の session だけ、UserPromptSubmit を sync にし、center の応答（2 秒で打ち切り。今の hook の打ち切りと同じ）を `additionalContext` として claude に返す。center が応答しない時は何も付けずに通す（受付の応答は止めない）。【未確認】対話型の `--remote-control` で、UserPromptSubmit の `additionalContext` が claude.ai 側からの入力にも効くか。4a の実測に含める。
- push が要る場合と比べた案: center が `core.input` で受付の pty に 1 行を打ち込む形。利用者の入力の途中に文字が混ざる、受付の turn が利用者の意図と無関係に始まる、の 2 つの欠点があるので、基本にしない。判断が要る物が長く放置された時（例: 30 分）に限って、受付が idle で画面の入力が 60 秒無い時に 1 行を打ち込む形を、4c の後に検討する（この設計では採らない）。

### 4.6 project の指定が曖昧な時

- `project_list` は各 project の名前、path の末尾、直近の指示の goal の先頭（pending と受け口の task から）、判断が要る物の数、受付からの直近の渡し先（project と時刻。4.3）を返す。受付はこれを手がかりに決める。受付の会話を起こし直しても、直近の渡し先は center の記録から分かる。
- 決め方:
  1. 利用者が名前を言った、または候補が 1 つに絞れる → そのまま渡し、応答で「→ <project> に渡した」と書く。
  2. 直前の受け渡しと同じ話の続き（直近の渡し先が 10 分以内で、別の project の名前が出ていない）→ 同じ project に渡し、同じく書く。
  3. 候補が 2 つ以上・0 → 渡さない。候補を最大 3 つ並べて 1 回だけ聞く。新しい project を作る事は受付ではしない（作るのは利用者が画面で行う）。
- 誤って渡した時: 利用者が「違う」と言えば、受付は正しい project に渡し直し、誤った先には `[受付から] 直前の指示は取り消し` を送る。

### 4.7 受付に要る tool

| tool | 返す物 |
|---|---|
| `project_list` | session ごとの名前、状態（起きている / 休止 / 起動中 / 停止 / error）、作業状態、未完了の task の数、判断が要る物の数、直近の goal の先頭 |
| `project_status(project)` | その project の集計と、受け口の最近の `line`（最大 15 件） |
| `attention_list(project?)` | 判断が要る物の `line` と id（全 project か 1 つ） |
| `project_dispatch(project, text)` | dispatch id と送達の状態 |
| `attention_answer(id, text)` | 渡した先と送達の状態 |
| `project_open(project)` | 画面にその project を開かせる |

- 受付の session には、これらだけを出す専用の MCP の窓口（`/mcp/front`。session と同じ使い捨ての token）だけを付ける。messenger は付けない（知らせは 4.5 の pull 型）。外部記憶は付けない（判断の材料を持たせない）。使える tool はこの 6 つだけ（4.2 の allowlist）。
- 受付から master-cap への送達（`project_dispatch`・`attention_answer`）は center が行う。center は master-cap の messenger の peer へ push で送る（master-cap 側には今どおり messenger が付く）。master-cap が休止中・起床の途中の時は、2.5 の列に入れ、起床の後に送る。

## 5. 以前の失敗が再発しない根拠と、残る危険

### 5.1 原因と、それを消す仕組み

| 以前の失敗の原因 | 消す仕組み | 改善 |
|---|---|---|
| 全 project の報告が 1 つの session の会話に流れ込み、そのたびに turn が始まる | 報告は center の受け口に溜まる。master-cap に行くのは判断が要る物の 1 行と、まとめた完了の 1 行だけ。受付には push しない（messenger が無い）。受付は利用者の入力の時に件数の 1 行を hook で受けるだけで、turn は利用者の入力でしか始まらない | 3、4 |
| 受付が他の session から直接の message を受け、他の session に直接指示する | 受付に messenger を付けず、tool を allowlist で受付用の物だけにする | 4 |
| 報告を読んで判断するのに turn が長くなり、利用者の指示を受けられない | 受付は報告を読めない。判断は project ごとの master-cap がする。受付の tool は待たずに短く返る | 4 |
| 会話が大きくなり、上限で圧縮されて状態を失う | 受付は状態を center の記録から答えるので、会話を区切って起こし直せる。master-cap の会話にも本文が入らない | 3、4 |
| 1 つの session が全 project の指揮も持つ | 指揮は project ごとの master-cap に残す。受付は受け渡しだけ | 4 |
| 並行の数が host の memory で頭打ち | 使っていない master-cap は休止する | 2 |
| worker の失敗・時間切れで cap が待ち続け、完了が来ない | server が `worker_finished` を cap と center に出す。center は見込みの時刻を過ぎた task を判断が要る物にする | 3 |
| 完了通知が、session が不在の間に失われる | 受け口に残り、起きた時に不在中の要約で渡る | 2、3 |

### 5.2 残る危険

| 危険 | 起きた時に見える事 | 抑え |
|---|---|---|
| 受付が project を取り違える | 違う master-cap が指示を受ける | 渡した先を毎回応答に書く。曖昧なら聞く。取り消しを送れる |
| 判断が要る物が多すぎる（review の issues が毎回出る等） | 受付と master-cap に 1 行が頻繁に届く | 30 / 60 秒でまとめる。基準を設定で絞れるようにする（`attention.reviewSeverity` 既定 medium 以上） |
| 起床が遅い・失敗する | 「起動中」が長い、起きない | 画面に経過秒と失敗の理由を出す。起床の失敗は受け口に `error` として残す |
| `--resume` も `--continue` も効かず、会話が戻らない | master-cap が前の会話を覚えていない | 記録の file と不在中の要約で補う。起床の結果（resume / continue / 素）を session_list に出す |
| center が単一の点になる | center が落ちると受け口も止まる | 今と同じ（center が落ちると session も止まる）。受け口は file なので再起動で戻る |
| 休止中の peer の message が失われる（3e の前） | 他の session からの message が届かない | 休止中である事を session_list と messenger の summary に出す |
| 受付の tool の制限が引数で絞りきれない（user scope の MCP や plugin が残る、確認待ちで止まる） | 受付が本文を読める・指揮できる、needs-input で止まる | allowlist・`--strict-mcp-config`・`--setting-sources` の組を 4a の前に実測する（12 節の R6）。残った物は system 指示で補い、ここに書き足す |
| 休止で background の作業を殺す | 預けた作業が途中で消える | 止める条件に background の作業が無い事を入れ、判定できない時は止めない（2.2、12 節の R4） |
| 休止中の master-cap が claude.ai と mobile から見えない | mobile から眠った project に届かない | mobile の窓口は受付。受付の dispatch で起こす（2.3）。改善 4 の前に休止を既定で有効にしない（D1） |
| 3a-1 の再開の輪 | 同じ worker が起動し直しと失敗を繰り返す | task ごとの再開の上限（3.6） |
| 利用者が受付と master-cap の両方に別々の指示を出す | 同じ project に食い違う指示が入る | 受付からの指示は `[受付から]` の印で区別できる。食い違いの判断は master-cap がする |
| 基盤仕様の「窓口」と言葉が衝突する | 指示文と画面で「窓口」が 2 つの意味になる | 新しい session を「受付」と呼ぶ。指示文の「窓口」は master-cap の意味のまま（10 節） |

## 6. web 版との整合

- 方針: command 名・event 名・型は desktop と web で同じに保つ（今の方針。center-client/src/commands.ts:1-4、center-client/src/events.ts:15）。新しい物は全部、両方に同時に入れる。
- 新しい物と影響:

| 物 | 種類 | desktop | web（center-client） | ui |
|---|---|---|---|---|
| `dormant` の state、起床の結果 | 型 | `session.rs` の写し | `ui/types` を直接使う | `ui/types/index.ts` の `CenterSession` と `Session`、サイドの行、TerminalView の休止の表示 |
| `lifecycle` の設定 | 型 | settings の正規化（`session.rs`） | `commands.ts` の正規化 | ProjectSettingsFields、SettingsDialog |
| event の理由 `state`（起動・休止・停止・終了）、`inbox`（受け口の数の変化）、`focus`（受付の `project_open`） | event | `center_events.rs` は理由を問わず転送する（desktop/src-tauri/src/center_events.rs:30-45）ので、型の追加だけ | `events.ts` も同じ | useSessionRefresh で取り直し。`focus` は画面の切り替え |
| `session_wake`、`inbox_list`、`inbox_read`、`inbox_ack`、`attention_list`、`project_list` | center の MCP の tool | `center_call` で呼ぶ（command は増やさない） | `WEB_ALLOWED_TOOLS` に足す（center-client/src/tool-policy.ts:4-24）。`inbox_ack` は web でも許す | 受け口の画面（新しい部品 `InboxPanel`）、受付の列 |

- command は増やさない: 今と同じく center の MCP の tool を `center_call` で呼ぶ（ui/api/center.ts）。desktop と web の command の表を変えずに済む。例外は画面の「見ている」の知らせ（2.2）で、center に `POST /sessions/<name>/seen`（外向け token。`input` / `resize` と同じ口）を足し、desktop と web に同じ名前の command `session_seen` を足す（terminal の command と同じ並び。ui/api/terminal.ts）。
- `focus` の event（受付の `project_open`）の受け手: event は center につながる全 client（desktop と web の全部）に届く。受けるのは「受付の terminal を表示していて focus がある画面」だけにする（画面の側で判定する）。該当の画面が無ければ何もしない（受付は「画面で開いてください」と答える）。
- 型の一致を確かめる test が今は無い（command 名・event 名の一致を自動で見る test は見つからなかった）。新しいまとまり（2c）で、`ui/types` の新しい型と Rust の写しの JSON の往復を `center-client/test/rust-parity.test.ts` の形で足し、event の理由の一覧を desktop と center-client で同じ定数から確かめる test を足す。

## 7. 実装のまとまり

### 7.1 一覧

| 名前 | 作る物 | 変える package | 確かめ方 | protocol |
|---|---|---|---|---|
| S0 spike: 文脈と起床の実測 | code を出さない実測。12 節の R1（`--resume` と `--remote-control`、4 時間越え）、R2（stop の後に残る process と RSS）、R3（起床の秒数の内訳）。結果を docs に残す | docs | 12 節の確かめ方。R1 が否なら 2.4 と D1 を書き直してから 2a に入る | 変えない |
| 3a-1 worker の終了で cap を再開 | 3.6 の 3a-1（実装の注意 1〜7 を含む） | server | server の unit: 時間切れ（再試行が尽きた後）・失敗・報告なしの終了で再開する。done の report があれば再開しない。再開の上限を越えたら error の task_result。偽の center（messenger の偽 peer）と組んだ e2e で、完了が 2 回届かない・0 回にならない事 | **変えない**（旧 center とも組める） |
| 3f 後から届く結果の通知 | `completeIfIdle` の後に届いた task_result を通知に載せる（R8 で載らないと分かった時だけ） | center | 偽の server で「最初の turn の結果 → worker failed → 再開の task_result」の順を流し、通知が 1 回は最後の結果で出る | 変えない |
| 2a 休止の芯 | `dormant` の状態、止める条件の判定（時計は注入。background の作業の判定は R4 の結果の方式）、`sessions.json` の休止の記録、`restore()` で休止中を起こさず `supervisor.add` はする、`rc_start` / `rc_stop` との関係（2.1 の表）、event の理由 `state` | center | 偽の supervisor と偽の時計で、条件の組み合わせごとに止まる・止まらない。background の作業がある時・判定できない時に止まらない。center の再起動で休止中が起きず、output の購読は 404 にならない | 変えない |
| 2b 起床と文脈 | 起こす契機（見ている知らせ、core の購読、`session_input`、`session_wake`）、hook の `session_id` の記録と `--resume`（S0 の結果に従う）、起床の途中の入力の 409、休止を決めた時点で通知を未配達の列に入れる経路、新しい peer の登録を確かめてから渡す不在中の要約 | center | 偽の wrapper で起床の順序。休止を決めた直後の通知が未配達の列に入る（messenger に送らない）。起床の後、新しい peer の登録を見てから 1 通で渡る。starting の間の input が 409 | 変えない |
| 2c 画面 | 休止・起動中の表示、開くと起こす、「見ている」の知らせ（`session_seen`）、409 の表示、`lifecycle` の設定欄、型と parity の test | ui、desktop、center-client、web、center（`/seen` の口） | ui の unit、desktop の e2e（mock の center で休止 → 開く → 起動中 → 接続。隠した画面で見ている知らせが止まる）、web の e2e（同じ流れ）、parity の test | 変えない |
| 2d 測定と既定 | 8 節の値の測定、12 節の R7、`lifecycle.enabled` の既定を true に（D1 の条件を満たした時） | center、docs | 測定の手順と値を docs に残す | 変えない |
| 3b 受け口の芯 | `inbox/<session>.jsonl`、1 行の要約、判断が要る物の基準、見込みの時刻（`expect_minutes`）、既存の通知（task_result・worker_report・lost・到達不能・worker の failed の activity）の取り込み、ask / approve の解消を `RemoteRecord` から導く | center | 偽の server の通知の列から受け口の中身と attention を確かめる。file の畳み込みと移し替え。worker_reply の後に受け口の該当が resolved に見える | 変えない（`expect_minutes` は center の tool の引数で、server に送らない） |
| 3c 知らせ方の切り替え | push を判断が要る物の 1 行（最初の 1 件はすぐ）と完了のまとめに変える、`inbox_list` / `inbox_read` / `inbox_ack`、system 指示の書き換え（部品の版を上げる）、2b の未配達の列を受け口に置き換え、止める条件に受け口の条件を足す（未完了の指示の条件は残す） | center | 偽の messenger で push の数・大きさ・最初の 1 件の即時。system 指示の文面の test。remote が動いている session が眠らない | 変えない |
| 3d 受け口の画面 | `InboxPanel`、event の理由 `inbox`、web の許可の一覧 | ui、desktop、center-client、web | ui の unit、desktop と web の e2e（mock の center） | 変えない |
| 3a-2 worker の終了の通知 | 3.6 の 3a-2（`worker_finished`、`isServerNotice`、版と versions.json、center の受け口への取り込み） | protocol、server、center | server の unit で通知が出る。center の unit で受け口に `timeout` / `no_report` が載る。versions.test。center と server の版が一致しない組で送らない事（今の門） | **上がる（1.8.1 → 1.9.0 想定）** |
| 3e 休止中の peer の message | 代理の登録と受け口への取り込み（R5 の結果に従う） | center（必要なら messenger の client の使い方） | 実 broker で、休止中の session 宛ての message が受け口に入り、起床の前に代理の登録が外れる | 変えない |
| 4a 受付の session | session の種類 `front`、専用の dir、system 指示の部品 `front-desk`、allowlist・`--strict-mcp-config`・`--setting-sources`（R6 の結果の組）、messenger を付けない、UserPromptSubmit を sync にして件数の 1 行を返す、休止させない、会話の区切りの起こし直し | center | 偽の supervisor で起動の引数（allowlist、MCP は `/mcp/front` だけ、messenger と外部記憶なし）。hook の応答に件数が載る。center が応答しない時に hook が通る | 変えない |
| 4b 受付の tool | `/mcp/front` と 6 つの tool、master-cap の `report_to_user`（大きさの上限）、受け渡しの記録と直近の渡し先 | center | 偽の session（messenger の偽 peer）で、dispatch → 起床 → 新しい peer の確認 → push の順。返り値の大きさの上限。`project_list` に直近の渡し先が出る | 変えない |
| 4c 受付の画面 | 受付を先頭に固定して出す、`focus` の event（受け手は受付を表示中で focus のある画面だけ）、直接つなぐ導線、web の許可の一覧 | ui、desktop、center-client、web | desktop と web の e2e（受付 → project_open → focus のある画面だけでその terminal が開く） | 変えない |

### 7.2 依存と並行

| まとまり | 依存 | 並行できる物 |
|---|---|---|
| S0 | なし | 3a-1、3b |
| 3a-1 | なし（R8 は 3a-1 の中で確かめる） | S0、2a〜2c、3b |
| 3f | 3a-1、R8 | 2a〜2c、3b |
| 2a | S0、R4 | 3a-1、3b |
| 2b | 2a、S0 | 3a-1、3b |
| 2c | 2a（型）、2b（起床の event・409） | 3b、3c |
| 2d | 2c（2a〜2c の release の後）、R7 | 3c、3d、3a-2 |
| 3b | なし（3a-2 の通知は来れば取り込む） | S0、3a-1、2a〜2c |
| 3c | 3b、2a（止める条件を書き換える）、2b（未配達の列を置き換える） | 2c、2d、3a-2 |
| 3d | 3c | 2d、3a-2、4a |
| 3a-2 | 3a-1、3b | 2d、3c、3d |
| 3e | 2a、2b、3b、R5 | 3d、4a |
| 4a | 2a（休止させない判定）、R6 | 3d、3e |
| 4b | 2b（起床）、3b、3c、4a | 3e |
| 4c | 4b、2c | — |

- 循環は無い。

### 7.3 release の単位と順

| 順 | release | 中身 | 単独で出る価値 |
|---|---|---|---|
| 1 | server の release | 3a-1（後で必要なら 3f は center の次の release に乗せる） | worker の失敗・時間切れ・報告なしで cap が待ち続ける事が消える。版を変えないので server だけを出せる |
| 2 | center と画面の release | 2a〜2c（既定は無効） | 設定で休止を有効にした利用者は memory の頭打ちが緩む。2a は単独では価値が出ない（起こせない）ので、2c まで揃えて出す |
| 3 | 設定の既定の変更 | 2d | 既定で有効。4 の前に既定を有効にする時は、mobile から眠った project に届かない事を受け入れる判断が要る（D1） |
| 4 | center と画面の release | 3b〜3d | master-cap の会話に本文が入らなくなる。3b と 3c は合わせて初めて価値が出る |
| 5 | center と server の release（版が上がる） | 3a-2（版を上げる他の変更があれば同じ release に寄せる） | 受け口に時間切れ・報告なしの終了が直接載る。server を先に publish |
| 6 | center と画面の release | 4a〜4c（3e は 5 か 6 に乗せる） | 利用者の前の窓口が 1 つになる |

- protocol の版が変わるのは 3a-2 だけ。

## 8. 測り方

| 値 | 測り方 | 比べ方 |
|---|---|---|
| session 1 つあたりの memory | wrapper の process group（claude、messenger client、MCP の子）の RSS の合計を、idle の状態で 10 分おきに 1 時間取る。【未確認】今の値は測っていない | 改善の前後で同じ project の構成 |
| 同時に持てる project の数 | center の host の空き memory を、起きている session 1 つあたりの RSS で割る。休止中の session の負担（center の記録だけ）も測る | 前: 保存済みの全部が常駐。後: 起きている数だけ |
| 通知から利用者に見えるまで | server の `worker_report.at` → center の受け口の `at` → session への push の送達（notifyPeer の ok）→ 画面に出た時刻（event の受信）。休止中の場合は起床の秒数を含める | p50 / p95。前: push の送達の失敗の割合（ログの「通知を送れない」の数） |
| master-cap の会話の大きさ | `contextUsage` の tokens を、task 1 つの完了ごとに記録する。hook の `SessionStart`（source=compact）の回数を圧縮の回数として数える | 同じ量の task を流して、前後の増え方と圧縮の回数 |
| 受付の 1 応答の時間 | hook の UserPromptSubmit → Stop の時間 | p95 が 30 秒以内を目安 |
| 判断が要る物の割合 | 受け口の attention 付きの件数 / 全件 | 多すぎる時は基準を絞る |

## 9. 利用者から見た結果が変わる分かれ目

| # | 分かれ目 | 案と、利用者に見える事 | 推奨 | 採用 |
|---|---|---|---|---|
| D1 | 休止の既定 | A: 最初から有効。使っていない project は 30 分で眠り、開くと数秒〜20 秒待つ。B: 2a〜2c の release では無効、2d の測定（R1・R3・R7）の後に有効。測るまでは今と同じに見える | B。起床の秒数と `--resume` の効き方を測ってから既定にする方が、待ち時間で驚かせない。休止中の project は claude.ai と mobile から見えなくなるので、受付（4a〜4c）の前に既定を有効にする時は、その事を利用者に示してから決める | B |
| D2 | 休止中・起床の途中の入力 | A: 入力は捨て（起床の途中は 409）、「起動中。入力は渡していません」を出す。B: 入力を溜めて起動後に流す | A。起動直後の確認の画面に誤って流れる危険を避ける。画面を開いた時点で起こすので、打つ頃には起きている事が多い | A |
| D3 | 判断が要る物で master-cap を起こすか | A: 起こす。眠っている project でも、失敗・時間切れ・質問に master-cap がすぐ対応する。B: 起こさない。利用者が受付で見て、開いた時に対応する | A。基盤仕様の案の [見張り]（止まっていたら原因を確かめて再開）を master-cap が担うため | A |
| D4 | 完了の知らせ | A: 60 秒ごとのまとめの 1 行を master-cap に送る。B: 送らない（master-cap は inbox を見に来るだけ） | A。master-cap が完了を知らずに止まる事を避ける。1 行なので会話は大きくならない。未完了の指示がある master-cap は眠らせないので、まとめの 1 行は必ず起きている master-cap に届く | A |
| D5 | 新しい session の呼び名 | A: 「受付」。指示文の「窓口」は master-cap のまま。B: 「窓口」と呼び、基盤仕様の「窓口」を言い換える | A。仕様の言葉を変えずに済む | A |
| D6 | 受付で答えた worker の質問の行き先 | A: master-cap に渡し、master-cap が worker_reply する。少し遅いが方針は master-cap が持つ。B: 受付から直接 worker_reply。速いが受付が指揮に触れる | A。受付は指揮をしない決まりを守る | A |
| D7 | 受付の会話の区切り | A: context 40% か 24 時間で、idle の時に素の起動で起こし直す。受付は前の雑談を忘れるが、状態と直近の渡し先は center の記録から答える。B: `--continue` で持ち越す | A。受付の会話が大きくならない事を仕組みで保証する | A |
| D8 | 要約に model を使うか | A: center は code の要約だけ。意味の要約は master-cap が本文を読んでする。B: center か memory の LLM で要約を作る | A。center を決定的に保つ。memory が無い構成でも動く | A |
| D9 | 休止中の peer の message | A: 3e で代理の登録を入れ、受け口に溜める。それまでは「休止中は届かない」と出す。B: peer の message がある session は休止させない | A。B だと messenger をつないでいる session が眠れなくなる。R5 で代理の登録ができないと分かった時は、broker が溜める物を起床後に読む形に変える | A |
| D10 | 見込みの時刻の既定 | A: `remote_send` に `expect_minutes` を任意で足し、無ければ 90 分。B: server の時間の上限から計算する | A。center は server の時間の上限を知らない。server に問う口を足さずに済む | A |
| D11 | 受付への知らせ方 | A: pull 型。利用者が受付に話しかけた時に件数の 1 行が付く。話しかけていない間は画面の印で見る。B: push 型（messenger か pty への打ち込み）。受付が自分から「判断が要る物があります」と言う | A。受付の会話に外から本文が入る経路と、受付が他の session に直接話す経路を作らない（5.1）。B は 4c の後に、長く放置された時だけの形を検討する | A |

## 10. 基盤仕様の案との関係

- 合う所: 状態の正本は file（受け口は file）。master-cap は source を読まない（変えていない。受付も読まない。受付は tool の allowlist で読めない）。指示は上から下、結果は下から上（受付は層の外に立ち、指示も結果も master-cap を通す。受付は messenger を持たず、他の層に直接話さない）。方針を決めるのは利用者と master-cap（受付は決めない）。remote-cap の [見張り] は 3a-1 で仕組みとして支える。
- 衝突する所:
  - 仕様の「利用者と対話するのは窓口だけ。既定は master-cap」に対し、この設計では利用者が受付と話す。受付は方針を持たず、利用者の言葉を master-cap に渡すだけの中継なので、仕様の「窓口」（方針を持ち、worker への指示の元を出す者）は master-cap のままとする。仕様の文面に「利用者の言葉は受付を通って届く事がある。受付は窓口ではない」の 1 行を足す必要がある。
  - 仕様の「窓口は同時に 1 つ」は project ごとの話として読む（project ごとに master-cap が 1 つ）。受付は全 project に 1 つ。
  - 仕様では worker は質問しない。この設計は ask / approve の口を判断が要る物の基準に残す（口が code に残る間の扱い）。

## 11. 確かめていない事

- 12 節の R1〜R8 の全部（どれも実測していない）。
- 「完了通知が届かない」の原因の候補（1.3 の 3 つと、止めた直後の古い登録への送信）のどれが起きているか。
- center の follow が、版の違う center が同じ broker に並んだ時に server の版を取り合うか（3.6 の推測）。
- 受付の allowlist の引数（`--tools` / `--allowedTools`、`--strict-mcp-config`、`--setting-sources`）が、この設計の通りに働くか（R6）。
- web の設計書（code の注記にある design 5.x）は repo の中に見つからなかった。整合は code（center-client、tool-policy）で判断した。

## 12. 実装の前に実測が要る物

| # | 何を | 確かめ方 | 前提にするまとまり |
|---|---|---|---|
| R1 | `--resume <session_id>` と対話型の `--remote-control` の併用、4 時間を越えた会話の復帰 | 実 claude を wrapper で起動し、合言葉を覚えさせる → stop → hook の `session_id` で `--resume` 起動し、合言葉を答えるかを見る。transcript の mtime を 4 時間より前にして同じ事をする。`--continue` でも同じ事をして比べる。起床の前後で `session_id` と claude.ai 側の session URL が変わるかを記録する | S0 → 2a・2b（否なら 2.4 と D1 を書き直す） |
| R2 | stop の後に残る process | stop の前後で、wrapper の pgid に属する process の一覧と RSS の合計を取る。messenger client（npx の node）と MCP の子が残らないか | S0 → 2a（休止で実際に memory が空くか）、8 節 |
| R3 | 起床の秒数の内訳 | spawn → `SessionStart` の hook → remote-control の接続（session URL）→ messenger の peer の登録、の各時刻を 10 回取る。npx の取得が済んでいる時と、そうでない時を分ける | S0 → 2b（409 の長さ）、2c（画面の見せ方）、D1 |
| R4 | background の作業の扱い | background の Bash（run_in_background）と background のサブエージェントを動かしたまま turn を終え、Stop の hook が出るか、PreToolUse / PostToolUse で起動と完了を数えられるか、wrapper の子の process 木で MCP 以外として区別できるかを見る。`/loop` と schedule も同じ | 2a（止める条件の判定の方式） |
| R5 | messenger の挙動 | peer の process を kill -9 した後、60 秒以内に `notifyPeer` で送って `ok` が返るか。broker が不在の peer 宛ての message を溜めるか（pull で後から読めるか）。client 1 つで別名の登録を持てるか。push が `starting` / `needs-input` の間に届いた時に turn が始まるか、消えるか | 2b（未配達の列の扱い）、3e（代理の登録） |
| R6 | 受付の tool の制限 | `permissions.deny` と、`--tools` / `--allowedTools`・`--strict-mcp-config`・`--setting-sources` の組で、(a) 使えない tool が確認待ちにならず拒否で返るか、(b) user scope の MCP・plugin・skill・user の CLAUDE.md が消えるか、(c) 対話型の `--remote-control` と一緒に使えるか、(d) UserPromptSubmit の sync の hook の `additionalContext` が claude.ai 側からの入力にも効くか | 4a |
| R7 | 起床の頻度の見積もり | center の log と `remotes.json` から、project ごとの 1 日の「判断が要る物」の件数（3.4 の基準を当てはめる）と、hook から取れる idle の間隔の分布を出す。30 分の既定で 1 日に何回起きるかを見積もる | 2d（既定の値と D1） |
| R8 | `completeIfIdle` の後に届く task_result の今の扱い | 偽の server で「最初の turn の task_result → worker の failed の activity → 再開の task_result」の順を流し、`applyLateReply` で記録が更新されるか、通知が出るか、pending が無い時に何が起きるかを見る | 3a-1（競合の確かめ）、3f（要るかどうか） |

## 13. review の反映

review（verdict issues。high 3、medium 8、low 8）の指摘ごとの扱い。全部を採った。

| 指摘 | 扱い | 直した節 |
|---|---|---|
| 事実 1: 止めた client の古い登録に送ると ok:true で消える | 採った。休止を決めた時点で通知を未配達の列に直接入れる | 1.3、2.2、2.5 |
| 事実 2: 旧 center は未知の type を isServerNotice で捨てる | 採った。「捨てる分岐を足す」を消し、新 center の isServerNotice に足すと書いた | 3.6（3a-2） |
| 事実 3: fallback は start(resume) の経路だけ | 採った。起床は start の経路を通すと書いた | 1.1 |
| 事実 4: NOTIFY_RESULT_MAX の行 | 採った（remotes.ts:252） | 3.5 |
| 事実 5: 4.7 の messenger の記述の矛盾 | 採った。受付に messenger を付けないに統一 | 4.7 |
| H1 受付への流入と受付からの指揮の経路 | 採った。messenger を付けない。UserPromptSubmit の hook の返り値で件数を付ける pull 型。core.input の案と比べ、基本にしない理由を書いた | 0、4.2、4.5、4.7、5、D11 |
| H2 tool の制限が deny だけ | 採った。allowlist・`--strict-mcp-config`・`--setting-sources`。4a の前に実測 | 4.2、4.7、5.2、7.1（4a）、12（R6） |
| H3 idle は何も動いていない事と違う | 採った。止める条件に background の作業が無い事を足し、判定の方法は実測。判定できない時は止めない | 1.1、2.2、5.2、7.1（2a）、12（R4） |
| M1 3c の後に remote が動く master-cap が眠る | 採った。未完了の指示が残る間は眠らせない条件を残す | 2.2、7.1（3c）、D4 |
| M2 未配達の列が notifyPeer の失敗だけで決まる | 採った。dormant の判定の時点で直接入れ、起床後は新しい登録を確かめてから送る | 2.2、2.5、7.1（2b） |
| M3 core の購読が 0 だけでは永久に眠らない | 採った。「最後に見た・入力した時刻」で判定。画面が見えて focus がある間だけ見ている知らせを送る | 2.2、2.3、6、7.1（2c） |
| M4 claude.ai / mobile からの経路が無い | 採った。明記し、mobile の窓口は受付と書いた | 2.3、4.4、5.2、D1 |
| M5 再開の輪と completeIfIdle との競合 | 採った。再開の上限、cap を running にしてから worker の failed を出す順、後から届く結果の通知（3f） | 3.6（3a-1 の注意 3・5）、7.1（3f） |
| M6 依存の抜け | 採った。4b → 2b・3c、3c → 2a、3e → 2b を足した | 7.2 |
| M7 版を上げる部分と上げない部分の混在 | 採った。3a-1（版は据え置き、最初に出す）と 3a-2（版が上がる）に分けた。3a-1 の実装の注意を書いた | 0、3.6、7.1、7.2、7.3 |
| M8 文脈が戻るかが未確認 | 採った。S0 spike を 2a の前に置いた | 0、2.4、7.1（S0）、12（R1） |
| L1 起床直後の starting で入力が pty に流れる | 採った。接続と SessionStart を見るまで 409 | 2.6、D2、7.1（2b） |
| L2 30 秒の後ろ寄せで遅れる | 採った。最初の 1 件はすぐ送る | 3.5、7.1（3c） |
| L3 受付を起こし直すと続きの手がかりが消える | 採った。直近の渡し先を center が記録し project_list で返す | 4.3、4.6、D7 |
| L4 report_to_user に上限が無い | 採った。text 1000、question 300、options 5 × 80 文字 | 4.3 |
| L5 ask / approve の解消を 2 か所で持つ | 採った。書き手は RemoteRecord だけ、受け口は導く | 3.2、3.8、7.1（3b） |
| L6 rc_start と dormant / stopped の扱い | 採った。状態ごとの表を足した。stopped が restore で起きる今の動きは変えない（理由を表に書いた） | 2.1 |
| L7 休止中も supervisor.add が要る | 採った | 2.1、7.1（2a） |
| L8 focus の event の受け手 | 採った。受付を表示中で focus のある画面だけが受ける | 4.4、6、7.1（4c） |
| まとまりの切り方（2a〜2c を 1 つの release、3a-1 を最初、3b・3c を合わせて） | 採った | 7.3 |
| 実装の前に実測が要る物 8 項目 | 採った。確かめ方と前提のまとまりを対応づけた | 12 |
