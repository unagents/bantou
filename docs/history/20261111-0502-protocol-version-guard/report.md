# protocol の版上げ忘れを test で防ぐ（protocol 1.8.1）report

branch: `fix/protocol-version-guard`（基点 origin/develop 2c1bedb）。package の version（server / center / protocol / desktop）と bun.lock は触っていない。release は含めない。

## release の順序（先頭に注意）

protocol を 1.8.0 → **1.8.1** に上げた。center は protocol の版が**完全一致**する server にしか `task` / `status` を送らないので、順序が要る。

1. **server を先に npm へ publish する**（`packages/server/package.json` の version は release 側で bump。この branch では上げていない）。
2. その後に desktop（center の sidecar）を release する。center は組の server 版（`pair.server`）へ `update_server` で server を揃える。
3. **server だけを手で先に 1.8.1 へ上げ、旧 center（pair が旧版）が動いたままにしない**。旧 center の follow は `server_version` が組の版と違うと、protocol の新旧を比べずに `update_server` で組の版へ**戻す**（`packages/center/src/follow.ts` evaluate）。旧 desktop（0.1.48〜0.1.51）が残っていると 0.6.4 / 0.6.5 の server（1.8.0 の旧 hash 6c776c34…）へ戻され得る。
4. 更新の間は center と server の版が違う時間がある（`task` / `status` は版違いで断られる。`hello` / `update_server` は通る）。server は center の follow が自動で更新するので、画面操作は要らない。

## 事故の原因（再確認）

- `packages/protocol/messenger/` の `protocol.json` / `PROTOCOL.md` を変えたが版が 1.8.0 のまま。broker は `name@version` ごとに hash を持ち、同じ版で hash が違うと `PROTOCOL_CONFLICT` で断る。
- 世に出た 1.8.0 の hash は 2 つ。server 0.6.4 / 0.6.5 = `6c776c34…`、0.6.6 = `0f6b7191…`（各 release commit の定義から再計算して確認）。

## 変更

- `packages/protocol/messenger/versions.json`: 版ごとの定義 hash の記録（64 桁 hex 全体）。1.0.0〜1.8.1。npm package にはディレクトリごと同梱される（`copy-protocol.mjs` が cp -r）が、`setProtocol` は `protocol.json` と `PROTOCOL.md` しか読まないので hash に影響しない。
- `packages/protocol/test/versions.test.mjs`（新規。node 依存は test のみ）:
  - 今の定義の hash が `versions.json[今の版]` と一致する。版を上げずに定義を変えると落ち、メッセージに手順を出す。
  - 版を上げて記録を足し忘れても落ちる（今の版の記録が無い）。
  - 複数 hash を持てるのは例外（1.6.0 / 1.8.0）だけで、その hash は test に固定している。他の版に 2 つ目の hash を足して通すことはできない。今の版は例外にできない。
  - hash は 1 文字違いで変わり、`protocol.json` の空白・改行だけの違いでは変わらない。
- `packages/server/test/.../protocol-registration.test.ts`: 実 broker / 実 client の `setProtocol` が返す `hash` が `versions.json[版]` と一致することを確認。記録の計算が登録と同じであることの実証。
- 版の更新: `protocol.json` と `src/server.ts` の `MESSENGER_PROTOCOL` を 1.8.1、`server.test.mjs` と `daemon.test.ts` の 1.8.0 固定を 1.8.1 へ。`RETIRE_MIN_PROTOCOL`（1.8.0）はそのまま。

## hash の計算方法（根拠）

`@unagents/messenger-client` 0.10.0 の `buildLoaded` / `protocolHash`: `sha256(canonicalJSON({ manifest, doc }))`。`manifest` = `protocol.json` を parse した値、`doc` = `PROTOCOL.md` の文字列（無ければ空）。`canonicalJSON` はキー昇順、undefined / function / symbol を落とす。git 履歴から再計算した値が事故報告の `6c776c34…` / `0f6b7191…` と一致した。

## 版の判断: 1.8.1 に上げた（据え置かない）

比較した案:
- A 据え置き + versions.json に「1.8.0 は 2 つ」と例外を明記: 今の 4 台は 0.6.6 で登録できており、変更が最小。
- B 1.8.1 に上げる。
- C 1.9.0 に上げる。

