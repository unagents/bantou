# remote_list の結果が最初の cap_result で固定される不具合 / center テスト 7 件落ち

## A. 原因

- server は kick_cap の `cap_result` を返した後、worker の report で cap を再開し、その結果も `cap_result` として kick_cap の送信元へ送る（docs/protocol.md「report」節）。
- center の server-link は cap_id ごとに 1 件の待ち（pending）を持ち、最初の返信で消す。後続の `cap_result` は「対応する待ちなし」とログに出して捨てていた。
- remotes は最初の返信で `state=done` / `result` を確定し、以後更新しなかった。

## A. 変更

- `packages/center/src/server-link.ts`: オプション `onLateCapReply` を追加。待ちに照合できなかった `cap_result` と、cap_id 付きの `kick_cap` の `error` を渡す（従来のログは残す）。
- `packages/center/src/remotes.ts`: `applyLateReply` を追加。記録があり running 以外なら `result` / `state` / `error` を最新に更新（成功は done + error 消去、失敗は failed + error、再開失敗の error は failed + message で result は残す）。`list` は、記録が done で activity の worker が running / stalled の間は `state: "running"`（`finishedAt` なし）で返す。保存される記録には混ぜない。failed は変えない。
- `packages/center/src/daemon.ts`: `onLateCapReply` を `remotes.applyLateReply` へ接続。
- `packages/center/README.md`, `docs/design/master-cap-session.md`: 挙動を追記。
- `state` の取りうる値は増やしていない（desktop の型 `running | done | failed` のまま。desktop は未変更）。
- テスト: `test/remotes.test.ts` に 5 件、`test/server-link.test.ts` に 1 件。

## server 側に必要な変更

- なし。protocol の追加も不要（既存の後続 `cap_result` / `error` を center が受け入れるだけ）。
- 前提: 後続の `cap_result` が kick_cap の送信元（center の messenger peer）へ届くこと。docs/protocol.md の記述どおり。実機の server 0.3.x で届くかは未確認（この環境に server が無い）。
- 任意の改善案: 後続の `cap_result` に区別用の項目（例 `trigger: "report"`, `worker_id`）があれば、center が履歴や表示を出し分けられる。今回は使っていない。

## B. center テスト 7 件落ち

- 再現: develop を clone → `bun install` → `packages/protocol` で `npm run build` → `packages/center` で `bun run test` → 116 件中 109 pass / 7 fail（follow / http / pair / rc 孤児 / remotes / server-link / tools）。報告どおり。
- 原因: 環境（手順の順序）。`@agent-hand/bantou-protocol` は `file:../protocol` 依存で、`bun install` は install 時点の protocol をコピーして `node_modules/.bun/...` に置く。protocol の `dist` は build 後にできるため、install → build の順だとコピーに `dist` が無く、center が `.../bantou-protocol/dist/index.js` を解決できず `ERR_MODULE_NOT_FOUND`。コードの不具合ではない。port 競合ではない。
- 回避手順: protocol を build した後に `bun install --force`（もしくは build → install の順）で再コピーする。実測: `bun install --force` 後に 231 件すべて pass。
- 別の時に 231 件通ったのは、protocol の `dist` がある状態で install されていた（または再 install 済み）ためと推測（未検証）。
- コードの修正はなし。

## 確認

- center: `bun run test` 237 件 pass / 0 fail（231 + 新規 6）、3 回連続で pass。`bun run typecheck` エラーなし。
- desktop は触っていないので e2e は未実施。

## 後始末と残存物

- 一時ファイル・サーバー起動なし。clone の外に置いた一時物なし。
- 作業 dir 内の clone（`bantou/`）と `node_modules` が残る。`bun install` で `bun.lock` が変わったので `git checkout bun.lock` で戻し、commit していない。
- version bump なし。develop / main へ push・merge なし。
