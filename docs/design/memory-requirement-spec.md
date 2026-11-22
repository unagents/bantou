# 外部記憶の「作業指示（requirement）」と「仕様・設計」の管理

状態: 設計案（未決あり）。コード・DB・設定は変えていない。動いている外部記憶（Graphiti / Neo4j）には触れていない。

調査の対象: `feat/memory-graphiti`（d0048f5）の `packages/memory`・`docs/design/memory-design.md`・`external-memory.md`・`memory-graphiti.md`、center の `packages/center/src/{remotes,memory-events,memory}.ts`・`tools.ts`、protocol の `packages/protocol/src/{server,envelope}.ts`。根拠は `file:行`（上記 branch のもの）で添える。**推測は「推測」と明記する。**

## 0. 利用者の原文（要件の全文）

> メモリ保存の仕組みについて、今回のような作業指示等で、明確な実装の指示や、このメッセージに含まれる仕様については、typeを分けて明確な管理として登録するようにする。内容としては2つ。作業指示と仕様・設計の2点。
> 作業指示については、今回もそうだがメッセージ内容に複数の作業の指示が混ざってる場合はまず1登録に対して1つの作業（＝requirement）として登録して扱う。で、1 requirementに対して、master-capかremote-cap、又は両方はrequirementをタスクに分解する。タスクはrequiremntと親子関係になるようにする事。また、ユーザーのrequirmentへの対応として、master-capがremote-capにrequirmentを出すみたいなのも、ユーザーrequiremntを親に、ツリーで広がるようにする。
> 仕様・設計では、ユーザーからの指示としてrequirementにそのまま設計が含まれている場合は、requirementとの相互関係がわかるように紐付けだけし、仕様・設計にまとめた形のメモリを一つ登録する。
> この仕様・設計に対して、深堀りや精緻化、エージェントの判断としての決めなどを経て、実装するうえで纒めた設計をさっきのユーザーの指示としてあった設計や仕様を親にする形でツリーにする。typeは設計扱い、種類？はエージェントの推論や判断による設計とわかるようにする。
> 尚、requirementも仕様・設計のどちらにおいても、categoryみたいなのを用意する事。requirementのcategoryはちょっとまだ柔らかい状態だが、例えば環境構築・整備とか。メンテナンスとか。要求された依頼の種類を定義。
> 仕様・設計のcategoryは見えてる。
> presentation: UI、APIエンドポイント、ビュー
> business: ビジネスロジック、サービス、ユースケース
> data: リポジトリ、データベースアクセス
> infrastructure: 設定、外部サービス
> cross-cutting: ログ、セキュリティ、ユーティリティ
> これで。

### 0.1 原文から読み取る要件（解釈を足さない形）

| # | 要件 | 原文の箇所 |
|---|---|---|
| R1 | 明確な作業指示と、メッセージに含まれる仕様を、type を分けて登録する。type は 2 つ: 作業指示、仕様・設計 | 1 段落 |
| R2 | 1 つのメッセージに複数の作業指示が混ざる時は、1 登録 = 1 作業（= requirement）として登録する | 2 段落 |
| R3 | 1 requirement を、master-cap か remote-cap（又は両方）がタスクに分解する。タスクは requirement の子 | 2 段落 |
| R4 | 利用者の requirement への対応として master-cap が remote-cap に出す requirement も、利用者の requirement を親にしたツリーに載せる | 2 段落 |
| R5 | 利用者の指示の中に設計が含まれる時は、requirement と紐付けだけして、仕様・設計にまとめたメモリを 1 つ登録する | 3 段落 |
| R6 | 仕様・設計を深掘り・精緻化・エージェントの判断で決めた設計は、利用者の仕様・設計を親にしたツリーにする。type は設計、種類はエージェントの推論・判断による設計と分かるようにする | 4 段落 |
| R7 | requirement にも仕様・設計にも category を持つ。requirement の category は柔らかい（例: 環境構築・整備、メンテナンス。依頼の種類）。仕様・設計の category は 5 つ（presentation / business / data / infrastructure / cross-cutting） | 5 段落以降 |

### 0.2 原文に無いもの（本書が足していない事の確認）

利用者は次を決めていない。本書では「未決」か「推測」として扱い、決まった事にしない。
requirement の状態の持ち方、requirement の category の最終一覧、1 つの仕様・設計に複数の category を付けるか、登録する担い手と時期、ツリーを DB のどう持つか、recall / context での出し方、Graphiti へ反映するか。

## 1. 今の外部記憶（調査結果）

### 1.1 event（素材の保存）

- `memory_events` の種別は 6 つだけ: `user_prompt` / `assistant_message` / `task` / `result` / `report` / `reply`（`packages/memory/migrations/001_init.sql:25`、`server/utils/events.ts:4`）。`task_id` / `remote_id` の列がある（`001_init.sql:23-24`、`events.ts:17-18`）。冪等キーは (agent_id, event_id)（`001_init.sql:35`）。
- event を保存する時、同じ transaction で `outbox_events`（topic `graphiti.episode`）に積む（`events.ts:59-63`）。
- agent は 1 つの記憶の持ち主。RLS は agent_id が一致する行だけ見せる（`001_init.sql:118`）。memory_items だけは自分の行 + scope が shared / organizational の行を読める（`001_init.sql:139-143`）。

### 1.2 抽出（event → item）

