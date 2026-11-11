# remote-cap の運用の決まり（設計）

背景: remote-cap が毎回 worker を 1 体だけ起動して丸投げし、cap と worker が 1 対 1 になっていた（「密結合なので 1 体」と判断していた）。cap は束ね役のはずなので、server が cap の `claude -p` に渡す system prompt（`CAP_GUIDE`、`--append-system-prompt-file`）に決まりを固定で入れて改める。

`CAP_GUIDE` の本文の正本は本書の「決まり本文」。`packages/server/server/utils/bantou/prompts.ts` は本文をこのとおりに持つ（変えるときは両方）。`kick_cap` の prompt は変えない。

## 決まり本文

````
あなたは bantou の remote-cap。作業を束ねるオーケストレーターで、自分では実装しない。
作業は必ず worker にさせる。cap がするのは、分割・指示・結果の確認・次の指示・まとめだけ。
「密結合だから worker は 1 体」と丸投げしない。

[道具]
worker の起動と続きの指示は mcp__bantou__worker_start を使う。worker_id を省けば新規、同じ worker_id を渡せば続きの指示になる。
状態は mcp__bantou__worker_status、停止は mcp__bantou__worker_stop を使う。
Bash で claude を直接起動しない。
一時物は作業 dir の中に置く。$TMPDIR（自分の path の tmp/）を使い、/tmp 直書きはしない。一時物の削除は Bash の rm でなく mcp__bantou__bash の rm（action: rm、paths は自分の path からの相対。自分の worker は worker:<id>/<path>、dir は recursive: true）を使う。
worker の報告は「worker <id> から <kind>: <text>」として届く。
worker_start は完了を待たずに返る。起動したらターンを終えてよい。

[分担]
最小の分担は 2 体。実装 worker と review worker。
review worker は実装 worker の push 後に、別 clone で差分を読み、テストを回し、仕様とのずれ・壊れ・抜けを report する。
review の指摘は、実装 worker に同じ worker_id で worker_start して戻す。直るまで回す。実装と review の往復は最大 3 回。3 回で直らなければ、残った問題として最終返答に書いて止める。
独立な部分（例: center と desktop、実装と docs、別 package）は別 worker で並列に起動する。依存がある部分は、前の worker の完了を確認してから次を起動する。
同じ branch に複数の worker が push する場合は、先に rebase して衝突を解消してから push するよう指示する。

[worker への指示]
指示には必ず次を含める。
- 成果物: branch、commit、report の置き場
- 確認方法: どのテストを回すか（review worker には、回すテストと見る差分の範囲）
- 後始末: 終わったら（push と report の内容を確かめた後に）自分の clone・node_modules・ビルド生成物と、自分で置いた一時物を自分で消す。logs/ と state.json は消さない
kick_cap の prompt にある制約（repo 引数を使わない、一時物の置き場、GIT_CONFIG_GLOBAL、push 先の branch、version bump しない など）は、worker への指示にも書き写す。worker は cap の prompt を見ない。

[model]
worker の model は、cap への指示の worker_model か prompt の指定に従う。
指定が無ければ、実装 worker は既定、review worker は実装と同じか軽いものにする。

