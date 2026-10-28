# 指示書: center 終了時に remote-control の子を確実に止める（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-2000-rc-orphan/task.md`

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止）に委譲。質問するな。

## 事実（mac200 実機、0.1.8 → 0.1.9 更新時）
- 0.1.8 の center（desktop sidecar）が 13:31 に起動した `claude remote-control --name bantou-rc --permission-mode auto --continue` が、アプリ終了と center 停止の後も ppid=1 で残った。新しい center が同じ project の remote-control を起動し、2 本が重複した。
- アプリ終了の経路: desktop の kill（SIGTERM）または brew upgrade による置き換え。center は http mode で、親プロセスの消滅（ppid の変化）を 2 秒間隔で監視して終了する設計。

## 要件
1. 原因を特定する（center が親の消滅で終了する時、center が SIGKILL された時、desktop が SIGTERM の後に kill した時に、子が残る経路）。
2. 対策（複数可）:
   - center の終了経路を全て通る子の停止（SIGTERM → 猶予 → SIGKILL）。
   - 子を process group で起動し、group ごと止める。
   - center 起動時に、同じ project の remote-control の孤児（自分の起動ではない、ppid=1、argv の `--name <project>` 一致）を見つけたら止めてから起動する（stroke の reap と同じ考え方）。
   - desktop 側の停止で center に十分な猶予を与える。
3. unit test と、stub の remote-control を使う再現テスト（center を SIGKILL → 孤児が残る → 次の center 起動で回収される）を追加。
4. version: desktop 0.1.10。commit（英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`）、`origin develop` へ push。main・release は触らない。
5. 報告 `docs/history/20261028-2000-rc-orphan/report.md`（commit・push）。原因、対策、テスト結果、mac200 で確認すべき項目。

禁止: server/・plugin/ の変更、本番 broker、sudo、python、tmux、質問。
