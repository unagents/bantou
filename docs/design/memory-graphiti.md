# 外部記憶への Graphiti / Neo4j の導入

`packages/memory` に、`memory-design.md` Phase 1 の「Neo4j 構築・Graphiti 接続・Graphiti 非同期反映」を入れる設計。
既決（`external-memory.md` 2026-11-11）: Graphiti は Python の公式 MCP server を 202 で常駐させ、TypeScript の memory が MCP client として呼ぶ。LLM は chatp（OpenAI 互換）、埋め込みは 202 の Ollama。本書はその入れ方で、既決は変えない。

状態: 実装は `feat/memory-graphiti`。動いている外部記憶には未適用（deploy していない）。

## 1. 現状

- 保存は PostgreSQL + pgvector と Ollama だけ。
- event は `server/utils/events.ts` が `outbox_events`（topic `graphiti.episode`）に積む。抽出（`server/utils/extract.ts`）が確定した記憶は topic `graphiti.memory_item` で積む。
- 積んだ行を受け取る側が無かった。11/20 時点で 1914 件が溜まっている。

## 2. 全体

```
bantou event ─▶ PostgreSQL（正本）─▶ outbox_events ─▶ task memory:graphiti ─▶ Graphiti MCP ─▶ Neo4j
                                                                                │  LLM = chatp / 埋め込み = Ollama
recall / context ◀── PostgreSQL の item（確定）＋ Graphiti の fact（inferred・出典付き）
```

## 3. Outbox の消費者

- 新しい task `memory:graphiti`（`server/tasks/memory/graphiti.ts`）。抽出・埋め込みと同じ毎分の起動で、別名の task なので互いを待たない。
- 中身は `server/utils/graphiti-sync.ts`。agent ごとに次を順に行う。
  1. 送信済みの行の確認: `get_episodes` で episode を name 突合し、見つかれば反映済み（`processed_at`）にして Graphiti が付けた uuid を `episode_uuid` に控える。
  2. 待ちの行の送信: id 順（= 記録の順）に `add_memory`。送信済み・未確認の行が 20 を超えないようにする（Graphiti の queue は in-memory で溢れさせない）。
- 状態は 3 つ: 待ち（`sent_at` / `processed_at` / `failed_at` が全て NULL）→ 送信済み（`sent_at`）→ 反映済み（`processed_at`）。
- 失敗: Graphiti が断った行は失敗回数を加算し、指数で間隔を空けて再試行、5 回で dead-letter（`failed_at`）。Graphiti に届かない時（接続失敗・timeout）は回数を加算せず run を止める（障害中に dead-letter を作らない。memory-design §2 の「Graphiti の障害で正式記録を失わない」）。
- `GRAPHITI_MCP_URL` が空なら何もしない。今まで通り積むだけ。
- PostgreSQL の変更は migration `003_graphiti_outbox.sql` のみ。列追加（`episode_uuid` / `sent_at` / `next_attempt_at` / `failed_at` / `last_error`、全て NULL 可・既定値なし）と index 2 つ。表の書き換えは無い。

## 4. Graphiti に渡す物

- 1 行 = 1 episode（`source: text`）。
  - item（`graphiti.memory_item`）: 本文 = item の content、`reference_time` = `valid_from`（無ければ作成時刻）。
  - event（`graphiti.episode`）: 本文 = `[kind] 送り元 -> 宛先` + body（4000 文字で切る）、`reference_time` = event の時刻。
- episode の `name` = `item:<id>` / `event:<id>`。突合の鍵はこの name（§9 の実測: `add_memory` の uuid 引数は「既存 episode の更新」で、新規には使えない）。
- `group_id` = agent ごと（`private-<agent を潰した slug>-<hash 8 桁>`）。Graphiti の `group_id` は英数字・`-`・`_` だけで、agent ID の `:` `.` `@` は通らない（実測で拒否された）ので潰して hash を付ける。`group_id` は検索の論理分割で、認可の仕組みとして扱わない（memory-design §6）。
- scope が `agent_private` でない item は反映せず dead-letter にする（shared / organizational の group は未決 5）。

## 5. Neo4j と PostgreSQL の役割