[最終返答]
各 worker の結果、review の結論、残った問題を書く。
指示が [task <task_id>] で始まる時（task 指示）は、最終返答を task_result の JSON 1 つで返す。JSON は ```json のコードブロックに入れ、ブロックの前後に説明を書いてよい。形式:
{"state":"done または failed","summary":"結果の要約","workers":[{"worker_id":"...","role":"implement|review|docs|test|other","state":"done|failed|idle|running|stalled|lost","branch":"...","commit":"...","tests":"回したテストと結果","report_path":"...","result":"worker の結果の先頭"}],"review":{"verdict":"ok|issues|unknown","items":[{"severity":"high|medium|low","text":"指摘","resolved":true}],"rounds":0},"remaining":["残った問題"]}
branch / commit / tests / report_path は分かるものだけ書く。review の結果が無い時は verdict を unknown にする。

[report が来ない worker]
worker が report を送らずに idle になった時（worker_status が idle で、その worker の report が届いていない）は、同じ worker_id で worker_start して report を送るよう指示し、再開させる。
````

## task 指示の文面

protocol 1.5.0 の `task`（center → server）を受けた server が、`goal` / `deliverables` / `verify` / `constraints` / `workers` から cap の最初の指示を組み立てる。正本は `prompts.ts` の `buildTaskPrompt`。文面は次のとおり（括弧内は `task` の値で置き換わる。項目が無い節は省くか「指定なし」「なし」と書く）。

- 先頭行は `[task <task_id>]` で固定。`CAP_GUIDE` はこの行で task 指示と見分ける
- `[作業の base]` は `repo` / `branch` のどちらかがある時だけ出す。server は `kick_cap` と同じく `repo` / `branch` を cap の path への clone に使う
- `[分担]` は `workers.items` が無ければ「最低 2 体: 実装 worker と review worker。分割は cap が決める。」。あれば `items` を 1 行ずつ（`<id または #番号>: role= scope= model= depends_on=`）。実装か review が無い時は cap が足す一文を付ける
- `[worker の model]` は `worker_model` がある時だけ出す。server は `worker_model` を cap の既定としても記録する（`kick_cap` と同じ）

```
[task t-1]

[目的]
（goal の自然文）

[作業の base]
repo: （repo）
branch: （base branch）

[成果物]
- push 先 branch: （push 先 branch）
- report の置き場: （report の置き場）
- （その他の成果物）

[確認方法]
- 回すテスト: （回すテスト）
- 手順: （手順）

[制約]
- （制約）

[分担]
次の分担に従って worker を起動する。依存（depends_on）がある worker は、その完了を確認してから起動する。
- impl: role=implement scope=（担当範囲） model=（model）
- #2: role=review scope=（担当範囲） depends_on=impl

[worker の model]
worker_model: （worker_model）（worker_start で model を省く時の既定。分担の model が優先）

[最終返答]
最終返答は task_result の JSON 1 つで返す（形式は system prompt の [最終返答]）。task_id は返さなくてよい。
```

## task_result（最終返答）

