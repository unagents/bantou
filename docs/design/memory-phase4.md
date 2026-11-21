# 外部記憶 Phase 4（記憶の自己整理）の設計

2026-11-21 起草。対象は `packages/memory`。設計だけを書き、code・DB・設定は変えていない。
元の仕様は `memory-design.md` §12・§15 Phase 4（`memory-design.md:508-522`、`:614-622`）。接続の決まりは `external-memory.md`。
根拠は `file:行` で示す。行番号は develop の `4bf3751` の時点。「推測」と書いた所は、一次情報や実測で確かめていない。

## 0. 前提と、確かめられなかった事

- Phase 4 は Graphiti / Neo4j がある前提で設計する。Graphiti が持つ働きは Graphiti に任せ、memory 側で同じ物を作らない（利用者の指示）。
- Graphiti 側の設計書（branch `feat/memory-graphiti` の `docs/design/memory-graphiti.md`）は、2026-11-21 の `git ls-remote origin` では見つからなかった。Graphiti との接点はすべて未決にする（U1〜U3）。
- 今の memory は Graphiti に何も送っていない。Outbox に積むだけである（`packages/memory/README.md:5`、`server/utils/events.ts:58`、`server/utils/extract.ts:398-401`）。
- 接続の形は決まっている。Graphiti の公式 MCP server を 202 で常駐させ、memory が MCP client として呼ぶ（`external-memory.md:78`）。
- Graphiti の働きは、公式の README（github.com/getzep/graphiti と同 `mcp_server/README.md`、2026-11-21 に閲覧）で次の事だけを確かめた。版の番号は README からは読めなかった。採用する版の実装での確認が要る（`memory-design.md:333`）。
  - 事実には有効期間がある。情報が変わると古い事実は消されずに無効化される（"Facts have validity windows. When information changes, old facts are invalidated — not deleted."）。
  - 抽出と重複の除去は LLM の構造化出力で行う。
  - MCP の tool は次のとおり。`add_memory`（episode の追加、`reference_time` 付き）、`search_memory_facts`（`valid_at` / `invalid_at` で絞れる）、`search_nodes`、`get_episode_entities`（episode から作られた entity と fact を辿る）、`get_episodes`、`delete_episode`、`delete_entity_edge`、`get_entity_edge`、`clear_graph`、`get_status`、`add_triplet`、`summarize_saga`、`build_communities`。
  - 次の 4 つは README に書かれていない。無効化に LLM を使うか、無効化が起きる条件、無効化した事実を検索が既定で除くか、`group_id` が Neo4j でどう分かれるか。
  - MCP server は認証を持たない（README の記述）。今の memory の MCP と同じく LAN / Tailscale の内側に限る（`external-memory.md:81`）。

## 1. 利用者が困っている事と、今の code での原因

### 1.1 古い決定が置き換わらない／推測を確定しても昇格しない

- 矛盾を検出していない。重複は「同 agent・同 type・正規化した本文の完全一致」だけで判定する（`server/utils/extract.ts:140-142`、`:367-370`、`README.md:40`、`:220`）。そのため「DB は MySQL」と「PostgreSQL に変更」は別の item になり、両方 `confirmed` で返る。
- `superseded` にする手段は内部 API の `supersede()` だけである（`server/utils/recall.ts:127-139`）。tool も自動の判定も無い（`README.md:221`）。test B もこの API を手で呼んでいる（`test/helpers/suite.ts:89-117`）。
- 既に `inferred` で入っている本文を利用者が述べても、重複の検索が status を区別しない（`extract.ts:367-370`）。そのため `decideCandidate` が `duplicate` で却下する（`extract.ts:182`、`README.md:223`）。

### 1.2 推測と古い途中経過が残り続ける

- 抽出の指示には「単なる進捗報告・一時的な情報は抽出しない」とある（`extract.ts:121`）。それでも LLM が抽出した物は、検証を通ればそのまま残る。検証は出典・形式・重複・確定の規則だけを見る（`extract.ts:166-196`）。
- 抽出の LLM には、新しい event だけを渡す。既存の記憶は渡さない（`extract.ts:127-138`）。そのため、既存の記憶を更新する物か、既存の記憶と同じ物かを LLM は判断できない。
- 記憶を古いと見なす処理、片付ける（archive）処理、推測を見直す処理が無い。`memory_items.status` に archive の値は無い（`migrations/001_init.sql:49`）。
- DB の role `memory_app` には DELETE の権限が無い（`README.md:170`）。片付けは行の削除ではなく、状態の変更で行う事になる。

