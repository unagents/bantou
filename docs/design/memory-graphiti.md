# 外部記憶への Graphiti / Neo4j の導入

`packages/memory` に、`memory-design.md` Phase 1 の「Neo4j 構築・Graphiti 接続・Graphiti 非同期反映」を入れる設計。
既決（`external-memory.md` 2026-11-11）: Graphiti は Python の公式 MCP server を 202 で常駐させ、TypeScript の memory が MCP client として呼ぶ。LLM は chatp（OpenAI 互換）、埋め込みは 202 の Ollama。本書はその入れ方で、既決は変えない。

状態: 実装は `feat/memory-graphiti`。動いている外部記憶には未適用（deploy していない）。

## 1. 現状

- 保存は PostgreSQL + pgvector と Ollama だけ。
- event は `server/utils/events.ts` が `outbox_events`（topic `graphiti.episode`）に積む。抽出（`server/utils/extract.ts`）が確定した記憶は topic `graphiti.memory_item` で積む。
- 設計の根拠: `memory-design.md` §15 の Phase 1（582-591 行。Neo4j 構築・Graphiti 接続）と Phase 2（593-601 行。Graphiti 非同期反映・Transactional Outbox）。本書は両方を 1 つの変更として入れる。
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
  2. 待ちの行の送信: id 順（= 記録の順）に `add_memory`。送信済み・未確認の行が上限（暫定 20。`GRAPHITI_IN_FLIGHT`。未決 3）を超えないようにする（Graphiti の queue は in-memory で溢れさせない）。
- 状態は 3 つ: 待ち（`sent_at` / `processed_at` / `failed_at` が全て NULL）→ 送信済み（`sent_at`）→ 反映済み（`processed_at`）。
- 失敗: Graphiti が断った行は失敗回数を加算し、間隔を空けて再試行し、上限で dead-letter（`failed_at`）にする。間隔・上限（暫定 5 回。`GRAPHITI_MAX_ATTEMPTS`）は未決 7。Graphiti に届かない時（接続失敗・timeout）は回数を加算せず run を止める（障害中に dead-letter を作らない。memory-design §3.1 の原則 8「Graphiti の障害が発生しても、正式イベントの記録を失わない」）。
- 送信済みの確認（`get_episodes`）が Graphiti に断られた時の扱いは未決 8（決まるまでは §10 に書いた挙動）。
- `GRAPHITI_MCP_URL` が空なら何もしない。今まで通り積むだけ。
- PostgreSQL の変更は migration `003_graphiti_outbox.sql` のみ。列追加（`episode_uuid` / `sent_at` / `next_attempt_at` / `failed_at` / `last_error`、全て NULL 可・既定値なし）と index 2 つ。表の書き換えは無い。

## 4. Graphiti に渡す物

- 1 行 = 1 episode（`source: text`）。
  - item（`graphiti.memory_item`）: 本文 = item の content、`reference_time` = `valid_from`（無ければ作成時刻）。
  - event（`graphiti.episode`）: 本文 = `[kind] 送り元 -> 宛先` + body（暫定 4000 文字で切る。`GRAPHITI_BODY_MAX`。未決 9）、`reference_time` = event の時刻。
- episode の `name` = `item:<id>` / `event:<id>`。突合の鍵はこの name（§9 の実測: `add_memory` の uuid 引数は「既存 episode の更新」で、新規には使えない）。
- `group_id` = agent ごと（`private-<agent を潰した slug>-<hash 8 桁>`）。Graphiti の `group_id` は英数字・`-`・`_` だけで、agent ID の `:` `.` `@` は通らない（実測で拒否された）ので潰して hash を付ける。`group_id` は検索の論理分割で、認可の仕組みとして扱わない（memory-design §5.4）。
- scope が `agent_private` でない item は、暫定で反映せず dead-letter にする（利用者が決めた挙動ではない。未決 5）。

## 5. Neo4j と PostgreSQL の役割

| | PostgreSQL | Neo4j（Graphiti） |
|---|---|---|
| 役割 | 正本（event・item・出典・status・Outbox・認可の元。データモデルは memory-design §6） | 関係・時間軸の検索用の派生物（memory-design §3.1 の原則 2・3） |
| 失った時 | 復旧不能 | Outbox を「待ち」に戻して再投入すれば作り直せる（LLM の費用と時間がかかる） |
| status | `confirmed` / `inferred` を決める（状態の定義は memory-design §6.2） | 常に `inferred` 扱い（LLM が組み立てた物。「Graphiti の検索結果だけで正式な意思決定を確定してはならない」は memory-design §10 の 483 行） |

## 6. recall・context からの読み

