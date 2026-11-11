# cap のライフサイクル（作業のまとまりごとに cap を起こし直す）report

branch: `feat/cap-lifecycle`（基点 origin/develop cd7d450）。release は含めない。

背景（2026-11-11）: master-cap が 1 つの cap に 7 日間すべての task を流し続け、cap の会話が上限を超えて「Prompt is too long」で終了コード 1。`remote_delete` が center の記録だけ消し（stopped:false）、server の `caps/<cap_id>/state.json` の session_id が残って、次の task が同じ会話を resume してまた落ちた。

## 変更
- 埋め込み指示: `master-cap-role` を @3 に上げ、「受けた指示の計画を立て、作業のまとまりごとに cap を起こし直す。同じ cap を使い回し続けない。まとまりが終わったら cap を閉じる」を追加。時期・条件の数値は書かない。
- 閉じる: `remote_delete` が server の `stop_cap` を呼び、実行中の worker を止めて実行の終了を待ち、cap の会話（state.json の session_id）を破棄する。idle / failed / 実行中のどれでも閉じられる。次の task は同じ cap_id のまま新しい session_id で始まる。返り値は `stopped`（run を止めたか）と `session_cleared`（会話を破棄したか。server が確認できなかった時は null と warning）と `previous_session_id`。
- 判断の補助: `remote_list` の cap に `conversation`（会話の開始時刻・run 数・直近の context 使用量 tokens / window / 割合・直近の失敗の error 文）と `cap_last_error`（「終了コード 1: Prompt is too long」のように claude の error 文まで）を出す。値は server が claude の result から取る。画面への新しい表示は足していない（既存の failed 表示の tooltip に理由が出る）。

## 方針
- logs/ と reports.jsonl: 消さずに残す。閉じた会話の履歴は cap の `logs/closed.jsonl` に追記して退避する（session_id・開始時刻・run 数・閉じた時刻）。
- 配下の worker dir: 閉じる操作では消さない（成果物が残っている可能性があるため）。溜まった dir は既存の「終わった worker の掃除」が掃除する。README と docs/design/cap-orchestration.md に記載。
- 引き継ぎ: 閉じた会話は引き継がれない。次のまとまりに必要な成果物と決定事項は master-cap が次の goal に書いて渡す。

## protocol 版の判断
版は上げない。`status_result` の `AgentStatus.conversation` は optional の追加のみ（後方互換。旧 server は送らず、旧 center は読み飛ばす）。`stop_cap` の応答に項目を足したが、旧 center は無視でき、新 center は項目が無ければ null として扱う。protocol に node 依存は持ち込んでいない。

## テスト
- protocol: build + test 40/40 pass
- center: typecheck OK、test 616 pass / 1 fail（rc-orphan の SIGKILL 孤児。既知の既存失敗）
- server: test 349/349 pass。typecheck の error は default-config.test.ts 6 件のみ（既知の既存失敗）。
- 追加した観点: remote_delete 後の次の task が新しい session_id、failed（Prompt is too long）の cap を閉じて起こし直せる、実行中の cap の close、remote_list の使用量と error 理由、埋め込み指示の version と文面。

## 影響
package version・bun.lock は触っていない。package-lock.json は commit していない。
