# 外部記憶（external memory）の接続設計

2026-11-11 決定。横断 PM 向け Persistent Memory 基盤（設計書の原文は `memory-design.md`。実装は `packages/memory`、以下「memory」）を、bantou に**後付けで**つなぐための bantou 側の形と、memory 側の実装方針。

## 何を決めたか

- memory は bantou monorepo の `packages/memory`（bantou と密結合: event の形、session 名 = Agent ID、tool 名）。動くのは 202 の別プロセス。記憶の抽出（LLM）・保存（PostgreSQL / Graphiti）・検証・スコープ・昇格はすべて memory 側。bantou は素材を渡し、問い合わせる入口を持つだけ。
- bantou から見た memory は **MCP server**（Streamable HTTP）。center の「外部記憶設定」に endpoint を登録すると使える。登録が無ければ今まで通り動く（これが後付け）。
- 経路は 2 本。**書き込み**（素材を memory に渡す）と**読み込み**（記憶を問い合わせる）。

## 対応関係（memory の設計書 ↔ bantou）

| memory の設計書 | bantou |
|---|---|
| 横断 PM | master-cap（session の対話型 `claude --remote-control`） |
| 個別 PM | remote-cap（server 上のオーケストレーター）とその worker |
| Agent ID | session 名（設定で `agentId` を上書きできる。session は改名できるため） |
| AgentMessage の task_id / correlation_id | `remote_send` の remote_id / task_id |
| Identity Memory | center の system-instructions + 設定の `instructions`（既存。変更なし） |

## 設定（外部記憶設定）

`docs/design/project-settings.md` の項目として足す。center 共通と session の両方に持て、session の値があれば共通の値は使わない（outputStyle と同じ規則）。

| 項目 | 型 | 意味 |
|---|---|---|
| `memory` | `{ url: string, token?: string, agentId?: string } \| null` | memory の MCP endpoint。`url` は必須。`token` は `Authorization: Bearer`（master-cap へは環境変数で渡し、argv・ファイルには書かない）。`agentId` 省略時は session 名 |

desktop の設定ダイアログ（共通・歯車・追加）に「外部記憶」の欄（URL / token / agent ID）。

## 読み込み（master-cap → memory）

- center が session を起動するたび、設定があれば `--mcp-config` の `mcpServers` に `memory`（`type: "http"`, `url`, `headers: { Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}", "X-Agent-Id": <agentId> }`）を足す。token は環境変数 `BANTOU_MEMORY_TOKEN` で渡す（`BANTOU_SESSION_TOKEN` と同じ扱い）。
- master-cap は `mcp__memory__*`（recall / context / explain など、memory が公開する tool）を直接呼ぶ。center は中継しない。tool が増えても center は無変更。
- system-instructions に部品 `memory@1` を足す（設定がある時だけ付く）: 起動時と判断の前に context / recall を呼ぶ運用の案内。書き込みは案内しない（下記のとおり bantou 側が自動で渡す）。

## 書き込み（bantou → memory）

素材は 2 種類。どちらも memory の `event` tool を、center / server が **MCP client として**（Streamable HTTP、`Authorization: Bearer`、`X-Agent-Id`）呼ぶ。LLM での抽出・要約は bantou ではしない。実装は共有モジュール `packages/protocol/src/memory.ts`（eventId の組み立て・body 整形・NUL 除去・切り詰め・キューの状態機械・MCP sink）。protocol は @types/node 無しで build され desktop も使うため、**Node 固有の処理は protocol に置かず注入**する: digest は `HexDigest`（center / server が `node:crypto` の sha256 で実装して `makeEventId` / `digest8` に渡す）、MCP の `Client` / `StreamableHTTPClientTransport` は center / server が自分の `@modelcontextprotocol/sdk` のものを `createMcpEventSink` に渡す、timer は `setTimeout` の返り値に `unref` があれば呼ぶ（型安全に）。

### 担当表（誰が・どの記憶へ・何を書くか）