- `server/utils/graphiti-recall.ts` の `graphSearch` を実装済み。`search_memory_facts` で fact を引き、fact の出典 episode の uuid を `outbox_events.episode_uuid` 経由で PostgreSQL の item / event に戻し、出典付き（`sourceItems` / `sourceEventIds`、item の現在の status）で返す。
- tool（recall / context）への接続は未決 4 に塞がれているので、まだ tool からは呼ばない。

## 7. 溜まった Outbox の反映

- 暫定の挙動: 消費者は古い順に、送信済み未確認が上限（暫定 20）に収まる範囲で送る。1914 件は専用の経路を作らず、毎分の run が少しずつ消化する（Graphiti 側の処理速度が律速）。
- 速度・順序・上限は未決 3。1 件が LLM を数回呼ぶので、event（`graphiti.episode`）まで含めると負荷が大きい（未決 2）。

## 8. 置き場と compose

- 置き場: 外部記憶の host（202。`external-memory.md` の既決）。`packages/memory/deploy/compose.yaml` に `neo4j` と `graphiti-mcp` を足した。両方 `profiles: ["graphiti"]` で、profile を付けなければ今まで通り postgres と ollama だけが起動する。graphiti の service は必須変数（`:?`）を使わない（`MEMORY_NEO4J_PASSWORD` 無しでも profile 無しの `docker compose config / up` が従来どおり通る。実測は §9）。
- 以下の値は暫定で、利用者が決めていない（未決 10）: image tag 固定、`network_mode: host`、MCP の port 7931、Neo4j の heap / page cache、`SEMAPHORE_LIMIT`（暫定 2。未決 1）。
- `neo4j`: `neo4j:5.26.0`、heap 512m〜1G・page cache 512m に上限（external-memory.md の「heap 1 GB / page cache 512 MB 程度」）、Bolt のみ `127.0.0.1` に公開（browser は出さない）、volume `memory-neo4j-data`。
- `graphiti-mcp`: 公式 image `zepai/knowledge-graph-mcp:1.1.3-graphiti-0.31.2-standalone`（tag 固定）。`network_mode: host` で `127.0.0.1` だけで待ち受ける（この server に認証が無い。chatp も 127.0.0.1:7920 だけなので、bridge の container からは届かない）。設定は `deploy/graphiti/config.yaml`（公式の `config-docker-neo4j.yaml` から、LLM と埋め込みの先を別の環境変数にし、埋め込みを 768 次元にした）。
- `.env`（`env.example`）: `MEMORY_NEO4J_PASSWORD` を埋める（必須の検査は起動手順で行う。下記）。`memory.env`（`memory.env.example`）: `GRAPHITI_MCP_URL`（例 `http://127.0.0.1:7931/mcp/`）を入れた時に消費者が動く。
- 起動手順: (1) `.env` の `MEMORY_NEO4J_PASSWORD` が空でない事を確かめる（空のまま起動しない。空の時に Neo4j がどう振る舞うかは確かめていない）。(2) `docker compose --profile graphiti up -d neo4j graphiti-mcp`。本番への適用（migration 003・`.env`・起動・bantou-memory の再起動）は利用者の作業で、worker は行っていない。

## 9. 実測（使い捨ての Neo4j 5.26.0 と公式 MCP server 1.1.3、別名・別 port の container）

LLM と埋め込みは、本物の chatp・Ollama に触れないため、OpenAI 互換の偽 server（固定の語彙で entity と edge を返す）に向けた。したがって **fact の品質と LLM の速度は未測定**。測れたのは配線・突合・冪等・出典の戻し。

- event 2 件 + item 2 件（Alpha は PostgreSQL を使う → MySQL に変えた）を Outbox に積み、消費者を 1 回回すと 4 件が送信済み、時間を置いて 2 回目で 4 件が反映済み（`processed_at`・`episode_uuid` が入った）。
- `search_memory_facts` で「Alpha database」を引くと、fact が出典 item（PostgreSQL の id・status）と event の id 付きで戻った。
- 実測で分かった事（設計に反映済み）:
  - `group_id` に `:` を含むと `add_memory` の処理で拒否される。
  - `add_memory` の uuid 引数は新規 episode には使えず、episode の識別は name で行う。
  - 同じ name で `add_memory` を再送すると episode が 2 つできる（冪等ではない）。→ 未決 6。
  - 結果は `{ result: … }` に包まれて返る。
- compose の config（up はしない）: `MEMORY_NEO4J_PASSWORD` 無しで `docker compose -f compose.yaml config --services` は `ollama` / `postgres` を返す。`--profile graphiti` を付けると `neo4j` / `graphiti-mcp` も返る（`MEMORY_PG_OWNER_PASSWORD` は従来どおり必須のため、測定では仮の値を環境変数で渡した）。
- 未測定: 本物の LLM での抽出品質・所要時間、chatp が `json_schema` を守るか、1914 件の消化時間。未決 1。

