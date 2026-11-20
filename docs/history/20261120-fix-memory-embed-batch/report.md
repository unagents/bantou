# fix/memory-embed-batch（外部記憶の埋め込みが止まる不具合）

2026-11-20。`packages/memory` だけを変えた（center / protocol は無変更）。deploy はしていない（review の後、別の者が行う）。

commit は 2 つ。1 つ目（ed29971）が最初の修正、2 つ目が review の指摘 14 件と test の穴への対応。この文書は 2 つ目の後の状態を書いている。review への対応の一覧は末尾の「review の指摘への対応」。

## 原因（2026-11-20 の実測で確定していたもの）

- `embedPending` が agent ごとに「埋め込み未設定の古い順 100 件」を 1 回の `/api/embed` で送っていた。timeout は chatp と共有の 120 秒。memory の host の CPU は遅く、100 件は 120 秒に収まらない。失敗しても何も記録しないので、次の run も同じ先頭 100 件を送り、永久に進まない。全 830 記憶のうち 400 件が埋め込み無しで、recall に出ていなかった。
- 失敗は Nitro task の戻り値に入るだけで、log に 1 行も出ていなかった。
- 失敗し続ける埋め込みが Ollama の CPU を使い続け、recall の query の埋め込みが同じ列で 44〜94 秒待つ事があった。

## 直した事

| 事 | 場所 |
|---|---|
| 小分け・並びの枠（新しい順 / 古い順 / 再試行）・1 件ずつへの fallback・失敗の後回し・時間上限・全滅した agent を外す・agent の交互と続きからの開始 | `packages/memory/server/utils/embed.ts`（`embedBacklog`） |
| recall の query を優先する門（`EmbedGate`）と query 用の embedder | `packages/memory/server/utils/embed.ts`（`createEmbedGate` / `createQueryEmbedder`）、`server/utils/runtime.ts`、`server/utils/tools.ts`（`handleRecall`） |
| Ollama client: timeout を `EmbedTimeoutError` に、呼び出しごとの timeout、error に本文を入れない | `server/utils/embed.ts`（`createOllamaEmbedder`） |
| recall が埋め込みを取れない時は `EmbedUnavailableError`（理由つき）で早く返す | `server/utils/recall.ts` |
| timeout の設定を分けた、件数・時間上限の設定 | `server/utils/config.ts` |
| 抽出と埋め込みを別の task に分けた。run ごとの log（同じ error は間引く）、process 内の重複実行の防止、直近の error の保持と解消 | `server/utils/worker.ts`（`runExtractCycle` / `runEmbedCycle` / `runTaskSafely`）、`server/tasks/memory/extract.ts`、`server/tasks/memory/embed.ts`、`nuxt.config.ts` |
| 状態を返す MCP tool `status` | `server/mcp/tools/status.ts`、`server/utils/status.ts`（`buildStatus`） |
| 失敗管理の列 | `migrations/002_embed_retry.sql` |

## 決めた事と理由

- **小分けの件数: 既定 1**（`MEMORY_EMBED_BATCH`。1 つ目の commit では 2）。Ollama は入力を順に計算するので、件数を増やしても全体の速さはほぼ変わらない。一方、送信済みの 1 回は止められないので、recall の query が待つ最長時間は小分け 1 回分になる。1 件なら待ちは 1 件分で、run の時間の刻みも細かくなる（下の表）。2 件以上にも設定できる。
- **埋め込みの timeout: 既定 60 秒**（`MEMORY_EMBED_TIMEOUT_MS`）。chatp の timeout とは別の設定で、`MEMORY_HTTP_TIMEOUT_MS` は引き継がない（chatp に合わせて延ばした値で Ollama を長く待たないため）。`MEMORY_HTTP_TIMEOUT_MS` は chatp の timeout として残し、`CHATP_TIMEOUT_MS` があればそちらを使う。
  - 互換の注意: これまで `MEMORY_HTTP_TIMEOUT_MS` で Ollama の timeout も変えていた設置は、`MEMORY_EMBED_TIMEOUT_MS` を足す必要がある（memory の host の env には上書きが無いと聞いているので、影響しない）。
