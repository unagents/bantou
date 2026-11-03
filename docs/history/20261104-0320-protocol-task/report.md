# center と server の間の取り決めの見直し（task / task_result / worker_report / worker_reply、protocol 1.5.0 / server 0.5.0）

## 取り決めの要点

仕様の正本は `packages/protocol/src/server.ts` と `docs/protocol.md`。remote-cap は 1 server に 1 つのまま。

- 旧: center → server は `kick_cap`（prompt）、server → center は `cap_result`（文字列）と `activity` だけ。
- 新（追加。`kick_cap` は互換で残る）:
  - `task`（center → server）: `cap_id`, `task_id`（center が採番）, `goal`, `repo?`, `branch?`, `deliverables`, `verify`, `constraints[]`, `workers{items?}`, `worker_model?`。server が文面を組み立てて cap の指示にする（`buildTaskPrompt`、文面の正本は `docs/design/cap-orchestration.md`）。同じ `cap_id` なら resume。返信は `task_result` か `error`。
  - `task_result`（server → center の返信）: `cap_id`, `task_id`, `state`（done / failed）, `summary`, `workers[]`（branch / commit / tests / report_path / result 先頭 500 文字）, `review{verdict ok|issues|unknown, items[], rounds}`, `remaining[]`, `error?`。cap の最終返答の JSON から取り出す。取り出せない時は `summary` = 生の返答、`review.verdict` = unknown。
  - `worker_report`（server → center の通知）: `cap_id`, `task_id?`, `worker_id`, `kind`（progress / ask / approve / done）, `text`, `at`。report のたびに、cap の再開と並行して送る。
  - `worker_reply`（center → server）: `cap_id`, `worker_id`, `text`。server は同じ `worker_id` で `worker_start`（worker を再開）。返信は `worker_reply_result` か `error`。
- version: protocol 1.5.0、server 0.5.0。desktop の version は上げていない。
- 混在時: center は hello の版確認（完全一致）で mismatch の server へ `hello` / `update_server` 以外を送らない。center が `task` / `worker_reply` を送れるのは server が 0.5.0 になってから。旧 center（1.4.0）→ 新 server は `kick_cap` のまま動く（`worker_report` は旧 center が知らない通知。扱いは未確認。下記）。
- center: `remote_send` は `task` を送る（`goal` 必須、他は省略可。`model` 引数は削除し、`servers[].model` は `cap_kick` 用に残す）。記録に `task_result`・`worker_reports`（最大 20 件）を持つ。`worker_report` は未完了の指示の owner session へ push（progress は同じ worker から 60 秒に 1 回、ask / approve / done は毎回）。新 tool `worker_reply`。完了判定は `task_result` 受信 + 既存の activity 条件。
- desktop: remotes 欄に `task_result`（worker・review・残った問題）と、未返信の ask / approve、`worker_reply` の送信欄。

## 既知の仕様判断（review で確認したもの）

- (a) `worker_report.task_id` は optional: cap に `task` が 1 度も来ていない（`kick_cap` のみ）時は付かない。center は `cap_id` で記録を決めるので問題なし。
- (b) 同じ `task_id` の `task_result` が複数届く: report 起因の再開で cap が JSON で答えると再送される。center は最初の 1 通を待ちに照合、以降は遅れた返信として記録に反映し、完了判定・通知は指示ごとに 1 回。新しい task を送った後に、前の task の report 起因の `task_result` が届くと、server は最新の `task_id` を付けるため新しい task のものとして扱われる（既知の限界。low）。
- (c) 「worker が report せず idle」を server が検知して起こす仕組みは無く、CAP_GUIDE の決まり（同じ `worker_id` で `worker_start` して report を促す）だけ。docs に明記済み。
- (d) `remote_send` の `model` 削除は docs / README / tool 説明と整合（今回 docs/protocol.md を直した。下記）。
- (e) 外向け `/mcp` の tool は 13→14（`worker_reply` 追加）。README に記載があり、テストも更新済み。矛盾なし。

## 変更ファイル

- protocol: `src/server.ts`（型・ガード・`MESSENGER_PROTOCOL` 1.5.0）、`messenger/protocol.json`、`messenger/PROTOCOL.md`、`test/server.test.mjs`。
- server: `server/utils/bantou/daemon.ts`、`prompts.ts`（`buildTaskPrompt` / `extractTaskResult` / `buildTaskResult`、CAP_GUIDE 追記）、`reports.ts`（`worker_report` 通知、task_id の記録）、`package.json`（0.5.0）、各 test、`bun.lock`。
- center: `src/remotes.ts`、`src/server-link.ts`、`src/tools.ts`、`src/daemon.ts`、`README.md`、`test/*`。
- desktop: `src/types/index.ts`、`src/components/RemoteActivity.vue`、`e2e/center.spec.ts`、`e2e/mock/bantou.ts`。
- docs: `docs/protocol.md`、`docs/architecture.md`、`docs/design/cap-orchestration.md`、`docs/design/center-tools.md`。
- w-review の修正: `packages/center/src/follow.ts`、`packages/center/test/follow.test.ts`、`docs/protocol.md`、`docs/design/center-tools.md`。

## テスト（w-review が全件再実行）