### 1.3 context の未回答の欄に、終わった report が積まれる

- `openQuestions` は「`kind=report` で、同じ task_id の後に reply が無い物」の新しい順 10 件である。本文は全文を返す（`server/utils/recall.ts:175-181`、`:193`）。
- report の種別（progress / ask / approve / done）は event の列に無い。本文の先頭に `(<kind>) ` として入るだけである（center の `packages/center/src/memory.ts:119`、`packages/center/src/memory-events.ts:189-201`）。種別の定義は `packages/protocol/src/server.ts:712`。
- reply は ask / approve への返事として送る物である（`packages/center/src/tools.ts:269`、`:446` の説明文）。progress / done の report には reply が来ないので、ずっと「未回答」に残る。
- task_id の無い report は、条件 `r.task_id IS NOT NULL`（`recall.ts:178`）により、どの reply とも対応しない。そのため常に未回答になる。report の task_id は省略できる（`packages/protocol/src/server.ts:725`）。

## 2. Phase 4 の範囲

> **仕様から外す・縮める物（利用者の判断が要る）**
> 元の仕様の Phase 4（`memory-design.md:614-622`）には「Procedural Memory 生成」と「Shared Memory 昇格」がある。この設計では次のように扱う。
> - **Shared Memory 昇格**: U9 の推奨では Phase 5 に回す（Phase 4 から外す）。
> - **Procedural Memory 生成**: 候補（inferred）を作るまでに縮める（§4.6、U8）。
> これは推奨であって決定ではない。Phase 4 に残すかは利用者が U9（と U8）で決める。

元の仕様（`memory-design.md:510-522`、`:614-622`）の項目ごとに、今回の扱いを決める。

| 元の項目 | 今回の扱い | 1〜3 との関係 |
|---|---|---|
| 重複記憶の検出・記憶の統合 | 一部が範囲内。統合は `inferred` の item だけ（§4.5）。`confirmed` 同士は、今ある完全一致の検査（`extract.ts:367-370`）で弾くだけにする。言い換えの関係は §4.4 の置き換えで扱う | 2 |
| 古い情報の識別・新旧情報の関係付け | 範囲内（Graphiti の無効化を使う） | 1・2 |
| 推測情報の再評価 | 範囲内 | 1・2 |
| 不要な一時情報のアーカイブ | 範囲内 | 2 |
| 再利用可能な手順（Procedural）の抽出 | 候補を作るだけ（U8） | なし |
| Private から Shared への昇格候補の抽出 | 未決（U9）。表と権限は Phase 5 の物（`README.md:224`、`migrations/001_init.sql:2`） | なし |

1〜3 を解くには、Phase 2・3 の残りも要る。これらを Phase 4 の前段として含める。

- 矛盾の検出（Phase 2、`memory-design.md:597`、`:422`）。
- 置き換え（superseded）の自動化と変更履歴（`memory-design.md:281-283`、`README.md:221`）。
- Graphiti への反映、つまり Outbox の消費（Phase 2、`memory-design.md:598-599`、`README.md:224`）。
- context の未回答の区別（Phase 3 の Context Builder、`memory-design.md:609`）。

範囲外。

- confirm / revise / promote / archive の MCP tool（`memory-design.md:337-352`）。利用者が手で操作する入口になる。作るかどうかは U10 にする。
- shared / organizational の権限、`memory_promotions` の表（Phase 5）。
- bantou（center / server / protocol）の変更。ただし U5 の案 (a) を採ると center の変更が要る。

## 3. 守る規則（元の仕様から。新しい制約は足さない）