- **1 回の run の時間上限: 既定 50 秒**（`MEMORY_EMBED_RUN_MS`。1 つ目の commit では 45 秒）。上限を過ぎたら新しい小分けを始めない。加えて、**その run で測った 1 件の所要（最大）から、始めると上限をまたぐと見込まれる小分けも始めない**。run は上限の内で終わるので、毎分の起動が飛ばない。
  - 1 つ目の commit は「上限の前に始めた小分けは最後まで待つ」だけだったので、1 件 15 秒・2 件ずつだと小分けが 0 秒と 30 秒に始まり 60 秒過ぎに終わって、毎分の起動が 1 回おきに捨てられていた（Nitro は実行中の task の起動を捨てる）。
  - 固定の短い上限（例: 25 秒）にする案は採らなかった。機械の速さによって「上限 + 小分け 1 回分」が 60 秒を超えるかどうかが変わり、遅い機械では使える時間を半分捨てるため。測った所要で決める方が、速さに依らず 60 秒に収まる。
  - 上限を超えるのは、送った 1 回が見込みより長くかかった時だけ（最悪は timeout まで = 50 + 60 秒）。その時は次の起動が 1 回飛ぶ。積み上がらない。
  - 小分けが失敗した直後の 1 件目だけは上限を過ぎていても試す（上限で止めると、次の run も同じ小分けで時間切れになり、元の不具合の小型版になる）。
  - 時間は単調な時計（`performance.now()`）で測る（壁時計が戻っても run が延びない）。
- **抽出と埋め込みは別の task**（`memory:extract` / `memory:embed`、どちらも毎分）。Nitro の scheduler は同じ cron の task を `Promise.all` で並行に動かし、実行中かどうかは task の名前ごとに見る（`nitropack/dist/runtime/internal/task.mjs` で確かめた）。chatp が遅い・無応答で抽出が長引いても（最長 10 分 × agent 数）、埋め込みは毎分進む。抽出の仕組みそのものは変えていない。
- **run は重ならない**（確かめた事）。Nitro の `runTask` は、同名の task が実行中なら実行中の Promise を返し、新しい実行を始めない。加えて `runExtractCycle` / `runEmbedCycle` が process 内で実行中なら `skipped` で戻る。抽出側の排他（`claimed_at` の lease と `FOR UPDATE SKIP LOCKED`）は変えていない。埋め込みには process をまたぐ排他は足していない（二重に埋めても結果は同じで、service は 1 process）。
- **agent の順番: 前回の続きから**。1 巡で agent ごとに小分け 1 回。run が時間の上限で打ち切られると、次の run は「最後に送った agent の次」から始める（process の中に覚える）。毎 run 先頭から始めると、1 run に 2 回しか送れない機械では 3 番目以降の agent が、前の agent が空くまで 0 件のままになる。
- **item の順序: 枠で回す**。agent ごとに、送った小分けの通し回数で「新しい順・新しい順・古い順・再試行」を繰り返す。
  - 新しい順だけ（1 つ目の commit）だと、処理能力いっぱいに新しい記憶が入り続ける間、溜まった古い分と失敗した item に永久に順番が来ない。枠の 1/4 を最古の item、1/4 を間隔の明けた失敗 item に割り当てた。
  - 枠の半分は新しい順のままなので、今入った記憶は数回の小分けの内に recall に出る（1 件 40 秒の機械で、最悪 3 分）。
  - 枠の対象が無い時は他の種類の item を取るので、枠を空費しない。
