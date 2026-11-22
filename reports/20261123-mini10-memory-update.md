# mini10 外部記憶の入れ替え（2026-11-22 実施）

## 実施
- branch `fix/memory-graphiti-healthcheck`（develop d9990c4 から。remote に同名 branch は無かった）に healthcheck 修正を commit・push。
- test → backup → migration 004/005 → 入れ替え → 再起動 → graphiti-mcp の作り直し。

## Graphiti の healthcheck（根拠）
- image 既定の healthcheck: `curl -f http://localhost:8000/health`（docker inspect の Config.Healthcheck）。待受は `GRAPHITI_MCP_PORT`=7931 なので常に失敗（FailingStreak 3015、`curl: (7) Failed to connect to localhost port 8000`）。
- 実測: `curl http://127.0.0.1:7931/health` → `200 {"status":"healthy","service":"graphiti-mcp"}`。container 内に curl あり（wget・python3 は無い）。
- 修正: compose.yaml の graphiti-mcp に `healthcheck: curl -sf http://127.0.0.1:$${GRAPHITI_MCP_PORT:-7931}/health`（interval 10s / timeout 5s / retries 3 / start_period 15s）。
- commit: f77ecd9（push 先 fix/memory-graphiti-healthcheck）。

## test（入れ替え前）
- `npm run typecheck`: 通過。
- `npm test`: tests 199 / pass 198 / fail 1 / skipped 0。docker の PostgreSQL integration も実行（skip なし）。
- 失敗 1 件は既知: `test/integration.pg.test.ts` の「並行: 同時に走らせた extractForAgent が同じ event を二重に取らない」（`20 !== 60`）。他に失敗なし。

## backup と戻し方
- 取得: 2026-11-22T22:52:09Z、`pg_dump -Fc`（memory_owner、DB memory）。
- 置き場: `/home/vagrant/bantou-backups/memory-before-004-005-20261122.dump`（40,213,642 byte、`pg_restore -l` で TABLE DATA 9 件を確認。消さない）。
- 戻し方（code）: `cd ~/bantou/packages/memory && rm -rf .output && mv .output.prev .output && systemctl --user restart bantou-memory`（`.output.prev` = 入れ替え直前の `.output`。source は git でない copy のため退避していない。必要なら `git checkout d9990c4` の同ファイルで戻す）。更に古い 11/11 の `.output.prev` は `.output.prev-20261111` に改名して残してある。
- 戻し方（DB）: migration は戻さない方針。DB ごと戻す時は service を止め、dump から restore する（`docker exec -i memory-postgres pg_restore -U memory_owner -d memory --clean --if-exists < <dump>`）。ただし dump 以降の event・outbox は失われる。

## migration
```
 001_init             | 2026-11-11 00:18:01
 002_embed_retry      | 2026-11-20 11:42:41
 003_graphiti_outbox  | 2026-11-22 14:22:07
 004_requirement_spec | 2026-11-22 22:52:30
 005_handoff_kind     | 2026-11-22 22:52:30
```
memory_events_kind_check:
`CHECK ((kind = ANY (ARRAY['user_prompt','assistant_message','task','result','report','reply','handoff'])))`

## 入れ替え
- clone で `npm install --no-package-lock --workspaces=false` → `npm run build` → `~/bantou/packages/memory` に source を rsync（node_modules/.nuxt/.output*/.env 除外）、`.output` を rsync --delete、`systemctl --user restart bantou-memory`（22:53:14）。
- `docker compose --profile graphiti up -d --no-deps graphiti-mcp` で memory-graphiti だけ作り直し（neo4j・postgres・ollama は触っていない）。

## 観測
- service: `Listening on http://0.0.0.0:7930`、`systemctl --user is-active bantou-memory` = active。`/health` の route は無い（404）ので、MCP の `initialize`（200、serverInfo bantou-memory）と `status` tool の応答を health とした。
- MCP tools/list: `context, event, explain, handoff, recall, status`（handoff が引継ぎを引く道具）。
- Graphiti: memory-graphiti `healthy`、memory-neo4j `healthy`。`curl 127.0.0.1:7931/health` → `{"status":"healthy","service":"graphiti-mcp"}`。

## Graphiti 向けの送り待ち（outbox_events）
| 時刻(UTC) | 送り待ち(未処理・未失敗) | processed | failed | sent 済み未確認 | 最終 processed |
|---|---|---|---|---|---|
| 22:52:19（入れ替え前） | 14227 | 555 | 204 | 140 | 21:51:00 |
| 22:58:06（入れ替え後） | 14264 | 557 | 217 | 140 | 22:56:00 |
- 消えずに残り、入れた後も毎分の run が送信・確認を続けている（processed 555→557、22:55 と 22:56 に confirmed=1）。

## 問題・想定と違った点
- 入れ替え前の `.output` は、installed の source（develop 相当）に無い graphiti の処理を既に含んでいた。source と .output の不一致が元からあった。
- dead-letter（failed）が増え続けている（204→217、数分で +13）。chatp の HTTP 502 や Graphiti 側の失敗が背景と思われる（推測）。今回は未調査。判断が要る残件。
- 配置時に旧 `.output.prev` を rm せず改名した。`.output.prev-20261111` は不要なら利用者が消してよい。
