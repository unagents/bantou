# cap の運用の決まり（orchestration policy）

branch: `feature/cap-orchestration-policy`（base: develop）。

## 方針

- cap は自分で実装しない。作業は worker にさせ、cap は分割・指示・確認・次の指示・まとめをする。
- 最小の分担は実装 worker と review worker の 2 体。review の指摘は同じ `worker_id` の `worker_start` で実装 worker に戻す。往復は最大 3 回。
- 独立な部分は別 worker で並列、依存は順番。worker への指示に成果物と確認方法を必ず入れる。
- 最終返答に各 worker の結果・review の結論・残った問題。worker の model は指示の `worker_model` か prompt の指定、無ければ実装は既定、review は実装と同じか軽いもの。
- 既存の決まり（repo 引数、一時物、GIT_CONFIG_GLOBAL、push 先、version bump）は `kick_cap` の prompt 側にあるため、worker への指示に書き写すよう決まりに入れた。
- 正本は `docs/design/cap-orchestration.md`。`CAP_GUIDE` は同じ本文を持つ。
- 旧 `CAP_GUIDE` の「軽い作業は Agent tool で済ませてよい」は「自分では実装しない」と衝突するため外した（要確認）。

## 変更ファイル

- `packages/server/server/utils/bantou/prompts.ts`（`CAP_GUIDE`）
- `packages/server/server/utils/bantou/mcp.ts`（`worker_start` の description）
- `packages/server/test/server/utils/bantou/prompts.test.ts`（決まりのテスト追加）
- `packages/server/package.json`（0.4.0 → 0.4.1）
- `packages/server/README.md`、`docs/architecture.md`、`docs/design/cap-orchestration.md`（新規）
- 変更なし: `packages/protocol`、`kick_cap` の prompt

## テスト

- server `npm test`: 203 件、pass 203、fail 0（追加 1 件）
- server `npm run typecheck`: エラーなし
- protocol `npm run build`: 成功

## review worker の指摘と対応

（後で追記）

## 残存物

- 作業 dir: `/home/vagrant/work/bantou-server-ws/workers/w-2a16c37efa`（clone `bantou/`）