- protocol: `npm run build` 成功、`npm test` 28 / 28 pass。
- center: `bun run test` 331 / 331 pass、`bun run typecheck` エラーなし。
- server: `npm test` 224 / 224 pass、`npm run typecheck`（`nuxt prepare` + `tsc --noEmit`）エラーなし。
- desktop: `bun run build:sidecar` 成功、`src-tauri` の `cargo test` 251 passed / 0 failed / 5 ignored、e2e 84 / 84 pass。`bun run generate` の静的ビルドを簡易静的サーバー（node、127.0.0.1:14200）で配信し、ms-playwright の chromium-1243 を一時 config で指定（204 は Chrome・nuxt dev が使えないため）。
- desktop `nuxt typecheck` は実行していない（前回の report のとおり、この環境では `vue-router/volar` が解決できず動かない）。
- 実機の server・messenger・center 間の通信は未確認（この環境に broker が無い）。

## review の指摘と対応

直したもの（commit 11b5bb2）:

- [medium] center の `follow.gate` が `kick_cap` だけを updating で断り、`task` を断らなかった。更新待ちの server へ `task` が送られ、server が `updating` で断る → center には「failed の指示」が記録される（旧 `kick_cap` では isError で記録が作られなかった）。README の門の記述（「更新中の server への `task` / `kick_cap` は送らず」）とも不一致。`task` も断るよう修正、テストに `task`（updating）と `worker_reply`（断らない）を追加。
- [medium] `docs/protocol.md` の remote_send の節（入出力表・model の説明）が旧形式（`prompt` / `model` / `model_ignored` / `kick_cap`）のままで、実装・README と矛盾していた。task 形式（`goal` ほか、返り値に `task_id`、`worker_reply` tool）に更新。完了判定・history の記述に `task` / `task_result` を追記。
- [low → 直した] `docs/design/center-tools.md` の「（今は）」が旧 `kick_cap` / `model_ignored` の記述のまま次項と矛盾していたため、「旧。protocol 1.4.0 まで」の印を付けた。

残したもの（low。判断は人に委ねる）:

- `packages/center/README.md`（`remote_delete` の項）と `docs/design/master-cap-session.md`（追加指示の前の「cap が無い時だけ最初の `kick_cap` で作る」）は、`kick_cap` の記述のまま（実際は最初の `task`）。
- `docs/design/center-tools.md` の「結果 = `cap_result`」「完了は `cap_result` の即時ではなく」は `task_result` にも当てはまる読み替えが要る（履歴的な記述）。
- desktop の「返信済み」は desktop のメモリだけで持つ。desktop を開き直すと、同じ worker の次の report が来るまで、返信済みの ask が再び出る。
- `worker_reports` は task をまたいで最大 20 件のまま（`task_id` で区別できる）。task を送るたびに空にはしない。
- 前の task の worker の report で再開した cap の `task_result` に、新しい task の `task_id` が付き得る（上記 (b)）。
- `worker_reply` は server の更新待ちの間も受け付ける（docs に明記済みの仕様。worker が走り直すため、更新の完了待ちが延びる）。

## merge 後に人手で要ること

- 前提: center が `task` / `worker_reply` を送れるのは、server の protocol が center と完全一致（1.5.0）の時だけ（`docs/protocol.md` の版の門、center README「server の版合わせ」）。server が旧版の間は `remote_send` は isError、`worker_reply` も error。
- 順序:
  1. server 0.5.0（`packages/server`）と protocol package を npm に publish する。server の自己更新の既定の取得元は `bantou@{version}`（`update.spec`、`packages/server/README.md`）。`packages/server/README.md` には「npm publish は protocol package の公開まで保留」とあるので、publish 済みかを確認する（このレビューでは未確認）。
  2. desktop を release する（version は今回上げていない。release 時に決める）。center の `pair.server` は desktop のビルド（`build-sidecar.ts`）が `packages/server/package.json` の版（0.5.0）を埋め込む（center README「組の版」）。新しい desktop の center が起動すると、再起動で center が入れ替わり、発見した server へ `hello` を送り、版が違えば `update_server 0.5.0` を自動で送る（新旧は比べない）。
  3. server は実行中の cap・worker・report が全部終わるのを待ってから自分で再起動する（待機中の `kick_cap` / `task` は `updating` で断られる）。各 server の `server_peers`（center の tool）で `state: ok` と `server_version: 0.5.0` を確認する。自動で更新されない server（`unsupported` / `failed` など）は、`npx bantou@0.5.0` で手動で入れ替える。
- 更新が済むまで、center からの `task` / `worker_reply` は断られる。session は、`remote_send` が版の不一致や `updating` で isError になったら、後で再送する（center は自動では再送しない）。
- `remote_send` を呼ぶ master-cap の指示（`remoteControl.sessionInstructions` など）に `prompt` / `model` 引数の説明があれば、`goal` 形式に直す。
- 実機で確認する: (1) `task` → `task_result` が center の `remote_list` に出る。(2) worker の ask / approve が session への push と desktop の返信欄に出て、`worker_reply` で worker が再開する。(3) 旧 center（1.4.0）が新 server の `worker_report` 通知を受けても壊れない（未確認）。

## 後始末と残存物

- 静的サーバーは停止し、`:14200` の解放と残存プロセスなしを `ss` / `pgrep` で確認した。desktop に置いた一時 config（`pw.tmp.config.ts`）は削除し、commit していない。
- 残る（いずれも git 管理外）: 作業 dir の clone（`bantou/`）と `node_modules`、desktop の `.output` `.nuxt`、`src-tauri/target`、`src-tauri/binaries`。
- develop / main へ push・merge はしていない。
