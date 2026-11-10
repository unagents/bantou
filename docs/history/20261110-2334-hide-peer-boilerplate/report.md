# hide-peer-boilerplate 調査報告（コード変更なし）

## 結論
- 定型句（"This came from another Claude session …" 等）と messenger の message / tool 呼び出しは、**xterm の端末表示（TerminalView.vue）にしか出ない**。
- 端末の後加工（A: buffer 走査マスク、B: write 前のストリーム加工）は今は進めない。方針は利用者に確認する（center が session に流す messenger の通知を減らす案を含む）。
- この task ではコードを変更していない。

## 出る場所
- 会話は center が pty の出力バイト列を `session-output` で流し、`useTerminalStore.onOutput` → `TerminalView.vue` の `term.write(bytes)` で描く（xterm 6.0.0）。
- desktop に会話の項目（user message / tool_use / tool_result）を持つ component・データは無い。SessionColumn / RemoteActivity は会話を描かない。ThreadModal の `m.text` は task チャットで、定型句は来ない。
- repo に "came from" / "Another Claude" の文字列は無い（Claude Code 本体が出す）。
- messenger の受信は Claude Code の inbox socket 経由で会話に現れ、Claude Code の TUI が描く（center README の `--mcp-config` 節）。pty に入るのは描画済みの文字列だけ。
- tool_use / tool_result は構造化データとして desktop に届かない。repo で tool_use を扱うのは `packages/server/server/utils/bantou/activity.ts`（transcript の jsonl を読む）だけ。

## 端末の後加工が危険な理由
- 出力は Claude Code の TUI（ANSI 色、カーソル移動、再描画）。定型句は端末幅で折り返され、語の間に制御シーケンスが挟まる。固定文言の一致が取れない。
- chunk は任意位置で切れる。複数 chunk をまたぐ一致は buffering が要り、描画遅延と制御シーケンスの分断を招く。
- 2 MiB の再生 buffer と reset の経路がある。加工位置を誤ると再接続時に表示が壊れる。
- 行単位で消すと cursor 位置がずれて TUI が崩れる。
- tool_result の対応づけ（tool_use の id ↔ tool_use_id）は端末の文字列から取れない。複数行ブロックの範囲判定は Claude Code の描画書式に依存する。

## 判断が要る選択肢（未決）
1. 端末を加工せず、center が session に流す messenger の通知を減らす（利用者の方針確認待ち）。
2. 構造化経路で会話表示を新設（center に transcript API が要る。center 変更の許可が要る）。
3. xterm buffer 走査のマスク（受信 message と定型句のみ。tool 呼び出しの結果側は隠せない）。
4. 純関数と unit test のみ先行（画面には効かない）。

## 想定していた判定規則（実装していない・次回の参考）
| 対象 | 規則 |
|---|---|
| 受信 message | 先頭が `[agent-messenger] message from` / `未読 N 件` / `ping` |
| tool 名 | 接頭辞 `mcp__bantou-messenger__`（他の `mcp__bantou__*` は対象外） |
| tool_result | tool_use の id と tool_result の tool_use_id の対応で消す（構造化データが要る） |
| 定型句の固定文言 | "This came from another Claude session" / "(reply with the agent-messenger send_message tool" / "Another Claude session sent a message:" / "After completing your current task, decide whether/how to respond" |

## 残課題
- 定型句は Claude Code の文言に依存する。文言が変わると判定は効かなくなる。
- 元データ（center の記録・ログ・transcript）は変えない前提（表示のみ）。