- 毎分の worker が未処理 event をまとめて LLM（chatp 経由の `claude -p`）に渡し、記憶候補を得る（`server/utils/extract.ts:116-124` の system prompt、`:74-96` の JSON schema）。候補の `memoryType` は `semantic / episodic / relational / procedural` の 4 つだけ（`extract.ts:65`）。`identity` は抽出しない。
- 確定・推測の決め方（`extract.ts:184-186`）: 出典が**全て** `user_prompt` で、LLM が `confirmed` と言った時だけ `confirmed`。それ以外は `inferred`。
- 保存: `memory_items` に insert、出典を `memory_sources` に、`outbox_events`（topic `graphiti.memory_item`）に積む（`extract.ts:381` `:396` `:399`）。候補の採否は `memory_candidates` に残す。
- `memory_items` の列: scope / project_id / memory_type / content（1〜2000 文字）/ status / confidence / valid_from / valid_until / superseded_by / embedding（`001_init.sql:41-58`）。同じ (agent, memory_type, 正規化 content) は 1 件に畳まれる（`001_init.sql:59`）。
- 設計書にある `memory_relations`・`memory_promotions`・`memory_permissions`（`docs/design/memory-design.md:209-215`）は、migration にも server にも**無い**（`grep` で確認。001〜003 に表が無い）。

### 1.3 recall / context

- recall は query の埋め込みで近傍検索。既定は `confirmed` / `verified` のみ、`includeInferred` で `inferred`、`temporal` 指定で `superseded` も含める（`server/utils/recall.ts:95-97`）。`memoryTypes` は 4 種（`recall.ts:16`）。
- context は LLM を使わず決定論的に作る（`recall.ts:162-196`）: `policies`（confirmed の semantic / procedural、10 件）、`recentDecisions`（confirmed の episodic、10 件）、`openQuestions`（kind=report で同じ task_id の後続 reply が無いもの）、`activeTasks`（kind=task で同じ task_id の後続 result が無いもの）。**item は `status = 'confirmed'` だけ**（`recall.ts:171`）。
- explain は item の出典 event と検証状態を返す（`recall.ts:210` の `explain`）。

### 1.4 Graphiti への反映（`memory-graphiti.md`）

- Outbox の 1 行 = 1 episode。item は本文 = content、event は `[kind] 送り元 -> 宛先` + body（`docs/design/memory-graphiti.md:37-41`）。agent ごとの group（`:41`）。
- Neo4j / Graphiti の fact は常に `inferred` 扱いで、PostgreSQL の item / event に出典として戻す（`memory-graphiti.md:50` `:54`、実装 `server/utils/graphiti-recall.ts`）。tool（recall / context）への接続は未決 4 で保留（`memory-graphiti.md:108-113`）。
- Graphiti に渡るのは episode の**本文**だけで、item 同士の親子・関係は渡らない（`memory-graphiti.md:37-41` の内容にその項目が無い。現状の事実）。

### 1.5 center の event の送り方

- center が記録するのは master-cap の記憶だけ（agent = session の agentId か session 名。eventId の名前空間 `c1`）。cap 側の記憶は書かない（`packages/center/src/memory-events.ts:1-6`、`docs/design/external-memory.md:39` `:43-44`）。
- 利用者の発言は hook（`UserPromptSubmit` の `prompt`）から `user_prompt` event になる（`memory-events.ts:119-141`、eventId は session・種別・prompt_id・時刻・本文 digest で決まる `:132`）。master-cap の応答は `Stop` hook の `last_assistant_message` から `assistant_message`。
- `remote_send` の送信時に `memoryEvents.task()`（`packages/center/src/remotes.ts:1837`）→ `kind: task` の event（`memory-events.ts:144-157`。sender = session、recipient = capId、`remoteId`・`taskId` 付き、eventId = `c1:<session>:task:<taskId>`）。
- 結果は `task_result`（`taskId` あり）または `cap_result`（**`taskId` 無し**。`memory-events.ts:159-186`）、worker の report は `n.task_id` があれば付く（`:189-200`）、worker への返答は `reply`（`remotes.ts:1968`）。
- 送信は非同期キューで、失敗しても center の処理は止まらない（`external-memory.md:57`）。

### 1.6 remote の task の id の付き方

- `task_id` は **center が `remote_send` ごとに採番**する: `t-<時刻の 36 進>-<乱数 3 byte の hex>`（`remotes.ts:306-307` の `newTaskId`、使用は `remotes.ts:1779`）。文字種は `TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/`（`packages/protocol/src/envelope.ts:27`）。
- server への `task` 命令に載り、`task_result`・`worker_report` に echo される（`packages/protocol/src/server.ts:221-226` の `TaskCommand`、`:435` の `TaskResultReply`、`:720-725` の `WorkerReportNotice`）。
- server は同じ cap の別の task を task ごとの指揮（lane）で並行に動かす（`docs/design/cap-orchestration.md:100-106`）。**server は task_id の重複を除かない**（`packages/center/src/tools.ts:436`、`remotes.ts:1755`）。
- `worker_report` の `task_id` は worker を起動した task の id。旧 server は最後に受けた task の id（`tools.ts:436`）。
- cap 内部で remote-cap / worker が task をさらに分けても、それを表す id は protocol に無い（`task_id` は center の 1 回の `remote_send` に対応する 1 つだけ。上記の通り）。

## 2. 全体像

```
利用者の発言 ──(hook)──▶ user_prompt event ─┐
                                              ├─▶ 抽出（今は memory 側の LLM）─▶ memory_items
master-cap ──(remote_send)──▶ task event ────┘                                   │
        │ task_id（center 採番）                                                   │
        ▼                                                                         ▼
   remote-cap ─▶ worker ─▶ result / report event                  requirement のツリー ＋ 仕様・設計のツリー
```

本書が決めたい事は 2 つの木とその紐付け。

- 木 A（作業指示）: 利用者の requirement を根に、master-cap → remote-cap の requirement、その下のタスク。
- 木 B（仕様・設計）: 利用者の仕様・設計を根に、エージェントの推論・判断の設計。
- 木 A と木 B は、requirement ↔ 仕様・設計の紐付けでつなぐ（親子ではなく相互関係）。

## 3. (1) 型と項目

### 3.1 type（R1）

原文の type は 2 つ: 作業指示（requirement）と仕様・設計。既存の `memory_type`（identity / semantic / episodic / relational / procedural。`001_init.sql:46`）は記憶の認知的な分類で、軸が違う（推測。原文は `memory_type` に触れていない）。持ち方は未決 #1。