同じ出来事を center と server の両方が見るが、書き先の **agent（X-Agent-Id）が別**で、eventId の名前空間も別（center `c1:` / server `s1:`）。1 つの記憶（agent）に同じ出来事が 2 回入ることは無い。

| 出来事 | center（master-cap の記憶。agent = `agentId` か session 名。`c1:`） | server（cap の記憶。agent = cap_id。`s1:`） |
|---|---|---|
| 利用者の発言（hook `UserPromptSubmit`） | `user_prompt` | — |
| master-cap の応答（hook `Stop`） | `assistant_message` | — |
| `remote_send` の task | 送信時 `task`（sender session → recipient cap） | 受付時 `task`（sender session → recipient cap） |
| `cap_result` / `task_result` | 受信時 `result`（send の返信と遅れた返信の両方。同じ内容は同じ eventId） | center へ返す時 `result`（`task` / `kick_cap` の返信と report 起因の返信の両方） |
| `worker_report` | 受信時 `report`（sender worker → recipient session） | `/mcp` の report 受信時 `report`（sender worker → recipient cap） |
| `worker_reply` | 送信時 `reply`（sender session → recipient worker） | worker に渡せた時 `reply`（sender session → recipient worker） |

- 理由: 設計上、横断 PM（master-cap）と個別 PM（remote-cap + worker）は別の agent で記憶も別（recall の `agentIds` は自分だけ）。master-cap は自分が見た往復、cap は自分が見た往復を、それぞれ自分の agent の記憶に持つ。center が server の見たものを代理で書く（または逆）と、片方の障害（center 停止中に届く report 起因の結果、server が記憶に届かない間の往復）で欠ける。
- 比較した別案: 往復の区間で担当を分ける（center = master-cap ↔ cap の task / result、server = cap ↔ worker の report / reply）。1 つの agent に各出来事が 1 回だけ入るが、master-cap の記憶に worker の report / reply が入らず、cap の記憶に task / result が入らない（どちらも自分が関わった往復の片方を失う）。採らなかった。
- 衝突: 利用者が `agentId` に cap_id と同じ値を入れると両者が同じ agent に書く（eventId は名前空間が違うので別 event として二重に入る）。cap_id は `c-<center の id>-<session>` なので通常は起きない。
- cap の記憶は今は誰も読まない（master-cap の `memory` MCP は session の agent のみ。cap / worker に memory の MCP は渡していない）。書き込みだけ先に入れる。

### 経路と形

1. **cap 間・worker の往復**: 既存の tool / protocol の処理に埋め込む。新しい通信は足さない。
   - center: `remote_send` の送信時（task）、`cap_result` / `task_result` の受信時（result）、`worker_report` の受信時（report）、`worker_reply` の送信時（reply）。session の記憶が無ければ何もしない（owner の session が無い旧共有 cap の report は書かない）。
   - server: center から endpoint を受け取る。**`task` に `memory` を載せる**（protocol 1.9.0。`{ url, token?, agent_id?, session? }`。`agent_id` は center が cap_id にする）。理由: (a) cap ごと・task ごとに書き先（session の memory 設定）が違い、cap / worker ごとに agent が異なる。task は常に session → cap の向きで届き、cap_id と対応づけられる。(b) hello 系（server 全体の識別）は session の設定を持たない。(c) 設定変更は次の task で反映され、memory を外した task で止められる（状態を server に永続化しない）。比較した別案: hello 系で server 全体に 1 つ渡す（session ごとの設定・agent を表せない）、専用コマンド `set_memory` を足す（コマンドが増え、送り忘れの状態が server に残る）。server は cap ごとにメモリだけで保持する（token をファイルに書かない）。
   - event の中身: 送り手・受け手（session 名 / cap_id / worker_id）、remote_id / task_id、種別（task / result / report / reply）、本文、時刻。`event_id` を冪等キーにする。