- R1: 正式な決定は、要約の処理だけで変えない。決定の変更は新しい event として記録し、古い決定は履歴として残す（`memory-design.md:281-283`）。
- R2: 整理は記憶の整理であって、意思決定の変更ではない。正式な決定、利用者の明示した指示、承認済みの方針を自動で変えない（`memory-design.md:520-522`）。
- R3: 正式な状態は PostgreSQL を優先する。Graphiti の検索結果だけで正式な決定を確定しない（`memory-design.md:481-483`）。
- R4: LLM が作った情報を、検証なしに正式な記憶にしない（`memory-design.md:576`）。`confirmed` は出典が全て user_prompt の時だけにする規則（`extract.ts:183-186`）を崩さない。
- R5: 変更の履歴と操作の監査を残す（`memory-design.md:569`、`:573`）。

R2 と「古い決定を置き換える（1.1）」はぶつかって見える。この設計では次のように読む。利用者の新しい発言（user_prompt）を出典とする confirmed の決定が、古い confirmed の決定を置き換えるのは、R1 の「決定の変更を新しい event として記録する」に当たる。整理の処理が自分の判断で決定を変える事ではない。ただし、何をもって「同じ事柄の新しい決定」と認めるかは U4 にする。

U5（未回答から外す条件）の推奨は、仕様に無い規則を足す案である。元の仕様には「report の種別で未回答を区別する」「result で質問を閉じる」の規則が無い。README の今の context の定義（`README.md:33`）も変えることになる。そのため U5 は利用者が決める。

## 4. 整理の仕組み

### 4.1 全体

処理は 3 つの時点で動く。

| 時点 | 処理 | 誰が |
|---|---|---|
| 問い合わせの時（context） | 未回答の判定（§4.2） | 決定論 |
| 抽出の時（`memory:extract`、毎分。`nuxt.config.ts:20`） | 推測の昇格（§4.3） | 決定論 |
| 定期の整理（新しい Nitro task。名前は仮に `memory:consolidate`。周期は U6） | ① Graphiti への反映 → ② 置き換え（§4.4） → ③ 推測の再評価と片付け（§4.5） → ④ 手順と昇格の候補（§4.6） | ①②は Graphiti と決定論の検査。③④は LLM と決定論の検査 |

順序の理由は次のとおり。② は ① で Graphiti が出した無効化を使う。③ は ② で置き換わった物を対象から除いてから動く（同じ物を二重に扱わない）。④ は整理し終えた記憶を元にする。

### 4.2 未回答の判定（問題 3。決定論）

- 未回答の候補を、種別が ask / approve の report に限る。種別の取り方は U5 で決める。
- その report は、次のどれかで閉じる（未回答から外す）。
  - 同じ task_id で、後に reply がある（今の条件、`recall.ts:178`）。
  - 同じ task_id で、後に result がある。task が終わった後の質問は未回答と見なさない。これを入れるかは U5 で一緒に決める。
- task_id の無い report の扱いは U5 で決める。
- 本文は全文のまま返す（今と同じ）。切り詰めや要約は、利用者が決めていない仕様になるので足さない。必要なら U5 の補足で扱う。
- DB の変更は無い（案 (b) の場合）。index `memory_events_task`（`001_init.sql:38`）がそのまま使える。

### 4.3 推測の昇格（問題 1 の後半。決定論）

- `applyCandidate`（`extract.ts:363-408`）の重複の検査で、一致した既存の item が `inferred`、新しい候補が検証の後も `confirmed`（出典が全て user_prompt）である場合を分ける。この場合は却下しない。
- やり方は U7 で決める。推奨は「新しい confirmed の item を作り、古い inferred を `superseded`（`superseded_by` = 新しい方）にする」こと。同じ transaction の中で、次の順に行う。
  1. 古い方の `status` だけを `superseded` に更新する。重複の unique index は `status <> 'superseded'` の部分 index なので（`001_init.sql:59`）、これで同じ本文の新しい item を入れられる。
  2. 新しい item を INSERT する。
  3. 古い方の `superseded_by` を、新しい item の id に更新する。`valid_until` も、今の `supersede()`（`recall.ts:131`）と同じくここで立てる。`superseded_by` は `memory_items(id)` への FK で（`001_init.sql:53`）、新しい item が無いうちは入れられない。そのため 1 と分けている。
  - 代わりの案として、FK を `DEFERRABLE INITIALLY DEFERRED` にする migration を足し、1 で `superseded_by` まで入れる方法もある。schema の変更が要るので推奨しない。