本書では説明のため、新しい軸の名前を **`record_type`** とし、値を `requirement` / `spec_design` と書く（名前は仮。#1 で決める）。

### 3.2 requirement の項目

| 項目 | 内容 | 根拠 |
|---|---|---|
| id | item の uuid（既存） | `001_init.sql:42` |
| record_type | `requirement` | R1 |
| content | 1 作業の内容（原文の言い回しを保つ。1 作業 = 1 登録） | R2 |
| category | 依頼の種類（3.4 の候補） | R7 |
| parent | 親の requirement（木 A。利用者の requirement は親なし） | R3 R4 |
| 起点 | 利用者の発言由来か、エージェントが出した物か（3.5。**推測**: 原文は区別を求めていないが、R4 の「ユーザーrequirementを親に」から必要になる） | R4 |
| task_id | center が採番した `remote_send` の task_id（master-cap → remote-cap の requirement だけ） | §1.6、R4 |
| 出典 | 既存の `memory_sources`（event との対応） | `001_init.sql:63-69` |
| status 等 | 既存の status（confirmed / inferred …）。requirement の進み具合（未着手・完了）をどこに持つかは未決 #9 | — |

role（requirement とタスクの区別）: 原文は「タスクは requirement と親子関係」と言うだけで、タスクを第 3 の type とは言っていない。**推測**: タスクも `record_type = requirement` の子として持ち、`role`（`requirement` / `task`）で区別するのが原文に近い。未決 #7 の一部。

### 3.3 仕様・設計の項目

| 項目 | 内容 | 根拠 |
|---|---|---|
| record_type | `spec_design` | R1 |
| content | 仕様・設計にまとめた形の本文（利用者の指示の中の設計を 1 つにまとめる） | R5 |
| category | `presentation` / `business` / `data` / `infrastructure` / `cross-cutting`（原文の 5 つ。定義は原文のまま） | R7 |
| parent | 親の仕様・設計（木 B） | R6 |
| 種類（basis） | 利用者の指示にあった物 / エージェントの推論 / エージェントの判断による決め。原文の「推論や判断」を 2 値に割るのは**推測**（原文は「エージェントの推論や判断による設計とわかる」とだけ言う）。未決 #3 | R6 |
| requirement との紐付け | 相互関係の link（親子ではない）。未決 #7 | R5 |
| 出典・status | 既存の `memory_sources` と status。利用者が言った設計は出典が user_prompt だけなら既存の規則で `confirmed`、エージェントの設計は `inferred`（`extract.ts:184-186`） | — |

仕様・設計の category の意味（原文）:

| category | 意味 |
|---|---|
| presentation | UI、API エンドポイント、ビュー |
| business | ビジネスロジック、サービス、ユースケース |
| data | リポジトリ、データベースアクセス |
| infrastructure | 設定、外部サービス |
| cross-cutting | ログ、セキュリティ、ユーティリティ |

### 3.4 requirement の category の候補（推奨つき）

原文が挙げた 2 つ: 環境構築・整備、メンテナンス。原文は「ちょっとまだ柔らかい」「要求された依頼の種類を定義」とだけ言う。下表の**他の候補は本書の推測**（利用者が挙げていない）。

| 候補（仮の識別子） | 意味 | 出どころ |
|---|---|---|
| `setup` | 環境構築・整備 | 原文 |
| `maintenance` | メンテナンス | 原文 |
| `feature` | 機能の実装・追加 | 推測 |
| `fix` | 不具合の修正 | 推測 |
| `investigation` | 調査・確認 | 推測 |
| `docs` | 文書・設計書の作成 | 推測（今回の task がこれ） |
| `other` | 上のどれでもない | 推測（柔らかい状態の受け皿） |

- 推奨: 原文の 2 つ + 推測の 5 つを**初期の候補**にし、固定の列挙にしない（未決 #2）。理由: 原文が「柔らかい」と言っている。
- 未決 #2 で、列挙を固定するか自由な文字列にするかを決める。

### 3.5 起点（利用者の発言由来か、エージェントが出したか）

- 利用者の requirement: 出典が `user_prompt`（§1.5）。
- master-cap が remote-cap に出す requirement: 出典が `task` event（`remote_send` の送信。§1.5）。既存の規則だと出典が `user_prompt` だけでない item は `inferred` に落ちる（`extract.ts:184-186`）。**「エージェントが実際に出した指示」を `inferred`（推測）と呼ぶのは意味が合わない**ので、status（根拠の強さ）と起点は別の項目にする案。未決 #5 で扱う。

## 4. (2) 1 つの発言から複数の requirement を分けて登録する仕組み

### 4.1 今の流れ

発言は `user_prompt` event として 1 件保存され（§1.5）、毎分の抽出が 4 つの `memoryType` の候補を作る（§1.2）。requirement を分ける処理は無い。

### 4.2 登録の担い手・時期の案（未決 #5）

- 案 A: 抽出 worker（memory 側の LLM）に requirement / 仕様・設計の候補を足す。1 つの `user_prompt` から N 件の requirement 候補を返させ、それぞれの出典を同じ event にする。
  - 利点: 既存の流れ（`extract.ts`）・出典・採否の記録（`memory_candidates`）・Graphiti 反映（`extract.ts:399`）をそのまま使う。master-cap の作法に依存しない。
  - 欠点: 登録が非同期（毎分）なので、master-cap がその発言に対して `remote_send` する時点では requirement の id がまだ無い（親の解決は未決 #6）。LLM が複数作業を分けそこなう可能性がある（推測）。
