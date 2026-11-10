# server_list に server_id を載せ、desktop の結合を server_id 優先にする

## 変更点

### center
- `server_list` の返り値の組み立て箇所: `packages/center/src/server-link.ts` の `list()`（`serverPeer: slot.serverPeer` の行）。
- `ServerInfo` を `ServerIdentity` 拡張にし、`identities.get(slot.serverPeer)`（`learnIdentity` が hello_result / status_result から学習したもの）を spread。足した field: `server_id?` / `host?` / `user?` / `workspace?`。
- 未学習の link、`servers[].peer` の名前指定や名前宛てフォールバック（serverPeer が peer id でない）では出ない（optional のまま）。
- `slot.serverId` は実体が peer id（server_id ではない）なので使わず、`serverPeer` で identity cache を引いた。
- `tools.ts` の server_list 説明、center README を更新。

### desktop
- `CenterDialog.vue` の `peerOfLink`: server_id 一致（peer 側で一意な時）→ peer id 一致 → 一意な name 一致。link だけの行は `server_id` / `host` があれば表示に使う。
- `CenterServerInfo` に optional の `server_id` / `host` / `user` / `workspace`。
- e2e: 「peer id が変わっても server_id で 1 行にまとまる」＋旧形式（server_id 無し）は peer id で結合、を追加。mock の server_list は `server_id` を持てる（コメント更新）。
- desktop README を更新。

## テスト結果
- center: `tsc --noEmit` OK、`node --import tsx --test test/*.test.ts` 488 pass / 0 fail（新規 3: 識別あり・識別なし・再登録で peer id 変更）。
- desktop: `nuxt typecheck` OK、`nuxt generate` の静的ビルドを簡易 node サーバーで配信し、ms-playwright の chromium を一時 config（作業 dir 内）で指定して全件 149 pass。bun が host に無く npm install --no-package-lock で依存を入れた（bun.lock 変更なし）。

## 判断
- identity の鍵は serverPeer（peer id）。名前宛て（servers[].peer）の link は識別を引けないので server_id が付かず、従来の name 結合にフォールバック。
- server_id が複数 peer に一致する（コピー）時は server_id 結合を使わず peer id 結合へ落とす。

## 残課題
- `servers[].peer` 名前指定の link は識別が出ない（center が名前宛ての返信の from_id から serverPeer を更新する等が要るが、範囲外）。
- link は次の request まで識別を学習しない（status / hello 前は server_id 無し）。