- `memory_candidates` には accepted として残す。`reason` に昇格の印を付ける。`decision` の CHECK は accepted / rejected だけなので（`001_init.sql:80`）、新しい値は足さない。
- 変更の履歴は §5 の表に残す（R5）。
- 本文が完全一致しない「言い換え」の確定は、ここでは扱わない。§4.4 の置き換え、または §4.5 の再評価に任せる。

### 4.4 置き換え（問題 1 の前半。Graphiti を使う）

1. ① Graphiti への反映。Outbox（`outbox_events`、`001_init.sql:88-98`）を消費し、Graphiti に `add_memory` で送る。冪等キーは `event_id`（`memory-design.md:331`）。何を episode にするかは U1 で決める（今の Outbox には event 用の `graphiti.episode` と item 用の `graphiti.memory_item` の 2 種類が積まれている。`events.ts:58-62`、`extract.ts:398-401`）。送り終えたら `processed_at` を立てる。失敗したら `attempts` を数える（列は既にある。`001_init.sql:95-96`）。
2. ② Graphiti が無効化した事実を取り、PostgreSQL の item と対応付ける。取り方は U2（`search_memory_facts` の `invalid_at` で取るか、`get_episode_entities` で出典から辿るか）。Graphiti の fact と memory の item との対応は U3。
3. 対応が付いた古い item について、次の検査を決定論で行う。全て通った物だけを、今の `supersede()`（`recall.ts:127-139`）と同じ更新で `superseded` にする。`valid_until` は新しい方の `valid_from`、それが無ければ現在時刻（`recall.ts:131`）。
   - 新旧が同じ agent に属する（今の条件と同じ）。
   - 新しい方の `valid_from`（無ければ出典 event の `at`）が、古い方より後である。test C の「取り違えない」に当たる。
   - 古い方が `confirmed` なら、新しい方も `confirmed`（出典が全て user_prompt）である。R2・R3 を守るため、推測で確定を置き換えない。
4. 検査を通らなかった対応（例: 古い方が confirmed で新しい方が inferred）は、変えずに「矛盾の候補」として §5 の表に記録する。利用者に見せる口は U10。
5. Graphiti が使えない間は ①② を飛ばし、PostgreSQL は変えない。Graphiti の障害で正式な記録は止めない（`memory-design.md:88`）。

Graphiti の無効化を使わない案（memory 側で、埋め込みの近傍と LLM で矛盾を判定する案）は U4 に並べた。利用者の前提「Graphiti の働きを重ねて作らない」により、推奨しない。

### 4.5 推測の再評価と片付け（問題 2。LLM + 決定論の検査）

- 対象は、`inferred` で、② で置き換わっておらず、片付け済みでない item。agent ごとにまとめる。
- LLM（今と同じ chatp。`external-memory.md:77`、`:79`）に、対象の item と、その後の item・event の要約を data として渡す。各 item について次のどれかを JSON で返させる。
  - 残す。
  - 片付ける（一時の途中経過・予定が後で変わった）。
  - 別の item と同じ（統合先の id）。
- LLM の答えは次の決定論の検査を通す（R4）。
  - 対象は `inferred` だけ。`confirmed` は LLM の答えでは変えない（R2）。
  - 統合先は同じ agent・同じ type の、見えている item に限る。
  - id は入力に存在する物に限る（今の出典の検査 `extract.ts:174-176` と同じ考え方）。
- この統合は、Graphiti の重複除去と重ならない。対象が違うためである。Graphiti の重複除去は、Graphiti の中の entity と fact に掛かる（Graphiti の README）。この統合が扱うのは、PostgreSQL の `memory_items` の行である。Graphiti で entity がまとまっても、`memory_items` の inferred の行は減らない。recall も context も `memory_items` から返す（`recall.ts:100-122`、`:166-174`）。
- 片付けの表し方（新しい status、列、`valid_until` のどれか）は U11。行は消さない（`memory_app` に DELETE が無い。`README.md:170`）。
- recall の既定から片付けた物を外すか、`temporal` 指定の時だけ返すかも U11 で決める。今の superseded の扱い（`recall.ts:95-97`）に揃えるのが推奨。
- 一定の期間で機械的に片付ける（TTL）案は、利用者が期間を決めていない。そのため U12 にする。
- 抽出の時点で既存の記憶を LLM に渡し、途中経過を最初から作らせない案は U13 にする。

