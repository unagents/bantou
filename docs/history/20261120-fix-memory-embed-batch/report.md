# fix/memory-embed-batch（外部記憶の埋め込みが止まる不具合）

2026-11-20。`packages/memory` だけを変えた（center / protocol は無変更）。deploy はしていない（review の後、別の者が行う）。

## 原因（2026-11-20 の実測で確定していたもの）

- `embedPending` が agent ごとに「埋め込み未設定の古い順 100 件」を 1 回の `/api/embed` で送っていた。timeout は chatp と共有の 120 秒。memory の host の CPU は遅く、100 件は 120 秒に収まらない。失敗しても何も記録しないので、次の run も同じ先頭 100 件を送り、永久に進まない。全 830 記憶のうち 400 件が埋め込み無しで、recall に出ていなかった。
- 失敗は Nitro task の戻り値に入るだけで、log に 1 行も出ていなかった。
- 失敗し続ける埋め込みが Ollama の CPU を使い続け、recall の query の埋め込みが同じ列で 44〜94 秒待つ事があった。

## 直した事

| 事 | 場所 |
|---|---|
| 小分け・新しい順・1 件ずつへの fallback・失敗の後回し・時間上限・全滅で打ち切り・agent の交互 | `packages/memory/server/utils/embed.ts`（`embedBacklog`） |
| recall の query を優先する門（`EmbedGate`）と query 用の embedder | `packages/memory/server/utils/embed.ts`（`createEmbedGate` / `createQueryEmbedder`）、`server/utils/runtime.ts`、`server/utils/tools.ts`（`handleRecall`） |
| Ollama client: timeout を `EmbedTimeoutError` に、呼び出しごとの timeout、error に本文を入れない | `server/utils/embed.ts`（`createOllamaEmbedder`） |
| recall が埋め込みを取れない時は `EmbedUnavailableError`（理由つき）で早く返す | `server/utils/recall.ts` |
| timeout の設定を分けた、件数・時間上限の設定 | `server/utils/config.ts` |
| run 1 回（抽出 → 埋め込み）と log、process 内の重複実行の防止、直近の error の保持 | `server/utils/worker.ts`（`runCycle`）、`server/tasks/memory/extract.ts` |
| 状態を返す MCP tool `status` | `server/mcp/tools/status.ts`、`server/utils/status.ts`（`buildStatus`） |
| 失敗管理の列 | `migrations/002_embed_retry.sql` |

## 決めた事と理由

- **小分けの件数: 既定 2**（`MEMORY_EMBED_BATCH`）。Ollama は入力を順に計算するので、件数を増やしても全体の速さはほぼ変わらない。一方、送信済みの 1 回は止められないので、recall の query が待つ最長時間は小分け 1 回分になる。1 件 10〜15 秒の見積もりなら 2 件で 20〜30 秒。待ち時間を短くする方を取った。
- **埋め込みの timeout: 既定 60 秒**（`MEMORY_EMBED_TIMEOUT_MS`）。2 件 × 15 秒 = 30 秒の 2 倍。chatp の timeout とは別の設定で、`MEMORY_HTTP_TIMEOUT_MS` は引き継がない（chatp に合わせて延ばした値で Ollama を長く待たないため）。`MEMORY_HTTP_TIMEOUT_MS` は chatp の timeout として残し、`CHATP_TIMEOUT_MS` があればそちらを使う。
  - 互換の注意: これまで `MEMORY_HTTP_TIMEOUT_MS` で Ollama の timeout も変えていた設置は、`MEMORY_EMBED_TIMEOUT_MS` を足す必要がある（memory の host の env には上書きが無いと聞いているので、影響しない）。
