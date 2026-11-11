# 外部記憶 段階 2「書き込みの埋め込み」実装 report

branch: `feat/external-memory-write`（基点 origin/develop）。依頼: w-cap（利用者承認済み）。release は含めない（merge は master-cap）。

## 設計

### hook の経路
- 既存を使い回す。center が全 session（wrapper 経由）に `--settings` で差す hook（`UserPromptSubmit` / `Stop` ほか。`status-line.ts` の `statusLineSettings`）→ `bantou-center hook`（`bantou_ts` を足す）→ `POST /sessions/<name>/hook` → daemon の `onHook`。ここに `memoryEvents.onHook(name, payload)` を 1 行足しただけ（hook は増えない）。`onHook` はキューに積んで即 return（memory の応答を待たない）。
- 対象は running（starting / connected）の session で、`composeMemory(共通, session)` が有効なものだけ。判定は `sessions.memoryOf(name)`（新設。既存の `composeMemory` の結果をそのまま返す）。

### hook payload の根拠（公式 docs https://code.claude.com/docs/en/hooks を WebFetch で確認、2026-11-11）
- 共通: `session_id`、`prompt_id`（「UUID identifying the user prompt currently being processed」「Absent until the first user input」）、`transcript_path`、`cwd`、`hook_event_name` など。
- `UserPromptSubmit`: 「receive the `prompt` field containing the submitted text」。貼り付けは展開済みで `<pasted_content id="…">` の行が付く場合がある。公式の例 JSON には `prompt_id` が**載っていない**（共通フィールド表にはある）→ **実際に UserPromptSubmit に prompt_id が付くかは未確認**。center は有れば使い、無くても `bantou_ts`（hook 発火時刻）で区別する設計にした。
- `Stop`: 「`stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`」。`last_assistant_message` は「the text content of Claude's final response… use this field rather than reading `transcript_path`: the transcript file isn't guaranteed to include the final message at Stop time」。
- `StopFailure`: `last_assistant_message` は API error 文（例 "API Error: Rate limit reached"）→ 記録しない。
- 未確認: `--remote-control` の session で hook の payload が上記と同形か（設計書にある claude 2.1.322 の実測は Stop の last_assistant_message のみ）。実機未検証。

### eventId
`<ns>:<session か cap_id>:<種別>:<部品…>`。ns は center `c1` / server `s1`。`[A-Za-z0-9_.-]` 以外は `_`。128 文字超は先頭 95 文字 + `:` + sha256 先頭 32 桁。
- 発言: `c1:<session>:u|a:<prompt_id か ->:<hook 発火時刻 ms>:<本文 digest8>`。
- task: `c1:<session>:task:<task_id>`。result: `c1:<session>:result:<task_id>:<本文 digest8>`（cap_result は `result:<cap_id>:cap:<ms>:<digest8>`）。report: `report:<cap_id>:<worker_id>:<server の at ms>:<digest8>`。reply: `reply:<cap_id>:<worker_id>:<ms>:<digest8>`。server は `s1:<cap_id>:…` で同形。
- **再送で同じ id**: 部品は出来事から決まる値のみ（hook 呼び出しの ts・prompt_id・本文、task_id、server の `at`）。キューの再試行は同じ event を再送し、同じ hook 呼び出し / 同じ通知の再到達も同じ id → memory が duplicate で弾く。test で確認（同じ payload 2 回 → 1 recorded + 1 duplicate）。
- **同じ内容の別の発言は別 id**: 発火時刻 ms（と prompt_id）が違う。同じ task_id の別の結果（report 起因 task_result）は本文 digest で別 id。本文も同じ結果の再通知は 1 件にまとまる（意図）。
- 弱点: 同じ ms に prompt_id 無しで同一本文が 2 回発火すると同じ id（現実的には起きない）。

### 担当表（center / server）
| 出来事 | center（master-cap の記憶。agent = agentId か session 名。`c1:`） | server（cap の記憶。agent = cap_id。`s1:`） |
|---|---|---|
| 利用者の発言 | `user_prompt` | — |
| master-cap の応答 | `assistant_message` | — |
| task | 送信時 `task` | 受付時 `task` |
| cap_result / task_result | 受信時 `result` | center へ返す時 `result` |
| worker_report | 受信時 `report` | `/mcp` の report 受信時 `report` |
| worker_reply | 送信時 `reply` | worker に渡せた時 `reply` |

- **判断**: 依頼文の推奨（center = master-cap ↔ cap、server = cap ↔ worker の区間分担）ではなく、**記憶（agent）で分担**した。要件 1 が center に report 受信・reply 送信まで、要件 3 が server にも task / report / reply / result を求めており、区間分担だと要件 1・3 の両方を満たせない。master-cap と cap は別の agent（設計の「横断 PM / 個別 PM」）なので、同じ出来事が別の記憶に入っても同じ記憶に二重には入らない。eventId も名前空間を分けた。区間分担案は設計書の「比較した別案」に理由付きで残した。変えたい場合は表の列を消すだけで済む（コード上は呼び出し 1 行ずつ）。
- 衝突しうる唯一のケース: 利用者が `agentId` に cap_id と同じ値を設定すると同じ agent に別 eventId で入る（通常 cap_id は `c-<center id>-<session>` なので起きない）。
- cap の記憶は今は誰も読まない（cap / worker に memory の MCP は渡していない）。書き込みだけ先に入る。