## 10. 未決

### 未決 1: Graphiti が使う LLM と埋め込みの先（実機で確かめられていない）

既決は chatp と Ollama。未決は、実際に使えるか。
- A（推奨）: chatp + Ollama のまま。chatp が `json_schema` を守らなければ `GRAPHITI_LLM_STRUCTURED_OUTPUT_MODE=json_object` に落とす（環境変数のみ）。利点: 既決どおり、API 費用なし。欠点: `claude -p` は 1 回が重く、1 episode が数回呼ぶので消化が遅い可能性。品質・速度は未測定。
- B: Graphiti だけ API の LLM（claude / OpenAI）を使う。利点: 速い。欠点: 既決（API は使わない）と違う。
- 推奨 A。動いている chatp に触れずには測れないので、適用時に少量で測る。
- 同じ未決に含む暫定値: Graphiti の同時処理数 `SEMAPHORE_LIMIT`（暫定 2。`GRAPHITI_SEMAPHORE_LIMIT`）。小さいと遅いが chatp を占有しない、大きいと速いが chatp（`claude -p`）に負荷をかける。推奨は暫定 2 のまま、適用時の実測で決める。

### 未決 2: 反映する topic

- A（推奨）: item（`graphiti.memory_item`）のみ。利点: 抽出で確定した少数の記憶だけで LLM の負荷が小さい。欠点: item にならなかった event は Graphiti に入らない。
- B: item + event。利点: 関係を原文からも作れる。欠点: 1914 件の大半が event で、負荷が桁違い。
- C: event のみ。利点・欠点は B に近く、抽出と二重。
- 暫定は A（`GRAPHITI_TOPICS`）。他の topic の行は触らず待ちのまま残る。

### 未決 3: 溜まった Outbox の流し方

- A（推奨）: 古い順に、送信済み未確認の枠で毎分消化（暫定の実装。枠は暫定 20、`GRAPHITI_IN_FLIGHT`）。利点: 記録の順に時間軸が組まれる。欠点: 終わるまで日数がかかりうる。
- B: 新しい方から。利点: 最近の記憶が早く引ける。欠点: 時間軸の更新（invalid_at）が前後する。
- C: 件数や期間で打ち切り、古い分は捨てる。欠点: 反映しない物が残る。

### 未決 4: recall / context への接続

- A（推奨）: 既存 recall の結果に Graphiti の fact を `origin: graphiti` / `status: inferred` で足す。利点: tool が増えず、agent が使い分けなくてよい。欠点: recall が Graphiti の遅さ・障害の影響を受ける（timeout で PostgreSQL だけに落とす必要）。
- B: 別 tool（例 `graph_recall`）。利点: 影響が分離。欠点: tool 名と `system-instructions` の追加が要る。
- C: context だけに足す。
- これが決まるまで tool には出さない（`graphSearch` は実装・test 済み）。

### 未決 5: shared / organizational の group_id と、scope が agent_private でない item の扱い

- 現状（暫定・利用者が決めていない）: `agent_private` 以外の item は反映せず dead-letter（`failed_at`、`last_error` に scope）にする。後で反映する時は `failed_at` を手作業で戻す必要がある。
- memory-design §7.1 の group 例は `shared:user-context` のように `:` を含むが、Graphiti は `:` を拒否する（§9 の実測）。group 名の形式を変える必要がある。
- A（推奨）: scope ごとに別の group にする（shared は `shared-<共有領域>`、organizational は `organization-<組織 ID>`、private は今の `private-…`）。昇格（memory-design §11）で作られた shared の item だけを shared の group に `add_memory` し、private 側の episode はそのまま残す。利点: 認可で見せる範囲と group が 1 対 1 になり、検索時の group の指定で絞れる（memory-design §5.4 のとおり、認可は group に頼らず PostgreSQL の RLS で行う）。欠点: 昇格が実装されるまで shared の group は空。昇格のたびに episode が増える。
- B: 全 scope を agent の group に入れ、scope は episode の `source_description` に書くだけにする。利点: 簡単。欠点: shared を他の agent が引く経路が無く、Graphiti 側で scope を分けられない。
- C: scope が agent_private でない item は、今のまま dead-letter にする（昇格の実装まで何も反映しない）。利点: 誤って共有しない。欠点: 昇格後の反映を手作業で戻す。
- 推奨 A。ただし、昇格（memory-design §11）の実装が決まるまでは C のまま。

### 未決 6: 再送の重複と確認待ちの時間

