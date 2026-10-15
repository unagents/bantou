# 指示書: bantou-server 雛形（204）

- 日付: 2026-10-15 10:30
- 発行: main cap（Mac）
- 宛先: 204 の remote cap（tmux `wcap-bantou`、cwd `/home/vagrant/work/bantou/develop`）

## お前の立場

お前は bantou の remote cap。実作業はせず、Agent ツールのサブエージェント（worker）に委譲して統括する。
実装 worker は `sonnet`、調査 worker は `opus`。`model` は毎回明示する。
方針はこの指示書で確定済み。変えるな。質問するな。判断に迷う点は推奨案で進め、報告書に「判断した点」として残せ。
worker の報告にバグがあれば別 worker を立てて補修まで自律で回せ。

## 背景

- このリポは monorepo。`desktop/` は Mac 上で動く bantou-desktop（Tauri 2 + Nuxt 4）で司令塔。`server/` はリモートサーバー側で動く bantou-server。root の `README.md` と `CLAUDE.md`、`server/README.md`、`docs/protocol.md` を先に読め。
- desktop の Rust 側は `desktop/src-tauri/src/`（`broker.rs` `session.rs` `task.rs` `thread.rs` `workspace.rs` `state.rs` `frontmatter.rs` `security.rs` `error.rs` `agent.rs` `menu.rs` `lib.rs` `main.rs`）。アーキテクチャの参考として読んでよいが、`desktop/` 配下は一切変更しない。

## 目的

`server/` に bantou-server の**実装するための雛形**を用意する。雛形のみ。業務ロジック（broker 接続、メッセージ処理、desktop との通信）は実装しない。

## 要件

1. Rust の cargo プロジェクトとして `server/` 直下に置く（`server/Cargo.toml`、`server/src/`）。Tauri は使わない。通常の Linux 上で動く daemon（常駐プロセス）。
2. desktop と同様のアーキテクチャ・モジュール分割に揃える。desktop の Tauri 固有部（`menu.rs`、Tauri コマンド登録、IPC）は持ち込まない。各モジュールは役割を示す doc コメントと最小の型・関数の stub だけでよい。
3. 設定ファイル（TOML）で workspace フォルダを指定する。設定ファイルのパスは CLI 引数 `--config <path>` で受ける。既定パスは home 配下（`~/.config/bantou-server/config.toml`）。`/etc` 配下は使わない。
4. workspace フォルダ配下に repo の展開スペース（`<workspace>/repos/`）を持たせる。起動時に workspace と `repos/` が無ければ作る。
5. daemon は起動後に常駐し、SIGTERM / SIGINT で後始末して正常終了する。起動・設定読込・workspace 準備・終了をログに出す。
6. `cargo build` と `cargo test` が通る。test は設定読込と workspace レイアウト作成の最小ケースでよい。
7. systemd unit のテンプレートを `server/` 配下に置いてよいが、インストール（sudo）はしない。
8. `server/README.md` を更新する。確定した事項（Rust、設定ファイル形式、workspace レイアウト、起動方法）を書き、未決定のまま残る事項（desktop との通信方式、配置先ホスト、work session との接続方式）は未決定として残す。
9. root の `CLAUDE.md` と `README.md` は、`server/` の説明が実態と食い違う場合のみ最小差分で直す。

## 禁止

- `desktop/` 配下の変更。`docs/`、`plugin/`、`Casks/` の変更。
- 業務ロジックの実装。クレートの過剰追加（必要最小限: 設定読込、CLI 引数、ログ、シグナル処理、非同期ランタイムが要るなら 1 つ）。
- `/etc` への書込、sudo を要する操作、systemd への登録。
- python の使用。
- `/tmp` への恒久ファイル配置。
- ユーザーへの質問。

## 完了条件

- `cd server && cargo build && cargo test` が成功する。
- `--config` に指定した TOML から workspace を読み、`<workspace>/repos/` を作って常駐し、SIGTERM で正常終了することを実際に起動して確認する（一時 workspace は `/home/vagrant/work/bantou/` 配下に作り、確認後に削除する）。
- 変更を develop に commit し、`origin develop` へ push する。commit message は英語の通常文。
- 報告書を書く。

## 報告

- パス: `docs/history/20261015-1030-server-scaffold/report.md`（commit して push する）
- 必須の証跡: `cargo build` / `cargo test` の結果要約、起動から SIGTERM 終了までのログ抜粋、commit hash、push 結果、作成したファイル一覧、判断した点、範囲外で見つけた問題。
- 報告書を書いて push したら、次の指示があるまで待機する。
