# feat/base-spec-instructions report

## 基点
- 基点: origin/feat/center-coordinator-read = 278c953f089518f2a1d4d036b8c36a9e72ff18dc
- その元の feat/center-task-status HEAD = 0b4247b7eca51940025273bf3a6dd3ffc8dad443
- origin/develop = 4ed3a3c1fd03edb0d694b9623dffda9a8a8240cf

## md の置き場と読み込みの方式
- 共通: packages/center/instructions/common.md（元は 1 つだけ）。master-cap: packages/center/instructions/master-cap.md。
- remote-cap: packages/server/instructions/remote-cap.md。worker: packages/server/instructions/worker.md。
- 方式: `scripts/gen-instructions.mjs`（center / server それぞれ）が md を `instructions.generated.ts`（文字列定数）に取り込む。生成物は commit し、build（center: build / build:bin、server: build / dev / e2e / prepack）の先頭でも再生成する。server の生成は ../center/instructions/common.md を読むので、共通の文面は手で 2 か所に書かない。
- 理由: bun --compile の実行 file と Nuxt の npm package は実行時に repo の file を読めない。build の時に TS の定数にするのが、tsx の test・tsc・bun・nitro のどれでも動く最も単純な形。package をまたぐ読み込みは、server の生成 script が build の時に 1 回だけ行う（実行時には無い）。
- test が「生成物 = md」「server の生成物に center の共通 md が入っている」を確かめる。desktop の build-sidecar.ts は変えていない（desktop を変えない制約）ため、md だけ直して再生成を忘れた場合は test が落ちる事で気付く。

## 部品の id と version（center_info / status に出る順）
base-spec@1（新規。共通の文面）、master-cap-role@4→5、master-cap-availability@1→2、memory@1（変更なし）、coordinator@1（変更なし）。
- 共通の文面を独立した部品 base-spec にした判断: 3 層共通の文面を 1 つの部品にでき、id / version の仕組みを保てるため。

## 文面から言い回しを変えた所
- md は承認文のまま（節の見出しも同じ）。
- 既存の文面とのつなぎで変えた所: 「自分は結果の通知を待つ」→「結果は通知で受ける」（[待ち方] の「自分で待たない」と食い違うため）。
- server の worker 案内「進捗・質問・承認依頼・完了は report で送る（kind: progress | ask | approve | done）」→「進捗・完了は report で送る（kind: progress | done）」（ask / approve を勧める記述を外す）。
- 文面に足した行: [待ち方] の節に「turn を塞がない。remote_wait や長い foreground の command で待たない」「状態を読む道具は remote_list と task_status」「完了・失敗は通知（task_result、worker の report、background の完了）で届く。結果を確かめてから、利用者に短く報告する」（既存の 2 行を 1 つにまとめた物）。task_status は基点に実在する。

## 消さずに残した既存の決まり
- center: [道具]（remote_send / remote_wait / remote_list / worker_reply / remote_delete と push の説明、worker_reply の ask / approve の説明）、[分担の指示]（最低 2 体、成果物・確認方法・制約、report を出させる）、[計画と cap の起こし直し]、[報告]、[自分でしてよいこと]の「利用者への説明、判断材料の整理」（短い読み取りの行だけを [判断の材料] に置き換えた）、並行の指示、利用者の判断が要る点は他を先に進めてから聞く、memory と coordinator の部品。
- server: CAP_GUIDE の分担・最終返答・model・worker への指示・後始末、[worker 終了通知] の扱い、再開の上限、idle の worker の再開（[見張り] の節に 1 つにまとめた。旧「[report が来ない worker]」の見出しは無くなった）、WORKER_GUIDE の [一時物]・[常設の制約]。

## 食い違いを直した所
- 「短い読み取り（ファイル・ログ・状態の確認）」→ [判断の材料] に置き換え。
- 「この Mac のローカル」→「center が動いている host」。
- 「完了・失敗は通知で受ける」「remote_wait や長い foreground で塞がない」→ [待ち方] に 1 つにまとめた。
- 3a-1 の「[report が来ない worker]」→ remote-cap の [見張り] と 1 つにまとめた（重複する文は残さず、固有の 3 行を足した）。

