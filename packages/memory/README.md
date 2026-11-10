# bantou-memory（packages/memory）

bantou の外部記憶。横断 PM（master-cap）と remote-cap 向けの Persistent Memory を、MCP server（Streamable HTTP, `/mcp`）として提供する。設計は `docs/design/external-memory.md`（接続）と `docs/design/memory-design.md`（原文。Python / FastAPI の記述は TypeScript / Nuxt に読み替える）。

Phase 1 の範囲: event の保存、LLM（chatp）による記憶候補の抽出と検証、埋め込み（Ollama）、recall / context / explain。Graphiti は Outbox に積むだけ（反映は Phase 2）。

## 構成

- Nuxt 4 + `@nuxtjs/mcp-toolkit`（0.24 系）。UI なし（Nitro のみ）。
- PostgreSQL + pgvector（System of Record、event、Outbox、埋め込み）。
- 抽出 LLM: OpenAI 互換 endpoint（`unagents/chatp`、`POST /v1/chat/completions`、`response_format: json_schema`）。
- 埋め込み: Ollama（`POST /api/embed`）。

## MCP tool

認証済み agent（`X-Agent-Id`）の記憶だけを扱う。入力は zod で検証する。

| tool | 入力 | 出力 |
|---|---|---|
| `event` | `eventId`（冪等キー）、`sender` / `recipient`（`session` / `capId` / `workerId`）、`remoteId?`、`taskId?`、`kind`（`user_prompt` / `assistant_message` / `task` / `result` / `report` / `reply`）、`body`（≤ 65536）、`at`（ISO 8601） | `{ status: "recorded" \| "duplicate", eventId }`。同じ `eventId` の再送は `duplicate`（無視） |
| `recall` | `query`、`memoryTypes?`、`scope?`（`projectIds` / `agentIds` / `userId`）、`temporal?`（`validAt` / `from` / `to`）、`includeInferred?`、`limit?`（≤ 50、既定 10） | `[{ id, content, memoryType, status, sourceEventIds, validFrom?, validUntil?, confidence?, relevance }]` |
| `context` | `agentId?`（自分のみ） | `{ agentId, policies, recentDecisions, openQuestions, activeTasks }` |
| `explain` | `id` | `{ item, sources: [event…], verification }` |

recall の規則:

- 既定は `confirmed` / `verified` のみ。`includeInferred: true` で `inferred` も返す。
- `superseded` は `temporal` を指定した時だけ返す（過去時点の状態を引くため）。
- `scope.agentIds` に自分以外を入れると拒否。他 agent の private は、SQL の条件と PostgreSQL の Row Level Security の両方で読めない。
- 近傍検索は cosine（`1 - (embedding <=> query)` が `relevance`）。現在の embedding model で埋め込み済みの item だけが対象。

context は LLM を使わず保存済みの情報から作る: `policies` = confirmed の semantic / procedural、`recentDecisions` = confirmed の episodic、`openQuestions` = 同じ task_id の後続 reply が無い `report`、`activeTasks` = 同じ task_id の後続 `result` が無い `task`（report の ask / progress は区別しない）。

## 記憶の確定 / 推測の規則

抽出 worker（Nitro task `memory:extract`、毎分）が、agent ごとに未処理 event をまとめて chatp に送り、候補（`memoryType` / `content` / `status` / `sourceEventIds` / `validFrom`）を受ける。候補は次の検証を通ったものだけ `memory_items` に入る。却下は `memory_candidates` に理由付きで残る。

- 出典 event が全て、その agent の event として存在する（無ければ `source_not_found`、空なら `no_source`）。
- 同 agent・同 type・正規化した content が既存 item と重複しない（`duplicate`）。
- `confirmed` にできるのは、出典に `kind=user_prompt` の event を 1 件以上持つ候補だけ。LLM が `confirmed` と言っても、出典に user_prompt が無ければ `inferred` に落とす（`memory_candidates.reason = downgraded_no_user_source`）。
- LLM 呼び出しが失敗した event は未処理のまま残り、次回再試行される。

## DB スキーマと migration

`migrations/001_init.sql`: agents / projects / memory_items / memory_sources / memory_events / memory_candidates / outbox_events / agent_messages（設計書 §6 の最小。organizations / memory_relations / memory_permissions / memory_promotions / agent_tasks は Phase 5 以降）。`agent_messages` は表のみで、Phase 1 では書き込まない。

- 埋め込み列は `vector(768)` + HNSW（`vector_cosine_ops`）。
- 各表に Row Level Security（`FORCE`）。各 transaction で `set_config('app.agent_id', <認証済み agent>, true)` を設定する。
- SQL は全てパラメータ化（値を文字列連結で埋めない）。`test/unit.test.ts` が `server/` の `query()` に `${}` / 連結が無いことを検査する。

### migration に node-pg-migrate を選んだ理由

pgvector の列型（`vector(768)`）、HNSW index、`CREATE EXTENSION`、RLS の `FORCE` と policy は、どのツールでも素の SQL で書く必要がある。drizzle なら TS の型が付くのは表・列の定義だけで、ここでは query を手書きの SQL（パラメータ化）で書くため、型の利点は小さい。node-pg-migrate は `-- Up Migration` / `-- Down Migration` 区切りの `.sql` をそのまま実行する（v9 のソースで確認）ので、SQL をそのままレビューでき、テストも同じ SQL を PGlite に流せる。