cap は `task` 指示の最終返答を task_result の JSON 1 つで返す（形式は上の「決まり本文」の `[最終返答]`）。server は返答から次の順で JSON を探す: ```json コードブロック（複数なら最後）、無ければ本文中の最後の `{...}`。`summary`（文字列）を持つ JSON だけを採る。取れた JSON は `cap_id` / `task_id` を server が補い、形が崩れた項目は既定値で補う（worker の role は `other`、state は `idle`、review の severity は `medium`、verdict は `unknown`、rounds は 0）。取り出せない時は `summary` に生の返答、`workers` / `remaining` は空、`review.verdict` は `unknown`（実行の失敗は `state: "failed"` と `error`）。

cap は worker の report のたびに再開するので、最終ではない返答（「worker を起動した、report 待ち」など）は取り出せず、verdict が `unknown` の `task_result` になる。center は完了を verdict ではなく従来どおり「cap が idle かつ配下の worker に running / stalled が無い」で判断する。report 起因の再開で cap が task_result の JSON で答えた時は `task_result`、そうでなければ従来の `cap_result` を center へ送る。

## 終わった worker の掃除

- worker の dir（`<workspace>/workers/<id>`）には clone・node_modules・ビルド生成物が溜まる。cap は指示（`[worker への指示]` の後始末）で worker 自身に消させ、それでも残るものは server が消す。
- server の掃除（config `session.workerKeepMs`、既定 30 分、0 は掃除しない）: worker が done（report kind=done を送って終了）か、worker_stop で止められ、かつその cap が idle（turn が終わっている）のまま `workerKeepMs` 経ったら、dir のうち `logs/` と `state.json` 以外を消す。cap の turn が続いている間・その worker に再開の指示が来ている間は消さない。同じ worker_id の `worker_start`（`worker_reply` 含む）が来たら待ち時間を数え直す。
- 消したら server.log に `worker 掃除: worker_id=...` を出し、その worker を activity の `agents[]` から外す（protocol は変えない）。`worker_status` は state.json から引くので掃除後も返る。
- 掃除後の同じ worker_id の `worker_start` は、dir に clone し直して起動する（`repo` を省いても、最初の clone の repo / branch を `logs/repo.json` から使う）。`repo` 引数なしで作った worker（dir の中で自分で clone する運用）は `repo.json` が無く clone 元が無いのが正常なので、空の dir（`logs/` と `state.json` は残る）でそのまま起動し、prompt に「この dir は掃除されて空。必要なら自分で clone し直すこと」を 1 行足す。session_id は state.json に残るので `--resume` は同じ。
- 消すのは server が動いている間に done / stop を観測した worker だけ（記録はメモリ。server の再起動前に終わった worker は対象外）。

## cap のライフサイクル（master-cap が作業のまとまりごとに起こし直す）

- 背景（2026-11-11）: master-cap が 1 つの cap に 7 日間すべての task を流し続け、cap の会話が上限を超えた。cap の claude が「Prompt is too long」で起動 4 秒後に終了コード 1 になり、center には「終了コード 1」としか出なかった。`remote_delete` は center の記録だけ消し、server 側の cap（`caps/<cap_id>/state.json` の `session_id`）が残って、次の task が同じ会話を resume してまた落ちた。
- 方針: cap は作業のまとまりごとに起こし直す。無意味に cap を使い回し続けない。計画（受けた指示を作業のまとまりに切り分ける）は master-cap の仕事で、埋め込み指示 `master-cap-role@3` に書く（`docs/design/system-instructions.md`）。起こし直す時期や条件の数値は決めない（判断は master-cap）。
- 閉じ方: master-cap が `remote_delete` で cap を閉じる。server は `stop_cap` で実行中の worker を止め、cap の会話（`session_id`）を破棄する。次の task は同じ cap_id のまま新しい会話で始まる。cap が idle / failed / 実行中のどれでも閉じられる。
- 残すもの: cap の `logs/`（セッションごとの生出力、`reports.jsonl`、閉じた会話の履歴 `closed.jsonl`）は消さずに残す。配下の worker の dir も閉じる操作では消さない。溜まった worker dir は「終わった worker の掃除」が掃除する。
- 引き継ぎ: 閉じた会話は引き継がれない。次のまとまりに必要な成果物（branch・commit・report の置き場）と決定事項は、master-cap が次の goal に書いて渡す。
- 判断の補助: `remote_list` の `conversation`（会話の開始時刻・run 数・context の使用量・直近の失敗の claude の error 文）と `cap_last_error`。失敗の理由は「終了コード 1: Prompt is too long」のように error 文まで出る。

## 根拠・補足

- protocol の定義（`packages/protocol/messenger/` の `protocol.json` / `PROTOCOL.md`）を変える task は、版を上げ `versions.json` に足す（`packages/protocol/test/versions.test.mjs` が落とす）。ただし package の version bump は worker の制約どおりしない。
- 2 体を最小にしたのは、実装した本人の確認では見落としが残るため。review は別 clone で差分を読み、テストを回す。
- 往復の上限は 3 回（固定。`CAP_GUIDE` 内の数値）。
- 既存の決まりは cap の prompt（`kick_cap`）側にあり、server は中身を知らない。cap が worker の指示に引き継ぐ形にした。
- 以前の「軽い作業は Agent tool で済ませてよい」の行は、「自分では実装しない」と衝突するため本文から外した。
- 変えないもの: `kick_cap` の prompt、tool の入出力。`worker_start` の description は説明を足す。
- `task` の追加（protocol 1.5.0）で `CAP_GUIDE` に「task 指示の最終返答は task_result の JSON」「report を送らずに idle になった worker を再開させる」を足した。`kick_cap` の prompt は従来どおり cap にそのまま渡る。
- 「report を送らずに idle」は cap が `worker_status` を見て気づく決まり。cap は report でしか再開しないので、worker が report を送らずに止まった時に server が cap を起こす仕組みは無い（未対応）。
