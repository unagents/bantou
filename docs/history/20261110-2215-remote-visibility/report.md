# remote の可視化（server 停止・task 未送達・cap 消失を log なしで判別する）

branch: `feat/remote-visibility`（基点 origin/develop 4564c8e（作業中に c7f8b7b から rebase））。server・protocol 版・bun.lock・version は変更なし。

## 背景（2026-11-10 UTC の事象）

1. 20:57 server の host が落ちた。center は hello タイムアウトを log に書いたが、remote_list は state running のまま、画面も変わらなかった。
2. 21:26 server が新 peer で復帰し cap を lost と通知したが、remote_list にも画面にも出なかった。
3. remote_send を 2 回出したが、送信が数分遅れ、返り値は state running で、届いたか分からなかった。

## 設計

### server が返す情報で取れるもの（protocol 1.5.0 を読んだ結果）

- `task` に ack は無い。返信は完了時の `task_result` か `error` だけ。
- `status_result.caps[]` は `state`（running / idle）、`queued`、`last_started_at` を持つ。→ 受付は「送る直前の status（base）から cap が変わったか」で判定する。
- activity 通知の cap agent は state `lost` を取れる（server が再起動後に実行が失われた cap を知らせる）。
- hello / status は応答があれば到達できている証拠。

### 判定の根拠

| 項目 | 判定 | 理由 |
| --- | --- | --- |
| task の受付 | 送る前の cap（存在・running・queued・last_started_at）を `base` に保存。後の status で、cap が新規に現れた / `queued` が増えた / `last_started_at` が変わった / idle→running のどれか、または `task_result` が返った | server と center の時計を比べない。ack が無いので status の変化が唯一の根拠 |
| 到達性 | server（server_id、無ければ peer id）単位で連続失敗を数える。無返信・送信失敗・発見から消えた = 失敗。応答（status / hello / activity / worker_report / task_result）= 成功。2 回続くと到達不能 | 1 回の取りこぼしで表示を揺らさない。server の返した error（版の門の断りなど）は応答があった扱い |
| 到達不能の対象 | 作業中の cap（pending がある、state が running / unknown）だけ。終わった cap は変えない | 終わった結果は server が落ちても変わらない |
| cap lost | activity の cap agent state が `lost` | server が通知する唯一の経路 |

### 定数

| 名前 | 値 | 理由 |
| --- | --- | --- |
| `ACK_TIMEOUT_MS`（環境変数 `BANTOU_REMOTE_ACK_TIMEOUT_MS`） | 15 秒 | status の往復は通常 1 秒未満・上限 10 秒（FOLLOW_TIMEOUT_MS）。数回やり直せて cap 作成にも足りる。これ以上は呼び出し側 session を待たせすぎる |
| `ACK_POLL_MS` | 1 秒 | 受付確認の取り直し間隔 |
| `RESEND_AFTER_MS` | 10 分 | 受付未確認の同じ指示を再送しない期間 |
| `REACH_FAIL_THRESHOLD` | 2 回 | 一過性の取りこぼしを除く |
| `REACH_CHECK_MS` / `REACH_RETRY_MS` | 30 秒 / 10 秒 | follow の hello と同じ周期。失敗中は短く再確認し 2 回目で素早く判定する |

### 再送の冪等性

server は `task_id` の重複を除かないため、再送は二重実行になる。pending に指示の fingerprint（cap_id + 中身の hash）を持ち、受付未確認のまま 10 分以内に同じ指示が来たら task を送らず、前の task_id の受付確認だけやり直す（返り値は前の task_id）。受付済み、または 10 分を過ぎた指示は新しい task として送る。messenger へ送り出す前に失敗した task は pending に残さない（再送を止めないため）。

### 状態の遷移表

cap の `state`（RemoteState）と `cap_state`、server の `reachable`:

| 契機 | reachable | state | cap_state | pending[].delivery |
| --- | --- | --- | --- | --- |
| remote_send 直後（messenger へ未送信） | - | running | 直前の値 | unsent |
| messenger へ送り出した | - | running | - | sent |
| status で cap が変わった / task_result | true | running | running | accepted |
| 15 秒待っても変わらない | - | running | - | sent のまま（isError・delivered:false） |
| status / hello が 1 回失敗 | true（failures=1） | 変わらない | 変わらない | 変わらない |
| 連続 2 回失敗（作業中の cap） | false | unknown | unknown | 変わらない |
| 応答が戻る | true（failures=0） | 元に戻る（status で取り直し） | status / activity の値 | 受付が分かれば accepted |
| activity の cap が lost | - | failed（未完了の指示は終了として通知） | lost | 変わらない |
| 新しい task が受け付けられる / cap が動き直す | - | running | running | accepted |