- **失敗した 1 件の扱い: 記録して後回し**。失敗した item に `embed_attempts + 1` / `embed_failed_at` / `embed_error`。次に試せるのは 60 秒 × 2^(回数-1)（上限 1 時間）の後。成功すれば記録は消える。諦める上限は置いていない（最長でも 1 時間に 1 回の再試行で、Ollama 側が直れば自然に埋まる）。
- **全滅した agent はその run から外す。run 全体を打ち切るのは Ollama の障害とみなせる時だけ**。
  - 1 つ目の commit は、どれか 1 つの agent の小分けが全滅すると run 全体を打ち切っていた。必ず失敗する item を持つ agent が id の若い側にあると、その item の間隔が明けるたびに、後ろの agent がその run で試されなかった。
  - 今は、全滅した agent だけを外して他を続ける。打ち切るのは 2 通り: (1) **接続できない**（`ECONNREFUSED` / `EHOSTUNREACH` / `ENOTFOUND` など、接続の確立に失敗した時）。item の内容とは無関係なので **item に失敗を付けない**。Ollama が落ちていた間に入った item が、復帰後に後回しにならない。(2) **続けて 2 つの agent が全滅**。
  - 応答の途中で切れた（`ECONNRESET` など）と timeout は、入力が原因の恐れがあるので item の失敗として数える（数えないと、その item が先頭を塞ぐ）。
  - Ollama が応答しない（つながるが返らない）障害の間は、1 run で 1 件に失敗が付く（timeout の 60 秒で run の上限を過ぎるため）。復帰後、その item は再試行の枠で埋まる。
- **小分けでは通らず 1 件ずつなら通る時**（2 件以上に設定していて、小分けが timeout に収まらない機械）。その run の残りと、以後 30 回の run を初めから 1 件ずつ送る（process の中に覚える）。1 つ目の commit は run の中だけの切り替えだったので、毎 run 60 秒の timeout を待っていた。30 回の後に設定の件数をもう一度試し、通れば戻る。
- **query を塞がない仕組み**。recall の query は門を通し、query が実行中・待ち中の間は消化が次の小分けを送らない。query が待つのは最長で送信済みの 1 回分。1 件ずつに落とした時の 1 件目も、20 秒を上限に query へ譲ってから送る（譲り切れなくても送る。進む事の保証）。query の timeout は `MEMORY_RECALL_EMBED_TIMEOUT_MS`（既定 60 秒）。過ぎたら recall は `recall: query の埋め込みを取得できない（ollama embed timeout …）。時間を置いて再試行すること` の error を返す（MCP の `isError`）。以前は 120 秒固まった。
- **状態の口は MCP tool**（`status`）にした。HTTP の口は足していない（middleware が `/mcp` 以外を 404 にしていて、認証と agent の制限が `/mcp` の中にあるため）。入力は無し。数えるのは認証済み agent の行だけ（SQL の条件 + RLS）。本文は返さない。worker の error は、次に成功した時に消える。SQL は 1 文 5 秒の上限つき（DB が遅い時は error で早く返る）。消化の SQL は 1 文 15 秒。
- **log**。件数が動いた agent と error だけを 1 行ずつ。何も無い run は 0 行。agent ID・件数・item の ID・error の要旨（200 字まで）だけで、本文・token・URL は出さない。Ollama の error には応答の body も fetch の message も入れない（入力や URL が写っている恐れがあるため。接続の失敗は固定の文言 + error の code）。**同じ要旨の error が続く間は初回と 30 分ごとにだけ出し、解消した時に 1 行出す**。task は失敗を外へ throw しない（throw すると Nitro の scheduler が毎分 error を丸ごと出力する）。

## 既定値と所要の計算

既定: 1 回 1 件、run の上限 50 秒、毎分起動、timeout 60 秒。次の 1 件は「経過 + 1 件の所要 ≤ 50 秒」の時だけ始める。実機の 1 件の所要は未実測なので、3 つの場合を計算した。

| 1 件の所要 | 1 run の始まり（秒） | 1 run の件数 | run の終わり | 毎分の起動 | 400 件の消化 | query が待つ最長 |
|---|---|---|---|---|---|---|
| 10 秒 | 0, 10, 20, 30,（40） | 4〜5 | 40〜50 秒 | 飛ばない | 80〜100 分 | 10 秒 |
| 15 秒 | 0, 15, 30 | 3 | 45 秒 | 飛ばない | 約 134 分（2.2 時間） | 15 秒 |
| 40 秒 | 0 | 1 | 40 秒 | 飛ばない | 400 分（6.7 時間） | 40 秒 |