| | PostgreSQL | Neo4j（Graphiti） |
|---|---|---|
| 役割 | 正本（event・item・出典・status・Outbox・認可の元） | 関係・時間軸の検索用の派生物 |
| 失った時 | 復旧不能 | Outbox を「待ち」に戻して再投入すれば作り直せる（LLM の費用と時間がかかる） |
| status | `confirmed` / `inferred` を決める | 常に `inferred` 扱い（LLM が組み立てた物。確定は PostgreSQL の item だけ。memory-design §10） |

## 6. recall・context からの読み

- `server/utils/graphiti-recall.ts` の `graphSearch` を実装済み。`search_memory_facts` で fact を引き、fact の出典 episode の uuid を `outbox_events.episode_uuid` 経由で PostgreSQL の item / event に戻し、出典付き（`sourceItems` / `sourceEventIds`、item の現在の status）で返す。
- tool（recall / context）への接続は未決 4 に塞がれているので、まだ tool からは呼ばない。

## 7. 溜まった Outbox の反映

- 消費者は古い順に最大 20 件ずつ送る。1914 件は専用の経路を作らず、毎分の run が少しずつ消化する（Graphiti 側の処理速度が律速）。
- 速度・順序・上限は未決 3。1 件が LLM を数回呼ぶので、event（`graphiti.episode`）まで含めると負荷が大きい（未決 2）。

## 8. 置き場と compose

- 置き場: 外部記憶の host（202）。`packages/memory/deploy/compose.yaml` に `neo4j` と `graphiti-mcp` を足した。両方 `profiles: ["graphiti"]` で、profile を付けなければ今まで通り postgres と ollama だけが起動する。
- `neo4j`: `neo4j:5.26.0`、heap 512m〜1G・page cache 512m に上限（external-memory.md の「heap 1 GB / page cache 512 MB 程度」）、Bolt のみ `127.0.0.1` に公開（browser は出さない）、volume `memory-neo4j-data`。
- `graphiti-mcp`: 公式 image `zepai/knowledge-graph-mcp:1.1.3-graphiti-0.31.2-standalone`（tag 固定）。`network_mode: host` で `127.0.0.1` だけで待ち受ける（この server に認証が無い。chatp も 127.0.0.1:7920 だけなので、bridge の container からは届かない）。設定は `deploy/graphiti/config.yaml`（公式の `config-docker-neo4j.yaml` から、LLM と埋め込みの先を別の環境変数にし、埋め込みを 768 次元にした）。
- `.env`（`env.example`）: `MEMORY_NEO4J_PASSWORD` を埋める。`memory.env`（`memory.env.example`）: `GRAPHITI_MCP_URL`（例 `http://127.0.0.1:7931/mcp/`）を入れた時に消費者が動く。
- 起動: `docker compose --profile graphiti up -d neo4j graphiti-mcp`。本番への適用（migration 003・`.env`・起動・bantou-memory の再起動）は利用者の作業で、worker は行っていない。

## 9. 実測（使い捨ての Neo4j 5.26.0 と公式 MCP server 1.1.3、別名・別 port の container）

LLM と埋め込みは、本物の chatp・Ollama に触れないため、OpenAI 互換の偽 server（固定の語彙で entity と edge を返す）に向けた。したがって **fact の品質と LLM の速度は未測定**。測れたのは配線・突合・冪等・出典の戻し。

- event 2 件 + item 2 件（Alpha は PostgreSQL を使う → MySQL に変えた）を Outbox に積み、消費者を 1 回回すと 4 件が送信済み、時間を置いて 2 回目で 4 件が反映済み（`processed_at`・`episode_uuid` が入った）。
- `search_memory_facts` で「Alpha database」を引くと、fact が出典 item（PostgreSQL の id・status）と event の id 付きで戻った。
- 実測で分かった事（設計に反映済み）:
  - `group_id` に `:` を含むと `add_memory` の処理で拒否される。
  - `add_memory` の uuid 引数は新規 episode には使えず、episode の識別は name で行う。
  - 同じ name で `add_memory` を再送すると episode が 2 つできる（冪等ではない）。→ 未決 6。
  - 結果は `{ result: … }` に包まれて返る。
