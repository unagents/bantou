# server identity（server_id）

branch: `feat/server-identity`。この節は worker w-id-server の担当。center / desktop は w-id-center が後で追記する。

## protocol / server

### 設計

- 問題: center は server を messenger の peer id で覚える。server の再起動・再登録で peer id が変わり、記録が "unknown" になる。名前は全部 `bantou-server` で同 host の 2 server を区別できない。
- `server_id`: `srv-` + 乱数 10 桁 hex（例 `srv-0a1b2c3d4e`）。protocol の検証は `SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`（形式を将来変えても通る広さ）。
- 保存先: `<workspace>/server.json` = `{"server_id","created_at"}`。理由: workspace 直下に server 自身の state ファイルは無かった（`state.json` は caps/workers の dir ごと）。`state.json` を workspace 直下に置くと cap/worker の `removeNonKept`（KEEP_ENTRIES）や README の `state.json` の意味と紛れるため、`update.json` / `server.ready` と同じ流儀（workspace 直下、tmp に書いて rename）の別ファイルにした。
- 生成: 初回のみ。再起動・自己更新・dir ごとの移動でも同じ workspace なら不変。別 workspace は別 id。
- 壊れた/読めない時: **再生成して上書き**（起動を止めない。id は変わる）。旧形式（`server_id` 無しの他のキーだけ）は他のキーを残して足す。保存に失敗したらその起動だけの id で動き log に残す。いずれも `server.log` に `server_id 生成: ... (理由)`。理由: 起動不能にするより、center 側の記録が旧 id になる損失（再 pairing 相当）のほうが軽い。壊れた時に別名で退避はしない（最小実装）。

### 載せるフィールドと message（center 側の契約）

- `hello_result` / `status_result` に **flat・すべて optional** で追加（`ServerIdentityFields`）:
  - `server_id?: string`（SERVER_ID_PATTERN）
  - `host?: string`（`os.hostname()`）
  - `user?: string`（`os.userInfo().username`、取れなければ `$USER`/`$LOGNAME`/`unknown`）
  - `workspace?: string`（絶対パス）
- `status_result` のみ追加: `server_version?: string`（npm `bantou` 版）、`protocol_version?: string`。
- `hello_result.server_version` は既存どおり npm `bantou` の版（server の版）。`protocol_version` は登録された messenger protocol 版（今回 1.7.0）。「version」= server の版 + protocol 版の両方を載せた（既存の定義を変えていない）。
- message の名前は増やしていない（`hello` / `status` の command はそのまま）。
- 型 export: `ServerIdentityFields`, `SERVER_ID_PATTERN`（`@agent-hand/bantou-protocol`）。

### 互換

- `MESSENGER_PROTOCOL` 1.6.0 → **1.7.0**（`server.ts` / `messenger/protocol.json` / `PROTOCOL.md` / `docs/protocol.md`）。1.6.0 の center と版違いになるが、`hello` は版違いでも通る既存の取り決め。
- 旧 server の返信（新フィールド無し）は検証を通る。center は `server_id` が無ければ従来どおり peer id で扱う。
- 新フィールドが不正な型/形式（server_id が pattern 外、host 等が非 string）の返信は `isServerReply` で false。
- `@agent-hand/bantou-protocol` の package.json version（0.2.0）は上げていない。1.5.0 / 1.6.0 の protocol 変更でも上げておらず、server / center の依存が `^0.2.0` のため 0.3.0 にすると workspace 解決と bun.lock が壊れる。

### 変更点

- protocol: `src/server.ts`（型・ガード・版）、`messenger/protocol.json`、`messenger/PROTOCOL.md`、`test/server.test.mjs`。
- server: 新規 `server/utils/bantou/identity.ts`（`loadOrCreateServerId` / `buildIdentity` / `generateServerId` / `serverFile`）。送信箇所:
  - `server/utils/bantou/update.ts`: `createUpdateController().hello()`（hello_result を作る。`identity` を deps で受ける）
  - `server/utils/bantou/daemon.ts`: `execute()` の status_result、`startDaemon()` で `loadOrCreateServerId` → `buildIdentity`、`createUpdateController` と `execute` に渡す
- test: `test/server/utils/bantou/identity.test.ts`（新規）、`daemon.test.ts`（版 1.7.0）。
- docs: `packages/server/README.md`（server_id 節・レイアウト・返信）、`docs/ops/server-install.md`（4.5 節・標準形の表）、`docs/protocol.md`。

### 同じ host に 2 つ server がある時

`hello_result`/`status_result` の `server_id` と `workspace`（と `user`）で見分ける。起動時の `server.log` に `server_id=... host=... user=...` を出す。

### テスト結果

