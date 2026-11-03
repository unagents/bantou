# remote の完了を owner の session へ通知する / remote_wait

## 原因

- center は remote の完了（`remote_list` の state）を保持するだけで、owner の session へ送る経路が無かった。session は `remote_list` を時間を置いて見に行くしかなかった。

## 届け方とその根拠

- 第一候補は依頼どおり agent-messenger（owner の session 名の peer へ `push`）。実装した。
- コードで確かめた結果、**master-cap の session は messenger の peer ではない**。
  - `desktop/src-tauri/src/broker.rs` が broker に登録するのは `bantou-core` 1 つ（task bridge 用）。session を peer として登録する処理は無い。session から届く message を適用するだけ。
  - `docs/design/master-cap-session.md`（2026-11-01 の経路テスト）に「master-cap は messenger の peer でない」と記録がある。center は session を pty wrapper 経由の `claude --remote-control` で起動し、agent-messenger の設定は渡していない（`wrapper.ts`、`sessions.ts`）。
  - 実機で session に届くかは未確認（この環境に center・session・broker が無い）。session 側で agent-messenger plugin を入れて `set_name` を owner 名にしていれば届く、という前提の送信。
- したがって通常は peer が見つからず `notifyError` になる想定。その場合の待ち手段が `remote_wait`。
- 別案（今回は入れていない）: center の core には pty への入力口（`core.input`）がある。完了通知をここに書けば session の入力欄に確実に届くが、ユーザーが打鍵中・許可確認中の画面に文字が混ざる。依頼にない方式なので入れず、判断を残す。

## 変更

- `packages/center/src/server-link.ts`: `notifyPeer(name, text)` 追加。`listPeers("all")` で名前一致の peer（自分以外）へ `push` 送信。いない・列挙非対応・送信失敗は `{ok:false, reason}`（投げない）。
- `packages/center/src/remotes.ts`: 完了判定・通知・`wait`・`onActivity` 追加。
  - 完了 = 記録が done / failed で、activity に running / stalled の worker も cap も無い。
  - `finish`（最初の返信・後続の `cap_result` / error）で通知待ちに入れ、完了なら送る。worker がまだ動いていれば、その後の activity 通知で完了した時に送る。
  - 二重送信防止: 記録に `notifiedKey`（state + result + error）を持ち、同じ結果では通知待ちにしない。`remotes.json` に保存（`list` の出力には出さない）。
  - 通知は 1 回だけ試す。失敗は `notifyError` に理由を残し center.log に出す。再送しない。
  - center 再起動前に終わっていた記録は、通知待ち（メモリ）に入らないので通知しない。
  - `list` の `state` は、cap 自身が running の間も running を返すようにした（再開中に古い done を見せないため）。
  - `RemoteView` に `notifiedAt?`、`notifyError?`。
- `packages/center/src/tools.ts`: `remote_wait` を `/mcp/session`（owner は header、引数なし）と `/mcp`（owner は header > query > 引数）に追加。`timeout_sec` は 1〜1800、既定 600。
- `packages/center/src/daemon.ts`: `notify` を `link.notifyPeer` に、activity 通知を `remotes.onActivity` に接続。
- docs: `packages/center/README.md`, `docs/protocol.md`, `docs/design/center-tools.md`。
- desktop は触っていない（`desktop/src/types` に `notifiedAt` は未追加。表示しない）。

## テスト

- center: `bun run test` 252 件 pass / 0 fail（237 + 新規 15）、`bun run typecheck` エラーなし。
- 新規: server-link 2（`notifyPeer` の送信・失敗系）、remotes 11（通知 / failed / worker 中は待つ / 二重送信なし・再開後の再通知 / cap 再開中 / 送れない・throw / 失敗後の成功で消える / 再起動後は通知しない / wait 終了 / wait の worker 待ち / wait の省略・拒否 / wait の timeout・delete）、tools 1（`remote_wait`）。既存の tool 一覧の期待値 3 箇所を更新。
- desktop は触っていないので e2e・cargo test は未実施。

## 注意・未確認

- `remote_wait` の最大 1800 秒は、MCP client 側のツール呼び出し timeout より長い可能性がある（client 設定は未確認）。
- activity が途絶えて worker が running のまま残る場合（stale）、完了と見なさない。`remote_wait` は timeout で running を返す。
- 最初の `cap_result` が最初の activity 通知より先に届く場合、worker 起動前に完了と見なして通知し得る。

## merge の順番

1. `fix/remote-result-followup`（遅れて届く `cap_result` の反映）を develop へ。
2. 本 branch `fix/remote-done-notify`（上の commit の上に積んである）を develop へ。

## 後始末と残存物

- 一時ファイル・サーバー起動なし。作業 dir 内の clone（`bantou/`）と `node_modules` が残る。
- `bun install` で変わる `bun.lock` は commit しない（`git checkout bun.lock`）。
- version bump なし。develop / main へ push・merge なし。