### 4.6 手順と昇格の候補（Phase 4 の残り。LLM）

- Procedural の生成: 繰り返し出てくる経験から、手順の候補を LLM に作らせる。作った物は `inferred` の procedural として入れる（R4。`confirmed` にはしない）。置き場を DB にするか、Markdown / JSON の file にするか（`memory-design.md:136-140`）は U8。
- 昇格の候補: Phase 5 の表と権限が無い（`README.md:224`）。候補の一覧を作る所までを Phase 4 に入れるかは U9。

### 4.7 失敗した時

今の抽出の決まり（`README.md:45-54`、`extract.ts:240-326`）に揃える。新しい決まりは足さない。

- 排他: 同じ agent の整理を二重に走らせない。process の中は今の `runOnce`（`server/utils/worker.ts:150-176`）と同じ形にする。別の process との排他は、抽出の lease（`claimed_at`）と同じ形の列が要る。要否は U6 で一緒に決める。
- Graphiti の障害（接続できない・5xx）: その run の ①② を止める。Outbox の `attempts` は数えない（抽出の「障害は加算しない」と同じ。`README.md:50`）。次の run で再試行する。
- chatp の障害: ③④ を止める。何も変えない。
- 応答の壊れ（不正 JSON・schema 違反）: その batch では何も変えない。二分して特定するかは、抽出と同じ形（`extract.ts:269-293`）を使えるが、③ は event ではなく item が単位になる。そのため dead-letter の置き場は U6 で一緒に決める。
- budget: 1 run の LLM の呼び出し回数と時間に上限を設ける。抽出の既定（20 回・10 分。`extract.ts:199-201`）に揃えるのが推奨。値は U6 で決める。
- 1 つの run の中の変更は、item ごとに 1 transaction にする。途中で落ちても、済んだ分だけが残り、半端な状態（superseded にしたが履歴が無い等）を作らない。
- log と `status` は、今の形（`README.md` の「状態と log」）に `consolidate` の行と件数を足す。本文は出さない。

## 5. DB と処理の変更点

migration は 003 以降に足す。今の 002 と同じく、何度当てても同じ形にする（`migrations/002_embed_retry.sql`、`README.md:111`）。

| 対象 | 変更 | 根拠・関係 |
|---|---|---|
| `memory_items.status` の CHECK（`001_init.sql:49`） | U11 で新しい status を採る時だけ、値を足す | §4.5 |
| 新しい表（名前は仮に `memory_revisions`） | item の状態の変更ごとに 1 行を書く。項目は item、変更前と変更後の status、変更前の `valid_until` と `superseded_by`、相手の item、理由（promoted / superseded_by_graphiti / contradiction / archived / merged）、出典（Graphiti の fact の id、LLM の run）、時刻。RLS は他の表と同じ（`001_init.sql:116-134`） | R5。§6 の「memory_events = 記憶の更新履歴」は、今は原イベントの表の名前に使われている（`README.md:221`）。そのため別の名前にする。表を足すかは U14 |
| `outbox_events`（`001_init.sql:88-98`） | 列はそのまま使う。`last_error` を足すかは U6 | §4.4 ① |
| Graphiti との対応（U3） | 案によって、`memory_items` に Graphiti の id の列を足す、または対応の表を足す | §4.4 ② |
| `server/utils/extract.ts` `applyCandidate`（`:363-408`） | inferred → confirmed の昇格の分岐 | §4.3 |
| `server/utils/recall.ts` `buildContext`（`:175-181`） | 未回答の条件 | §4.2 |
| `server/utils/recall.ts` `recall`（`:95-97`） | 片付けた物の扱い（U11） | §4.5 |
| `server/utils/recall.ts` `supersede`（`:127-139`） | 履歴の表に書く。§4.4 の検査を通った呼び出し元からも使う | §4.4 |
| 新しい file（仮に `server/utils/consolidate.ts`、`server/tasks/memory/consolidate.ts`、Graphiti の MCP client） | §4.4〜§4.6 の処理 | §4 |
| `nuxt.config.ts:20` | `scheduledTasks` に整理の task を足す（周期は U6） | §4.1 |
| 新しい表の GRANT | `memory_app` に SELECT / INSERT / UPDATE（`README.md:170-177` の注意どおり、migration で GRANT する） | §5 |
| center（`memory-events.ts:189-201`） | U5 で案 (a) を採る時だけ、report の種別を項目で渡す | §4.2 |