- protocol: `npm run build && npm test` → 32 pass / 0 fail。
- server: `npm test` → 290 pass / 0 fail（identity.test.ts: 初回生成、再読み込みで不変、旧形式から追記、壊れた各形式の再生成、保存不能でも起動、別 workspace は別 id、hello_result / status_result に載る、identity 無し=旧形式も検証を通る）。
- server `npm run typecheck`: 7 error（`default-config.test.ts` 6、`launcher.test.ts` 1）。いずれも触っていないファイル。今回の変更で増減なし。

### 残課題

- center 側: `server_id` で server を覚える・旧記録（peer id のみ）の引き継ぎ・表示と指定（w-id-center）。
- 壊れた server.json の退避（`.broken`）は未実装。
- `server_id` を手で変える/引き継ぐ手段（HOME を作り直す時は `server.json` を移す、と ops docs に記載のみ）。
- review 第1回 L3: commit 15b64f6 の `Claude-Session` トレーラが指示と違う。push 済み履歴の書き換え（force push）になるため直さない。この commit 以降は正しいトレーラ（`_01TuyNWyRteHWx9rPbch1q8B`）。
- 上書き（旧形式・壊れた server.json の再生成）は先勝ちにできない（rename 上書き）。壊れた状態で複数 server が同時に初回起動すると id が割れる可能性が残る（通常は起きない）。

### review 第1回の指摘と対応（protocol / server）

- L7(1) [low] 並行起動で同時に生成すると、rename 後勝ちで負けた側がメモリ上に別 id を持つ → 修正。server.json が無い時の生成を先勝ち（tmp に書いて `link`。既にあれば EEXIST）にし、負けたら読み直して勝者の id を使う。`identity.ts` の `writeAtomic(exclusive)` / `readServerId`。test 追加: 同一プロセス 16 並行、子プロセス 4 並行でも全員同じ id でファイルと一致。
- L7(4) server.json の権限 → 修正（docs）。secret を含まず umask 次第の既定権限（0644 など）で、読み取り可でよいと `identity.ts` のコメントと `packages/server/README.md` に明記。
- L7(5) user と workspace 絶対パスが peer 全員に見える → 修正（docs）。`packages/server/README.md` と `docs/ops/server-install.md` に「識別情報（host / user / workspace / server_id）は messenger の peer に見える」と明記。
- L1（docs 部分） → 修正。`docs/ops/server-install.md` に、workspace / VM を `server.json` ごとコピーすると同じ `server_id` の server が 2 つできる、複製側は `server.json` を消してから起動する、を追記。
- L3 → 上記「残課題」。直さない。
- 確認: protocol 32 pass / 0 fail、server 292 pass / 0 fail（+2）、server typecheck は develop 時点の 7 error のまま（増減なし）。

## center / desktop

担当: worker w-id-center。基点 commit 15b64f6（protocol / server）の上に積んだ。

### 設計

- 識別: center は server を `server_id` で覚え、peer id は「今の到達先」として都度更新する。`server_id` は server が hello_result / status_result で名乗る（protocol 1.7.0）。無い server（旧 server）は従来どおり peer id で扱う。
- `RemoteRecord`（remotes.json）: `server`（server_id。旧形式で server_id 不明なら peer id）、`server_id?`、`peer?`（今の到達先）、`peer_seen_at?`、`serverHost?`（host 名）、`serverUser?`、`serverWorkspace?`。server_id の有無で新旧を区別する。
- 識別の取得: `ServerLink` が返信（hello_result / status_result）から peer id → 識別を学ぶ。未取得の peer へは hello を送って取る（旧 server の返信は「識別なし」として取得済み扱い。届かない peer は 60 秒後に再試行）。同じ server_id で peer id だけ違う旧 id の識別は捨てる。
- server 指定（remote_send / remote_delete / worker_reply の `server`）: `server_id` → peer id → host 名（大文字小文字を区別しない）→ messenger の名前、の順で、最初に 1 件以上一致した段を採る。同じ段で複数一致（同じ host に 2 つなど）は error。候補を `host(server_id) user= workspace=` で列挙し、誤送信しない。remote_delete は server が今見えなくても記録の server_id / peer / host で指せる。
- 表示: host 名を主に server_id を添える（`server_label`）。同じ host 名の server が複数ある時だけ user と workspace を付ける。center の log も `describeServer`（host(server_id) user= workspace=）。desktop の server 一覧は host 名 + server_id、同じ host 名が複数なら user / workspace。RemoteActivity は `server_label`。

### 旧形式の記録の移行