- **1 回の run の時間上限: 既定 45 秒**（`MEMORY_EMBED_RUN_MS`）。task は毎分なので 1 分より短くした。上限を過ぎたら新しい小分けを始めない。小分けが失敗した直後の 1 件目だけは上限を過ぎていても試す（上限で止めると、次の run も同じ小分けで時間切れになり、元の不具合の小型版になる）。1 run の最長はおよそ 上限 + timeout × 2。
- **run は重ならない**（確かめた事）。Nitro の `runTask`（`nitropack/dist/runtime/internal/task.mjs`）は、同名の task が実行中なら実行中の Promise を返し、新しい実行を始めない。毎分の起動が積み上がる事は無い。加えて `runCycle` が process 内で実行中なら `skipped` で戻る。抽出側の排他（`claimed_at` の lease と `FOR UPDATE SKIP LOCKED`）は変えていない。埋め込みには process をまたぐ排他は足していない（二重に埋めても結果は同じで、service は 1 process）。
- **順序: 新しい順**（まだ失敗していない item を `created_at DESC`）。理由: 溜まった 400 件を古い順に消化すると、今日入った記憶が最大で 400 件分待つ。新しい順なら、今入った記憶は次の run（1 分以内）で recall に出る。古い分は新しい分が無い時間に消化される。記憶が絶えず入り続けて消化が追いつかない場合は古い分が後ろに残るが、`status` の `oldestPendingCreatedAt` と log の `remaining` で見える。
- **失敗した 1 件の扱い: 記録して後回し**。小分けが失敗 → 1 件ずつ → それでも失敗した item に `embed_attempts + 1` / `embed_failed_at` / `embed_error`。次に試すのは 60 秒 × 2^(回数-1)（上限 1 時間）の後で、順序は未失敗の item の後ろ。成功すれば記録は消える。諦める上限は置いていない（最長でも 1 時間に 1 回の再試行で、Ollama 側が直れば自然に埋まる）。
  - 抽出のような「内容起因 / 障害」の区別はしていない。代わりに、**小分けの全件が失敗したらその run を打ち切る**。Ollama が落ちている間に失敗が付くのは 1 run あたり小分け 1 回分（既定 2 件）で、復旧後は数分で再試行される。先頭の小分けが全て本当に通らない item だった場合は、その run は進まないが、次の run は別の item から始まる。
  - 小分けでは通らず 1 件ずつなら通る時は、その run の残りを 1 件ずつ送る。
- **query を塞がない仕組み**。小分けにするだけでは足りないと判断した（消化が休みなく次の小分けを送ると、query は毎回その後ろに並ぶ）。recall の query は門を通し、query が実行中・待ち中の間は消化が次の小分けを送らない。query が待つのは最長で送信済みの小分け 1 回分。query の timeout は `MEMORY_RECALL_EMBED_TIMEOUT_MS`（既定 60 秒 = 小分け 1 回の最悪 30 秒 + 自分の 15 秒に余裕）。過ぎたら recall は `recall: query の埋め込みを取得できない（ollama embed timeout …）。時間を置いて再試行すること` の error を返す（MCP の `isError`。toolkit が throw を変換する）。以前は 120 秒固まった。
- **状態の口は MCP tool**（`status`）にした。HTTP の口は足していない（middleware が `/mcp` 以外を 404 にしていて、認証と agent の制限が `/mcp` の中にあるため）。入力は無し（inputSchema に正規表現は無い）。数えるのは認証済み agent の行だけ（SQL の条件 + RLS）。本文は返さない。
- **log**。件数が動いた agent と error だけを 1 行ずつ。何も無い run は 0 行。agent ID・件数・item の ID・error の要旨（200 字まで）だけで、本文・token・URL は出さない。Ollama の error には応答の body を入れない（入力が写っている恐れがあるため）。

## 設定の一覧

| 名前 | 既定 | 新旧 |
|---|---|---|
| `MEMORY_EMBED_BATCH` | 2 | 新 |
| `MEMORY_EMBED_RUN_MS` | 45000 | 新 |
| `MEMORY_EMBED_TIMEOUT_MS` | 60000 | 新 |
| `MEMORY_RECALL_EMBED_TIMEOUT_MS` | 60000 | 新 |
| `CHATP_TIMEOUT_MS` | `MEMORY_HTTP_TIMEOUT_MS` の値 | 新 |
| `MEMORY_HTTP_TIMEOUT_MS` | 120000 | 既存。chatp だけに効くようになった |