### task の送信を task_result の chain から外す（安全性）

- 変更前: `server-link` は同じ cap_id の指示を返信（task_result = cap の完了）まで直列にしていた。1 本目の task が実行中だと 2 本目は center の中で待たされ、「remote 指示」の log の後に「指示送信」が出ず、返り値も先に返っていた（事象 3）。
- 変更後: task は messenger に送り出した時点（`onSent`）で次の指示を通す（`releaseOnSend`）。task 以外の指示（status など）は従来どおり返信まで直列。
- 根拠: 順序は center の chain が送り出しを順番に行うので、同じ cap への 2 本目は 1 本目の後に broker へ出る。実行の直列化は server が持つ（`docs/protocol.md`「Commands to the same agent are serialized」「Runs are serialized per cap」。status の `queued` = 待っている command 数）。2 本目が 1 本目の完了前に届いても server が待たせるだけで並行実行にならない。1 本目の task_result は task_id（center が採番）で照合するので、返信が後から重なっても取り違えない。
- 依存する前提と限界: (a) broker 経由の到着順が送信順であること（protocol に順序保証の明記は無い。messenger の単一接続上の送信なので通常は保たれるが、保証はしていない）。順序が入れ替わっても cap は 2 本を直列に実行するだけで、実行順が逆になりうる。(b) 二重送信: server は task_id の重複を除かないため、center が同じ指示を再送すると二重実行になる。→ 受付未確認の同じ指示は 10 分間再送しない（上の「再送の冪等性」）。10 分を過ぎた同じ指示は新しい task として送る。(c) 受付の判定は status の `queued` / `last_started_at` の変化なので、2 本続けて送った時の受付確認は server ごとの直列（`serial`）の中で 1 本ずつ行い、次の送信の基準（base）を汚さない。
- 検証: 実機の server とは繋いでいない。fake の link で、受付なし → 再送しない、受付あり → delivered:true を確認。

## 変更点

center（`packages/center`）:
- `remotes.ts`: `remote_send` が受付を確認してから返す（`delivered` / `delivery` / `delivered_at` / `error`）。pending に `delivery` / `sent_at` / `accepted_at` / `fp` / `base`。`RemoteView` に `reachability`、`cap_state`。`cap_lost` の記録。`checkReachability()`（周期 + 直接）、`noteReach()`。`summary()` に `unreachable[]` / `lost[]`（`{server, remoteId, lastOkAt|at}`）。集計が変わると `onSummaryChange` → `GET /events` の `reason: "remote"`（既存の経路）。
- `server-link.ts`: task の送信を task_result の chain から外す（`releaseOnSend`）、`taskOn` の `onSent` hook、status 返信を peer で取り違えない `Pending.peer`、`isTransportError`（無返信・送信失敗と server の error の区別）。
- `follow.ts` / `daemon.ts`: hello の応答の有無を `remotes.noteReach` へ接続。
- `tools.ts`: `remote_send` は `delivered:false` で isError。説明の更新。

desktop（`packages/desktop`）:
- `src-tauri/src/session.rs`: `SessionRemote` に `unreachable` / `lost`（`SessionRemoteIssue`）。
- `types/index.ts`、`useBoard.ts`: `SessionActivity` に `remote-unreachable` / `remote-lost`。優先順位は claude の needs-input／remote の未返答 > 到達不能 > lost > 作業中 > remote 作業中 > 待機。connected の session だけ（未返答の worker の質問のみ state を問わない）。
- `SessionActivityMark.vue`、`pages/index.vue`: icon と tooltip、集計 chip。

### 画面の icon

| data-activity | label（title / aria-label のみ） | icon | 色 |
| --- | --- | --- | --- |
| working | 作業中 | loader-circle（回る） | info |
| needs-input | 判断待ち | message-circle-question | warning |
| idle | 待機 | circle-check | success |
| remote-working | remote 作業中 | server-cog（回る） | info |
| remote-unreachable | 到達不能 | server-off | error |
| remote-lost | lost | unplug | error |