### キューの仕様（`packages/protocol/src/memory.ts` の `createMemoryQueue`）
- (owner, memory url, agentId) ごとの FIFO。1 件ずつ送る。enqueue は同期・投げない・ネットワークを待たない。
- 失敗: 送信は MCP の `event` tool。HTTP / 接続 / timeout（15s）の失敗は 1s → 2s → … 最大 60s の backoff で先頭を再試行（順序保持）。`isError`（入力検証違反）は再試行しても直らないので log して捨てて次へ。
- 上限 1000 件/レーン: 超えたら送信中でない最古から捨て、log（eventId のみ）。
- 終了: center は `close()`、server は最大 1 秒だけ空になるのを待ってから `close()`（残りは捨てる。停止は遅らせない）。
- log は `eventId` と理由のみ。理由は token を `***` に置換、Bearer を伏せ、200 文字で切る。url・body は出さない。
- token: argv・log・status・応答・エラー文に出ない（test で確認）。唯一の経路は center の記憶内 → messenger の task メッセージ → server の記憶内。messenger は平文（memory も平文 HTTP。LAN / Tailscale 内前提）。server の「無視した指示」log は先頭 120 文字を出すので `"token":"…"` を伏せるようにした（`ignoreText`）。

### 共有モジュールの置き場
`packages/protocol/src/memory.ts`。MCP SDK に依存させない（desktop も protocol を参照するため、`node:crypto` 以外の依存を足さない）。transport は注入: center / server がそれぞれ自分の `@modelcontextprotocol/sdk` の `Client` / `StreamableHTTPClientTransport` を `createMcpEventSink` に渡す（各 2 行）。center `src/memory-events.ts` と server `server/utils/bantou/memory.ts` は薄い層（eventId の組み立てと呼び出し点）。fake memory の test helper は center / server の test にそれぞれ同内容を置いた（package 間の相対 import を避けた）。

### protocol の変更と後方互換
- `MESSENGER_PROTOCOL` を **1.8.0 → 1.9.0**。`protocol.json` の `task.properties.memory`（任意）を追加。protocol.md の注記どおり、定義を変えると版を上げる必要がある（同名同版・内容違いは PROTOCOL_CONFLICT）。
- `TaskCommand.memory?: TaskMemory`（`{ url, token?, agent_id?, session? }`）。guard は未知項目を許すので**古い server は memory を無視して task を普通に実行する**。server は `readTaskMemory` で寛容に読み、壊れていれば捨てる（task は止めない）。
- `MEMORY_MIN_PROTOCOL = "1.9.0"` / `supportsMemory(version)`（`supportsRetire` と同形）。center は `supportsMemory(peer.version)` の時だけ memory を添える。
- **版の門との整合（要注意）**: center の既存の門（`gateOf`）は「宣言された版が center と違えば kick_cap / task を送らない」（完全一致）。1.9.0 に上げたため、**1.8.x の server は他の版上げと同じく更新されるまで task を断られる**（follow が組の版へ更新を指示する既存の流れ）。つまり「新しい center が古い server に memory を渡して壊れる」ことは無い（そもそも送らない）が、「古い server が memory 無しで task を受け続ける」ことも center の門で止まる。MESSENGER_PROTOCOL を上げずに済ませる案は、protocol.json を変える以上 PROTOCOL_CONFLICT になるため採れなかった。RETIRE_MIN_PROTOCOL（1.8.0）とは独立（retire は control command で門を通る）。
- desktop: protocol の値を import していない（`RETIRE_MIN_PROTOCOL` のミラーのコメントのみ）。types を共有していないので desktop の変更・typecheck は不要。

## 変更点
- protocol: `src/memory.ts`（新）、`src/index.ts`、`src/server.ts`（版・`TaskCommand.memory`）、`messenger/protocol.json` / `PROTOCOL.md`、test（`memory.test.mjs` 新 / `server.test.mjs` の版）。
- center: `src/memory-events.ts`（新）、`src/daemon.ts`（recorder 生成・onHook・remotes へ受け渡し・close）、`src/sessions.ts`（`memoryOf`）、`src/remotes.ts`（task へ memory 添付と、send / settle / applyLateReply / onWorkerReport / workerReply の記録点）、test。
- server: `server/utils/bantou/memory.ts`（新）、`daemon.ts`（task 受付・worker_reply・task / kick_cap の返信・終了時 drain・`ignoreText` の token 伏せ）、`reports.ts`（report 受信と report 起因の返信の記録点）、test。
- docs: center / server README、`docs/protocol.md`、`docs/design/external-memory.md`。
- package.json は変更なし（center は `@modelcontextprotocol/sdk` 1.32.2、server は `^1.32.2` が既に入っている）。**bun.lock は触っていない。master-cap が merge 時に bun.lock を更新**（実際は依存追加が無いので差分は出ない見込み）。version bump なし。