## 6. 段階

先に出せる小さい物から並べる。1〜3 は Graphiti が無くても出せる。

1. **未回答の区別**（問題 3）。`buildContext` の条件だけを変える（U5 が (b) なら DB の変更も bantou の変更も無い）。
2. **推測の昇格**（問題 1 の後半）。`applyCandidate` の分岐と、U14 の履歴の表。
3. **置き換えの土台**。`supersede()` を、履歴の表に書き、§4.4 の 3 の検査を持つ形にする。この段階では呼び出し元はまだ無い。test の B / C を、偽の「無効化の通知」で先に書ける。
4. **Graphiti への反映**（Phase 2 の残り）。Outbox の消費。U1〜U3 が決まってから。
5. **Graphiti の無効化と対応付けの確認**。次の 2 つを、採用する Graphiti の版の実装で確かめる。
   - 無効化が起きる条件（README に書かれていない。§0）。
   - fact から memory の item への対応付け（U3）が実装できるか。
   確かめられない時は、段階 6 を U4 の (c) に落とす。自動では置き換えず、矛盾の候補を利用者に見せる。
6. **置き換えの自動化**（問題 1 の前半）。Graphiti の無効化から §4.4 の ②〜④ を動かす。段階 5 で確かめられなかった時は、上のとおり U4 (c) の形にする。
7. **推測の再評価と片付け**（問題 2）。§4.5。U11〜U13 が決まってから。
8. **手順と昇格の候補**。§4.6。U8・U9 次第。

## 7. 確かめ方

### 7.1 test（`test/helpers/suite.ts` の統合の筋書き。PGlite と docker の PostgreSQL の両方。`README.md` のテストの節）

Graphiti は、今の chatp・Ollama と同じく決定論の fake にする（`test/helpers/fakes.ts` の形）。fake の返す無効化の形は U2 で決まった形に合わせる。

- **B 決定の履歴（§17、`memory-design.md:662-664`）**。今の test（`suite.ts:89-117`）は `supersede()` を手で呼んでいる。これを、2 つの user_prompt（「DB は MySQL」→「PostgreSQL に変更」）を event として入れ、抽出 → 整理の run の後に次を確かめる形にする。
  - 既定の recall は新しい方だけを返す。
  - `temporal.validAt` に間の時刻を入れると、古い方が `superseded` で返る。
  - 履歴の表に、理由付きで 1 行ある。
- **C 時系列の整合性（§17、`memory-design.md:666-668`）**。次を確かめる。
  - 古い時刻の event が後から届いても（`at` が古い。center の再送で起きうる。`external-memory.md:57`）、新しい決定を置き換えない（§4.4 の時刻の検査）。
  - 新しい方が inferred の時は、古い confirmed を置き換えず、矛盾の候補として残る。
  - `validAt` を境界の前後に置くと、それぞれの時点の決定が返る。
- **昇格**: inferred の後に、同じ本文の user_prompt。却下されず、confirmed が 1 件、古い方は superseded になる。
- **未回答**: progress / done / ask / approve の report を混ぜて入れる。ask / approve だけが未回答に出る。reply か result（U5 次第）で閉じる。task_id の無い report の扱い（U5）。
- **再評価**: fake の LLM が confirmed の片付けや、他 agent の id を返しても、何も変わらない（R2・R4）。inferred の片付けだけが効く。
- **失敗**: Graphiti の fake が落ちている間は、PostgreSQL の item が変わらない。Outbox の `attempts` が増えない。復帰後に進む。chatp が落ちている間も同じ。
- **D・E・H の回帰**: 今の test（`suite.ts:119`、`:221`、`:157`）がそのまま通る。

