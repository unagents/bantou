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

- 消すのは center の記録だけ。記録を消すために server へ stop_cap などは送らない。ただし発見した peer のうち識別が未取得のものへは、読み取りだけの hello を送り得る（prune 自体は発見 + identify のみ）。
- 消す: (1) 同じ server_id・同じ remote_id の重複（再登録前の旧 peer id のエントリ）。動いている記録を優先、同順位なら最新を残す。(2) 長く確認できない到達先 `peer`（`peer_seen_at` から 6 時間 = `PEER_TTL_MS` 超過、かつ今の発見にも居ない）。消すのは `peer` と `peer_seen_at` だけで、server_id・host・user・workspace は残す。
- 消さない: remote cap の記録そのもの（session × server の対応）。消えるのは `remote_delete` だけ。旧形式（server_id なし）の記録は server が peer id なので消さない。発見に失敗している間は到達先を消さない（server 側の障害か broker 側かを区別できないため）。
- `peer_seen_at` の保存は 10 分に 1 回まで（確認のたびに書かない）。

### 変更点

- center: `src/server-identity.ts`（新規。ServerIdentity / describeServer / ambiguousServerMessage）、`src/server-link.ts`（識別の学習・identify・`matchServerPeers`・`selectPeer`）、`src/remotes.ts`（記録・移行・prune・指定・表示）、`src/store.ts`（`backupFileOnce`）、`src/follow.ts`（FollowEntry に識別、log）、`src/daemon.ts`（退避・prune タイマー）、`src/tools.ts`（remote_send / remote_list / remote_delete / server_peers の説明と schema）、README。
- desktop（最小限）: `types/index.ts`（CenterServerPeer / CenterRemoteRecord に識別）、`CenterDialog.vue`（host 名 + server_id、同 host 名なら user / workspace）、`RemoteActivity.vue`（server_label）、`e2e/center.spec.ts`（1 件追加）。
- version bump は触っていない。

### 互換性

- 旧 server（識別なしの hello_result）+ 新 center: 識別は「なし」として扱い（hello は再送しない）、記録は peer id のまま。ただし center は protocol 版が完全一致する server にしか task / status を送らない（`gateOf`）ので、旧 server（1.6.0）には hello / update_server だけが通り、task / status は版違いエラーになる。移行は server を 1.7.0 へ更新（follow が自動に指示）してから。
- 新 server + 旧 center: 追加は全て optional の flat フィールドで、旧 center の返信検証は通る。ただし旧 center も版が完全一致でないと task / status を断り、旧 center の follow は update_server で server を旧 pair の版へ戻す（巻き戻される）。旧 center に新 server を当てない。center 側の旧形式の解釈は変えていない。
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

### review 第1回（HEAD 705e9c6）の指摘と対応

- M1 [medium] 直した: `resolveRecord` が peer id 一致を識別より先に見て、同じ peer id に別 server_id が現れると新しい記録に届かなかった。識別（server_id）があれば先に server_id 一致で探し、server_id を持たない旧形式だけ peer id で探す。あわせて `syncRecord` が、その peer id を別の server_id の記録に残さない（旧記録の `peer` / `peer_seen_at` を外す）。再現 test 追加（遅延返信が新しい記録に届き、旧記録の peer が外れる）。補足: 二つの修正のどちらか一方でも再現 test は通る（外す方が堅い）。
- L1 [low] 直した: 同じ server_id を名乗る peer が live に複数いる時、`selectPeer`（server 指定なし・server_id・host 名で複数一致）と `findPeer`（記録の server_id）は peer id・user・workspace 付きのエラーで送らない。peer id 指定は通る。`learnIdentity` は、旧 peer id が発見に居る間は同じ server_id の識別を捨てない（揺れ・hello 再送を防ぐ）。（第2回 N1 で、再起動直後に誤ってこのエラーになる点を直した。下記）test 追加（2 peer、識別が揺れない、hello 再送なし、remote_delete は stop_cap を送らない）。
- L2 [low] 直した: `restoreInner` は発見に失敗した時 `clearStalePeers` を呼ばない（prune と同じ）。test 追加。
- L4 [low] 直した: README と本 report の互換の記述を、版完全一致の門（旧 server に task / status は通らない、旧 center に新 server を当てると巻き戻される、移行は server を 1.7.0 へ更新してから）に合わせた。
- L5 [low] 直した: README の移行節に downgrade（非推奨、`remotes.json.pre-server-id.bak` を戻す、退避は最初の 1 回で上書きしないので移行後の新規 cap は失われる）を追記。
- L6 [low] 直した（明記のみ）: 名前 + host で旧記録を引き継ぐ場合、元の server が廃止され別 server が稼働していると別の workspace / user に紐づき得る。厳密化はしない。README に制約として記載。
- L8 [low] 直した（言い回し）: 「server に何も送らない」は記録を消すための送信（stop_cap 等）に限る。識別が未取得の peer へ read-only の hello を送り得る旨を README / 本 report に書いた。

