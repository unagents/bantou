# fix: master-cap の session 名を `<project 名>-cap` にする

## 解釈
変えるのは (a) Claude に渡す名前と (b) messenger の peer 名。(c) 内部の識別子は変えない。調べた結果、この解釈で成り立つ（内部 key まで変える必要は無い）。

## session 名の使われ方
| | 場所 | 名前 | 本 fix |
|---|---|---|---|
| (a) | `claude --remote-control <名>`（wrapper.ts buildWrapperArgs）、旧経路 `claude remote-control --name`（remote-control.ts buildRcArgs） | project 名 | `<project>-cap` |
| (b) | `--mcp-config` の bantou-messenger の `AGENT_MESSENGER_NAME`（wrapper.ts mcpConfigJson）。center が決めており session の Claude が set_name で決める作りではない | project 名 | `<project>-cap` |
| (b) | center が master-cap へ完了通知を push する宛先（daemon.ts notify → server-link notifyPeer が peer 名で引く） | project 名 | `<project>-cap`（旧名へ fallback） |
| (b) | 起動時の指示文「session「…」」（system-instructions.ts master-cap-role） | project 名 | `<project>-cap`、role@3→@4 |
| (c) | sessions の key、cap_id `c-<center-id>-<session>`、作業 dir、log 名、memory の X-Agent-Id、bantou MCP の X-Bantou-Session、session token、desktop の操作名、remote_send 等の session 引数 | project 名 | 変えない |

## 実装
- `src/session-name.ts` の `capSessionName(project)` が変換の唯一の場所。`-cap` で終わる名前は重ねない。
- messenger の名前は center が起動時に env（AGENT_MESSENGER_NAME）で決めるので、指示文で Claude に set_name させる方式は採らない（Claude の判断に依存せず確実に決まるため）。指示文には実際に付く名前だけを書く。
- 利用者や設定が別名を渡す経路は無い（name は project 名のみ）。変換は常に通る。

## 既存 session への影響
- center / app を再起動して session が再起動すると、remote-control 一覧の名前と messenger の peer 名が `bantou` → `bantou-cap` に変わる。再起動するまでは旧名のまま。
- 他の session / peer が旧名を宛先にしていると、再起動後は届かない（宛先の更新が要る）。互換の別名登録は messenger 側の仕様に踏み込むので入れていない。
- center → master-cap の完了通知は、新名で見つからなければ旧名へ送る fallback を入れた（再起動前の session に通知が届き続ける）。最小の移行処理で、sessions.json の移行は不要（key が不変のため）。
- remote の cap の記録（cap_id）と memory の記憶との対応は変わらない。

## test
- packages/center typecheck: 通る。
- packages/center test: 623 件中 622 pass・1 fail。fail は既知の不安定 test「center を SIGKILL すると rc が孤児で残り…」で、単独再実行では pass（1/1）。1 回目の実行（622 件）でも同じ test が落ち、同様に単独では通った。
- 追加した test: `capSessionName`（session-name.test.ts）、起動引数の `--remote-control <session>-cap` と messenger の `AGENT_MESSENGER_NAME`、X-Bantou-Session / X-Agent-Id / token / status が session 名のままである事（remote-control-wrapper.test.ts）、指示文の名前（system-instructions.test.ts）、cap_id が変わらない事（session-name.test.ts）。既存 test の期待値（`--name`、`--remote-control`、role@4）は更新。
- desktop: 変更が無い（画面は session 名＝内部の識別子を使い続ける）ので typecheck・e2e は回していない。
- daemon の notify fallback（新名→旧名）は単体の test が無い（daemon の組み立て内。`notifyPeer` 自体の test は既存）。