2. **利用者の発言**: center が activity 用に全 session へ付けている hook（`bantou-center hook`）の payload に確定後の本文が入る。center はそれを event として渡す。
   - desktop からの発言も claude.ai の remote-control からの発言もこの hook を通る。pty の入力（`POST /sessions/<name>/input`）は生のキー入力で、remote-control 分も通らないため使わない。
   - hook の payload（公式 docs https://code.claude.com/docs/en/hooks で確認）: 共通の `session_id` / `prompt_id`（user prompt を表す UUID。最初の入力までは無い）/ `hook_event_name` など。`UserPromptSubmit` は `prompt`（貼り付けは展開済み。`<pasted_content id>` の行が付く場合がある）、`Stop` は `last_assistant_message`（transcript は最終 message を含まないことがあるので hook ではこちらを使う）と `stop_hook_active`。`StopFailure` の `last_assistant_message` は API の error 文なので使わない。`UserPromptSubmit` の公式の例の JSON には `prompt_id` が載っていないため、center は `prompt_id` があれば使い、無くても発火時刻（center の `hook` サブコマンドが付ける `bantou_ts`）で区別する。
   - master-cap の応答本文は `Stop` hook の payload の `last_assistant_message` から取る（claude 2.1.322 で実測。transcript は読まない）。pty の text は TUI の差分描画で空白・文字が落ちるので素材にしない。`--output-format stream-json` は `-p` 専用で `--remote-control` には付かない。
   - hook は center が activity 用に既に全 session へ付けているもの。memory のために hook は増えない（payload を使い回す）。2026-11-11 に hook でよいと決めた。
3. **送信は非同期・失敗しても bantou の処理を止めない**。center / server に小さな送信キュー: (owner, memory url, agent) ごとの FIFO、順序保持、失敗は 1s から倍々で最大 60s の backoff で再試行、上限 1000 件を超えたら古い分から捨てて log、memory が入力検証で拒否（`isError`）したものは log して捨てる（再試行しても直らない）。hook の処理はキューに積むだけで即 return する。log は eventId と理由のみ（本文・token・url は出さない）。

### eventId の設計

`<ns>:<session か cap_id>:<種別>:<部品…>`（`[A-Za-z0-9_.-]` 以外は `_`、128 文字を超えたら末尾を digest）。満たす 2 条件:

- **再送で同じ eventId**: 部品は出来事そのものから決まる値だけ（task_id、hook の発火時刻と prompt_id、server が付けた report の `at`、本文の digest）。キューの再試行は同じ event を再送するので同じ id。同じ hook 呼び出しや同じ通知が再度届いても同じ id になり、memory が `duplicate` で弾く。
- **同じ内容の別の発言は別の eventId**: 発言は hook の発火時刻 ms（と prompt_id）を含むので、同じ本文でも別の発話は別 id。同じ task_id の別の結果（report 起因の task_result）は本文の digest で区別する（本文も同じなら同じ結果の再通知として 1 件にまとまる）。

### 後方互換（protocol 1.9.0）

`task` の `memory` は任意の追加項目で、古い server は無視する（guard は未知項目を許す）。MESSENGER_PROTOCOL を 1.9.0 に上げたので、center の既存の版の門（宣言された版が center と違えば送らない）により、1.8.x の server は他の版上げと同じく更新されるまで task / kick_cap を断られる。center は `supportsMemory(peer.version)`（`MEMORY_MIN_PROTOCOL = "1.9.0"`）の時だけ `memory` を添える。memory が無い・届かない時は server は何も書かず、cap / worker は今までどおり動く。

## bantou がやらないこと

- 記憶候補の抽出、確定 / 推測の判定、重複・矛盾の検証、スコープ（private / shared / organizational）と昇格、Graphiti への反映。設計書 §5〜§12 はすべて memory 側。
- transcript の読み取り。
- session の制御（`--continue` をやめて memory から文脈を組み立て直す、compact の代替）。今回の範囲外。別設計にする。