### 埋め込みの次元

次元は migration の `vector(N)` で固定し、環境変数 `MEMORY_EMBED_DIM`（既定 768 = nomic-embed-text）で server に伝える。起動時（最初の呼び出し時）に `memory_items.embedding` の次元と一致するか検査し、違えば止まる。embedder が違う次元を返した場合も検査で拒否する。model を変えて次元が変わる時は、新しい migration（列の作り直し）と `MEMORY_EMBED_DIM` の変更が必要。次元が同じ別 model に変えた場合は、`embed_model` が違う item は recall の対象外になり、`memory:extract` が再埋め込みする。初回問い合わせで次元を決める方式は採らなかった（migration と実行時の食い違いを隠すため）。

## 環境変数

| 名前 | 既定 | 意味 |
|---|---|---|
| `MEMORY_TOKEN` | なし（必須） | Bearer token。空なら全 request を 401 にする。log に出さない |
| `MEMORY_PORT` | 7930 | listen port（`bin/memory.mjs` が `NITRO_PORT` にする） |
| `MEMORY_DATABASE_URL` | なし（必須） | PostgreSQL。**非 superuser role で接続する**（superuser は RLS を無視する） |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama |
| `MEMORY_EMBED_MODEL` | `nomic-embed-text` | 埋め込み model |
| `MEMORY_EMBED_DIM` | 768 | model の次元（migration の `vector(N)` と一致させる） |
| `CHATP_URL` | なし | chatp の base URL（`/v1/chat/completions` を付けて呼ぶ） |
| `CHATP_TOKEN` | なし | chatp の Bearer token |
| `CHATP_MODEL` | `claude` | chat の model 名 |
| `MEMORY_EXTRACT_BATCH` | 50 | 1 回の抽出に渡す event 数の上限 |
| `MEMORY_HTTP_TIMEOUT_MS` | 120000 | chatp / Ollama の timeout |

認証: `Authorization: Bearer <MEMORY_TOKEN>`（定数時間比較）と `X-Agent-Id`（必須。`[\w.@:-]{1,128}`）。どちらかが無い・不正なら 401（理由は返さない）。

## 起動

設置の手順は `deploy/`（202 用の docker compose と systemd user unit。設置は別作業）。

```sh
# 依存（repo root）
bun install            # bun が無ければ: npm install --no-package-lock -w packages/memory

# PostgreSQL / Ollama
cd packages/memory/deploy && cp env.example .env   # パスワードを埋める
docker compose up -d
docker compose exec ollama ollama pull nomic-embed-text

# DB role（owner で一度だけ）。memory_app は非 superuser、DELETE 権限なし
#   CREATE ROLE memory_app LOGIN PASSWORD '…';
#   GRANT USAGE ON SCHEMA public TO memory_app;
#   （migration 後）GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO memory_app;
#   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memory_app;

# migration（owner の接続で）
cd packages/memory
DATABASE_URL=postgres://memory_owner:…@127.0.0.1:5433/memory npm run migrate -- up

# build と起動
npm run build
MEMORY_TOKEN=… MEMORY_DATABASE_URL=… CHATP_URL=… node bin/memory.mjs   # 通常は systemd user unit
```

bantou 側は center の「外部記憶設定」に `http://<host>:7930/mcp` と token を登録する。

## テスト

```sh
cd packages/memory
npm test            # unit + 統合
npm run typecheck
```

- unit: 認証（token 無し / 不正 / X-Agent-Id 無し）、検証規則（confirmed → inferred の降格など）、入力検証、chatp / Ollama client（`node:http` の fake server）、SQL パラメータ化の検査。
- 統合（設計書 §17 の A / B / D / H ほか）: 同じ筋書き（`test/helpers/suite.ts`）を 2 つの PostgreSQL で回す。chatp と埋め込みは決定論的な fake。
  - `test/integration.pg.test.ts`: docker の実 PostgreSQL（`pgvector/pgvector:pg17`）。docker が使える host では `npm test` が自動で container（名前 `w-mem1-impl-pg-<pid>-<乱数>`）を起動し、migration を当て、非 superuser role（README の GRANT と同じ権限）で接続して回し、終了時に `docker rm -f -v` する。docker が使えなければ skip し、理由（例: `docker unavailable: … /var/run/docker.sock …`）を出力する。image は `MEMORY_TEST_PG_IMAGE` で変えられる。docker ありでの回し方: `docker info` が通る host で `cd packages/memory && npm test`（初回は image の pull に時間がかかる）。
  - `test/integration.test.ts`: PGlite（WASM の PostgreSQL + pgvector）。docker 不要。migration の SQL をそのまま流し、非 superuser role に `SET ROLE` して RLS を効かせる。docker が無い host でも統合の筋書きを確かめるために置いている。

## 既知の範囲外（Phase 2 以降）

Graphiti への反映（Outbox の消費）、revise / confirm / promote などの tool、shared / organizational の書き込み、agent_messages の書き込み、memory_items の `superseded` を作る経路（現状は内部 API `supersede()` のみ）。