- 10 秒の機械の 5 件目は、測った所要がちょうど 10 秒以下の時だけ始まる（少しでも超えれば 4 件）。
- 新しい記憶が入っている間は、その分も同じ枠を使う（表は溜まった分だけを消化する時）。agent が複数でも合計は同じ。
- DB の時間（1 件あたり数ミリ秒〜数十ミリ秒）は入れていない。

参考: 1 つ目の commit の既定（2 件ずつ、上限 45 秒、見込み無し）での同じ計算。

| 1 件の所要 | 1 run の始まり（秒） | run の終わり | 毎分の起動 | 1 分あたり | 400 件の消化 |
|---|---|---|---|---|---|
| 10 秒 | 0, 20, 40 | 60 秒過ぎ | 1 回おきに飛ぶ | 3 件 | 約 134 分 |
| 15 秒 | 0, 30 | 60 秒過ぎ | 1 回おきに飛ぶ | 2 件 | 200 分 |
| 40 秒 | 0（2 件は 60 秒で timeout）→ 1 件 | 100 秒 | 1 回おきに飛ぶ | 0.5 件 | 800 分 |

## 設定の一覧

| 名前 | 既定 | 新旧 |
|---|---|---|
| `MEMORY_EMBED_BATCH` | 1 | 新 |
| `MEMORY_EMBED_RUN_MS` | 50000 | 新 |
| `MEMORY_EMBED_TIMEOUT_MS` | 60000 | 新 |
| `MEMORY_RECALL_EMBED_TIMEOUT_MS` | 60000 | 新 |
| `CHATP_TIMEOUT_MS` | `MEMORY_HTTP_TIMEOUT_MS` の値 | 新 |
| `MEMORY_HTTP_TIMEOUT_MS` | 120000 | 既存。chatp だけに効くようになった |

定数（`server/utils/embed.ts` / `worker.ts` / `status.ts`）: 再試行の間隔 60 秒〜1 時間（`EMBED_RETRY_BASE_SEC` / `EMBED_RETRY_MAX_SEC`）、1 件ずつを覚える run の数 30（`EMBED_SINGLE_RUNS`）、1 件目の前に query へ譲る上限 20 秒（`EMBED_FIRST_YIELD_MS`）、並びの枠（`EMBED_LANES`）、SQL の上限 15 秒 / 5 秒（`EMBED_SQL_TIMEOUT_MS` / `STATUS_SQL_TIMEOUT_MS`）、同じ error を log に出し直す間隔 30 分（`LOG_REPEAT_MS`）。

## migration

`packages/memory/migrations/002_embed_retry.sql`。`memory_items` に `embedded_at` / `embed_attempts`（既定 0）/ `embed_failed_at` / `embed_error` を足し、埋め込み済みの行の `embedded_at` を `updated_at` で埋める。**002 はまだどこにも当てていないので、2 つ目の commit で file を直した**（003 は足していない）。

- 全て `IF NOT EXISTS` / `WHERE embedded_at IS NULL` で、何度当てても同じ。列の追加は定数の既定値だけなので表を書き換えない。
- **index は足さない**（1 つ目の commit の部分 index は削った）。条件が `embedding IS NULL` だけの部分 index は、消化の query の条件（`embedding IS NULL OR embed_model が違う`）からは使えない。並びも枠ごとに変わる。埋め込み待ちの行は少数で、既存の `(agent_id, status)` の index による agent の絞り込みで足りる。
- **`embedded_at` を埋める UPDATE**。`memory_items` は `FORCE ROW LEVEL SECURITY` なので、owner が superuser でないと、素の UPDATE は policy（`agent_id = app.agent_id`）に当たらず黙って 0 行になる。agent ごとに `app.agent_id` を設定して更新する `DO` block にしたので、superuser でない owner でも埋まる（`agents` に RLS は無い）。仮に 0 行でも害は無い: 埋め込みの消化と recall には影響せず、`status` の `lastEmbeddedAt` が次の埋め込みまで `null` になるだけ。
- 旧版の code は足した列を見ないので、**migration を先に当てて、その後で code を切り替える**。逆順だと、新しい code の埋め込みと `status` が「列が無い」で失敗する（log に agent ごとに 1 行、以後は 30 分ごと。data は壊れない）。
- `memory_app` は `memory_items` に表単位の SELECT / INSERT / UPDATE を持つので、GRANT の追加は不要。
- 当て方は 2 通り。owner の接続（migration 専用の role）で行う。
  1. `pgmigrations` 表に `001_init` が記録されている場合（`SELECT name FROM pgmigrations`）: `cd packages/memory && DATABASE_URL=<owner の接続> npm run migrate -- up`。
  2. 記録が無い場合（001 を psql で直接当てていた等。`migrate up` は 001 を当て直そうとして失敗する）: `002_embed_retry.sql` の `-- Up Migration` から `-- Down Migration` の手前までを、owner の psql でそのまま流す（`DO $$ … $$;` を途中で切らない）。