## memory 側の実装方針（`packages/memory`）

- 言語は TypeScript。Python / FastAPI は使わない。
- 本体は Nuxt 4。MCP server は `@nuxtjs/mcp-toolkit`（0.24 系。`server/mcp/tools/*.ts` に `defineMcpTool` で tool を置く）。読み込み用の recall / context / explain と、書き込み用の event を同じ MCP に出す。認証は Bearer token（bantou の設定の `token`）。
- 保存は PostgreSQL + pgvector（System of Record、イベント、Outbox）。
- 抽出 LLM は `claude -p`（サブスク。API / litellm は使わない）。呼び方は上記の別プロジェクト（OpenAI 互換 endpoint）経由で、その中身が `claude -p --output-format json --json-schema <schema> --no-session-persistence --tools ""`。起動コストがあるので event ごとではなく turn の区切りや件数でまとめて 1 回。202 の claude は 2.1.322、claude.ai でログイン済み（Linux なので credentials.json。keychain の問題は無い）。
- Graphiti は Python 実装しか無い（graphiti-core）ので、Python のまま使う。Graphiti の Python サービス（公式の MCP server）を 202 で常駐させ（docker）、TypeScript の memory から MCP client として呼ぶ（2026-11-11 決定）。memory の Python はこの 1 つだけ。Graphiti は Neo4j に書き、抽出・矛盾判定に LLM、意味検索に embedding を使う（`llm_client` と `embedder` は別部品）。
  - LLM: Graphiti の OpenAI client は `base_url` を差し替えられるので、OpenAI 互換の `POST /v1/chat/completions` を `claude -p --json-schema` で返す**別プロジェクト `unagents/chatp`**（TypeScript / Nitro 単体、202 に常駐）を指す。memory の抽出 worker も同じ endpoint を使い、`claude -p` を直接は呼ばない。API は使わない。memory 固有ではないので memory には入れない（2026-11-11 決定）。
  - embedding: Anthropic に embedding model は無い（Anthropic 用 embedder も無い）。202 の Ollama のローカル model（例 `nomic-embed-text`）を使う。pgvector 側も同じ embedding を使う。
- 設置は 202（mini10。Linux x86_64、8 core、RAM 16 GB、disk 空き 341 GB、docker あり）。PostgreSQL は mflow-postgres と分けて pgvector 入りの別コンテナ。Neo4j を入れる時は heap 1 GB / page cache 512 MB 程度に上限を切る。MCP は平文 HTTP なので LAN / Tailscale 内に限る。

## 比較した案

- 読み込み: (A) center が memory の tool を `/mcp/session` に中継する、(B) `--mcp-config` に memory を直接足す。(B) を採用。tool の増減で center を変えない。
- 書き込みの素材: (A) hook（Stop + transcript）で全部取る、(B) 通信（tool 処理）に埋め込み + 利用者の発言だけ既存 hook。(B) を採用。center が会話ログのファイルを読まない。
- memory との接続: (A) agent-messenger の peer（server と同じ発見）、(B) MCP endpoint を設定に登録。(B) を採用。memory は MCP server として作る前提で、後付けの入口が設定 1 つで済む。

## 段階

1. memory 側の Phase 1（登録・検索の MCP tool）と同時: center の `memory` 設定 + `--mcp-config` 注入 + desktop の設定欄 + system-instructions `memory@1`。
2. memory 側の書き込み tool が決まったら: center / server の埋め込み（通信 + 利用者の発言・応答）と送信キュー。
3. それ以降（memory の Phase 3〜5）: bantou は無変更。
4. session の制御（`--continue` 廃止、文脈の組み立て直し）は別設計。読み書きの経路はそのまま使う。

## 要確認（memory 側）

- 書き込み tool の名前と event の形（bantou の event の項目は上記）。
- Agent ID の正。session 名でよいか、固定 ID を設定で渡すか。
- Ollama の embedding model の選定（日本語の品質）。
