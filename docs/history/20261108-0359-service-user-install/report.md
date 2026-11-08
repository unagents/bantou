# service-user-install report (2026-11-08)

branch: feature/service-user-install（基点 develop 1f2ce896）

## 実施内容

- packages/server: workspace 省略で「config.json のある dir = root」。root 構成では `session.env.CLAUDE_CONFIG_DIR` 既定が `<root>/.claude`。`--config` 省略時は `$BANTOU_HOME`（無ければ `$HOME`）の `config.json`。launcher / supervisor / config.ts の 3 箇所。明示指定の従来構成は不変。
- scripts/install-service.sh（Linux systemd system unit / macOS launchd LaunchDaemon、冪等、--user/--home/--version/--broker/--broker-port/--mcp-port/--discovery/--dry-run）と unit 雛形 scripts/service/。
- docs/ops/server-install.md 全面更新（新標準形、設置、運用、トラブル、204 と 209/206/mini10 の移行手順）。
- 旧の設置 script は無かったため置き換え対象なし。

## テスト

- packages/server `npm test`: 257 tests / 257 pass / 0 fail（protocol を `tsc` でビルドした後）。追加: config の root 構成テスト、supervisor.test の readWorkspace 更新（workspace 省略は許容に仕様変更）。
- install-service.sh: `bash -n` OK、dry-run OK。shellcheck はこの host に無く未実施。
- macOS(launchd) は実機未検証。

## 209 の実機確認（第 2 instance）

- `sudo install-service.sh --version 0.6.2 --broker 202 --broker 210 --broker-port 7911 --mcp-port 7912 --discovery off` で user bantou（HOME /home/bantou）を作成・設置・起動。既存の vagrant の server（7901/7902）とは port を分けた。
- `systemctl is-active` = active、`is-enabled` = enabled。
- `systemctl restart` 後に戻る（peer 再登録）。main pid を `kill -9` しても 10 秒後に Restart=always で戻る。host 再起動はしていない（restart で代替）。
- server.log に `起動`、`peer 登録: name=bantou-server`、center(cecivcbt) からの `指示受信: type=hello` と `返信: type=hello_result` を確認。
- claude login は代用: vagrant の `.credentials.json` と claude バイナリを /home/bantou にコピーした（この host 内のみ。正規手順は docs の `sudo -u bantou ... claude auth login`）。
- **peer id（現在）: `83caasod`**（peer 名 `bantou-server`、host lenovo）。peer id は起動のたびに変わる（確認中に eery43ox → l0r1uhye → 83caasod と変化）。残した instance は今も動いており、再起動ごとに新 id になるので remote_list で名前・host を見ること。

## 気付き・残課題

- server.log は systemd が root で開くため所有が root（bantou からは読めない。`sudo tail`）。必要なら unit で `User` 側に開かせる改修を検討。
- 第 2 instance は gitconfig の credentials 未配置（GitHub 鍵は未設定）。
- README の「配布版は workspace 必須」な旧版 (< この変更) では `--config` 省略時の root 構成は使えない。script は明示形 config を書くので公開版 0.6.2 でも動いた。