- 案 B: master-cap が発言を読んだ時に、新しい tool（例 `requirement_register`）で 1 作業ずつ登録する。
  - 利点: 登録が同期で id が即座に得られ、`remote_send` の親に使える。分け方を master-cap（利用者との窓口）が決める。
  - 欠点: 新しい tool と system-instructions の追加。今の system 指示は「記憶への書き込みは bantou が自動で渡す。自分では書き込みの tool を呼ばない」と案内しており（`packages/center/src/system-instructions.ts:173-186`、`external-memory.md:35`）、その決まりを変える。resession 設計の U2 の B と同じ決まり（§8.2 接点 2）。master-cap が登録を忘れうる。出典の event id は center が決める（`memory-events.ts:132`）ので、master-cap は自分の発言の event id を知らない（推測: 別途渡す仕組みが要る）。
- 案 C: A と B の併用。master-cap が登録し、抽出が漏れを拾う。利点: 即時性と網羅の両立。欠点: 二重登録の突き合わせ（既存の重複排除 `001_init.sql:59` は同文でしか効かない）。
- 推奨: 案 A（まず既存の経路に載せる）。理由: `external-memory.md:39` の設計（抽出は memory 側、bantou 側はしない）に沿い、新しい tool と運用の追加が要らない。親の即時性は #6 の案で補う。

### 4.3 分け方の規則（原文から）

- 1 登録 = 1 作業（R2）。1 つのメッセージに複数の作業が混ざる時は、混ざった分だけ requirement を登録する。
- メッセージに設計が含まれる時は、requirement とは別に仕様・設計のメモリを **1 つ**登録し、紐付ける（R5）。作業ごとに設計を割るかは原文に無い（推測では 1 つにまとめる）。

## 5. (3) requirement → タスク、利用者 → master-cap → remote-cap の木と center の remote_send・task_id

### 5.1 木 A の形

```
R-user（利用者の requirement。出典 = user_prompt）
 ├─ R-send-1（master-cap が remote-cap に出した requirement。task_id = t-… 、出典 = task event）
 │    ├─ T-1（remote-cap / worker が分解したタスク）
 │    └─ T-2
 ├─ R-send-2（別の remote_send。別の task_id）
 └─ T-3（master-cap が自分で分解したタスク。remote_send 無し）
```

- 利用者の requirement を根にし、master-cap が出す requirement と、タスクは子（R3 R4）。
- 同じ requirement に対して `remote_send` を複数回出すと、`task_id` の違う子が複数できる（task_id は送信ごとの採番。§1.6）。

### 5.2 center の task_id との結び方

- master-cap → remote-cap の requirement 1 件 = `remote_send` 1 回 = `task_id` 1 つ。requirement のノードに `task_id` を持たせ、同じ `task_id` を持つ event（`task` / `result` / `report` / `reply`。§1.5）と対応づける。`memory_events` には `task_id` の index が既にある（`001_init.sql:38`）。
- `task` event の eventId は `c1:<session>:task:<taskId>`（`memory-events.ts:147`）なので、ノードと出典 event の対応は task_id から一意に引ける。
- `result` / `report` の task_id の取りこぼし（実装上の事実）:
  - `cap_result` の event には task_id が付かない（`memory-events.ts:175-185`）。
  - 旧 server の `worker_report` の task_id は「最後に受けた task の id」で、別の task のものになりうる（`tools.ts:436`）。
  - server は task_id の重複を除かない（`tools.ts:436`、`remotes.ts:1755`）。center は受付未確認の同じ指示を 10 分は再送しないが、再送されれば別の task_id の別の子になる。
- 親（利用者の requirement）をどの `remote_send` に結ぶかは未決 #6。

### 5.3 remote-cap / worker が分解したタスク（未決 #8）

- 今、center が記録するのは master-cap の記憶だけで、server（remote-cap）は書かない（`external-memory.md:44`）。remote-cap の中の分解（worker ごとの分担、task の中の手順）は、master-cap の記憶には `result` の本文（`summary` / `remaining`。`memory.ts:106-110` の `formatTaskResultBody`）と `report` の本文として入るだけ。
- 「remote-cap もタスクに分解する」（R3）をノードとして持つ案:
  - 案 A: master-cap の記憶の中だけで持つ。remote-cap の分解は `result` / `report` の本文から抽出する（A は #5 の抽出と同じ経路）。利点: 利用者の決定「外部記憶の書き込みは master-cap の記憶だけ」（`external-memory.md:39`）を変えない。欠点: 抽出の LLM 頼みで、分解の粒度は本文に書かれた分だけ。
  - 案 B: remote-cap の記憶（agent = cap_id）にも書き、その木を別 agent の行として持つ。利点: cap の分解を直接記録。欠点: 利用者の決定（master-cap だけ）を変える。RLS が agent ごとに行を隔てる（`001_init.sql:118`）ので、親（master-cap の記憶の requirement）を cap 側の木から辿れない（共有する仕組みは scope の shared / 昇格だが未実装。`memory-design.md:489-504`）。
  - 案 C: 親子の参照だけ `(agent_id, item_id)` の文字列で持ち、読めるのは各 agent 自身の範囲だけにする。欠点: 木が agent をまたいで読めない。
- 推奨: 案 A。理由: 既決の範囲内で動き、RLS を触らない。cap 側の記憶が要る時は `external-memory.md:44` の「将来足す」で別に扱う。

## 6. (4) 利用者の仕様・設計 → エージェントの設計の木と、requirement との紐付け

### 6.1 木 B の形

```
S-user（利用者の指示にあった仕様・設計をまとめた 1 件。basis = 利用者）
 ├─ D-1（深掘り・精緻化した設計。basis = エージェントの推論）
 │    └─ D-1a（さらに詳細化）
 └─ D-2（エージェントの判断で決めた設計。basis = エージェントの判断）
```

- 親は利用者の仕様・設計（R6）。エージェントの設計は、実装に使う形にまとめた物。
- 利用者が仕様を言っていない（設計が最初からエージェント由来の）場合は、親なしのエージェント設計が根になる（**推測**: 原文は触れていない）。

### 6.2 requirement との紐付け（R5）

