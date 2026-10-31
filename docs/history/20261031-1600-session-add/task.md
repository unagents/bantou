# 指示書: 「セッション追加」に統一する（center の session 一覧からの追加・作成、一覧の取り直し）

- 日付: 2026-10-31 / 発行: Mac main cap
- 実行: 204 remote cap（worktree）。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次（204 は高負荷で固まった前歴あり。並行で別 cap が develop で作業中）。
- 作業 dir: `/home/vagrant/work/bantou/wt-session-add`（branch `feature/session-add`、develop から分岐）。develop には push しない。branch を origin に push する。
- 前提: `docs/concept.md`。並行作業: develop で「外側 IP の既定化・IP 変化の検知・center の待ち受けを 0.0.0.0 に」が進行中（`SettingsDialog.vue`、`center.rs`、`center_snippet.rs`、`packages/center/src/http.ts` 付近）。そこへの変更は避け、衝突しそうなら report に書く。

## ユーザー確定事項

1. メニューは「セッション追加」に統一する。「PM を立てる」は「セッション追加」に統合する。
2. 送り先（ユーザーが確認済みの今の振り分けのまま）: center が on なら自分の center、off なら貼り付けた別ホストの center（`center_mcp.rs` の `select_target`）。
3. 「セッション追加」は、送り先の center の `session_list` から選んで追加する。一覧に無いものは名前を付けて `session_create` で新しく作る。
4. desktop は、追加した session をメモリに持つ（ファイルには残さない）。
5. 一覧（`session_list`）を取り直すきっかけ:
   - bantou の画面で何か操作する前（毎回）
   - OS のスリープからの復帰（macOS: `NSWorkspaceDidWakeNotification`、Windows: `WM_POWERBROADCAST` の `PBT_APMRESUMEAUTOMATIC` か `PowerRegisterSuspendResumeNotification`）
   - ネットワークの変化（macOS: `NWPathMonitor`、Windows: `NotifyIpInterfaceChange` 等）
   - 接続先の変更（設定の変更、貼り付け）
   - 保険の定期取得（長めの間隔）
   OS の通知は desktop の Rust 側で受け、フロントにイベントで渡す。crate の選択は任せる（report に）。
6. 取り直した結果の扱い:
   - center の一覧にある: そのまま残す（状態を更新）。スリープ復帰で同じネットワークなら、ユーザー操作なしで続く。
   - center の一覧から消えた: 消えた（ロスト）と表示。
   - 問い合わせられなかった: 「つながらない」と表示し、ロストと区別する。
7. MVP の「messenger につないでいる既存 session を登録する」セッション追加は、この形に置き換える（廃止）。ただし作業 session からの `task` / `ask` / `ping`（agent-messenger の `bantou-core`）は今回は触らない。

## 範囲外・未決

- 別の URL（LAN → Tailscale 等）でつなぎ直した時に同じ center と見なす識別子と、その時の session の扱いは未決。今回は作らない（report に案を書くのは可）。
- version bump、release、main / develop への push。

## テスト

- Rust（OS 通知の受け口は可能な範囲で単体テスト、突き合わせの判定）、e2e mock と spec（一覧から追加、新規作成、ロスト表示、つながらない表示、操作前の取り直し）。既存 spec の PM 関連は置き換え。e2e は 204 で動かなければ書くところまで（mac200 で main cap が実行）。

## 報告

- 同 dir に `docs/history/20261031-1600-session-add/report.md`。後始末は自分で行い、残ったものを列挙。branch `feature/session-add` を origin に push（push まで必ず）。
