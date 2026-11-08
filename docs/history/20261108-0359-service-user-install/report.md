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

## review 指摘と対応（medium M1〜M4）

- **M1 server.log が root 所有**: `install-service.sh` が HOME 雛形の作成時に `server.log` を bantou 所有・`640` で先に作る（`sudo -u bantou touch` → `chown` → `chmod 640`。旧設置で root 所有になっていた場合も `chown` で直す）。systemd は既存ファイルを root で開いても所有を変えない。macOS の `StandardOutPath` も同じファイルなので揃う。docs 5 章の「root のことがある」/「sudo tail」を直し、1 章に「設置後は ssh しない、見る時は設置者が sudo で `journalctl -u bantou-server -e` / `systemctl status` / `tail`」を明記。
- **M2 版固定と自己更新**: 既定は latest のまま。`--version` 固定は非推奨とし、docs 3・4 章に「固定すると自己更新後の restart / host 再起動で固定版に戻る」を明記（「自己更新で追従」を削除）。script は `--version` 指定時に警告、既存 unit が変わる時（`--version` を変えて再実行など）に「restart される／実行中の cap は中断／update_server の版は unit の版に戻る」と警告。docs の冪等の説明にも追記。
- **M3 203 に docs だけで設置できる**:
  - (a) script の入手: 作業用に `git clone --depth 1 https://github.com/unagents/bantou.git` して実行し、終わったら消す具体コマンド。repo は公開で、未認証の HTTPS が 200（`curl -I`、GitHub API も 200）なので認証は不要と書いた。
  - (b) Ubuntu 24.04 の node 22: NodeSource（setup_22.x → `apt install -y nodejs`）を docs 2 章に記載。NVM など人の HOME 配下は不可と明記。script は user 作成後に `sudo -u bantou test -x $NODE_BIN/node`（と npx）を検査して die。
  - (c) claude CLI: 公式 native installer（`curl -fsSL https://claude.ai/install.sh | bash`、`~/.local/bin/claude`）を `sudo -u bantou -H bash -c` で入れる手順を docs と script の完了メッセージに記載。一次情報: https://code.claude.com/docs/en/setup 、https://code.claude.com/docs/en/authentication 。完了メッセージの `claude` は `$HOME/.local/bin/claude` の絶対パスにした（`sudo -u -H` の PATH に入らないため）。
  - (d) HOME が先に存在し所有が違う場合は、useradd 後に `chown bantou:`（macOS は owner のみ）。
  - (e) 「設置後は ssh しない」を 1 章に明文化（M1 参照）。
- **M4 移行手順 6.1 / 6.2**: 順序を「旧 server 停止 → caps 移送 → 新 server 起動」に直した。204 は先に止める方針に一本化。旧プロセス停止は `server.lock` の `launcher` から PID を取り出し SIGTERM、`server.lock` が消えるまで待つ具体例。旧 config は退避してから消す（新 HOME に使わない）。rsync の有無確認、`chown -R bantou:bantou` 後に bantou が読めるかの確認コマンド。`workers/` も移す（owner 記録 `logs/owner.json` を引き継ぐため）。
  - 旧パスの記録（実コード: state.ts / reports.ts / workers.ts / agents.ts）: `caps/*/state.json` のフィールドは `session_id` `state` `last_started_at` `last_finished_at` `last_error?` `retries` のみでパスは無い。旧パスが効くのは `session_id` の先の claude 会話記録（旧 `CLAUDE_CONFIG_DIR` 側）。新 HOME では見つからず `sessionMissing` → 「session が無いので新規に切り替え」(agents.ts) になり文脈が引き継がれない。進行中 cap の確認は `state` が `"running"` のものが 0 件であること（grep 例を docs に記載）。
  - script は即 enable+start するので、6.1 は「旧停止 → script（新 server 起動、caps 空）→ 新 server 停止 → rsync → 起動」の順にした（script の仕様は変えていない）。

## テスト（M1〜M4 修正後）

- packages/server `npm test`: 257 / 257 pass（protocol を `tsc` でビルド後）。
- install-service.sh: `bash -n` OK。shellcheck 0.11.0（npx shellcheck）警告 0。`--dry-run`: 副作用ゼロ（呼ばれたのは読み取りの `id` のみ）。
- 実走（root 不要経路。sudo / useradd / passwd / systemctl / chown / chmod / id / getent を stub に差し替え、仮 HOME・仮 unit dir は作業 dir 内）: `sudo -u bantou touch server.log` → `chown bantou` → `chmod 640` が実行される、先に存在した HOME で所有が違うと `chown bantou:` が呼ばれる、NODE_BIN 検査が通る、`FAIL_NODE=1` で die する。2 回目は config.json / gitconfig を上書きせず（cmp 一致）、unit 変更なしなら restart しない。`--version` を変えた 3 回目は警告 2 行を出して unit を置き換え restart。
- `systemd-analyze verify`（レンダリング済み unit）: 出力なし（OK）。plist（レンダリング済み）は fast-xml-parser で well-formed と確認（xmllint はこの host に無い）。

## 残り（low、今回は直していない）

- L1: `--config` 省略時の既定パスが `~/.config/bantou/config.json` → `$BANTOU_HOME`/`$HOME` の `config.json` に変わった（後方互換）。`packages/server/README.md` の古い記述（:27、:68）。
- L2: install-service.sh の入力検証（`--broker-port` 等の数値検査）、config.json の `--model sonnet` / `timeoutMs` 固定。
- L3: launcher/bantou.mjs の単体テスト不足。server.log のローテーション無し。peer id が起動ごとに変わる（agent-messenger broker の register が毎回乱数 8 文字を生成する仕様で、この branch の範囲外。影響: remote_send の宛先 id が再起動で変わる。center は名前 `bantou-server` + host で引くので名前経由は影響なし）。
- 任意: 6.1 で新 server が一度空の caps で起動する点を避けたいなら、script に `--no-start` を足す案がある（未実装）。

## 未検証

- root での実 useradd / systemd 起動（stub での実走のみ。209 の実機確認は修正前の版）。
- macOS launchd 実機。host 再起動。
- 移行手順 6.1 / 6.2 の実行（204 / 209 での通し）。claude native installer の `sudo -u bantou -H bash -c` 実行。