再試行の間隔（60 秒 〜 1 時間）は定数（`EMBED_RETRY_BASE_SEC` / `EMBED_RETRY_MAX_SEC`）。

## migration

`packages/memory/migrations/002_embed_retry.sql`。`memory_items` に `embedded_at` / `embed_attempts`（既定 0）/ `embed_failed_at` / `embed_error` を足し、埋め込み待ちの部分 index を作り、埋め込み済みの行の `embedded_at` を `updated_at` で埋める。

- 全て `IF NOT EXISTS` / `WHERE embedded_at IS NULL` で、何度当てても同じ。列の追加は定数の既定値だけなので表を書き換えない。
- 旧版の code は足した列を見ないので、**migration を先に当てて、その後で code を切り替える**。逆順だと、新しい code の埋め込みと `status` が「列が無い」で失敗する（log に出る。data は壊れない）。
- `memory_app` は `memory_items` に表単位の SELECT / INSERT / UPDATE を持つので、GRANT の追加は不要。
- 当て方は 2 通り。owner の接続（migration 専用の role）で行う。
  1. `pgmigrations` 表に `001_init` が記録されている場合（`SELECT name FROM pgmigrations`）: `cd packages/memory && DATABASE_URL=<owner の接続> npm run migrate -- up`。
  2. 記録が無い場合（001 を psql で直接当てていた等。`migrate up` は 001 を当て直そうとして失敗する）: `002_embed_retry.sql` の `-- Up Migration` から `-- Down Migration` の手前までを、owner の psql でそのまま流す。
- どちらで当てたかは未確認（この作業では memory の host にも DB にもつないでいない）。

## deploy の手順（未実施）

`packages/memory/README.md` の「起動」と `docs/design/external-memory.md` の「設置の記録」に合わせる。memory の host では `nuxt build` が落ちるので、build は作業用の Mac で行う。

1. 作業用の Mac: `bun install --frozen-lockfile`（repo root）、`cd packages/memory && npm run build`。
2. memory の host の repo を、この branch を含む版に更新する（`migrations/` と `bin/` が要る）。
3. memory の host: migration 002 を当てる（上の「当て方」）。この時点では旧版の service が動いたままでよい。
4. 作業用の Mac → memory の host: `packages/memory/.output/` を rsync する（`--delete` 付きで、配置先は unit の `WorkingDirectory` の下の `.output/`）。
5. memory の host: `systemctl --user restart bantou-memory`。
6. env の変更は不要（既定で動く）。調整する時だけ env file に上の設定を足して再起動する。

## deploy 後に確かめる事

- **起動**: `journalctl --user -u bantou-memory -f`。1 分以内に `[memory] embed: agent=… embedded=N failed=0 remaining=M … run=deadline` が出る（これまでは 0 行だった）。
- **溜まった 400 件が減っていく事**: 毎分の `[memory] embed:` の `remaining` が減る。または MCP の `status` tool（各 agent の token と `X-Agent-Id` で）: `memories.pendingEmbedding` が減り、`lastEmbeddedAt` が進み、`memories.embeddingRetryWait` が 0 のまま。1 run の `embedded` から残り時間を見積もれる（1 件 10〜15 秒なら 1 run で 4 件前後、400 件で 2 時間弱。実際の速さは log で分かる）。
- **今日の記憶が recall に出る事**: `status` の `memories.newestPendingCreatedAt` が、溜まりが残っている間も古い時刻へ下がっていく（新しい分から埋まる）。今日の話題で `recall` を呼び、今日作られた記憶が返る事。
- **recall が固まらない事**: 消化の最中に `recall` を呼び、数十秒以内に返る事（結果か、`query の埋め込みを取得できない` の error）。
- **`[memory] embed error:`** が出る場合:
  - `batch of 2 failed (ollama embed timeout …); retried one by one` が続く → 2 件が 60 秒に収まっていない。`MEMORY_EMBED_BATCH=1` にするか `MEMORY_EMBED_TIMEOUT_MS` を延ばす。
  - `item <id>: ollama embed timeout (60000 ms, 1 texts)` が続く → 1 件も 60 秒に収まっていない。`MEMORY_EMBED_TIMEOUT_MS` を延ばす（`status` の `embeddingRetryWait` が増えていく）。
  - `column "embed_attempts" does not exist` → migration 002 が当たっていない。