#### 残り（直していない）

- L3: commit 15b64f6 の Claude-Session トレーラが他と違う件。push 済み履歴の書き換え（force push）になるので直さない。
- L8: host 名の FQDN 差（`lenovo` と `lenovo.local`）は別の host 名として扱う。今回は直さない。
- `server_label` の「同じ host 名が複数」の判定は記録の範囲。live の同 host の別 server は考慮しない。
- 余分な旧形式の記録の掃除（surplus）は、同じ server の判定を旧形式の name + host に頼る。server_id が分かる記録との同一視は今回は直さない。
- 既存の「残課題」（PEER_TTL_MS 6 時間・prune 間隔の仮値、廃止 server の cap は remote_delete まで残る）は変わらない。

#### review 第1回後のテスト結果

- center: typecheck エラー無し、test 481 pass / 0 fail（+4）。

### review 第2回（HEAD 231ae42）の指摘と対応

- N1 [medium] 直した: 第1回 L1 の重複エラーは、server 再起動で旧 peer id（死んでいるが発見に残る）と新 peer id が同じ server_id を名乗る間にも出て、再起動のたびに送信・追従が詰まり得た（server_id を入れた目的と衝突）。
  - 方式: **同じ server_id の peer が複数いる時、その全員へ hello を投げ直し、応答した peer だけを残す**（`aliveOnly`）。両方が応答した時だけ重複エラー（本当の workspace / VM のコピー）。誰も応答しなければ何も落とさない。
  - 方式の選択: (a) 全員へ hello を再送して応答した peer を残す、(b) 重複判定を「直近で応答した peer」に限る、を比べた。(b) は応答の履歴を持ち続ける必要があり、識別を学習済みの旧 peer が履歴に居ない初回の判定が決まらない。(a) は判定の時点の生存を直接確かめ、旧 peer は hello の timeout で落ちる。(a) を採った。
  - 適用箇所: `selectPeer`（指定なし・server_id・host 名）と `identifiedPeers`（remotes の `findPeer` / 一覧が使う）。remotes.ts の findPeer は無変更で、除かれた一覧に対して判定する。
  - 抑制: 同じ顔ぶれ（peer id の集合）への再確認は `DUP_RECHECK_MS`（30 秒）に 1 回まで。同時の要求は 1 つの確認にまとめる（in-flight 共有）。死んだ peer の確認は identify と同じ timeout（既定 3 秒）で済む。
  - peer id の指定は常に通す（応答しない旧 peer でも、利用者の明示は止めない）。
  - 「約 60 秒」は messenger broker 側の挙動で未検証だった。新方式は broker の失効時間に依存しない。README の該当記述を新仕様に直した。
  - 既存 test の期待値: 第1回の L1 test の「hello を再送しない」は、重複時のみ再確認する新仕様でも通る（確認の結果が間隔内でキャッシュされ、test の計測点より後に hello が増えないため）。ただし意味が変わる: 重複時は初回に生存確認の hello が増え（識別 2 + 確認 2 = 4）、間隔内は増えず、間隔後に 1 回増える。この新仕様は新 test（`review N1: 両方が hello に答える時…`）で件数を明示した。
  - test: 旧 peer が答えず新 peer が答える時、指定なし / server_id / host 名のすべてで新 peer が選ばれ、一覧からも旧 peer が除かれる。両方が答える時は重複エラー、再確認は間隔内に増えず間隔後に 1 回。peer id 指定は旧 peer でも通る。
- N2 [low] 直した: 同じ peer を持つ 2 記録を restore で読み込み（発見失敗で syncRecord を通さない）、遅延返信が識別一致の新記録に届く test を追加。resolveRecord の順序修正を外すとこの test だけが落ちることを確認した（第1回の test は syncRecord の peer 外しでも通っていた）。

#### 残り（第2回で直していない）

- N3: server.json の link() 非対応 FS への fallback は w-id-server の担当。直していない。
- N4: 15b64f6 の Claude-Session トレーラ（第1回 L3 と同件）。force push になるので直さない。
- 生存確認は hello の応答を見る。応答が遅いだけの生きた peer（3 秒超）は一時的に除かれ得るが、次の確認（30 秒後）で戻る。

#### review 第2回後のテスト結果

- center: typecheck エラー無し、test 484 pass / 0 fail。
