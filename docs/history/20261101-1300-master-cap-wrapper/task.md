# 指示書: master-cap を pty wrapper で起動し、出力を desktop に配信する

- 日付: 2026-11-01 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。commit・push は `GIT_CONFIG_GLOBAL=/home/vagrant/.config/git/agent.gitconfig` を付ける。
- 仕様の正本: `docs/design/master-cap-session.md`（合意した方針・決定 1〜12）。本書と食い違ったら設計書が正。読んでから着手する。

## やること

### 1. wrapper（新規 `packages/pty-wrapper`、Rust）

- `portable-pty` で pty を開き、渡された引数で `claude --remote-control <name> …` を起動する。
- center との間は自分の stdin / stdout。枠付きのメッセージ（例: 1 行 1 JSON）で、出力のチャンク、制御文字を除いた文字列、終了コードを center へ送り、入力・サイズ変更・停止を center から受ける。
- 子が終わったら終了コードを伝えて自分も終わる。center が死んだら（stdin が閉じたら）子を止めて終わる。
- desktop の sidecar として同梱する（`desktop/scripts/build-sidecar.ts`、`tauri.conf.json` の externalBin、両 darwin triple）。204 では Linux 向けにビルド・テストする。

### 2. center（`packages/center`）

- master-cap（`session_create` の session）の起動を、サーバー型の `claude remote-control` から「wrapper 経由の対話型 `claude --remote-control <name> --permission-mode <m> --mcp-config '<JSON 文字列>'`」に替える。config の `projects`（`rc_*`）の起動は今のまま変えない。
- `--mcp-config` の JSON はセッション向けの窓口 `http://127.0.0.1:<port>/mcp/session`、header に `Authorization: Bearer ${…}`（使い捨て token を環境変数で渡す）と `X-Bantou-Session: <name>`。ファイルは書かない。
- tool の窓口を分ける（設計書の 1、決定 8・9）。外向け `/mcp`: `session_*`、読み取り専用 `remote_list`、既存の `rc_*` / `server_*` / `worker_resume`。`remote_create` / `remote_delete` と `cap_kick` は外向けから外す。セッション向け `/mcp/session`: `remote_create` / `remote_delete` / `remote_list`（owner は header から）。
- 再起動・`--continue`・素の起動への切り替え・ログ・有効化確認への自動応答は center に残す（決定 3・5）。session URL と接続状態は、wrapper から来る文字列の直近の一定量に対して照合する（決定 4）。
- core（決定 1・2・6）: center のプロセスの中のモジュール。セッションごとのキュー（連番チャンク ID、上限 8 MiB、古い分から消す）。HTTP（center と同じポート・外向け token）で `GET` の SSE（イベント ID = チャンク ID、`Last-Event-ID` 以降を送る。古すぎれば持っている分を全部）、`POST` の入力、`POST` のサイズ変更（最後に送った desktop に合わせる、決定 11）。

### 3. desktop

- 画面を「サイドメニュー（center の session）｜リモート指示タスクの一覧｜対話の履歴」の 3 列にする（設計書の 5、決定 10）。中央は `remote_list` の owner 一致分。今の Cork 形式のタスク一覧は消さず中央の列の下に残す。
- 右の列はターミナル表示（xterm.js 系）。Rust 側が SSE を受けて Tauri の event で渡し、入力・サイズ変更は Tauri command から POST する（webview は center に直接触れない）。セッションごとのバッファ 2 MiB、受け取り済みチャンク ID を保持、古すぎる時は全部塗り替え（設計書の 4）。
- 「タスク追加を指示」ボタンと `InstructTaskDialog` をやめる（設計書の 6）。

### 4. 実測（実装時に確かめ、report に結果を書く）

- 対話型の画面出力から session URL と接続状態を拾えるか（決定 4）。
- 対話型の `claude --continue --remote-control <name>` で続きから再開できるか（決定 5）。
- 204 の claudeAgent の claude で remote-control が使えなければ、その事実を書いて実測は Mac main cap に回す（mac200 で行う）。

### 5. テスト

- center の unit（窓口の分離と認証、core のキューと SSE の続き、wrapper とのやり取り）、wrapper の Rust テスト、desktop の Rust テストと e2e（mock と spec、3 列の画面のスクリーンショット）。

## 範囲外

- version bump、release、main への push、npm publish。server の変更。
- 設計書に無い機能の追加。設計書と合わない点が出たら実装を止めず report の要判断事項に書く。

## 報告

- 同 dir `docs/history/20261101-1300-master-cap-wrapper/` に `report.md`（変更ファイル、テスト結果の件数、実測の結果、後始末の結果と残存物、要判断事項）。develop に commit・push（push まで必ず）。
- 後始末は自分で行う（一時 config・scratch・起動した dev server / playwright / claude）。消せなかったものは列挙。
