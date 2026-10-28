# 指示書: center と server の broker 固定接続をやめる

- 日付: 2026-10-28 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## 方針（ユーザー確定）

- bantou は agent-messenger の上に乗る。center と server は、普通の agent-messenger client として、通常の解決（env → config → UDP 発見 → ローカル fallback）で broker につなぐ。
- 特定の broker URL を指名・固定しない。
- server は自分の broker を立てる（仕様として必須、今の実装を維持）。ただし server の稼働は自前の broker に依存しない。LAN の常設基盤（例 202 の broker、0.10.0）があればそれで動く。
- 「自前 broker があればそれ、無ければ…」のような分岐は入れない。
- broker メッシュの扱いは本件の範囲外。

## 変更内容

1. server（`server/server/utils/bantou/daemon.ts`）
   - messenger client の `brokers: [url]` と `AGENT_MESSENGER_DISCOVERY: "off"` をやめ、通常の解決に任せる。
   - broker の起動（`startBroker`）は残す。
   - 古い peer の解除など、自前 broker の URL を前提にした処理は、通常の解決でつながった broker に対して行うか、不要なら外す。判断は report に書く。
2. center（`packages/center`）
   - `createPinnedClient` の HOST/PORT 固定と discovery off をやめ、通常の解決でつなぐ client にする。
   - 設定 `servers[].broker` と `servers[].token` を削除する。server は protocol `bantou` の peer 発見（`peer` 指定があればその名前）で見つける。
   - broker への到達確認（`/health`）など、固定 URL 前提の処理を合わせて直す。
3. desktop（設定画面の servers 欄、型、e2e mock）
   - center の設定変更に合わせて broker・token 欄を外す。
4. 資料
   - `docs/architecture.md`、`docs/protocol.md`、`server/README.md`、`desktop/README.md` の該当記述を合わせる。

## 範囲外

- version bump、release、main への push。
- agent-messenger 側の変更。
- この Mac・mac200・202 の設定変更。

## 確認

- center・server の既存テストと typecheck を通す。固定 URL 前提のテストは新方針に合わせて直す。
- 204 で実動確認: server を起動し、LAN の常設 broker（`http://192.168.1.202:7901`）経由で、protocol `bantou` の peer として見えること（`curl` で 202 の `/list-peers` 等）。確認後に server は止める。

## 報告

- 同 dir に `report.md`。commit 一覧、変更点、テスト結果、判断した点、未解決。
- develop に commit・push（task.md と report.md も含める）。