tooltip: 到達不能 = 「到達不能: remote の server に届かない…: server <名前>（最後の応答 MM/DD HH:mm）」、lost = 「lost: …: server <名前>（MM/DD HH:mm に通知）」。集計 chip は到達不能・lost を別 chip にし、該当 session がある間だけ出す（既存 3 chip の表示・件数は変えない）。判断: 既存の流儀（remote-working は作業中に数える）だと異常が埋もれるため、異常は別 chip にした。

## 返り値の形

remote_send（成功）: `{remote_id, server, server_id?, peer, host?, serverName, state:"running", created, task_id, worker_model?, delivered:true, delivery:"accepted", delivered_at}`。
remote_send（受付を確認できない）: isError で `{…同じ, delivered:false, delivery:"sent"|"unsent", error}`（`delivered_at` 無し）。
remote_list: 各 cap に `reachability: {reachable, last_ok_at, failures, last_error?}`、`cap_state: running|idle|lost|unknown`、`pending[].delivery: unsent|sent|accepted` と `sent_at` / `accepted_at`。

## テスト結果

- `packages/center`（rebase 後）: `npm run typecheck` OK。`env -u BANTOU_SESSION_TOKEN npm test` 564 件中 563 pass、1 fail（`rc-orphan.test.ts`「center を SIGKILL すると rc が孤児で残り…」: `stub A が ppid=1 で残る` のタイムアウト）。この test と対象の src は無変更で、origin/develop 4564c8e 単体（別 worktree で `rc-orphan.test.ts` のみ実行）でも同じ失敗（環境起因と推定: 孤児化した stub の ppid が 1 にならない）。
- 新規 `test/remote-visibility.test.ts` 7 件 pass: ack 成功で delivered:true、ack 取れず delivered:false（pending に sent で残り後で accepted）、再送しない（task を二重に送らない）、tool の isError、status 失敗で unknown→回復で reachable が戻る（SSE の通知つき）、hello 失敗（noteReach）、cap lost で cap_state が lost→復帰。fake の server link のみ。
- `packages/desktop`: `npm run typecheck` OK。Rust `cargo test --offline --lib remote_is_read` OK（rebase 前の実行。develop 側の `session.rs` は c7f8b7b..4564c8e で無変更。sidecar の実体が無く build できないため空のダミーを置いて実行し、実行後に削除済み）。
- e2e: nuxt generate の静的ビルド + node の簡易サーバー（port 14850）+ ms-playwright chromium-1243、bun が無いので mock bundle は esbuild で作成。結果は下記。新規 `e2e/remote-visibility.spec.ts` 5 件（icon・tooltip・文字が出ないこと・chip・SSE 即時反映・優先順位）。

e2e 全件（rebase 後）207 件 pass、失敗 0（新規 5 件を含む）。

## server 側の変更が要る点（今回は変更しない）

- `task` の ack（受付時に即 `task_accepted` 等を返す）。現状は status の cap の変化で推定しており、受付の直後に別の要因で cap が変わると偽陽性になりうる（queued / last_started_at は task 単位の識別ではない）。ack があれば推定は不要。
- `task_id` の重複排除（現状は二重実行になる。center は再送を抑止して回避）。
- 復帰した server が、再起動前の cap と新 peer の対応を hello / status で明示する情報（今は server_id で突き合わせている）。
- `docs/protocol.md` は変更なし（protocol 版を上げずに済んだ）。

## rebase で解消した衝突

develop 4564c8e への rebase で衝突したのは README 2 件のみ。どちらも develop 側の文を残し、自分の追記を載せ直した。

- `packages/center/README.md`: tool 表の `center_info` / `remote_send` 行。develop 側を残し、`remote_send` 行に delivered / delivery / delivered_at / error と ack 待ちの説明を追記し直した。
- `packages/desktop/README.md`: セッション一覧の行。develop 側の行を残し、その後ろに状態 icon の表（到達不能・lost）の項を追加し直した。

## 残課題

- 受付確認は server 単位の直列（`serial`）の中で待つため、別 session から同じ server への `remote_send` が最大 15 秒待たされる（server が落ちている時は特に）。
- 到達不能の判定は center からの status / hello の周期（最大約 30 秒 + 失敗時 10 秒）に依存する。host が落ちてから表示が変わるまで最大 40 秒前後かかる。
- center の再起動直後は `last_ok_at` が null（最初の応答まで）。
- `follow` の `onReach` 接続の単体 test は無い（`noteReach` の test で代替）。
- desktop の chip は到達不能・lost を session 数で数える。cap 単位の件数は tooltip で見る。