- `add_memory` は同じ name で重複する（§9 の実測）。送信済みのまま一定時間（暫定 30 分。`GRAPHITI_CONFIRM_TIMEOUT_MIN`）確認できない行は「待ち」に戻して再送するので、Graphiti の処理が遅いだけの時に重複が出うる。
- A（推奨）: 再送の前にもう一度 name で episode を確認し、あれば反映済みにする。確認待ちの時間は、消化の実測（未決 1）の後に決める。利点: 重複が出にくい。欠点: 確認の呼び出しが増える。
- B: 再送せず、確認できない行は dead-letter にして手動で扱う。利点: 重複が絶対に出ない。欠点: 一時的な遅れでも手作業になる。
- C: 重複を許容し、fact の重複は Graphiti の統合に任せる。利点: 実装が簡単。欠点: episode が増え、出典の戻し（recall）が重複する。

### 未決 7: 失敗の上限・間隔・dead-letter の扱い

- 現状（暫定）: Graphiti が断った行は、失敗回数を加算して間隔（60 秒 × 2 のべき乗、上限 1 時間）を空けて再試行し、暫定 5 回（`GRAPHITI_MAX_ATTEMPTS`）で dead-letter にする。dead-letter の行を戻す手順は無い。
- A（推奨）: 上限は暫定のまま、dead-letter の件数を log に出し、戻す手順（`failed_at` / `attempts` の初期化）を運用手順に書く。利点: 実装が小さい。欠点: 手作業。
- B: dead-letter にせず、間隔の上限で永遠に再試行する。利点: 手作業が無い。欠点: 直らない行が毎回 Graphiti を叩く。
- C: dead-letter の戻しを MCP tool / コマンドにする。利点: 運用が楽。欠点: 追加の仕様（利用者が決めていない）。

### 未決 8: 確認（get_episodes）が Graphiti に断られた時

- 現状（暫定）: 送信済みの行の確認で `get_episodes` が断られる（`GraphitiRejectedError`。例: group が不正）と、その agent の run はそこで失敗し、待ちの行の送信も行われない。毎分同じ失敗を繰り返し、他の agent は続ける。失敗回数は加算せず、dead-letter にもならない。log（`memory: graphiti error`）は同じ要旨なら初回と復旧の時だけで、毎分は出ない（実装: `graphiti-task.ts`）。
- A（推奨）: 現状のままにして log で気づく。利点: 実装が増えない。欠点: その agent の反映が止まり続ける。
- B: 確認が断られた行を失敗として加算し、dead-letter にする。利点: 止まり続けない。欠点: 一時的な Graphiti 側の不具合で dead-letter が作られる。
- C: 確認が断られても待ちの行の送信は続ける。利点: 止まらない。欠点: 確認できない間に送信が積み上がる。

### 未決 9: episode に入れる内容の上限

- 暫定は event の body を 4000 文字で切る（`GRAPHITI_BODY_MAX`。抽出の入力上限に合わせた値で、Graphiti の都合ではない）。item は切らない。
- A（推奨）: 暫定のまま。利点: LLM の入力が有界。欠点: 長い event は後半が反映されない。
- B: 切らない。利点: 欠落が無い。欠点: 1 episode の LLM 負荷が不定。
- C: 長い event は分割して複数の episode にする。利点: 欠落が無く有界。欠点: 実装が増え、name の規則が変わる。

### 未決 10: 配置の値（port・network・image・Neo4j の上限）

- 現状（暫定・利用者が決めていない）: MCP の port 7931（`GRAPHITI_MCP_PORT`）、`network_mode: host`、image tag 固定（`1.1.3-graphiti-0.31.2-standalone`）、Neo4j の heap 512m〜1G・page cache 512m（`external-memory.md` の「1 GB / 512 MB 程度」に合わせた）。
- network: A（推奨）host network で 127.0.0.1 のみ。利点: chatp（127.0.0.1:7920 のみ）に届く。欠点: container の隔離が弱い。B: bridge にして chatp を LAN で待ち受けさせる。欠点: chatp の設定変更が要る。
- image: A（推奨）tag 固定。利点: 挙動が変わらない。欠点: 更新は手作業。B: latest。欠点: 予告なく挙動が変わる。
- port と上限は、host の既存の port・RAM と照らして利用者が決める（推奨は暫定のまま）。

### 未決 11: 本番への適用

- migration 003 の適用、`.env` の `MEMORY_NEO4J_PASSWORD`、`--profile graphiti` の起動、`memory.env` の `GRAPHITI_MCP_URL`、bantou-memory の再起動。利用者が時期を決める（worker は deploy しない）。

## 11. test

- `packages/memory/test/graphiti.test.ts`（fake の Graphiti client で、消費者の状態遷移・失敗・dead-letter・再送・agent 分離、recall の出典戻し、task の配線）。
- `packages/memory/test/e2e/graphiti-live.ts`: 本物の Graphiti に対する手動確認用（`npm test` には含まれない）。
