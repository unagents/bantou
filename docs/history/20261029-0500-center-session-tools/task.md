# 指示書: center の tool を「master-cap の起動・削除」と「master-cap に持たせる remote session 道具」にする

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。
- 必読: `docs/concept.md`（概念。これに反する決め事を作らない）、`docs/design/center-tools.md`（ドラフト）。

## ユーザー指示の要点

- center は MCP サーバーで、master-cap の生存圏。master-cap の起動・管理は center が持つ。
- master-cap は「考えて指示を出す」だけの中継役。起動手段は今は `claude remote-control`（確定ではない）。
- center の tool に要るのは: (A) 番頭が使う、center 上の session（master-cap）の起動・削除。(B) master-cap が remote session（remote-cap）を起動・削除する道具。B は center が master-cap に持たせ、中身は agent-messenger の protocol `bantou` で server に指示を送る。
- agent-messenger の通信部分は center が持つ。master-cap ごとに agent-messenger の MCP を抱えさせない（資源の無駄）。

## 変更内容

1. A（packages/center）: `session_create` / `session_delete` / `session_list`（ドラフトの表どおり）。
   - session は `claude remote-control --name <name>` を path（省略時 `<workspace>/<name>`、無ければ作る）で起動。center 再起動時は `--continue` で復帰。
   - 起動した session の一覧は center が自前で保存（config の projects には書かない）。
   - config の projects（desktop が書く workspace 1 件）は今どおり起動する。
2. B（packages/center）: `remote_create` / `remote_delete` / `remote_list`（ドラフトの表どおり）。
   - center の既存の messenger client（protocol `bantou`）で server に送る。
   - 呼んだ master-cap の識別（owner）: center が master-cap を起動する時に付けられる手段を調べて決める（例: 起動時に center の MCP 接続を session 名入りの header で持たせる）。`claude remote-control` で付けられない場合は、引数で受ける等の「今は」の案にして report に理由。
   - server 自動選択: protocol `bantou` で見つかった server の先頭。`server` 引数で指定も可。
   - `remote_delete` のために server 側に削除の命令が要るなら追加してよい（`server/`、`packages/protocol` の protocol.json は version を上げる）。
3. 既存 tool（`rc_*`、`cap_kick`、`worker_resume`、`server_list`、`server_status`）: 消さずに残す。A・B と重複する点は report に列挙（整理はユーザー判断）。
4. テスト（center・server）、`packages/center/README.md`、`server/README.md`、`docs/design/center-tools.md`（決めた点を反映、未決を更新）。
5. desktop の変更は不要なら行わない。

## 範囲外

- version bump、release、npm publish、main への push。agent-messenger 側の変更。この Mac・mac200・202 の設定変更。

## 確認

- center・server の test / typecheck。
- 可能なら 204 で center と server を起動し、A で session を作れること（remote-control が起動できない環境なら起動直前までを確認）、B で remote-cap が作られ削除されることを実測。終わったら止めて後始末。

## 報告

- 同 dir に `report.md`。判断した点は「概念」か「今は」の実装かを分けて書く。develop に commit・push（push まで必ず）。