- 原文: 「requirementとの相互関係がわかるように紐付けだけし」。親子ではなく、requirement ↔ 仕様・設計の関連。
- 1 つの requirement に仕様・設計が 1 つ（その発言の分）、または 1 つの仕様・設計に複数の requirement が紐づく（1 発言に複数作業 + 設計 1 つ。§4.3）。つまり多対多の可能性がある（推測）ので、親子の列ではなく**関連の表**（from / to / 関係の名前）で持つ案。未決 #7。
- 設計書にある `memory_relations`（`memory-design.md:209`）は未実装（§1.2）。これを使う案が最小（推測）。

### 6.3 木 B の status

- 利用者の仕様・設計: 出典が `user_prompt` だけなら `confirmed`（`extract.ts:184-186`）。
- エージェントの設計: 利用者が確定していない物は `inferred`。**`memory-design.md` の原則「推測を確定として扱わない」（`:672` のテスト D）と同じ**。エージェントの設計が実装の根拠になっても、利用者が確定するまでは `inferred`（推測）のまま。
- 利用者が後から確認した時に `confirmed` へ上げる手順（`memory.confirm`。`memory-design.md:345`）は未実装（tool 一覧は event / recall / context / explain / status。`server/mcp/tools/`）。本書では扱わない。

## 7. (5) context・recall からの読み方

今の読み方（§1.3）に対して、次の変更が要る。

| 点 | 今 | 影響 |
|---|---|---|
| recall の絞り込み | `memoryTypes` は 4 種、status は既定 confirmed / verified（`recall.ts:16` `:95-97`） | requirement / 仕様・設計を `record_type` と `category` で絞れない。エージェントの設計（`inferred`）は既定で出ない |
| context | item は `confirmed` の semantic / procedural / episodic だけ（`recall.ts:166-174`） | requirement のツリーも仕様・設計も context に出ない。activeTasks は event から導出（`recall.ts:182-188`） |
| 木の情報 | item 単体の結果（`RecallResult`。`recall.ts:32-42`） | 親・子・紐付けを返す項目が無い |

### 7.1 案（未決 #10）

- recall: 引数に `recordType` と `category`（任意）を足す。結果に `recordType`・`category`・親の id・紐付く requirement の id を足す。エージェントの設計（`inferred`）は `includeInferred` の時だけ出す（既存の規則と同じ。推測と確定を分けて渡す `memory-design.md:485`）。
- context: 次の 2 つを足す案。
  - `openRequirements`: 完了していない requirement のツリー（根 = 利用者の requirement、子 = master-cap が出した requirement とタスク）。
  - `specs`: 利用者の仕様・設計（`confirmed`）と、その子のエージェントの設計の要約（`inferred` と明示）。
- 「完了していない」の判定: 既存の `activeTasks` と同じく event から導出する（task の後続 `result` が無い。`recall.ts:182-188`）案。requirement に状態の列を持たない（未決 #9）。
- context は今 10 件で切る（`recall.ts:172`）。ツリーでの件数・深さの上限は未決のまま実装時に決める。

### 7.2 Graphiti との関係

- Graphiti の fact は `inferred` の補助で、tool への接続は未決 4（`memory-graphiti.md:108-113`）。本書の recall / context は PostgreSQL を正にする（`memory-design.md:481`）。
- ツリー（親子・紐付け）を Graphiti に渡すかは未決 #11。

## 8. リセッション設計との関係

別 task のリセッション設計 `origin/docs/resession-design`（01f6673。`docs/design/resession.md`、以下「resession 設計」）を fetch して読んだ。行は `resession.md:行`。resession 設計は develop 未 merge。

### 8.1 resession 設計の要点（本書に関わる所）

- リセッション = 引継ぎを外部記憶に保存 → session を `--continue` 無しで再起動 → 起動した session が引継ぎを memory から読んで応対を続ける。center が 1 つの操作として実行する（`resession.md:17`）。
- 引継ぎの内容は common.md の記録 3 つ（引継ぎ・決定と未決・今の窓口）に合わせ、新しい項目は足さない（`:92`）。
- 引継ぎの保存は、session が tool の引数で本文を渡し、**center が** memory に書く案を推奨。memory 側に新しい event の種別 `handoff` を足す（`:95`、`:174-175`、`:197`。U2 は `:212-217`）。
- 読み出し: memory に「識別（agent + 引継ぎの id）で本文をそのまま返す口」を足す。抽出（LLM）を通さない（`:136`、`:198`）。理由は、`recall` / `context` が抽出後の記憶を返すので引継ぎの全文が欠けうるから（`:136`）。
- session 名・memory の Agent ID・messenger の peer 名・remote の記録は再起動でも変わらない（`:34`）。
- 本書の branch について、resession 設計は「まだ読めていない」と書き、矛盾を避ける約束を推測で置いている（`:185-193`）。その約束は §8.3 で照合する。

### 8.2 接点・重なり