- どちらで当てたかは未確認（この作業では memory の host にも DB にもつないでいない）。

## deploy の手順（未実施）

`packages/memory/README.md` の「起動」と `docs/design/external-memory.md` の「設置の記録」に合わせる。memory の host では `nuxt build` が落ちるので、build は作業用の Mac で行う。

1. 作業用の Mac: `bun install --frozen-lockfile`（repo root）、`cd packages/memory && npm run build`。
2. memory の host の repo を、この branch を含む版に更新する（`migrations/` と `bin/` が要る）。
3. memory の host: migration 002 を当てる（上の「当て方」）。この時点では旧版の service が動いたままでよい。
4. 作業用の Mac → memory の host: `packages/memory/.output/` を rsync する（`--delete` 付きで、配置先は unit の `WorkingDirectory` の下の `.output/`）。
5. memory の host: `systemctl --user restart bantou-memory`。
6. env の変更は不要（既定で動く）。調整する時だけ env file に上の設定を足して再起動する。1 つ目の commit の版を試していて `MEMORY_EMBED_BATCH` / `MEMORY_EMBED_RUN_MS` を env に書いていた場合は、消すか見直す（既定が 2 → 1、45000 → 50000 に変わった）。

task が 2 つ（`memory:extract` と `memory:embed`）になったが、どちらも同じ service の中で動く。unit と起動の手順は変わらない。

## deploy 後に確かめる事

- **起動**: `journalctl --user -u bantou-memory -f`。1 分以内に `[memory] embed: agent=… embedded=N failed=0 remaining=M retry-wait=0 run=deadline` が出る（これまでは 0 行だった）。
- **1 件の所要を測る**: 毎分の `embedded=N` と上の表を比べる（N が 4〜5 なら 1 件 10 秒前後、3 なら 15 秒前後、1 なら 25 秒以上）。`status` の `worker.embed.lastRunMs` が 60000 より小さい事（= 毎分の起動が飛んでいない）。
- **溜まった 400 件が減っていく事**: 毎分の `[memory] embed:` の `remaining` が減る。または MCP の `status` tool（各 agent の token と `X-Agent-Id` で）: `memories.pendingEmbedding` が減り、`lastEmbeddedAt` が進み、`memories.embeddingRetryWait` が 0 のまま。残り時間は「remaining ÷ 1 run の件数」分。
- **どの agent も進む事**: agent が複数ある時、`[memory] embed:` の行が同じ agent だけにならない（run ごとに始まる agent が替わる）。
- **今日の記憶が recall に出る事**: 今日の話題で `recall` を呼び、今日作られた記憶が返る事。`status` の `memories.oldestPendingCreatedAt` も進む（4 回に 1 回は最古の item を埋めるため）。
- **recall が固まらない事**: 消化の最中に `recall` を呼び、1 件分 + 数秒で返る事（結果か、`query の埋め込みを取得できない` の error）。
- **抽出と埋め込みが別に動く事**: `status` の `worker.extract` と `worker.embed` の `lastRunAt` がそれぞれ毎分進む。
- **`[memory] embed error:`** が出る場合（同じ error は初回と 30 分ごとにだけ出る。直ると `[memory] embed recovered: agent=…` が 1 行出る）:
  - `ollama embed failed: connection error (ECONNREFUSED)` など → Ollama に接続できない。`OLLAMA_URL` と Ollama の起動を見る。item に失敗は付かない（`retry-wait` は増えない）。
  - `ollama embed timeout (60000 ms, 1 texts)` が続く → 1 件が 60 秒に収まっていない。`MEMORY_EMBED_TIMEOUT_MS` を延ばす（`status` の `embeddingRetryWait` が増えていく）。
  - `batch of N failed (ollama embed timeout …); retried one by one`（`MEMORY_EMBED_BATCH` を 2 以上にした時だけ）→ 小分けが timeout に収まっていない。以後 30 回の run は自動で 1 件ずつになる。`MEMORY_EMBED_BATCH=1` に戻す。
  - `column "embed_attempts" does not exist` → migration 002 が当たっていない。
