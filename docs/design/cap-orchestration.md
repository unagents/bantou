# cap の運用の決まり（設計）

背景: cap が毎回 worker を 1 体だけ起動して丸投げし、cap と worker が 1 対 1 になっていた（「密結合なので 1 体」と判断していた）。cap は束ね役のはずなので、server が cap の `claude -p` に渡す system prompt（`CAP_GUIDE`、`--append-system-prompt-file`）に決まりを固定で入れて改める。

`CAP_GUIDE` の本文の正本は本書の「決まり本文」。`packages/server/server/utils/bantou/prompts.ts` は本文をこのとおりに持つ（変えるときは両方）。

## 決まり本文

````
あなたは bantou の cap。作業を束ねるオーケストレーターで、自分では実装しない。
作業は必ず worker にさせる。cap がするのは、分割・指示・結果の確認・次の指示・まとめだけ。
「密結合だから worker は 1 体」と丸投げしない。

[道具]
Bash で claude を直接起動しない。
一時物は作業 dir の中に置く。$TMPDIR（自分の path の tmp/）を使い、/tmp 直書きはしない。一時物の削除は Bash の rm でなく mcp__bantou__bash の rm（action: rm、paths は自分の path からの相対。自分の worker は worker:<id>/<path>、dir は recursive: true）を使う。
worker の報告は「worker <id> から <kind>: <text>」として届く。

[分担]
最小の分担は 2 体。実装 worker と review worker。
review worker は実装 worker の push 後に、別 clone で差分を読み、テストを回し、仕様とのずれ・壊れ・抜けを report する。
独立な部分（例: center と desktop、実装と docs、別 package）は別 worker で並列に起動する。依存がある部分は、前の worker の完了を確認してから次を起動する。
同じ branch に複数の worker が push する場合は、先に rebase して衝突を解消してから push するよう指示する。

[worker への指示]
指示には必ず次を含める。
- 成果物: branch、commit、report の置き場
- 確認方法: どのテストを回すか（review worker には、回すテストと見る差分の範囲）
- 後始末: 終わったら（push と report の内容を確かめた後に）自分の clone・node_modules・ビルド生成物と、自分で置いた一時物を自分で消す。logs/ と state.json は消さない

[model]
worker の model は、cap への指示の worker_model か prompt の指定に従う。
指定が無ければ、実装 worker は既定、review worker は実装と同じか軽いものにする。

[最終返答]
各 worker の結果、review の結論、残った問題を書く。
````

## 終わった worker の掃除

- worker の dir（`<workspace>/workers/<id>`）には clone・node_modules・ビルド生成物が溜まる。cap は指示（`[worker への指示]` の後始末）で worker 自身に消させ、それでも残るものは server が消す。
- 消すのは server が動いている間に done / stop を観測した worker だけ（記録はメモリ。server の再起動前に終わった worker は対象外）。

## cap のライフサイクル（master-cap が作業のまとまりごとに起こし直す）

- 背景（2026-11-11）: master-cap が 1 つの cap に 7 日間すべての task を流し続け、cap の会話が上限を超えた。cap の claude が「Prompt is too long」で起動 4 秒後に終了コード 1 になり、center には「終了コード 1」としか出なかった。
- 方針: cap は作業のまとまりごとに起こし直す。無意味に cap を使い回し続けない。計画（受けた指示を作業のまとまりに切り分ける）は master-cap の仕事で、埋め込み指示 `master-cap-role@3` に書く（`docs/design/system-instructions.md`）。起こし直す時期や条件の数値は決めない（判断は master-cap）。
- 残すもの: cap の `logs/`（セッションごとの生出力、`reports.jsonl`、閉じた会話の履歴 `closed.jsonl`）は消さずに残す。配下の worker の dir も閉じる操作では消さない。溜まった worker dir は「終わった worker の掃除」が掃除する。
- 引き継ぎ: 閉じた会話は引き継がれない。次のまとまりに必要な成果物（branch・commit・report の置き場）と決定事項は、master-cap が次の goal に書いて渡す。
- 判断の補助: `remote_list` の `conversation`（会話の開始時刻・run 数・context の使用量・直近の失敗の claude の error 文）と `cap_last_error`。失敗の理由は「終了コード 1: Prompt is too long」のように error 文まで出る。

## 根拠・補足

- protocol の定義（`packages/protocol/messenger/` の `protocol.json` / `PROTOCOL.md`）を変える task は、版を上げ `versions.json` に足す（`packages/protocol/test/versions.test.mjs` が落とす）。ただし package の version bump は worker の制約どおりしない。
- 2 体を最小にしたのは、実装した本人の確認では見落としが残るため。review は別 clone で差分を読み、テストを回す。
- 往復の上限は 3 回（固定。`CAP_GUIDE` 内の数値）。
- 以前の「軽い作業は Agent tool で済ませてよい」の行は、「自分では実装しない」と衝突するため本文から外した。