- Ollama の log で、`/api/embed` の 2 分打ち切りが出なくなっている事。

## test

`packages/memory` で実行（並行には回していない）。

- `npm run typecheck`: 通過。
- `npm test`: 67 件中 67 件通過、失敗 0（変更前は 52 件）。docker が無い Mac なので `test/integration.pg.test.ts`（実 PostgreSQL）は skip（`docker unavailable`）。同じ筋書きは PGlite 版で回っている。
- `npm run build`: 通過（`.output` に `status` tool が入っている事を確認）。
- `packages/center` は変えていないので回していない。

足した test（統合は `test/helpers/suite.ts`、偽の Ollama は `test/helpers/fakes.ts` の `startFakeOllama`）:

- 統合 12 件: 小分けで送る / 新しい順 / 小分けが失敗したら 1 件ずつ・失敗する 1 件は後回しで先頭を塞がない / 先頭の小分けが全滅しても次の run は別の item から進む / 無応答（timeout）でも run が終わり次へ進む / run の時間上限で止まり次の run に回る / 複数 agent を交互に / recall の query を優先 / recall が埋め込みを取れない時は timeout で理由を返す / worker の log（件数が動いた時と error だけ・本文なし・重複実行なし）/ status の値（本文なし・他 agent は見えない）/ migration 002 は何度当てても同じ。
- unit 3 件: timeout の設定が別 / Ollama client の timeout と呼び出しごとの上書き・error に本文なし / query 優先の門。

**修正前の code で落ちる事の確認**: 足した test は新しい関数を import するので、修正前の `server/` ではそのままは読み込めない。そこで、修正前にもある API（`embedPending(db, agent, embedder)` / `readEnv`）だけで同じ筋書きを書いた一時 test 3 件を作り、`server/` だけを修正前に戻して回した（一時 test は commit していない）。

| 筋書き | 修正前 | 修正後 |
|---|---|---|
| 7 件を、5 件以上の 1 回は失敗する Ollama で埋める | 落ちる（7 件を 1 回で送り、0 件のまま） | 通る |
| 先頭に失敗する 1 件がある 4 件を 3 回の run で埋める | 落ちる（埋め込み済み 0 件。期待 3 件） | 通る |
| `MEMORY_HTTP_TIMEOUT_MS=300000` の時の埋め込みの timeout が 60000 | 落ちる（設定が無い） | 通る |

## 出来なかった事・確かめていない事

- 実機（memory の host、実 Ollama、実 PostgreSQL）での確認。この作業は code・test・push まで。1 件あたりの実際の所要時間は未実測（10〜15 秒は log の間隔からの見積もり）なので、既定の件数と timeout は deploy 後の log で見直す。
- docker の実 PostgreSQL での統合 test（この Mac に docker が無い）。足した SQL は `make_interval` / `power` / `count(*) FILTER` / `ADD COLUMN IF NOT EXISTS` で、PGlite（PostgreSQL 本体の WASM 版）では通っている。
- build した server を起動して `/mcp` から `status` を呼ぶ確認（DB が要る）。
- 抽出が長引く run（chatp が遅い時、最長 10 分 × agent 数）の間は、その後ろの埋め込みが始まらない。抽出の仕組みは今回の範囲外なので変えていない。
