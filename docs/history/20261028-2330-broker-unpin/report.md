# report: center と server の broker 固定接続をやめる

- 日付: 2026-10-28 / 実行: 204 remote cap の worker / branch: develop（push はしていない）

## commit

- b5ea20d Stop pinning the broker URL in center and server（task.md・report.md を含む 1 commit）

## 変更点

- server `daemon.ts`: messenger client から `brokers: [url]` と `AGENT_MESSENGER_DISCOVERY: "off"`（と token env）を除去。通常の解決（env → config → UDP 発見 → ローカル fallback）に任せる。`startBroker` は維持。`peer 登録` ログから broker URL を外した（解決結果は messenger の `broker=... via ...` ログに出る）。
- center `server-link.ts`: `createPinnedClient` を `createClient` に置換（HOST/PORT 固定・discovery off・token を廃止）。`ServerInfo.broker` を削除。`/health` 前提の到達確認は「接続を確保できるか」に変更。
- center `config.ts`: `servers[].broker` と `servers[].token` を削除（zod は未知キーを捨てるので旧 config は無視されて読める）。`tools.ts` の説明文を修正。
- desktop: `CenterServer` 型・`center.rs`（検証、`center.json` 出力）・設定画面 servers 欄から broker を外し name のみに。Rust テスト、旧保存設定の読み込み互換テストを調整。
- テスト: center の config / server-link / tools テストを新方針に直した。固定 URL テストは「実 client が通常解決に従う（テスト専用に env HOST/PORT を一時上書きして失敗メッセージで解決先を確認）」に置換。`reachable` 既定動作のテストを追加。
- e2e スクリプト（server `e2e-launch.ts` / `probe-survival.ts`、center `scripts/e2e.ts`）: server は自前 broker を指名しなくなったため、空き port を先に決め、env（`AGENT_MESSENGER_HOST/PORT/DISCOVERY=off`）で server・center をそこへ向ける。テスト専用の上書き。
- 資料: `docs/architecture.md`、`docs/protocol.md`、`server/README.md`、`desktop/README.md`、`packages/center/README.md`。

## テスト結果

- center: `npm test` 106 件 pass / fail 0、`npm run typecheck` OK。
- server: `npm test` 98 件 pass / fail 0、`npm run typecheck` OK、`npm run build` OK。
- desktop: `cargo test` 163 pass（4 ignored）。`npm run typecheck`（nuxt typecheck）は `vue-router/volar/sfc-route-blocks` の MODULE_NOT_FOUND で実行不可。本件の変更を stash した状態でも同じエラーで、環境起因。Playwright e2e も、sandbox で fonts 取得が拒否され webServer が 180 秒でタイムアウト。実行不可（handoff 通り mac200 向け）。なお既存 e2e に servers 欄のテストは無い。
- center `npm run e2e`: 実行したが、既存不具合で失敗（`server/src/cli.ts` が存在しない。server が Nitro 構成へ移った際の取り残し）。本件が原因ではない。上記スクリプト修正は未実行確認。server の e2e-launch / probe-survival は実 claude が要るため未実行。

## 実動確認（204）

- 事前: 既存の bantou / messenger プロセス・7901 系 listen は無し。
- sandbox 内で server を起動（config は workspace のみ、既定 broker port 7901）。解決の記録（ログ原文）:
  - `config broker not reachable` が `~/.agent-messenger/config.json` の 4 件（192.168.1.202 / 192.168.1.210 / 100.74.95.112 / 100.102.221.120、各 :7901）すべてで出た。
  - `discovery: no broker answered`。
  - `Broker already running` → `broker=http://127.0.0.1:7901 (local, via local fallback)`。
  - つまり自前 broker に ローカル fallback で解決した。202 には届いていない。
- ただしこの結果は sandbox のネットワーク遮断による可能性が高い（LAN へ出られない）。`allowed_domains` に 192.168.1.202:7901 を指定しても同じ。`dangerouslyDisableSandbox` での再実行は permission で拒否された。迂回はしていない。
- よって「202 経由で protocol `bantou` の peer として見える」確認（202 の `/list-peers`）は未確認。自前 broker への fallback は実コードの通常解決の結果であり、分岐追加や URL 固定は行っていない。テスト用の env 上書きも実動確認では使っていない（e2e スクリプトとテストのみ）。
- 後始末: server は同一コマンド内で終了済み。`pgrep` に bantou.mjs 無し、7901/7902 の listen 無しを確認。一時 dir `$TMPDIR/tmp.uWIOYiKZr2`（空に近い workspace と log）の削除は permission 拒否で残っている（`/tmp/claude-1002/` 配下）。

## 判断した点

- 「古い peer の解除」: 削除。通常解決でつないだ broker の URL を client が公開しておらず（`broker.getUrl()` は内部のみ）、取るにはログ解析か二重解決が要るため。かつ broker 側が heartbeat 切れの peer を `cleanStalePeers` で掃除するため必須でない。
- `reachable`: 固定 URL が無いので `/health` は使えない。接続を確保できた（`ensure` 成功）かで判定。0.9 系 broker で `listPeers` 非対応でも true になるよう listPeers は使わない。
- 範囲外を触らない原則から、server config の `broker`（自前 broker の port/bind/discovery/token）は仕様として維持。
- 残存 grep（`brokers:` / `AGENT_MESSENGER_DISCOVERY` / `createPinnedClient` / servers の broker・token）:
  - `createPinnedClient`: 0 件。`servers[].broker/token`: 本番コード 0 件（README の廃止説明と Rust の旧設定互換テストのみ）。
  - `brokers:` と `AGENT_MESSENGER_DISCOVERY`: `server/test/.../protocol-registration.test.ts`、`server/scripts/e2e-launch.ts`、`probe-survival.ts` は、テスト用に隔離 broker へつなぐ送信側 client / テスト専用 env。本番経路ではないので妥当。`center/scripts/e2e.ts` も同様。
  - `desktop/src-tauri/src/broker.rs`: desktop の `bantou-core` が使う別系統（自分の解決実装）。本件の対象外で変更なし。
  - `server/README.md` の `"broker": {...}` は server 自前 broker の config で維持。

## 未解決

- 202 経由で `bantou` protocol の peer として見えるかの実動確認（要ネットワーク。sandbox 無効化の許可が要る）。
- desktop の nuxt typecheck と Playwright e2e が 204 で動かない（環境）。mac200 で要確認。
- center `npm run e2e` の既存不具合（`server/src/cli.ts` 不在）。
- 注意（挙動）: 202 が到達可能でも、server の自前 broker が 7901 で先に立つため、config に 202 が無い・到達不能な環境では自前 broker に fallback する。この環境では config の先頭が 202 なので到達可能なら 202 を選ぶ想定だが未検証。
- 一時 dir の残り（上記）。
