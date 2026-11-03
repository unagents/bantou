# model 指定（protocol / center 側）

## 原因

remote-cap / worker / master-cap の claude に `--model` を渡す経路が無く、モデルを選べなかった。status / activity にも動作モデルが出なかった。

## 変更

- protocol を 1.3.0 → **1.4.0** に上げた（`MESSENGER_PROTOCOL`、`messenger/protocol.json`）。
  - `kick_cap` に `model?` / `worker_model?`、`AgentStatus` / `AgentActivity` に `model?: string | null` を追加。
  - `MODEL_PATTERN`（`^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`）と `isValidModel`。先頭 `-` を禁じた（引数注入を防ぐため。依頼の例より 1 文字目だけ厳しい）。
  - `docs/protocol.md` に `worker_start` の `model?`（server 側の MCP tool。仕様だけ記載）も記載。
- center:
  - `remote_create` に `model` / `worker_model`（形式検証つき）。記録（`RemoteRecord`）と `kick_cap` に載せる。省略時は載せない。
  - master-cap: `remoteControl.model`（config）を wrapper 経由の claude に `--model` で渡す。未設定なら付けない。
  - README に追記。
- desktop: remotes 欄に remote の model と、agent ごとの model を表示（`CenterRemoteRecord.model`, `CenterAgentActivity.model`）。

## 変更ファイル

- packages/protocol: `src/server.ts`, `messenger/protocol.json`, `messenger/PROTOCOL.md`, `test/server.test.mjs`
- packages/center: `src/config.ts`, `src/remotes.ts`, `src/tools.ts`, `src/wrapper.ts`, `src/remote-control.ts`, `README.md`, `test/config.test.ts`, `test/remotes.test.ts`, `test/remote-control-wrapper.test.ts`
- desktop: `src/types/index.ts`, `src/components/RemoteActivity.vue`, `e2e/center.spec.ts`
- docs: `docs/protocol.md`

## テスト

- protocol: 23 件 pass
- center: `bun run test` 236 件 pass、`bun run typecheck` OK
- desktop e2e（`bun run generate` の静的ビルド + 簡易静的サーバー + ms-playwright chromium-1243、一時 config）: `center.spec.ts` 11 件 pass（model 表示の assert を含む）。他の spec は回していない。

## 古い相手との互換

- 項目はすべて省略可、guard は未知の項目を無視する。model を知らない server の `status_result` / `activity`（`model` 無し）も通る（テスト済み）。
- 版を上げたため、既存の仕組みで **center は protocol の版が違う server（1.3.0）に `hello` / `update_server` 以外を送らない**（`version_mismatch`）。旧 server は follow が更新を指示して揃える。更新するまで旧 server への `remote_create` は断られる（記録は作らない）。この挙動は今回変えていない。
- 旧 center（1.3.0）から新 server（1.4.0）への指示は、旧 center 側の門で止まる（既存仕様）。

## server 担当への申し送り

- docs に書いた server の挙動: `kick_cap.model` は cap の `claude -p --model`、`worker_model` は cap の既定として記憶、`worker_start.model` が無ければ cap の `worker_model`、resume でも同じモデル。`status` / `activity` の `model` は未指定なら `null`。
- `kick_cap` に `model` が無い時、記憶済みの `worker_model` を消すか残すかは未定義のまま（docs には書いていない）。

## 後始末と残存物

- 静的サーバーは停止（ポート 14201 解放確認済み）。一時 config（`desktop/pw.tmp.config.ts`）・作業 dir の `tmp/` は削除。`bun.lock` は `bun install --force` で変わったので戻した。
- 残存: clone の ignored ビルド物（`desktop/.nuxt/`, `desktop/.output/`, `desktop/dist`, `packages/protocol/dist/`, `node_modules/`）。
- 気づき（未対応）: `docs/protocol.md` の tool 表に、実装が無い `cap_kick` の行が残っている。