| # | 接点 | 内容 | 根拠 |
|---|---|---|---|
| 1 | 型の軸 | resession は引継ぎを **event の種別 `handoff`**（`memory_events.kind` の追加）として持つ。本書 #1 は **item 側の type**（`record_type`）の話で、軸が違う。今の `kind` は 6 つの CHECK（`001_init.sql:25`、`events.ts:4`）で、両者とも migration / CHECK を変える | `resession.md:197`、`001_init.sql:25` |
| 2 | 書き手 | resession は「session は memory に書かない。書くのは center」を守る（U2 の推奨 A）。system 指示にも「書き込みの tool を呼ばない」とある（`packages/center/src/system-instructions.ts:173-186`）。本書 #5 の案 B（master-cap が登録 tool を呼ぶ）はこの決まりを変える。resession の U2 の案 B（session が直接書く）と**同じ決まりを動かす**ので、片方だけ決められない | `resession.md:95-96`、`:212-217`、`system-instructions.ts:186` |
| 3 | 読み方 | resession の読み出しは「識別で event 本文を返す口」で、抽出を通さない。本書 #10 は `recall` / `context` の出力に木と category を足す。**変更する関数は別**（resession は新しい口、本書は `recall.ts` の既存 2 関数）だが、tool 一覧（`server/mcp/tools/`）と system 指示の案内（memory 部品）を両方が変える | `resession.md:136`、`:198`、本書 §7 |
| 4 | 抽出との交差 | 抽出は kind を問わず未処理の event を全て取る（`extract.ts:243-249`。`UPDATE memory_events SET claimed_at = now() WHERE agent_id = $1 AND event_id IN (SELECT event_id FROM memory_events WHERE agent_id = $1 AND processed_at IS NULL AND failed_at IS NULL AND (claimed_at IS NULL OR claimed_at < ...) ORDER BY at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED)`。kind の条件は無い）。**推測**: `handoff` event もそのまま抽出に入り、引継ぎの中の決定・仕掛かりが item（本書の requirement・仕様・設計）として二重に登録されうる。出典が `user_prompt` でないので既存規則では `inferred`（`extract.ts:184-186`）。抽出の対象から外すか、入れるかは未決 | `extract.ts:243-249` |
| 5 | 内容の重なり | 引継ぎ（仕掛かり・決定と未決、`resession.md:92`）と、本書の木 A（未完了の requirement・task）・木 B（決めた設計）は同じ事の別の持ち方になりうる。**推測**: 木が入れば、引継ぎの「仕掛かり」は木の読み出し（本書 #10 の `openRequirements`）で代替でき、引継ぎ本文は「次の一手・止まっている事」に絞れる。ただし resession は「session が本文を書く」前提で、この代替は resession 側が決める事 | `resession.md:92` |
| 6 | 再起動をまたぐ継続 | Agent ID = session 名は再起動で変わらない（`resession.md:34`）ので、本書の木は再起動後も同じ agent の記憶として残る。木の親子は新しい会話の session からも読める | `resession.md:34` |
| 7 | 完了の判定 | resession の安全確認は center の remote の記録の `pending`（未完了の指示）を見る（`resession.md:76`）。本書 #9 案 A は未完了を memory の event（task の後続 result 無し）から導く（`recall.ts:182-188`）。**元が別**（center の pending と memory の event）で、食い違いうる。どちらを正にするかは両設計で未調整 | `resession.md:76`、`recall.ts:182-188` |

### 8.3 resession 設計が置いた「約束」との照合

resession 設計は「その設計が出たら照合する」として 3 点を置いている（`resession.md:189-193`）。本書の側の答え:

- 「引継ぎは event の 1 種別 `handoff` と識別で引ける読み出しの 2 つだけを memory に求める。型の仕組みが先にできていれば、引継ぎをその型の 1 つとして載せ替える」（`:190`）→ 本書の型（`record_type`、#1）は item 側。**載せ替えるなら** `record_type` に 3 つ目（例 `handoff`）を足す形になるが、引継ぎは全文を抽出なしで返したい（`:136`）ので item（抽出後）には向かない（**推測**）。event の種別のまま持つ方が resession の目的に合う。載せ替えは本書からは求めない。
- 「引継ぎの項目は common.md の 3 記録に合わせ、その設計が別の項目を決めたらそちらを優先」（`:191`）→ 本書は引継ぎの項目を決めない。requirement・仕様・設計の項目は §3 のとおりで、引継ぎとは別。
- 「書くのは center の決まりはそのまま。その設計が session の直接の書き込みを許すなら U2 の B が選べる」（`:192`）→ 本書 #5 の案 A（抽出 worker）は書き込みの決まりを変えない。案 B（master-cap の tool）を選ぶ場合のみ、決まりが動く（接点 #2）。
- 「要確認: 型の名前、識別の形、読み出しの口の名前」（`:193`）→ 本書の型の名前は仮（`record_type` / `requirement` / `spec_design`。#1）。識別は item の uuid と event の `event_id`（既存）。読み出しの口は本書 #10。

### 8.4 順序（推奨）

1. 先に決める: 書き込みの決まり（本書 #5 と resession U2 を**同時に**）。同じ決まり（session は memory に書かない）を両方が動かしうるため。本書 #5 が案 A なら決まりは変わらず、resession U2 の A と矛盾しない。
2. 次に: 型（本書 #1）と event 種別の追加（`handoff`）の migration を 1 つの変更にまとめるか分けるか。変える CHECK が違う（resession は `memory_events.kind` の CHECK = `001_init.sql:25`。本書 #1 は推奨の案 B なら `memory_items` に新しい列を足すだけで、`memory_type` の CHECK（`001_init.sql:46`）は変えない。案 A を選ぶ場合だけ `:46` の CHECK を変える。**どの案でも `:25` の CHECK とは別**なので衝突はしない。**推測**: migration の番号を揃えるだけでよい）。
3. その次: 読み出し（本書 #10 と resession の識別で引く口）。tool 名と system 指示の案内を 1 回で書く。
4. 抽出との交差（接点 #4）は、`handoff` を足す側（resession）が実装する時に決める。本書はその時点の抽出規則に従う。

本書は resession 設計に依存しない（単独で実装できる）。resession 設計は本書の型・木が入ると、引継ぎの本文を短くできる可能性がある（接点 #5。**推測**）が、入らなくても動く（`resession.md:201` は memory が無い構成でも file で動くとする）。

## 9. 未決

### 未決 #1: 新しい type の持ち方

