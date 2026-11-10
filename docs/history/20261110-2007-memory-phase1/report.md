# memory Phase 1（packages/memory）

branch `feat/memory-phase1`（基点 develop d20aac2）。設計は `docs/design/external-memory.md` と `docs/design/memory-design.md`。

## 作ったもの

- `packages/memory`: Nuxt 4 + `@nuxtjs/mcp-toolkit` 0.24.3。`/mcp`（Streamable HTTP）。
- tool: `event`（書き込み、冪等）/ `recall` / `context` / `explain`。
- 認証: Bearer（`MEMORY_TOKEN`、sha256 化して `timingSafeEqual`）+ `X-Agent-Id` 必須。無い・不正は 401（理由は返さない）。token は log に出さない（smoke で log に token が無いことを確認）。
- DB: `migrations/001_init.sql`。8 表、RLS（FORCE）、`vector(768)` + HNSW cosine。
- 抽出 worker: Nitro task `memory:extract`（毎分）。chatp（`POST /v1/chat/completions`、`response_format: json_schema`）→ 検証 → `memory_candidates` → `memory_items`。続けて埋め込み（Ollama `POST /api/embed`）。
- Outbox: event 受信時（`graphiti.episode`、key = event_id）と item 作成時（`graphiti.memory_item`）に同じ transaction で積む。反映は Phase 2。
- deploy: `deploy/compose.yaml`（pgvector/pgvector:pg17 + ollama）、systemd user unit、env の雛形。実際の設置はしていない。

## 設計判断

- **migration は node-pg-migrate**。pgvector の列・HNSW・RLS はどのツールでも素の SQL になり、query も手書きのため drizzle の型の利点が小さい。`.sql` を直接レビューでき、test も同じ SQL を流せる。node-pg-migrate v9 が `-- Up Migration` / `-- Down Migration` を読むことはソース（`sqlMigration`）で確認。CLI 実行そのもの（`npm run migrate`）は実 PostgreSQL が無く未実行。
- **埋め込み次元**: migration で固定、`MEMORY_EMBED_DIM` で server に伝え、最初の呼び出し時に列の次元と照合。初回問い合わせ方式は採らない。
- **agent 分離**: 認証済み agent を SQL の条件と RLS（`app.agent_id`）の二重で強制。`recall` の `scope.agentIds` に他 agent を入れたら `ForbiddenError`、`context` の `agentId` も同様、`explain` は他 agent の item を「無い」扱い。shared / organizational は読めるが、Phase 1 では書く経路が無い。
- **confirmed / inferred**: README の規則のとおり。`decideCandidate` は DB 参照を引数で受ける純関数にして unit で網羅。
- **superseded**: `recall` は `temporal` 指定時だけ返す。置き換えの経路は Phase 1 に tool が無く、内部 API `supersede()` のみ（test B で使用）。
- **context**: LLM を使わない決定論的な集計（README 参照）。

## 設計書と external-memory.md の食い違い・設計書に無く自分で決めた点

食い違い（external-memory.md を優先）:

- `memory_events`: memory-design.md §6 では「記憶の更新履歴」だが、external-memory.md の「event」（bantou が渡す原イベント）に合わせて原イベントの表にした。更新履歴は未実装。
- Agent ID: memory-design.md の `agents` + 認証済み Agent ID を、`X-Agent-Id`（session 名または設定の `agentId`）で確定。`agents` 行は初回の event で作る。
- 抽出 LLM / Graphiti / session 制御は external-memory.md のとおり（chatp 経由、Graphiti は Python サービス、制御は別設計）。

設計書に無く決めた点（レビューしてほしい）:

- 表は task 指定の 8 表のみ。organizations / memory_relations / memory_permissions / memory_promotions / agent_tasks は作っていない。`organization_id` 列も無い。
- `agent_messages` は表のみで書き込まない（event kind から §13 の messageType への対応が設計書に無いため）。
- `openQuestions` は「同 task_id の後続 `reply` が無い `report`」。report の ask / progress は event に区別が無く、区別していない（進捗報告も「未回答」に出る）。
- 重複判定は同 agent・同 type・正規化 content の完全一致のみ（意味的な重複・矛盾は未対応）。既存 inferred と同じ内容を利用者が新たに述べても「重複」で却下され、confirmed に昇格しない。昇格は revise / confirm（Phase 2 以降）で扱う想定。
- 矛盾の検出・`valid_until` の自動設定は無い。
- event の入力に `agentId` は持たせない（認証済みヘッダから確定）。
- `confidence` は Phase 1 では常に null。

## テスト結果

- `npm test`: 33 pass / 0 fail（unit 21 = 認証 6 + その他 15、統合 12。内訳は下）。
- `npm run typecheck`: 通過。
- 統合は docker 無し（`docker ps`: docker.sock 無し、DOCKER_HOST 未設定）のため **PGlite 0.5.16 + `@electric-sql/pglite-pgvector`**（WASM の本物の PostgreSQL + pgvector）。migration の SQL をそのまま流し、非 superuser role（`memory_app`）に `SET ROLE` して RLS を効かせている。**実 PostgreSQL（docker）では未実行**。
  - A 過去の指示の再現 / B 決定の履歴 / D 推測と確定の分離 / H 検索の根拠
  - event の冪等（outbox も 1 件）と入力検証
  - 検証規則（出典なし・存在しない出典・他 agent の event 盗用・重複の却下）
  - 抽出の失敗時再試行・処理済みの非再処理
  - agent 分離（recall / explain / context / RLS の SELECT・INSERT）
  - 埋め込みと recall の整合（未埋め込みは出ない、近い順、別 model は出ない、次元不一致は拒否）
  - SQL 断片を含む入力の保存・検索
  - context（方針 / 決定 / 未回答の質問 / 進行中 task）
- 実サーバーの smoke（`nuxt build` → `node bin/memory.mjs`、port 17931、DB 無し）: token 無し・不正 token・X-Agent-Id 無しが 401、正しい認証で `tools/list` が 4 tool を返し、`event` 呼び出しが X-Agent-Id を受けて DB 未設定のエラーまで進む。停止後に port 解放・log に token が無いことを確認。
- 未検証: §17 の C（時系列の整合性）/ E（Agent 分離の一部は実施）/ F / G は Phase 1 の範囲外。実 Ollama・実 chatp は未接続（fake / `node:http` の fake server のみ）。

## 残課題

- 実 PostgreSQL（pgvector/pgvector:pg17）で `npm run migrate` と統合 test を回す。
- DB role の GRANT（README の SELECT/INSERT/UPDATE のみ）が全 tool で足りるかは実 PostgreSQL で未確認（test の role は ALL を付与）。
- bun.lock: root は bun workspace（`packages/*`）で、`packages/memory` は既存の glob に入るため workspace 設定の変更は不要。bun が host に無く `npm install --no-package-lock` で入れたので bun.lock は更新していない。bun 環境で `bun install` すると bun.lock に memory の依存が入るはず（commit 対象かは cap の判断）。
- `nuxt.config.ts` の `scheduledTasks`（毎分）が Nitro の node-server preset で実際に起動することは未確認（task 本体は test 済みだが、スケジューラの起動は未検証）。
- 抽出 prompt の品質（実 chatp / claude -p での候補の質）は未評価。
- Ollama の embedding model の日本語品質（external-memory.md の要確認項目）は未評価。
- 作業中に誤って `/tmp/x`（空ファイル）を作った。権限で削除できず残っている（空、無害）。
