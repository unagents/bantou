# remote-cap を 1 つの server につき 1 つにする（center / desktop）

## 仕様

- 原則: remote-cap は 1 つの server につき 1 つだけ。作業が何であれ、center はその cap に次の指示を送る。作業ごとに cap を作らない（資源と設計の両面で無意味）。
- protocol・server は変えない。`kick_cap` は同じ cap_id なら resume、server は cap ごとに直列実行し worker の report で cap を再開する（docs/protocol.md の取り決めのまま）。
- MCP tool（`/mcp/session`）:
  - `remote_send` `{prompt, server?}` を新設。`remote_create` は同じ処理の互換の別名（schema・handler とも同一）。
  - 指示の流れ: server の `status` で cap の有無を確かめ、無い時だけ最初の `kick_cap`（`created: true`、`model` / `worker_model` は config `servers[]` の `model` / `workerModel`。設定に無ければ付けない）。あれば同じ cap_id の `kick_cap`（resume。model は付けない）。返信は待たず `{remote_id, server, serverName, state: "running", created}` を返す。
  - 引数から `repo` / `branch` / `model` / `worker_model` を外した（渡されても無視）。
  - status が error・タイムアウトの時は、cap の有無が分からないので送らず isError（記録も作らない）。
  - `remote_delete` `{remote_id?, server?, force?}`: cap の停止（`stop_cap`）と記録の削除。cap は共有なので owner を見ない。省略時は center の cap。
  - `remote_wait` `{remote_id?, server?, timeout_sec?}`、`remote_list`: cap 単位。
- 記録（`remotes.json`）は「server の cap」単位。`remote_id` = cap_id。`state` と最新の `result` / `error`、`history`（指示 = 送った session・時刻・prompt 先頭 200 文字、結果 = `cap_result`・時刻。最大 200 件で、古い完了済みから捨てる。未完了の指示は残す）。`remote_list` は加えて `owners` と `activity` を返す。
- 完了 = cap が idle かつ配下の worker に running / stalled が無い（今の done の定義のまま）。実装は「返信待ちの `kick_cap` が 0」かつ「stored state が running でない」かつ「activity で cap・worker が running / stalled でない」。その時点で未完了の指示を全て完了にし、指示を送った session ごとに 1 回 push で通知する。`cap_result` が来るたびに古い指示から順に完了にはしない。通知本文は、その owner の指示の先頭 80 文字 + 最新の result 先頭 500 文字（+ error）。
- どの session から頼んでも同じ cap に行く。通知先は指示を送った session（履歴の `owner`）。
- 2 本目以降の指示: center の server-link は同じ cap_id の `kick_cap` を直列にする（返信が来てから次を送る）。cap が実行中なら、center のメモリで待ち、server 側も cap ごとに直列。送信は server ごとに直列（status 確認 → 記録 → 投入）なので、同時に 2 本来ても最初の `kick_cap` は 1 本だけ。
- 複数 server: cap_id は同じ。記録は server ごとに 1 件（peer id、無ければ名前 + host で照合）。通知・遅れた返信は server-link が送信元の peer id（`from_id`）を渡し、記録を決める（activity の保持も peer id ごと）。同じ `remote_id` が複数 server にある時、`remote_wait` / `remote_delete` は `server` 引数が要る（無ければ error）。

## cap_id の決め方

- `c-<10 桁 hex>`。center の状態 dir（config と同じ場所）の `center-id` に保存し、無ければ最初の起動で乱数から作る（`packages/center/src/center-id.ts`）。
- 根拠: (1) center を再起動しても同じ値になる（再起動のたびに cap が増えるのを防ぐ）。(2) hostname や config パスからの導出は、別 center との衝突、dir の移動・コピーでの変化／重複が起きる。(3) 状態 dir はすでに `remotes.json` `sessions.json` の置き場で、center の状態と一緒に残る。
- 書けない時は、その起動の間だけの id を使い、ログに残す（再起動で変わるため server に前の cap が残る）。
- 限界: 状態 dir を消すと新しい id になる（server の旧 cap は旧形式と同様に残る）。

## 取り違え・二重送信の確認

- 同じ cap_id の `kick_cap` は link で直列。返信待ちは cap_id で照合され、2 本が並走して返信を取り違えることは無い（server-link の既存テスト「同じ cap_id の kick は直列」、新規テストで center 側の 2 本投入）。
- 二重送信: 最初の `kick_cap` は server ごとの直列化で 1 本だけ（テスト「同時に 2 本送っても最初の kick_cap は 1 本だけ」）。同じ指示を二重に通知しない: 完了にする処理は同期で `done_at` を付けるので、同じ指示は 1 回だけ通知される。
- 残る取り違えの余地: cap が worker の report で再開した結果（`cap_result`）が、返信待ちの指示の返信として受けられ、本来の返信が後から「遅れた返信」になり得る。どちらも cap の結果として履歴に積み、完了判定は返信待ち数 + cap の activity なので、完了と通知先は変わらない。ただし、その間 center が一瞬「返信待ち 0」と判断し、activity の更新より先に完了と見なす競合はあり得る（実機未確認）。
- 完了後に worker の report で cap が再び動いて出た結果（指示が全て完了済みの状態）は、履歴と最新状態を更新するだけで通知しない（通知先の未完了の指示が無い）。従来（`remote-done-notify`）は再通知していた点が変わる。

## 旧記録（作業ごとの cap）の扱い