- 案 A: 既存の `memory_type` に値を足す（`requirement` / `spec_design`）。利点: 列が増えない。欠点: 認知分類（semantic など）と作業の種別が 1 つの軸に混ざる。recall の `memoryTypes`（`recall.ts:16`）と抽出の型（`extract.ts:65`）、CHECK（`001_init.sql:46`）を変える。dedup の unique index（`001_init.sql:59`）が memory_type 込みなので、同じ文の requirement が畳まれる点は別途対処が要る。
- 案 B（推奨）: 新しい列 `record_type`（NULL = 従来の記憶）を足し、`memory_type` は残す。利点: 既存の item と recall が変わらない。軸が分かれる。欠点: 列が増え、2 軸の組み合わせの規則が要る。dedup の index は `record_type` を含める変更が要る。
- 案 C: 別の表（`requirements` / `specs`）。利点: 型ごとの制約が書ける。欠点: recall・出典・Graphiti 反映の経路を表ごとに作り直す。
- 推奨 B。理由: 既存の経路（出典・Outbox・埋め込み）を使い回せて、既存の記憶に影響しない（推測。原文は表の作りを指定していない）。

### 未決 #2: requirement の category の持ち方と一覧

- 案 A（推奨）: 文字列の列。値の候補（§3.4）はコードと抽出 prompt で案内し、DB の CHECK で固定しない。利点: 「柔らかい」（原文）に合い、候補の追加で migration が要らない。欠点: 表記ゆれが出うる。
- 案 B: 列挙（CHECK）で固定。利点: ゆれが無い。欠点: 変えるたびに migration。原文の「まだ柔らかい」と合わない。
- 一覧の確定は利用者が決める（原文は 2 例のみ）。候補は §3.4。
- 推奨 A。仕様・設計の category は原文が 5 つに確定しているので CHECK で固定してよい（推測。原文は「見えてる」とだけ言う）。

### 未決 #3: 仕様・設計の「種類」の持ち方

原文は「typeは設計扱い、種類？はエージェントの推論や判断による設計とわかるように」と、「種類？」に疑問符を付けている。
- 案 A（推奨）: type は `spec_design` の 1 つで、項目 `basis` に `user`（利用者の指示にあった）/ `agent_inferred`（エージェントの推論）/ `agent_decided`（エージェントの判断による決め）を持つ。利点: 木 B が 1 つの type で済む。原文の「推論や判断」の 2 つを区別できる（ただし原文の「推論や判断」を 2 値に割るのは**推測**で、利用者は 2 つに分けろとは言っていない）。欠点: 推論と判断を分ける意味が使う側に伝わるか（推測）。
- 案 B: `basis` を `user` / `agent` の 2 値にする。利点: 単純。欠点: 推論と判断が混ざる。
- 案 C: 利用者の仕様と、エージェントの設計を別の type にする。利点: type で分かる。欠点: type が 3 つになり、原文の「type は 2 つ」と合わない。
- 推奨 A。「種類？」の意味は利用者に確認が要る（本書は A で進める前提の推測）。

### 未決 #4: 1 つの仕様・設計に複数の category を付けるか

原文は category を持つとだけ言い、複数かは言っていない。1 発言の設計を「1 つにまとめる」（R5）と、複数の category にまたがる事がある（推測）。
- 案 A（推奨）: 複数可（配列）。利点: まとめた 1 件に実態が書ける。欠点: category での絞り込みが配列の検索になる。
- 案 B: 1 つだけ。利点: 単純。欠点: またがる設計は割って複数件にするので「まとめた 1 件」（R5）に反する。
- 推奨 A（requirement の category は 1 つで足りる前提。推測）。

### 未決 #5: requirement を分けて登録する担い手・時期、起点と status の分け方

- 担い手・時期: §4.2。推奨は案 A（抽出 worker）。案 B（master-cap の tool）・案 C（併用）は即時性が必要な時の選択肢。
- 起点と status: master-cap が出した requirement を既存規則のまま登録すると `inferred` に落ちる（§3.5）。
  - 案 A（推奨）: 起点（`origin` = user / agent）を別項目にし、status は根拠の強さのまま。agent 起点の requirement は出典が `task` event なら記録済みの事実として `confirmed` にしてよいか、利用者が決める。
  - 案 B: 既存規則のまま `inferred`。欠点: 実際に出した指示が推測と表示される。

### 未決 #6: 利用者の requirement を、どの `remote_send` の親にするか

登録が非同期（#5 案 A）だと、`remote_send` の時点で親の id が無い。
- 案 A: `remote_send` に親の requirement id の引数を足す。利点: 親が確定。欠点: protocol / center / tool の変更。登録が同期（#5 案 B）でないと id が無い。
- 案 B（推奨）: 抽出（#5 案 A）が `task` event を処理する時に、同じ session の直近の `user_prompt` から親を決める（LLM が open な requirement の中から選ぶ）。利点: center・protocol を変えない。欠点: 親の選び誤り（推測）。結びは `inferred` として扱い、誤りを直す手順が要る。
- 案 C: 時刻の近さだけで決める（直近の user_prompt 由来の requirement）。利点: 機械的。欠点: 複数 requirement の発言で親を特定できない。
- 推奨 B。理由: bantou の変更が不要。

### 未決 #7: 木と紐付けの持ち方、タスクの区別

- 木（親子）:
  - 案 A（推奨）: item に `parent_id`（同じ record_type 内）を持つ。利点: 1 親の木が 1 列で書け、親を辿る問い合わせが単純。`superseded_by`（`001_init.sql:53`）と同じ作りで、RLS も既存の行の規則（`001_init.sql:139-143`）のまま。欠点: 親が 1 つに限られる。item を差し替える時の親子の付け替えを別に扱う。
  - 案 B: 関連の表に親子も入れる。利点: 親子と紐付けが 1 つの表で揃い、親が複数でも書ける。欠点: 木を辿るたびに結合が要る。`memory_relations` は未実装（§1.2）で、表と RLS から作る。
- requirement ↔ 仕様・設計:
  - 案 A（推奨）: 関連の表（`memory_relations` を実装して使う）。利点: 多対多を持てる（1 発言の複数 requirement と 1 つの仕様。§4.3）。関係の名前を付けられる。欠点: 新しい表と RLS が要る。
  - 案 B: requirement の列に仕様の id を持つ。利点: 表が増えない。欠点: 1 requirement に 1 仕様しか持てず、多対多にならない。