- `[memory] extract error:` / `[memory] … run error:` が出ていない事（出ていれば `status` の `lastErrors` に同じ要旨がある）。
- Ollama の log で、`/api/embed` の 2 分打ち切りが出なくなっている事。

## test

`packages/memory` で実行（並行には回していない）。

- `npm run typecheck`: 通過。
- `npm test`: 81 件中 81 件通過、失敗 0（変更前は 52 件、1 つ目の commit で 67 件）。docker が無い Mac なので `test/integration.pg.test.ts`（実 PostgreSQL）は skip（`docker unavailable`）。同じ筋書きは PGlite 版で回っている。
- `npm run build`: 通過（`.output` に `status` tool と task `memory:embed` が入っている事を確認）。
- `packages/center` は変えていないので回していない。

test の場所: 統合は `test/helpers/suite.ts`、unit は `test/unit.test.ts`、偽の Ollama は `test/helpers/fakes.ts` の `startFakeOllama`（遅い応答・HTTP 失敗・無応答）と `closedPortUrl`（接続の拒否）。時間に依る筋書きは数十〜数百ミリ秒に縮めている。

1 つ目の commit の test（統合 12 件、unit 3 件）: 小分けで送る / 新しい順 / 小分けが失敗したら 1 件ずつ・失敗する 1 件は後回し / 先頭の小分けが全滅しても次の run は別の item から / 無応答（timeout）でも run が終わる / run の時間上限 / 複数 agent を交互に / recall の query を優先 / recall が埋め込みを取れない時は理由を返す / worker の log / status / migration 002 は何度当てても同じ / timeout の設定が別 / Ollama client の timeout / query 優先の門。

2 つ目の commit で足した test（統合 11 件、unit 3 件。既存の test も書き直した）:

- 統合:
  - 時間の上限で打ち切られても、次の run は続きの agent から始める（agent 3 つ、1 run に 2 回）。
  - 全滅した agent だけを外す。続けて 2 agent の全滅と、接続不能で打ち切る。接続不能では item に失敗を付けない。
  - 新しい記憶が入り続けても、最古の item と、間隔の明けた失敗 item に順番が来る。新しい順の枠では失敗 item は後ろ。
  - 失敗の間隔（指数・上限 1 時間・回数が大きくてもあふれない）。
  - 1 件ずつなら通る時は、次の run も 1 件から始める。試し直して戻る。
  - 1 件ずつの時、1 件目は上限を過ぎても送る。2 件目以降は上限と門に従う。1 件目の前に query へ譲る。
  - 上限をまたぐ見込みの小分けは始めない。壁時計が止まっても上限で止まる。
  - recall の配線（tool は query 用の embedder を使う）。
  - 同じ error の log を絞る。解消の 1 行。古い error が成功で消える。task は throw しない。
  - SQL の時間上限（status と消化）。
  - migration 002 の backfill が、RLS を受ける role でも埋まる。
- 統合で書き直した物: 順序（枠）、worker の log（task が 2 つ。抽出が長引いても埋め込みが進む）、status（RLS では見える他 agent の shared の行を置いた。worker の欄）、migration 002（index を作らない）、小分け（既定 1 件）。
- unit: `errorSummary` の長さ切り / `rotateAgents` / task の配線（`nuxt.config.ts` に 2 つの task）。書き直し: 既定値、Ollama client（接続不能は `EmbedUnreachableError`、error に URL を写さない、途中で切れた接続は接続不能と扱わない）。