B を選んだ理由:
- 据え置きは再発経路が残る。旧 center の follow は上記の通り server を組の版（0.6.5 など）へ戻す。戻った server は `6c776c34…` の 1.8.0 を登録しに行き、broker 側の 1.8.0 の定義と食い違えば今回と同じ `PROTOCOL_CONFLICT` で名前待受に落ち、center の発見から消える。center からは更新も指示できない。
- 1.8.1 にすれば `1.8.0` と `1.8.1` は broker で別の登録になり、同時に居られる。旧 server は発見に残り、center の門で「版違い」として見え、`update_server` で直せる。消えて見えなくなる障害が、見えて直せる状態に変わる。
- 後からの `versions.json` も「1 つの版に 1 つの hash」の規則を保てる（例外は過去分に固定）。
- C を避けた理由: 1.9.0 は develop 上で別定義（`24d51a44…`、外部記憶の書き込み。9c0b37a で 1.8.0 へ戻した）として一度使われた番号。どの server release にも入っていない（0.6.3〜0.6.6 の release commit の定義が 1.7.0 / 1.8.0）ことは確認したが、開発中の broker に残っている可能性は除けない。同じ番号で別定義を登録すると同じ事故になる。patch の 1.8.1 は未使用。
- 既存の慣例（optional 項目の追加は minor）とは外れるが、番号の再利用を避けるのを優先した。

`versions.json` は 1.9.0 を記録していない（未 release。develop の履歴にのみある）。1.6.0 にも 2 つの hash がある（`34ae8dbc…` と `eb42f07e…`、前者は 4b58bb3、後者は 0f6bc85 と server 0.6.2）。どちらが世に出たかは release commit から確認できなかった分があり、両方を例外として固定した。

## 案 3: PROTOCOL_CONFLICT を center から見える形にする（提案のみ。実装しない）

実装しなかった理由: hello_result に項目を足すと `protocol.json` が変わり、版上げが要る（hello_result の形は固定の取り決め）。さらに、登録に失敗した server は protocol の発見に出ないので、center がそもそも `hello` を送る相手として拾えない。小さくは収まらない。

案（推奨順）:
1. **center 側の検出（protocol を変えない）**: center が `listPeers("all")`（protocol で絞らない）を呼び、`bantou-server` という名前なのに `protocols` に `bantou` を宣言していない peer を「protocol の定義が衝突して登録できていない（または旧 server）」として `remote_list` / `server_peers` の state に出し、log に残す。`ListedPeer.protocols` で宣言済み protocol を読める（messenger-client の型）。`server-link.ts` に名前一致の列挙が既にある。center 側の変更だけで済み、版上げ不要。
2. **server の再登録**: `daemon.ts` の `setProtocol` 失敗時に、一定間隔で再試行する（衝突元が居なくなれば自然に回復する）。ログに PROTOCOL_CONFLICT を残す。server 単体の変更。
3. server が `hello_result` に `protocol_registered: false` と理由を載せる: 1 と 2 が済んでから。protocol の版上げが要る。

## 確認した test

- `cd packages/protocol && npm run build && npm test`: 43 pass / 0 fail（`versions.test.mjs` 3 件を含む）。
- `cd packages/server && npm test`: 349 pass / 0 fail。
- `cd packages/center && npm run typecheck`: 通る。`env -u BANTOU_SESSION_TOKEN npm test`: 617 件中 616 pass / 1 fail。fail は `rc-orphan.test.ts`「center を SIGKILL すると rc が孤児で残り…」（「stub A が ppid=1 で残る」で timeout）。変更を stash した基点でも同じ test が単独で落ちるので、この変更とは無関係（この実行環境の孤児プロセスの扱いによる）。
- 変異確認: `PROTOCOL.md` の 1 文字、`protocol.json` の description の 1 文字をそれぞれ変えると `versions.test.mjs` の「今の定義の hash が…」が落ちることを確認し、戻した。`protocol.json` の空白・改行だけの変更では落ちない（hash が parse 後の値のため）。

## docs

- `docs/protocol.md`: 「Version rule」を追加（どのファイルのどの変更で版上げが要るか、versions.json に足す、release の順序）。版を 1.8.1 に。`conversation` 項目の「(no version bump)」を「(in the definition since 1.8.1)」に。
- `packages/protocol/README.md`: 「定義を変える時（版を上げる）」節。
- `packages/desktop/CLAUDE.md`: Release 手順に、定義を変えたら版を上げ server を先に publish する 1 項目。
- `docs/design/cap-orchestration.md`: 根拠・補足に 1 行。
- `packages/server/README.md`: stop_result の「protocol の版は 1.8.0 のまま」を実態に合わせた。

## 気づいた点（未対応・判断はお任せ）

- `docs/design/external-memory.md:45` の「protocol は 1.8.0 のまま」、`center/README.md` の「現行 1.8.0」等は当時の記述として残した。
- 過去の commit が「optional 項目の追加は版を上げない」と運用していた（cap-lifecycle の report にも同旨）。この規則は定義ファイルを変える限り成り立たない。今回 `docs/protocol.md` に規則を明記した。
- desktop の e2e mock の `1.8.0` は pair の任意値なので触っていない（e2e は回していない）。