- タスクの区別:
  - 案 A（推奨）: requirement の `role`（requirement / task）。利点: 原文の 2 type のまま（タスクは requirement の子）。欠点: role の値の規則が増える。
  - 案 B: タスクを別 type にする。利点: type で区別できる。欠点: 原文の「type は 2 つ」と合わない（推測。原文はタスクの type を言っていない）。
- 推奨: 木は `parent_id`、紐付けは関連の表。理由: 木は 1 親で足り、紐付けは多対多になりうる（推測）。

### 未決 #8: remote-cap / worker が分解したタスクの記録

§5.3。
- 案 A（推奨）: master-cap の記憶の中だけ（result / report から抽出）。利点: 利用者の決定（書き込みは master-cap の記憶だけ。`external-memory.md:39`）を変えず、RLS（`001_init.sql:118`）も触らない。欠点: 抽出の LLM 頼みで、分解の粒度は result / report の本文に書かれた分だけ。remote-cap の中の分解は漏れうる。
- 案 B: cap の記憶（agent = cap_id）にも書く。利点: cap 側の分解を直接記録できる。欠点: 利用者の決定（`external-memory.md:39` `:44`）を変える。RLS が agent ごとに行を隔てる（`001_init.sql:118`）ので、親（master-cap の記憶の requirement）を cap 側の木から辿れず、木が分断される。cap 側の抽出の LLM 呼び出しが増える（`external-memory.md:44` の理由）。
- 案 C: 親の参照だけ `(agent_id, item_id)` の文字列で持つ。利点: 書き込みの決まりを変えずに cap 側の分解を持てる。欠点: 親を読めるのは各 agent 自身の範囲だけで、木として読めない。
- 推奨 A。

### 未決 #9: requirement の進み具合の持ち方

原文は requirement / タスクの状態を言っていない。
- 案 A（推奨）: 状態の列を持たず、既存の `activeTasks` と同じ規則で event から導出する（task の後続 `result` が無い = 未完了。`recall.ts:182-188`）。利点: 利用者が決めていない状態を足さない。欠点: master-cap が自分で分解した task（remote_send 無し）は event が無く導出できない。
- 案 B: `status`（未着手 / 進行 / 完了 / 取消）の列。利点: 全ノードに使える。欠点: 利用者が決めていない仕様を足す。更新の担い手が要る。
- 推奨 A。ただし remote_send 無しのタスクの扱いは残る。

### 未決 #10: recall / context での出し方

§7.1。
- 案 A（推奨）: recall に `recordType` / `category` の絞り込みを足し、context に `openRequirements` と `specs` を足す。利点: tool が増えず、起動時と判断前に context / recall を呼ぶ既存の運用（`external-memory.md:35`、`system-instructions.ts:173-186`）で読める。エージェントの設計は `inferred` と明示して出せる。欠点: context の出力が大きくなる（今は各 10 件。`recall.ts:172`）。recall の入力 schema の変更で tool の互換に注意が要る。
- 案 B: 別の tool（`requirement_tree` など）。利点: 既存の recall / context が変わらず、影響が分離する。欠点: tool 名と system 指示の案内の追加。agent が使い分ける必要がある。resession 設計の読み出しの口（§8.2 接点 3）と tool が増える。
- 案 C: context だけに足す。利点: 変更が小さい。欠点: category や木の絞り込み検索ができず、context の件数上限の外の requirement は読めない。
- 推奨 A。

### 未決 #11: Graphiti にツリーを反映するか

- 案 A（推奨）: 反映しない。本文（content）だけを今まで通り episode にし、木は PostgreSQL を正にする。利点: Graphiti の未決（`memory-graphiti.md` 未決 1〜5）と独立。欠点: 木の関係は Graphiti の検索に出ない。
- 案 B: episode の本文に親の要約・category を入れる。利点: 検索に効く（推測）。欠点: LLM 負荷が増え、親の更新時に再投入が要る。
- 推奨 A。

### 未決 #12: 同文の requirement と content の長さ

- 同じ (agent, 型, 正規化 content) は畳まれる（`001_init.sql:59`）。同じ依頼を別の時期に出した時に 1 件になる。
- content は 2000 文字まで（`001_init.sql:47`）。仕様・設計のまとめがそれを超える時がありうる（推測）。
- 案 A（推奨）: 新しい type は dedup の index に `record_type` と親を含め、content の上限は仕様・設計だけ緩める。欠点: migration が要る。案 B: 変えない。欠点: 同じ依頼の再発行が畳まれ、長い仕様が登録できない。

## 10. 調べて分からなかった事

- resession 設計（`docs/design/resession.md`）は読んだが、`handoff` event を抽出に通すか外すか（§8.2 接点 4）と、未完了の判定の元（center の pending と memory の event。接点 7）の突き合わせは、resession 設計がまだ決めていない。
- 抽出 LLM（chatp 経由の `claude -p`）が、1 発言から複数の requirement を分けられる精度か。実機で未測定（`memory-graphiti.md:73` と同様、本物の LLM は触っていない）。
- master-cap が分解したタスク（remote_send 無し）を、どの event で捉えるか。今の event 種別（§1.1）に該当が無い（`assistant_message` の本文から抽出するしかない。推測）。
- 利用者の「種類？」の意図（未決 #3）。

## 11. 実装に入る時の順序（案。推測）

1. 利用者が #1〜#12 を決める。resession の設計と #1・#10 を突き合わせる（§8）。
2. migration（列・関連の表・RLS。新しい表も `001_init.sql:118` と同じく agent_id で隔てる）。
3. 抽出 prompt / schema の拡張（`extract.ts:74-124`）と test。
4. recall / context の拡張（`recall.ts`）と tool schema・system-instructions の案内。
5. 本番適用は利用者の作業（`memory-graphiti.md:69` と同じ扱い）。