### 変異の確認

主要な分岐を 1 つずつ外した変異 44 個を入れ、毎回 `npm test` を回した（入れた変異は全て戻し、戻した後の diff が入れる前と同じ事を hash で確かめた）。

- **落ちた（test が検出）: 42 個**。
  - 並びと間隔: 失敗 item を後ろに並べる条件を外す / 間隔を指数にしない / 上限 1 時間を外す / 回数の上限 20 を外す / 枠を全て新しい順にする / 再試行の枠を外す / 古い順の枠を外す。
  - 1 件ずつ: 2 件目以降の時間上限を外す / 同じく門を外す / 1 件目も時間上限に従わせる / 1 件目の前の query への譲りを外す / run の中の 1 件ずつへの切り替えを外す / 次の run へ覚える事を外す / 覚えた回数を減らさない。
  - agent と打ち切り: agent の続きからの開始を外す / 全滅で run を即打ち切る / 続けての全滅で打ち切らない / 全滅した agent を run に残す / 接続不能を item の失敗として数える（2 通り）/ `ECONNRESET` を接続不能と扱う / 「1 件も通らなければ failing」を外す。
  - 時間: 上限をまたぐ見込みを外す / 壁時計に戻す / 消化の SQL の時間上限を外す / status の SQL の時間上限を外す。
  - error と log: `errorSummary` の長さ切りを外す / fetch の message を error に写す / log の間引きを外す / 数字を潰す要旨を外す / 1 件も通らない run の件数の行を絞らない / 解消の行を出さない / embedError・extractError・lastRunError を消さない（3 個）/ task が throw する。
  - 配線と分離: status の `memory_items` の 3 つの query から `agent_id` の条件を外す（3 個）/ `handleRecall` を消化用の embedder に戻す / 埋め込みが抽出の終わりを待つ / backfill を素の UPDATE に戻す。
- **生き残った: 2 個**（どちらも等価な変異）。status の `memory_events` の 2 つの query から `agent_id` の条件を外す。`memory_events` の policy は自分の行だけを見せるので（shared の行が無い）、SQL の条件を外しても RLS で同じ結果になる。条件は二重の守りとして残している。
- 1 回目の実行で生き残り、test を足して落ちるようにした物: 失敗 item を後ろに並べる条件、数字を潰す要旨。

**修正前の code で落ちる事の確認**（1 つ目の commit の時）: 修正前にもある API だけで同じ筋書きを書いた一時 test 3 件を作り、`server/` だけを修正前に戻して回した（一時 test は commit していない）。

| 筋書き | 修正前 | 修正後 |
|---|---|---|
| 7 件を、5 件以上の 1 回は失敗する Ollama で埋める | 落ちる（7 件を 1 回で送り、0 件のまま） | 通る |
| 先頭に失敗する 1 件がある 4 件を 3 回の run で埋める | 落ちる（埋め込み済み 0 件。期待 3 件） | 通る |
| `MEMORY_HTTP_TIMEOUT_MS=300000` の時の埋め込みの timeout が 60000 | 落ちる（設定が無い） | 通る |

## review の指摘への対応（2 つ目の commit）

14 件とも、code を読んで指摘が正しい事を確かめた上で直した。直さなかった物は無い。