## 変えずに残した、食い違いかもしれない所（判断が要る）
- center の [道具] の remote_wait の説明は「cap の完了まで待つ」。[待ち方] の「自分で待たない」と緊張する（道具の節は今の内容を保つ指示のため変えていない）。
- ローカルのサブエージェント / background 実行（Bash の run_in_background）の例外は残した。[待ち方] の「background に置いた待ち」の禁止とは、前者が作業の実行、後者が待つための loop という区別で並ぶ。
- 「実装と review の往復は最大 3 回。同じ worker_id で戻す」と [自分の層で直し切る] の「別の worker を立てて直る所まで回す」は、review の指摘（同じ worker）と worker の結果の不具合（別の worker）の違いと読んで両方残した。
- center の [道具] の「worker の report（ask / approve / done）が届く」と worker_reply の説明は、ask / approve の口の説明であり勧める記述ではないので残した。
- master-cap の指示文の分担「最低 2 体」と、remote-cap の [役割] 「そのまま、または分け直して」は並べて残している。

## 確認
- center: typecheck 通過。test 650 件、649 通過、1 落ち（既知の不安定「center を SIGKILL すると rc が孤児で残り…」）。
- server: test 367 件、全通過。typecheck は default-config.test.ts の型エラー 6 件（既知。触っていない file）のみ。
- 変異（落ちる事を確認して戻した）: WORKER_GUIDE から共通を外す（1 落ち）、worker に ask / approve を勧める行を戻す（1）、[完了の判定] を外す（1）、base-spec を部品の一覧から外す（6）、master-cap-role の version を戻す（4）、[判断の材料] を外す（1）、状態を読む道具の行を外す（1）。
- build: center の bun --compile（build:bin。約 1 秒）の実行 file に、「bantou の体制」「窓口を預ける時・戻す時」「判断は、仕様・状態・報告・証跡」「状態を読む道具は remote_list と task_status」が入っている事を確認（実行 file 内では日本語は \uXXXX の形で入っている）。server の nuxt build（約 14 秒）の .output に「質問しない。止まらず最後まで進む」「bantou の体制」「報告を待つだけにしない」が入っている事を確認。
- protocol の file（protocol.json / PROTOCOL.md / versions.json）と packages/protocol、desktop、Rust に差分なし。ask / approve の code に差分なし。
- 回さなかった確認: desktop の build-sidecar.ts の実行（Rust と pty-wrapper を含むため。center の部分に相当する build:bin を回した）。

## 残った問題
- build-sidecar.ts は md の再生成を呼ばない（desktop を変えない制約）。生成物は commit 済みで、test が一致を確かめる。
- bun install は中継経由で約 5 分かかった。

## 基点の更新（coordinator-read ebfa53f、task-status 4dbb57d）の取り込みと確認結果
- feat/center-coordinator-read の HEAD ebfa53fb3295f6821d8d392f77580011471e7edc（feat/center-task-status 4dbb57d955baaf05bb3f8a64055cbe212a18c206 を含む）を git merge で取り込んだ（rebase なし）。衝突なし。merge 前の HEAD は ba8672353d84495e167e44a007e1af248d2799fd。取り込みで system-instructions.ts とその test に差分は出ていない。
- center: typecheck 通過。test 655 件、654 通過、1 落ち（既知の「center を SIGKILL すると rc が孤児で残り…」）。部品の並び（base-spec@1・master-cap-role@5・master-cap-availability@2・memory@1・coordinator@1）の test は通る。生成物と md の一致の test も通る。
- server: test 367 件、全通過。typecheck の error は default-config.test.ts の 6 件のみ（既知）。
- [待ち方] で名前を出す道具: remote_list と task_status は、取り込み後の packages/center/src/tools.ts に実在する（task_status は 4dbb57d で入った物）。
- coordinator@1 の文面と base-spec の [窓口] の読み合わせ（変えていない）: 矛盾は無いが、2 点の差がある。(1) 共通の文面は統括の session の役目を「利用者の指示を各 project の master-cap に渡す事と、状態を答える事だけ」とするが、coordinator@1 は「使える道具は session_brief だけ」で、指示を渡す道具（P5）はまだ無い。道具が入るまで、指示を渡す役目の方は文面だけで道具が無い。(2) coordinator@1 の「自分の project の master-cap でもある」は、共通の文面の「窓口は project ごとに 1 つ。既定は master-cap」「統括は渡す事と答える事だけ」と並ぶと、統括が自分の project では master-cap として方針を決めてよいのかが曖昧に読める。変更が要るか判断が要る。
- 回さなかった確認: build の成果物の再確認（取り込みで文面と build 手順に差分が無いため）。