- 対象: server_id の無い記録（server = peer id）。起動時（`restore`）に remotes.json を `remotes.json.pre-server-id.bak` へ退避する（既にあれば上書きしない = 冪等。失敗しても起動は止めない。log に残す）。
- 対応する server が今 hello を返す（peer id 一致、または名前 + host 一致で同名の peer が 1 つだけ）なら、記録を server_id に寄せる。同じ host に同名の server が 2 つあって peer id が一致しない記録は、取り違えを避けて引き継がない。
- 対応する server が見えない・識別を返さない旧記録は peer id のまま保持する（"unknown" を悪化させない）。その server が後で hello を返した時に `findPeer` / 通知の送信元解決で server_id へ引き継ぐ。
- 壊れた / 空の remotes.json、退避失敗、発見失敗でも `restore` は投げない。

### 古い記録の整理（`prune`、起動後 10 分ごと）

- 消すのは center の記録だけ。server には何も送らない（stop_cap などを出さない）。
- 消す: (1) 同じ server_id・同じ remote_id の重複（再登録前の旧 peer id のエントリ）。動いている記録を優先、同順位なら最新を残す。(2) 長く確認できない到達先 `peer`（`peer_seen_at` から 6 時間 = `PEER_TTL_MS` 超過、かつ今の発見にも居ない）。消すのは `peer` と `peer_seen_at` だけで、server_id・host・user・workspace は残す。
- 消さない: remote cap の記録そのもの（session × server の対応）。消えるのは `remote_delete` だけ。旧形式（server_id なし）の記録は server が peer id なので消さない。発見に失敗している間は到達先を消さない（server 側の障害か broker 側かを区別できないため）。
- `peer_seen_at` の保存は 10 分に 1 回まで（確認のたびに書かない）。

### 変更点

- center: `src/server-identity.ts`（新規。ServerIdentity / describeServer / ambiguousServerMessage）、`src/server-link.ts`（識別の学習・identify・`matchServerPeers`・`selectPeer`）、`src/remotes.ts`（記録・移行・prune・指定・表示）、`src/store.ts`（`backupFileOnce`）、`src/follow.ts`（FollowEntry に識別、log）、`src/daemon.ts`（退避・prune タイマー）、`src/tools.ts`（remote_send / remote_list / remote_delete / server_peers の説明と schema）、README。
- desktop（最小限）: `types/index.ts`（CenterServerPeer / CenterRemoteRecord に識別）、`CenterDialog.vue`（host 名 + server_id、同 host 名なら user / workspace）、`RemoteActivity.vue`（server_label）、`e2e/center.spec.ts`（1 件追加）。
- version bump は触っていない。

### 互換性

- 旧 server（識別なしの hello_result）+ 新 center: 識別なしの peer として動く。hello は再送しない。記録は peer id のまま、従来の挙動。
- 新 server + 旧 center: 追加は全て optional の flat フィールド。旧 center の検証（未知フィールドを許す）を通る。center 側の旧形式の解釈は変えていない。
- 旧形式の remotes.json は上記の移行で読み替える。新形式の remotes.json を旧 center が読むと `server` が server_id になり旧 peer id と一致しないので、server は名前 / host でしか探せない（downgrade は非推奨。退避ファイルで戻せる）。
- `remote_send` の返り値に `peer` と `host` を追加（`server` は server_id。旧 server は peer id）。`remote_list` に `server_id` / `peer` / `serverHost` / `serverUser` / `serverWorkspace` / `server_label` を追加。既存キーは残る。

### テスト結果

- center `npm run typecheck`: error なし。`npm test`: 477 pass / 0 fail（新規 `test/server-identity.test.ts` ほか）。
- protocol `npm run build && npm test`: 32 pass / 0 fail。server `npm test`: 290 pass / 0 fail、`npm run typecheck`: 7 error（develop と同数）。
- desktop `nuxt typecheck`: exit 0。e2e: 静的ビルド + 簡易サーバー + ms-playwright chromium の一時 config で全件実行: 142 pass / 0 fail（新規 1 件含む）。
- 示した事（`test/server-identity.test.ts`）: 旧 server の hello / error 返信で壊れない、新旧の返信が parseServerReply を通る、peer id 変更を同じ server として扱い cap が引き継がれる、server 引数が server_id / host / peer id で通り曖昧な host はエラー、通知元の peer id が変わっても届く（別 server_id は取り違えない）、旧形式の移行（退避・冪等・見えない記録を保持・同名 2 server で取り違えない・退避/発見失敗でも起動継続）、prune（server に何も送らない・TTL・発見失敗中は消さない）。

### 残課題

- `PEER_TTL_MS`（6 時間）と prune 間隔（10 分）は経験則でなく仮の値。運用で調整が要る。
- 新形式から旧 center への downgrade は想定しない（退避ファイルで手動復旧）。
- hello が来ない server の「記録」自体（session × server の cap）は消さない方針のため、廃止された server の cap は remote_delete まで残る。