### 7.2 実際の記憶での実測（手順の設計だけ。この作業ではどの DB にも繋いでいない）

実施する host・人・時期は利用者が決める。読むだけの手順にする。

1. 事前の数を取る。agent ごとに `status` tool の `memories.byStatus`。
2. 問題の例を recall で引き、結果を保存する。
   - `recall({ query: "DB" })` で、MySQL と PostgreSQL が両方 confirmed で出るか。
   - `includeInferred: true` で「未決 17 件を確認中」「repo 名は superbash の予定」が出るか。
3. `context` を取る。`openQuestions` の件数と、各 report の本文の先頭（`(done)` / `(progress)` / `(ask)` / `(approve)`）の内訳を数える。
4. 段階ごとに新しい版を入れた後、1〜3 を取り直して比べる。
   - 段階 1 の後: `openQuestions` に done / progress が 0 件。
   - 段階 2 の後: 利用者が確定した推測が confirmed になり、元の inferred が superseded になる。
   - 段階 6 の後: 「DB」の既定の recall が 1 件になる。
   - 段階 7 の後: `byStatus.inferred` が減る。片付けた物は、U11 の決め方に従い既定の recall に出ない。
5. 誤りを数える。置き換え・片付けの全件を、履歴の表から `explain`（出典）付きで抜き出し、利用者が正しいかを見る。誤りがあれば、その段階の自動の処理を止めて戻す。戻し方は、履歴の表に残した変更前の `status`・`valid_until`・`superseded_by` の 3 つを戻す。

## 8. 未決

### U1 Graphiti に何を episode として送るか

- (a) 原 event（`graphiti.episode`）。利点: 元の仕様の登録対象（`memory-design.md:314-323`）に近く、出典を辿れる。欠点: Graphiti の LLM 呼び出しが event の数だけ増える（MCP README に「episode ごとに複数の LLM 呼び出し」とある）。
- (b) 検証済みの item（`graphiti.memory_item`）。利点: 数が少ない。item と Graphiti の fact を対応付けやすい（U3）。欠点: inferred も送るなら、推測が Graphiti の事実になる。
- (c) 両方。
- 推奨: Graphiti 側の設計（未作成）で決める。この文書からは決めない。

### U2 Graphiti の無効化を、memory がどう知るか

- (a) `search_memory_facts` を `invalid_at` で絞って定期に引く。欠点: 無効化した事実を既定で除くか等、README に書かれていない。
- (b) 送った episode ごとに `get_episode_entities` で fact を辿り、無効化の有無を見る。
- 推奨: 採用する版の実装を確かめてから決める（`memory-design.md:333`）。

### U3 Graphiti の fact と memory の item の対応

- (a) item を episode にして、episode の uuid を item に持つ。
- (b) event を episode にして、出典の表（`memory_sources`）で item に戻る。
- 推奨: U1 に従う。

### U4 「同じ事柄の新しい決定」を誰が判定するか

- (a) Graphiti の無効化を使い、memory は §4.4 の 3 の決定論の検査だけをする。利点: 利用者の前提（重ねて作らない）に合う。欠点: Graphiti の判定の精度に依る（推測。未実測）。
- (b) memory 側で、埋め込みの近傍と LLM で判定する。欠点: Graphiti と重なる。近傍の閾値を実 model で調整する必要がある（`README.md:220`）。
- (c) 自動ではせず、矛盾の候補を利用者に見せて決めてもらう。利点: R2 に最も安全。欠点: 手間が利用者に残る。
- 推奨: (a)。古い方が confirmed の時の自動の置き換えに利用者が同意しない場合は、その時だけ (c) にする。

### U5 report の種別の取り方と、未回答から外す条件