- 未測定: 本物の LLM での抽出品質・所要時間、chatp が `json_schema` を守るか、1914 件の消化時間。未決 1。

## 10. 未決

### 未決 1: Graphiti が使う LLM と埋め込みの先（実機で確かめられていない）

既決は chatp と Ollama。未決は、実際に使えるか。
- A（推奨）: chatp + Ollama のまま。chatp が `json_schema` を守らなければ `GRAPHITI_LLM_STRUCTURED_OUTPUT_MODE=json_object` に落とす（環境変数のみ）。利点: 既決どおり、API 費用なし。欠点: `claude -p` は 1 回が重く、1 episode が数回呼ぶので消化が遅い可能性。品質・速度は未測定。
- B: Graphiti だけ API の LLM（claude / OpenAI）を使う。利点: 速い。欠点: 既決（API は使わない）と違う。
- 推奨 A。動いている chatp に触れずには測れないので、適用時に少量で測る。

### 未決 2: 反映する topic

- A（推奨）: item（`graphiti.memory_item`）のみ。利点: 抽出で確定した少数の記憶だけで LLM の負荷が小さい。欠点: item にならなかった event は Graphiti に入らない。
- B: item + event。利点: 関係を原文からも作れる。欠点: 1914 件の大半が event で、負荷が桁違い。
- C: event のみ。利点・欠点は B に近く、抽出と二重。
- 暫定は A（`GRAPHITI_TOPICS`）。他の topic の行は触らず待ちのまま残る。

### 未決 3: 溜まった Outbox の流し方

- A（推奨）: 古い順に、送信済み未確認 20 件の枠で毎分消化（実装済み）。利点: 記録の順に時間軸が組まれる。欠点: 終わるまで日数がかかりうる。
- B: 新しい方から。利点: 最近の記憶が早く引ける。欠点: 時間軸の更新（invalid_at）が前後する。
- C: 件数や期間で打ち切り、古い分は捨てる。欠点: 反映しない物が残る。

### 未決 4: recall / context への接続

- A（推奨）: 既存 recall の結果に Graphiti の fact を `origin: graphiti` / `status: inferred` で足す。利点: tool が増えず、agent が使い分けなくてよい。欠点: recall が Graphiti の遅さ・障害の影響を受ける（timeout で PostgreSQL だけに落とす必要）。
- B: 別 tool（例 `graph_recall`）。利点: 影響が分離。欠点: tool 名と `system-instructions` の追加が要る。
- C: context だけに足す。
- これが決まるまで tool には出さない（`graphSearch` は実装・test 済み）。

### 未決 5: shared / organizational の group_id

- 今は `agent_private` だけ反映し、他の scope は dead-letter。昇格（memory-design §6）の後に別 group へ入れるか、agent ごとの group に残すかが未決。
- A: scope ごとに group を分ける。B: 検索時に複数 group を引く。推奨は設計 §6 の確定を待つ。

### 未決 6: 再送の重複

- `add_memory` は同じ name で重複する（実測）。送信済みのまま 30 分確認できない行は今「待ち」に戻して再送するので、Graphiti の処理が遅いだけの時に重複が出うる。
- A（推奨）: 再送の前に name で episode を確認し、あれば反映済みにする（確認は毎回行っているので、確認後の再送だけが重複しうる。待ち時間を長くする）。B: 再送せず手動で扱う。C: 重複を許容し fact の重複は Graphiti の統合に任せる。

### 未決 7: 本番への適用

- migration 003 の適用、`.env` の `MEMORY_NEO4J_PASSWORD`、`--profile graphiti` の起動、`memory.env` の `GRAPHITI_MCP_URL`、bantou-memory の再起動。利用者が時期を決める（worker は deploy しない）。

## 11. test

- `packages/memory/test/graphiti.test.ts`（fake の Graphiti client で、消費者の状態遷移・失敗・dead-letter・再送・agent 分離、recall の出典戻し、task の配線）。
- `packages/memory/test/e2e/graphiti-live.ts`: 本物の Graphiti に対する手動確認用（`npm test` には含まれない）。