| # | 指摘 | 直し方 | 場所 |
|---|---|---|---|
| 1 | agent が毎 run 先頭から始まり、後ろが埋まらない | 最後に送った agent を process の中に覚え、次の run はその次から | `embed.ts` の `rotateAgents` / `EmbedState.lastAgent`、`worker.ts` の `runEmbedCycle` |
| 2 | 1 つの agent の全滅が run 全体を止める | 全滅した agent だけを外す。打ち切りは接続不能か、続けて 2 agent の全滅 | `embed.ts` の `embedBacklog` の外側の loop、`EmbedUnreachableError` |
| 3 | 流入が続くと古い分と失敗分に順番が来ない | 並びの枠（新・新・古・再試行）。接続不能では失敗を付けない | `embed.ts` の `EMBED_LANES` / `PENDING_SQL` |
| 4 | 小分けが timeout に収まらない機械で毎 run 60 秒を捨てる | 1 件ずつなら通った事を 30 run 覚え、その後に試し直す。既定も 1 件にした | `embed.ts` の `EmbedState.singleRuns` / `EMBED_SINGLE_RUNS` |
| 5 | run が 60 秒を超え、毎分の起動が 1 回おきに飛ぶ | 測った所要から、上限をまたぐ小分けを始めない。既定を 1 件・50 秒に | `embed.ts` の `wouldOverrun` / `DEFAULT_EMBED_RUN_MS`、`config.ts` |
| 6 | 抽出が長引くと埋め込みが始まらない | 別の task `memory:embed` に分けた | `server/tasks/memory/embed.ts`、`nuxt.config.ts`、`worker.ts` |
| 7 | 1 件ずつの 1 件目が門を見ない | 20 秒を上限に query へ譲ってから送る | `embed.ts` の `EMBED_FIRST_YIELD_MS` |
| 8 | error の間、log が毎分出続ける | 同じ要旨は初回と 30 分ごと。解消で 1 行。task は throw しない | `worker.ts` の `throttle` / `clearLogged` / `runTaskSafely` |
| 9 | worker の error が成功しても消えない | 成功した時に消す | `worker.ts` の `clearAgentError` / `runOnce` |
| 10 | `status` と消化の SQL に時間上限が無い | transaction ごとに `statement_timeout`（5 秒 / 15 秒） | `db.ts` の `setStatementTimeout`、`status.ts`、`embed.ts` |
| 11 | 002 の部分 index が使われない | 削った | `migrations/002_embed_retry.sql` |
| 12 | backfill が FORCE RLS の下で黙って 0 行 | agent ごとに `app.agent_id` を設定する `DO` block。害が無い事を comment と README に明記 | `migrations/002_embed_retry.sql`、README |
| 13 | 接続失敗の error に URL が写る恐れ | 固定の文言 + error の code だけ | `embed.ts` の `createOllamaEmbedder` |
| 14 | 時間上限が壁時計 | `performance.now()` | `embed.ts` の `embedBacklog`、`worker.ts` |

指摘の案と違う直し方をした所:

- **5**: 案は「run の上限を 25 秒にする」。測った所要で次を始めるかを決める方式にした（理由は「決めた事と理由」の時間上限の項）。
- **8**: 指摘に無い所も直した。task が throw すると Nitro の scheduler 自身が毎分 error を出力するので、task は throw せず要旨を返すようにした。
- **13**: 確かめて分かった事。Node の fetch は認証情報入りの URL を受け付けず、その error の message に URL がそのまま入る。指摘の恐れは実際に起きる形だった。
- **`status` の出力の形が変わった**（task を分けたため）: `worker` は `{ extract, embed }`、`lastErrors.workerRun` は `workerExtractRun` / `workerEmbedRun`。`status` は 1 つ目の commit で足した tool で、まだ deploy していない。

## 出来なかった事・確かめていない事

- 実機（memory の host、実 Ollama、実 PostgreSQL）での確認。この作業は code・test・push まで。1 件あたりの実際の所要時間は未実測なので、上の表は計算。deploy 後の log で確かめる。
- docker の実 PostgreSQL での統合 test（この Mac に docker が無い）。次の 2 つは PGlite では確かめられない: `statement_timeout` が実際に SQL を打ち切る事（設定している事だけを test で確かめた）、真の並行 transaction（抽出と埋め込みが同時に DB を使う事。別の行を書くので競合しない設計）。
- build した server を起動して、2 つの task が毎分並行に動く事と `/mcp` から `status` を呼ぶ事の確認（DB が要る）。task の並行は Nitro の source を読んで確かめ、配線は test で確かめた。
- `getRuntime`（実行時に embedder と門を組み立てる所）そのものの test。実 DB の接続が要るので、`handleRecall` が query 用の embedder を使う事までを test した。
- Ollama が応答しない（つながるが返らない）障害の間は、1 run で 1 件に失敗が付く。復帰後は再試行の枠で埋まるが、その item は最大でその時点の間隔（60 秒〜1 時間）だけ遅れる。