- (a) center が event に種別の項目を足して送る。利点: 確実。欠点: center と memory の event の形の変更が要る。「Phase 3〜5 では bantou は無変更」（`external-memory.md:93`）と食い違う。
- (b) memory が本文の先頭 `(<kind>) ` を読む（`center/src/memory.ts:119`）。利点: bantou の変更が無い。欠点: 本文の書式に依る。書式が変わると壊れる。test で書式を固定する。
- 外す条件の追加: 後に同じ task_id の result がある時も閉じるか。
- task_id の無い report: 未回答に出すか、出さないか。
- 補足: 本文を切り詰めるかどうか。
- 推奨: (b)。外す条件は reply と result の両方。task_id の無い ask / approve は出す（出さないと質問を見落とす）。本文はそのまま。

### U6 整理の周期・排他・budget・dead-letter

- 周期: (a) 毎分（抽出と同じ）、(b) 数十分ごと、(c) 1 日 1 回。利用者の指定は無い。
- 推奨: ①② は毎分（Outbox を溜めない）。③④ は LLM の起動コスト（`external-memory.md:77`）を考えて、間を空ける。間隔の値は利用者が決める。
- 排他・budget・dead-letter は §4.7 のとおり、抽出の決まりに揃える。dead-letter の置き場（Outbox は `attempts` で足りるか、`last_error` を足すか）もここで決める。

### U7 推測を確定する時の形

- (a) 新しい confirmed の item を作り、古い inferred を superseded にする。利点: 履歴が残る（R1）。
- (b) 古い item の status をその場で confirmed に書き換え、出典を足す。利点: item の id が変わらない。欠点: 「推測だった」という経緯が履歴の表にしか残らない。
- 推奨: (a)。

### U8 手順（Procedural）の候補の置き場

- (a) DB の `memory_items`（procedural、inferred）。
- (b) 元の仕様のとおり、版を管理する Markdown / JSON（`memory-design.md:136-140`）。
- 推奨: 候補は (a)。正式なルールを (b) にするかは利用者が決める。

### U9 昇格の候補を Phase 4 に入れるか

- (a) 候補の一覧だけを作る（表は足さない。recall などで見せる）。
- (b) Phase 5 に回す。
- 推奨: (b)。表と権限（`memory_promotions`、shared の書き込み）が無いまま候補だけ作ると、使い道が無い。

### U10 利用者が手で操作する口（confirm / revise / archive の tool、矛盾の候補の一覧）

- (a) Phase 4 で tool を足す。
- (b) 足さない。会話で利用者が言い直せば、§4.3・§4.4 で直る。
- 推奨: 矛盾の候補が出るなら、少なくとも一覧を見る口（`context` の欄、または tool）が要る。形は利用者が決める。

### U11 片付けた記憶の表し方と、recall での扱い

- (a) status に新しい値（例 `archived`）を足す。元の仕様の状態の表（`memory-design.md:270-279`）に無い値になる。
- (b) `valid_until` を立てるだけ（status は inferred のまま）。欠点: 今の recall は既定で期間を見ない（`recall.ts:111-113` は `temporal` を指定した時だけ効く）。
- (c) `superseded` を使う。欠点: 置き換え先が無いのに superseded になり、意味が混ざる。
- recall での扱い: 既定では返さず、`temporal` 指定の時だけ返す（superseded と同じ）。
- 推奨: (a)。元の仕様の API に `memory.archive` がある（`memory-design.md:352`）ので、状態として持つのが素直（推測）。

### U12 期間による機械的な片付け（TTL）

- (a) 入れない。片付けは LLM の再評価だけ。
- (b) inferred の episodic などに期間を設ける。期間の値は利用者が決める。
- 推奨: (a)。期間は利用者が決めていない。

### U13 抽出の時に、既存の記憶を LLM に渡すか

- (a) 渡す。抽出の段で「更新」「同じ」を言わせる。利点: 途中経過の記憶が最初から増えにくい（推測）。欠点: prompt が大きくなる。既存の記憶に入った指示文の注入に対する扱い（`extract.ts:116-118` の隔離）を広げる必要がある。
- (b) 渡さない。整理の段（§4.5）でまとめて扱う。
- 推奨: (b)。抽出は今のまま小さく保つ。

### U14 変更履歴の表を足すか

- (a) 足す（§5 の仮の `memory_revisions`）。
- (b) 足さず、`memory_candidates` と `superseded_by` だけで追う。欠点: 片付け・統合・矛盾の候補が残らない。R5 を満たさない。
- 推奨: (a)。
