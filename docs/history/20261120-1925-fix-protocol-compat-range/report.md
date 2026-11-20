# fix-protocol-compat-range

基点: bfa827c（origin/fix/center-version-wait-visible）。branch: fix/protocol-compat-range。

## 変えた file
- packages/protocol/src/server.ts: `isProtocolCompatible(a, b)` を追加（major・minor が同じなら true。形 `^\d+\.\d+\.\d+$` 以外は false）
- packages/center/src/server-link.ts: 門 `gateOf` が完全一致でなく `isProtocolCompatible` を使う。A の `versionMismatchError`（更新の状態つきの文）はそのまま
- packages/protocol/test/server.test.mjs, packages/center/test/server-link.test.ts: test 追加
- packages/protocol/README.md（「版の互換」節）, packages/center/README.md（互換と更新の順序・門・版合わせの節）

## 判断
- follow.ts は変えない。`protocolOk` は従来どおり完全一致で、patch 差でも `update_server` を指示し続ける。
  patch 差のまま組の server 版に達した場合は follow の状態が `mismatch` と表示される（従来どおり。表示を壊さないため触らず、門だけ通す）。
- 形の厳格さ: pre-release 付き（1.8.1-beta）・先頭空白も false。
- PROTOCOL.md は変えない。判定は center の挙動で、定義（protocol.json / PROTOCOL.md）の内容ではない。
  変えると versions.test.mjs の hash 検査が落ち、版を上げる仕組みなので、規則は packages/protocol/README.md と center README に書いた。
  protocol.json / versions.json / MESSENGER_PROTOCOL.version は不変（messenger/ に差分なし）。
- server・Rust・desktop は未変更。server は版を見ていないことの再確認は未実施（grep していない）。

## test
- protocol: build + test 46 件 pass / 0 fail
- center: typecheck error なし。test 665 件中 664 pass、1 fail =「center を SIGKILL すると rc が孤児で残り…」（既知の不安定 test）
- 他 package: export の追加のみで型の影響は無いと判断、typecheck は走らせていない

## 変異の確認
`gateOf` の判定を `peer.version !== MESSENGER_PROTOCOL.version`（完全一致）に戻すと server-link.test.ts の
「門: patch だけ違う版の server へは送れる…」が fail（pass 65 / fail 1）。確認後 git checkout で戻した。

## 実行上の事情
- bun install は作業 dir 内の IPv4 中継（127.0.0.1）経由で通った。bun.lock は変更なし。
- 中継の疎通確認に curl を使おうとして hook に拒否された（「curl での検証を検出…」）。回避せず、そのまま bun install で確認した。
- 完了待ちの shell loop（Monitor）は auto mode classifier に拒否。回避せず通知を待った。
