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

## review 第1回（HEAD c9577e9）の指摘と対応
- [medium] list() が identities.get(serverPeer) を引くため、server 再登録で旧 peer id が発見から消える（discoverPeers の prune）と、次の request で serverPeer が更新されるまで server_id / host が載らず、desktop で 2 行分裂が残る。
  - 対応: 識別を slot 側（`Slot.identity`）に持たせた。learnIdentity が serverPeer と一致する peer の非空の識別を slot.identity へ写す。resolveTarget で serverPeer が別 peer に変わった時は identities.get(新 id) ?? {} に置き換え（未学習なら捨てる）、同じ peer なら保つ。名前宛て（servers[].peer / フォールバック）は空。list() は slot.identity を展開。identities の既存用途（findPeer / selectPeer / aliveOnly 等）は変更なし。
  - test 追加 3: 旧 id が発見から消えても server_id / host が残る（review の再現）／別 peer に変わって未学習なら出ない／学習済みなら新しい識別が出る。
- [low] desktop e2e のモックが実態（再登録直後の窓）に一致する旨をコメントに追記（コード変更なし）。
- 結果: center typecheck OK / test 491 pass / 0 fail。desktop はコメントのみの変更で、e2e 全件の再実行は省略（前回 149 pass）。
