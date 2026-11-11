# 外部記憶の書き込みを master-cap の記憶だけにする report

branch: `fix/external-memory-master-only`（基点 origin/develop 68e3dc6）。利用者の決定: 「外部記憶の書き込みは master-cap の記憶だけで十分」。release は含めない。

## 変更
- server: memory への書き込み（`utils/bantou/memory.ts`、`daemon.ts` / `reports.ts` の組み込み、`ignoreText` の token 伏せ）と test（memory.test.ts、helpers/fake-memory.ts）を削除。
- protocol: task の `memory`、`TaskMemory` / `supportsMemory` / `MEMORY_MIN_PROTOCOL` / `readTaskMemory` を削除。`MESSENGER_PROTOCOL` / protocol.json / PROTOCOL.md / docs/protocol.md は 1.8.0 に戻した。
- center: task に memory を添える処理（`taskMemoryOf`、`remotes.ts` の `memoryOf` opt、daemon の受け渡し）を削除。master-cap の記憶への書き込み（user_prompt / assistant_message / task / result / report / reply）はそのまま。
- 版固定の test（protocol server.test.mjs、server daemon.test.ts、center follow.test.ts）は 016a2c0 の内容に戻した。
- docs: docs/design/external-memory.md（書き込み節）、packages/server/README.md、packages/center/README.md を実装に合わせた。「server は書かない。理由: 今の目的は master-cap の記憶で、cap の記憶は抽出 LLM の呼び出しを増やすだけ。将来 cap の記憶が要る時に足す」を server README と design に記載。

## protocol 定義の一致
`git diff 016a2c0 -- packages/protocol docs/protocol.md packages/server/README.md` 相当（protocol 配下全体と docs/protocol.md）が差分なし = 016a2c0 時点と一致（server README は追記したので別）。

## memory.ts の判断
`packages/protocol/src/memory.ts` を `packages/center/src/memory.ts` へ移した（test も `packages/center/test/memory.test.ts`）。理由: server から参照が無くなり center だけが使う。protocol に残す理由（server と共有、Node 依存を持たない）が消えた。protocol は @types/node 無しの build を保てる。TaskMemory 系は削除。Node 非依存と digest 注入の作りはそのまま（差分最小のため）。

## テスト
- protocol: build + test 38/38 pass
- center: typecheck OK、test 612 pass / 1 fail（rc-orphan の SIGKILL 孤児。既知の既存失敗）
- server: test 340/340 pass
- git grep で server / protocol に supportsMemory / MEMORY_MIN_PROTOCOL / readTaskMemory / TaskMemory / memory の残骸なし（agent_id は AGENT_ID_PATTERN のみ）。

## 影響
- 1.9.0 は未 publish のため互換の考慮なし。package version・bun.lock は触っていない。
