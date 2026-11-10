# 外部記憶（external memory）の接続設計

2026-11-11 決定（設計のみ。実装はまだ）。横断 PM 向け Persistent Memory 基盤（別リポ、以下「memory」）を、bantou に**後付けで**つなぐための bantou 側の形と、memory 側の実装方針。

## 何を決めたか

- memory は bantou の外にある別サービス。記憶の抽出（LLM）・保存（PostgreSQL / Graphiti）・検証・スコープ・昇格はすべて memory 側。bantou は素材を渡し、問い合わせる入口を持つだけ。
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

素材は 2 種類。どちらも memory の書き込み tool（memory が公開する `event` 相当。名前は memory 側で決める）を、center / server が **MCP client として**呼ぶ。LLM での抽出・要約は bantou ではしない。

1. **cap 間・worker の往復**: 既存の tool / protocol の処理に埋め込む。新しい通信は足さない。
   - center: `remote_send`（task）の送信時、`cap_result` / `task_result` / `worker_report` の受信時、`worker_reply` の送信時。
   - server: remote-cap への task 投入、worker の report / reply、cap_result の返送時。server は memory の endpoint を center から受け取る（protocol に `memory` を足す。無ければ何もしない）。
   - event の中身: 送り手・受け手（session 名 / cap_id / worker_id）、remote_id / task_id、種別（task / result / report / reply）、本文、時刻。`event_id` を冪等キーにする（memory 側の Outbox と同じ）。
2. **利用者の発言**: center が activity 用に全 session へ付けている hook（`bantou-center hook`、`UserPromptSubmit`）の payload に確定後の本文が入る。center はそれを event として渡す。
   - desktop からの発言も claude.ai の remote-control からの発言もこの hook を通る。pty の入力（`POST /sessions/<name>/input`）は生のキー入力で、remote-control 分も通らないため使わない。
   - master-cap の応答本文は `Stop` hook の payload の `last_assistant_message` から取る（claude 2.1.322 で実測。transcript は読まない）。center はこれも event として渡す。pty の text は TUI の差分描画で空白・文字が落ちるので素材にしない。`--output-format stream-json` は `-p` 専用で `--remote-control` には付かない。
   - hook は center が activity 用に既に全 session へ付けているもの。memory のために hook は増えない（payload を使い回す）。2026-11-11 に hook でよいと決めた。
3. 送信は非同期・失敗しても bantou の処理を止めない。center / server に小さな送信キュー（順序保持、再試行、上限を超えたら古い分から捨てて log）。

## bantou がやらないこと

- 記憶候補の抽出、確定 / 推測の判定、重複・矛盾の検証、スコープ（private / shared / organizational）と昇格、Graphiti への反映。設計書 §5〜§12 はすべて memory 側。
- transcript の読み取り。
- session の制御（`--continue` をやめて memory から文脈を組み立て直す、compact の代替）。今回の範囲外。別設計にする。

## memory 側の実装方針（別リポ）

- 言語は TypeScript。Python / FastAPI は使わない。
- 本体は Nuxt 4。MCP server は `@nuxtjs/mcp-toolkit`（0.24 系。`server/mcp/tools/*.ts` に `defineMcpTool` で tool を置く）。読み込み用の recall / context / explain と、書き込み用の event を同じ MCP に出す。認証は Bearer token（bantou の設定の `token`）。
- 保存は PostgreSQL + pgvector（System of Record、イベント、Outbox）。
- 抽出 LLM は `claude -p`（サブスク。API / litellm は使わない）。`claude -p --output-format json --json-schema <候補の schema> --no-session-persistence --tools ""` を Nitro の worker から subprocess で呼ぶ。起動コストがあるので event ごとではなく turn の区切りや件数でまとめて 1 回。202 の claude は 2.1.322、claude.ai でログイン済み（Linux なので credentials.json。keychain の問題は無い）。
- Graphiti は Python 実装しか無い（graphiti-core）ので、Python のまま使う。Graphiti の Python サービス（公式の MCP server / REST）を 202 の別コンテナで動かし、TypeScript の memory から呼ぶ（2026-11-11 決定）。memory の Python はこの 1 つだけ。Graphiti 自身の抽出・embedding は LLM client（API か Ollama）を要する。どちらにするかは memory 側で決める。
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
- Graphiti の LLM client（API か Ollama）。