## テスト結果
- protocol: `npm test` 50 pass / 0 fail（memory 新規 11 件含む）。
- center: `npm run typecheck` エラー 0。`env -u BANTOU_SESSION_TOKEN npm test`: 595 件中 594 pass、fail 1 は rc-orphan（環境起因・想定内）のみ。新規 `memory-events.test.ts` 12 件、`remotes.test.ts` に memory 6 件追加。`follow.test.ts` の「別の protocol 版」の値を 1.9.0 → 1.99.0 に変更（現行版と同じになったため）。
- server: `npm test` 348 件（`daemon.test.ts` の版を 1.9.0 に更新、`memory.test.ts` 8 件追加）。`npm run typecheck` は 6 件で、全て develop 時点から有る `test/server/utils/bantou/default-config.test.ts` の既存 error（今回の変更ファイルに error なし）。
- fake memory: MCP Streamable HTTP の最小実装（`test/helpers/fake-memory.ts`、SDK の低水準 `Server` + `StreamableHTTPServerTransport`）。memory の入力検証と (agent, eventId) の冪等を再現。packages/memory の本物は起動していない。
- 実機（実 claude の hook・実 memory・実 server 間の messenger）は未検証。

## 残課題・申し送り
- 実機確認: `--remote-control` session で UserPromptSubmit に `prompt_id` が付くか、payload の形。
- 1.9.0 の server を npm に publish する前に center だけ入れると、1.8.x の server への task が断られる（follow の更新が効くまで）。release 順は master-cap で。
- cap / worker が memory を読む経路は無い（cap の記憶は書くだけ）。
- agentId 未設定時の X-Agent-Id は session 名なので、session の改名で書き先の agent が変わる（既存の読み込み側と同じ仕様）。
- キューはメモリのみ。center / server 再起動で未送信分は失われる（要件どおり。永続化は別課題）。
- token は messenger（平文）経由で server に渡る。

## 設計書の変更が要る点（反映済み、形は大きく変えていない）
- 「書き込み」節に担当表・eventId・キュー仕様・hook payload の根拠・後方互換を追記。サブ節見出し（担当表 / 経路と形 / eventId の設計 / 後方互換）を足した。
- 「server は endpoint を center から受け取る（protocol に memory を足す）」を「task に memory を載せる」に具体化（理由と別案を併記）。
- 区間分担（推奨案）を採らず記憶（agent）分担にした点は、利用者 / master-cap のレビューで差し戻す余地あり。

## review 対応（HEAD 78cd7a3 → verdict ok、差し戻しなし。test の追加のみ、実装は変更なし）

追加した test（変異で落ちることを自分で確認）:
1. [medium] eventId の digest: center `memory-events.test.ts` に「ts と prompt_id が同じで本文だけ違う user_prompt / assistant_message は別 eventId」、server `memory.test.ts` に同条件の report、protocol `memory.test.mjs` に digest8 / makeEventId の unit。変異: center の hook id から `digest8(text)` を外す → center の新 test が落ちた（他は pass のまま＝従来は検出できなかった穴）。server の report id から外す → server の新 test が落ちた。
2. [low] hang する memory: center `memory-events.test.ts`（接続は受けるが応答しない TCP server に実 MCP sink で接続。onHook / task / result / report / reply が各 100ms 以内。実時間）と `remotes.test.ts`（応答しない sink で send / onWorkerReport / workerReply / applyLateReply が 100ms 以内）。変異: 記録点（push）で 300ms 同期ブロック → 両 test が落ちた。
3. [low] `remotes.test.ts`: memory 有効 session で send / report / reply 後の remotes.json に token・url が含まれない（task cmd には token が載っていることも確認）。変異: 記録に task memory を JSON で保存 → 落ちた。変異は全て元に戻した（`git checkout`）。
- docs: center README の memory の節に、hook 記録は live な設定を引くため動いている session でも追加/解除が次の hook から反映される旨を 1 文追記。

### 残り（low。実装は変えていない。必要なら別 task）
- 設定の反映時刻のずれ: center の hook 記録は呼ぶ時点の memory 設定を引く（動いている session でも追加/解除が即反映）。`--mcp-config` の memory と session_settings_update の説明「次の起動から」とずれる。
- client の蓄積: sink は (url, token, agentId) ごとに client を保持し、設定の変更で古い組の client が閉じられずに残る（close() でまとめて閉じる）。
- execute が error になった task も、受付時点で cap の記憶に task event が入る（result は error を書かないので対応する result が無い）。
- close が hang 中の connect を abort しない: キューの close() は待ち timer を解くが、応答しない接続中の connect / callTool は SDK の timeout（15s）まで残る。
