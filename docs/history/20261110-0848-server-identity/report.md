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