- 読み捨てず、起動時に `legacy: true`（`history: []`、`owners` = 旧 `owner`）として `remote_list` に残す。`history` が無い記録を旧形式と判定する。
- 決めた理由: 旧 cap は server に残って資源を使っているので、一覧に出して `remote_delete`（`remote_id` 指定。`stop_cap` して記録を消す）で片付けられるようにするため。自動で捨てると server 側の cap が孤児になる。
- 旧形式には新しい指示を混ぜない・完了通知を送らない・遅れた `cap_result` を反映しない。`running` だったものは従来どおり `failed` で復元。
- desktop は「旧形式」バッジで出す。

## 変更ファイル

- center: `src/center-id.ts`（新規）、`src/remotes.ts`（全面改修）、`src/tools.ts`、`src/daemon.ts`、`src/server-link.ts`（`statusOn`、`onNotice` / `onLateCapReply` に送信元の peer id）、`src/activity.ts`（scope = peer id）、`src/config.ts`（`servers[].model` / `workerModel`）。
- center テスト: `test/remotes.test.ts`（全面書き直し）、`test/tools.test.ts`、`test/http.test.ts`、`test/server-link.test.ts`。
- desktop: `src/types/index.ts`、`src/components/RemoteActivity.vue`（`owners`・履歴・旧形式バッジ）、`e2e/center.spec.ts`、`e2e/terminal.spec.ts`、`e2e/mock/bantou.ts`（コメントのみ）。
- docs: `docs/protocol.md`（bantou-center tools）、`docs/architecture.md`（center の remote-cap 節）、`docs/design/center-tools.md`、`docs/design/master-cap-session.md`（追記）、`packages/center/README.md`。
- `packages/protocol` は変更なし。version bump なし（protocol 変更なし、server 変更なし）。

## テスト

- center: `bun run test` 296 件 pass / 0 fail（この clone の develop で書き換え前は 280 件、うち remote 関連 37 件が新仕様で落ちる状態 → 書き換え後 296）。`bun run typecheck` エラーなし。
  - 新規・書き換え（remotes.test.ts 48 件 + server-link 2 件 + tools / http の更新）: 2 回目の指示が同じ cap_id の kick_cap・cap が無い時だけ最初の kick（model は設定から）・cap があるのに記録が無い／cap が無くなった時・status error・複数 session の指示の記録と通知先（owner ごとに 1 通、未完了を全て完了にする）・remote_wait の完了条件（cap idle + worker 無し、複数 server は `server` 指定）・remote_delete（同じ cap_id の stop、名前 + host 照合、force）・旧形式の保持と delete・cap_id の保存と再読込・config の `servers[]` model 形式。
- desktop e2e: 81 件 pass（center.spec に cap 単位＋履歴の新テスト 1 件を追加、seed 更新）。
- cargo test（`src-tauri`）: 251 passed / 0 failed / 5 ignored。`bun run build:sidecar` 成功（sidecar は pty-wrapper のみ staged、`src-tauri/binaries` は git 管理外）。
- desktop `bun run typecheck`（`nuxt typecheck`）はこの環境で `vue-router/volar/sfc-route-blocks` が解決できず動かない（今回の変更とは無関係。TS エラーの出力は無かったが、型検査としては未確認）。
- e2e の手順: 204 は Chrome が無く nuxt dev も sandbox で動かないので、`bun run generate` の静的ビルド（`.output/public`）を簡易静的サーバー（node、127.0.0.1:1420）で配信し、ms-playwright の chromium-1243 を一時 config（clone の外）で指定。playwright は 1.64.1 で期待する chromium-1248 と版が違うが動作した。

## 未確認・注意

- 実機の server・messenger での動作は未確認（この環境に server・broker が無い）。確認項目: (1) 2 回目以降の指示が同じ cap に行き、cap が実行中でも直列に処理される。(2) 複数 session の指示が重なった時の通知。(3) server の status の `caps[].id` に cap_id が出る（protocol の `StatusReply` 型どおり）。
- server が cap の dir を消さない限り、`remote_delete` 後も server 側に cap の記録は残る（`stop_cap` は実行を止めるだけ）。その後の指示は status で cap があると見え、`created: false`（model を付けない）になる。
- center 再起動で、center のメモリで待っていた指示（直列待ち）は失われる（`failed` で復元、未完了の指示は閉じて通知しない）。
- `servers[].model` / `workerModel` は center 起動時に読む（変更は再起動で反映）。

## merge 後に人手で要ること

- なし（protocol・server 無変更、version bump なし）。server は更新不要。
- 任意: 旧形式の記録（作業ごとの cap）が server に残っていれば、`remote_list` で `legacy` を確認して `remote_delete {remote_id}` で片付ける。
- 任意: server ごとにモデルを決めたい場合は center の config `servers[]` に `model` / `workerModel` を書く（`servers[].peer` または `name` が server の peer 名に一致すること）。
- 実機で上の「未確認」項目を確認する。

## 後始末と残存物

- 起動した静的サーバー（node）は停止、一時 config・結果・ログは作業 dir の `scratch/` ごと `find -delete` で削除済み（下の確認を参照）。pgrep / ss で残存なし（`/tmp/center-rem-*` に 11/3 05:06 作成の他の実行の残骸が 1 つあるが、今回のものではないので触っていない。他の chrome は puppeteer の別プロセス）。
- 残る: 作業 dir 内の clone（`bantou/`）、その `node_modules`、desktop の `.output` `.nuxt`、`src-tauri/target`、`src-tauri/binaries`（いずれも git 管理外）。
- `bun install` で `bun.lock` は変わっていない。一時 config は commit していない。develop / main へ push・merge なし。
