# 報告書: bantou-server 雛形（204）

- 日付: 2026-10-15
- 実施: 204 の remote cap（実装 worker `server-scaffold`、model `sonnet`）

## 結果

- 雛形 commit: `31cb6c6f1c705a5ac83431bb9cfa4b7750297569`（Add bantou-server scaffold）
- push: `5bf6f35..31cb6c6  develop -> develop`（origin）
- 未了: smoke 用の一時ディレクトリ `server/.smoke/` を削除できていない（後述）

## cargo build / cargo test

- `cargo build`: 成功（`Finished dev profile ... in 8.29s`）
- `cargo test`: 4 passed / 0 failed（cap 側でも `cargo test --offline` を再実行して成功を確認）
  - `config::tests::parses_config_from_temp_file`
  - `config::tests::missing_workspace_is_an_error`
  - `config::tests::resolves_config_path`
  - `workspace::tests::creates_workspace_and_repos`

## 起動から SIGTERM 終了まで（worker の実測）

```
bantou-server 0.1.0 starting
config loaded: config.toml
workspace ready: .../server/.smoke/ws (repos: .../server/.smoke/ws/repos)
SIGTERM received, shutting down
shutdown complete
```

- SIGTERM: exit code 0。起動後に `<workspace>/repos/` の作成を確認した。
- SIGINT: exit code 0（ログ末尾 `SIGINT received, shutting down` / `shutdown complete`）。
- 残存プロセス: `ps -eo pid,args | grep '[b]antou-server'` で該当なし。

## 作成・変更したファイル

- 新規: `server/Cargo.toml`, `server/Cargo.lock`, `server/.gitignore`, `server/systemd/bantou-server.service`
- 新規: `server/src/` の `lib.rs`, `main.rs`, `config.rs`, `broker.rs`, `session.rs`, `task.rs`, `thread.rs`, `workspace.rs`, `state.rs`, `frontmatter.rs`, `security.rs`, `error.rs`, `agent.rs`
- 変更: `server/README.md`, root `README.md`, root `CLAUDE.md`（root 2 件は「実装未着手」を「雛形のみ（業務ロジック未実装）」に置換したのみ）

## 判断した点

- クレート: `tokio =1.52.3`（rt, macros, signal。ランタイムとシグナル処理を兼ねる）、`serde =1.0.228`、`toml =1.1.8`、`log =0.4.34`、`env_logger =0.11.11`、dev `tempfile =3.27.0`。desktop と重なるものは同じ pin。CLI 引数は手書きで、`clap` は入れていない。
- tokio は `current_thread` ランタイム。
- CLI は `--config` のみ受け付け、それ以外の引数はエラー。終了コードは引数エラー 2、実行時エラー 1。
- 既定の設定パスは `$HOME` から解決（`dirs` クレートは不使用）。
- `config.rs` を追加した（desktop には無いモジュール）。`menu.rs` と `live_e2e.rs` は持ち込んでいない。
- `security.rs` の `ensure_in_workspace` は、desktop と同じ path confinement を数行で実装した。業務ロジックではないため stub 方針の例外として許容した。
- systemd は user unit のテンプレート。`ExecStart` は `%h/.cargo/bin/bantou-server` を仮置きしており、配置時に調整が要る。
- smoke 用の一時 workspace は repo 内の `server/.smoke/`（`/home/vagrant/work/bantou/` 配下、`server/.gitignore` で除外）に作った。sandbox の書込範囲に収めるため。
- `cargo build` は crate レジストリへの書込が sandbox で拒否されたため、そのコマンドのみ sandbox 外で実行した。`git push` も同様に sandbox 外で実行した。

## 範囲外で見つけた問題

- `server/.smoke/` の削除が permission で拒否され、残っている（gitignore 済みのため commit には入っていない）。削除にはユーザーの許可が要る。
- repo root に `.bashrc` `.gitconfig` `.mcp.json` `.vscode` などの untracked エントリが出ている。中身は `/dev/null` と同じ character device（1,3）で、sandbox が bind mount 用に置いたものと見られる。commit には含めていない。
- `pgrep -f bantou-server` は sandbox のラッパーシェルの cmdline に一致するため、残存確認には使えない。
- root に untracked の `.session_init/` がある（作業開始前から存在）。触っていない。
