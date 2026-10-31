# 追加指示 1: desktop のセッション一覧を center の session_list そのものにする

- 日付: 2026-11-01 / 発行: Mac main cap

## ユーザー指示

desktop が出すセッションの一覧が、desktop のメモリにある「追加済み」の分だけなのがおかしい。center の MCP の操作と同期しないと、center 側で作られたセッション（他の desktop や MCP から作られたもの）が永遠に出ない。

## 変更内容

- desktop のサイドメニューのセッション一覧は、つないでいる center（自分の sidecar、または貼った別ホストの center）の `session_list` そのものにする。desktop のメモリの「追加済み」一覧（`session.rs` の `Sessions`、`add_sessions`、`reconcile` の lost 判定）はやめる。
- 取り直しの時機は今の仕組み（操作前・スリープ復帰・ネットワーク変化・設定を閉じた時・5 分）に加え、center のセッションが増減した時にすぐ反映する。core の SSE にセッション一覧の変化を知らせるイベントを足し、desktop はそれを受けて `session_list` を取り直す。
- center に問い合わせられない時は、最後に取れた一覧を「つながらない」表示付きで出す。
- 「セッション追加」は新規作成（`session_create`）だけにする。一覧から選んで追加する画面は不要になる。
- `docs/design/master-cap-session.md` にこの方針を追記する（「合意した方針」に 7 として）。

## 対象

- 今動いている w-desktop（と、SSE のイベントを足す w-center）に反映する。e2e も合わせる。
