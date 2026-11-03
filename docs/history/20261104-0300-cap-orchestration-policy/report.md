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

1. 実施: review worker（別 clone、commit c45052a）。bun install / protocol build / server npm test（203 件、pass 203、fail 0）/ typecheck はいずれも成功。bun.lock は install 後に差分なし。
2. [中] `docs/architecture.md:27`: 「軽い作業は cap 内のサブエージェント（Agent tool）。」が残っている。同じ段落末尾の「自分では実装しない」および `CAP_GUIDE` と矛盾する。修正案: 該当文を削除する。
3. [低] `docs/design/cap-orchestration.md` と `prompts.ts` の本文の一致は人手に依存する（現時点では完全一致を確認）。修正案: 設計書の「決まり本文」ブロックと `CAP_GUIDE` を比較するテストを足す。
4. [低] 旧「軽い作業は Agent tool で済ませてよい」の削除は妥当。「自分では実装しない」「作業は必ず worker にさせる」と衝突し、残すと cap が実装を抱える抜け道になる。要確認事項は、読み取りだけの調査まで禁じるかどうか。現状の本文は「確認」を cap の役割に含めるので禁じていない。必要なら「読み取りだけの調査は cap がしてよい」と 1 行足す（任意）。
5. 確認済み（指摘なし）: `packages/protocol` 無変更、`kick_cap` の prompt 無変更（変更は `worker_start` の description と `CAP_GUIDE` のみ）、server version 0.4.1 と bun.lock が一致、README / architecture / design / worker_start の記載内容は仕様と一致。
6. 結論: 要修正 1 件（中）。

## 残存物

- 作業 dir: `/home/vagrant/work/bantou-server-ws/workers/w-2a16c37efa`（clone `bantou/`）
