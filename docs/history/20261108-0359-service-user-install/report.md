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

## review 指摘と対応（2 回目: be65049 の検証 + L1 + 任意分）

branch の実 HEAD が指示の 6108f83 ではなく be65049（別 author が M1〜M4 を修正済み）だったため、これを土台にして元の指示の各要件と 1 項目ずつ突き合わせた。

### be65049 が既に満たしていた項目（検証のみ、変更なし）

- M1: `server.log` を bantou 所有・640 で先に作成（touch → chown → chmod。systemd / launchd 共通のコード）。docs 5 章の「root のことがある」/「sudo tail」を修正済み。
- M2: 既定 latest、`--version` 固定は非推奨で「再起動で版が戻る」を docs 3・4 章に明記。
- M3 (a) git clone → 実行 → 消すコマンド (b) NodeSource の node 22 手順と `sudo -u bantou test -x node` の die (c) claude 公式 installer のコマンド (d) 既存 HOME の `chown bantou:` (e) 「設置後は ssh しない」と journalctl / systemctl status / server.log の位置付け。
- M4: server.lock の launcher pid を `node -p` で取り SIGTERM → lock が消えるまで待つ手順、旧 config 退避、state.json のフィールド記述、running 確認の grep、rsync 有無確認、chown -R 後の読み取り確認。state.json は `session_id` `state` `last_started_at` `last_finished_at` `retries` のみでパスのフィールドは無い（state.ts と実 state.json で再確認。旧パスが効くのは session_id の先の claude 会話記録）。
- 念のため確認: repo / claude installer URL が未認証で 200（`curl -I`）。

### 今回追加で直した項目

- M1 追加: docs 5 章に server.log が無限に伸びる旨の運用メモ 1 行（ローテーション無し、`copytruncate` を使う理由）。
- M2 追加: 警告が設置の途中（unit 配置時）に出ていたのを、設置作業に入る**前**に出すよう移動（`render` を前に出して既存 unit と比較）。「`--version` 固定後に無しで再実行すると latest に戻り restart」「restart する／しない（--no-start）」「update_server の版が unit の版に戻る」を表示。docs 3 章の冪等性の説明に同旨を追記。
- M4 追加: 6.1 の順序が「旧停止 → 新 server 起動（空 caps）→ 停止 → caps 移送 → 起動」で、指示の「旧停止 → caps 移送 → 新 server 起動」と違っていた。script に `--no-start`（unit 配置と enable まで。macOS は RunAtLoad のため bootstrap もしない）を足し、6.1 を「旧停止 → `--no-start` で設置 → caps 移送 → 起動」に直した。HOME 750 でも bantou 所有なので読める旨を明記。
- L1: `--config` 省略時は `$BANTOU_HOME`（無ければ `$HOME`）の `config.json`、無く旧 `~/.config/bantou/config.json` があれば旧へ fallback（`bin/default-config.mjs` 新規、`bantou.mjs` から利用）。`packages/server/README.md` の既定パス、`workspace` 任意（省略時は config.json のある dir）、レイアウト節（root 構成）を更新。docs 1 章にも fallback を追記。
- 任意: install-service.sh の値検証（`--broker-port` / `--mcp-port` は 0..65535 整数、`--discovery` は on/off、`--broker` は `http(s)://host[:port]`）。launcher の `workspaceOf` を export して workspace 省略 fallback の単体テスト、`resolveDefaultConfig` の単体テスト（BANTOU_HOME 優先、旧への fallback）。

### テスト（2 回目）

- protocol を `tsc` でビルド後、packages/server `npm test`: 260 / 260 pass（追加 3 件）。
- install-service.sh: `bash -n` OK、shellcheck 0.11.0 警告 0、不正な引数 5 種で die、`--dry-run` は副作用なし。
- root 不要の実走（sudo / useradd / passwd / systemctl / chown / id / getent を stub、仮 HOME・仮 unit dir は作業 dir 内）: 1 回目で設置（touch→chown→640、config 生成、restart）。2 回目は config / gitconfig を上書きせず unit 変更なし・start のみ（sha1 一致）。`--version 0.6.2` で警告 4 行→unit 置換→restart。`--version` 無しに戻すと「固定解除」警告。`--no-start` は daemon-reload と enable のみで start / restart が呼ばれない。node 実行検査を落とすと die。
- `systemd-analyze verify`（レンダリング済み unit）: unit 固有の指摘なし（host 側の他 unit の警告のみ）。
- 未検証: root での実 useradd / systemd、macOS launchd（`--no-start` の launchd 分岐を含む）、移行手順の通し実行。

## review 指摘と対応（3 回目: 61f2824 への review、medium 1 / low 6）

- **[medium] 5 章の journal の位置付け**: unit は `StandardOutput` / `StandardError` を `append:` で `server.log` に向けるため、server と npx の出力は journal に出ない。docs 5 章と 1 章を直し、「起動失敗の本文は `server.log` を見る」「journal は systemd の起動/停止メッセージ程度（いつ落ちて再起動したかの確認用）」「status が failed → 原因は `server.log` 末尾」と明記。
- **[low 2] `--home` の読み替え**: 設置後の手順の冒頭に、`/home/bantou` は既定値で `--home` / `--user` を変えたら読み替える旨（5・6 章も同じ）を追加。
- **[low 3] 既存 HOME の chown**: 直下 1 つだけで再帰しないことを docs に明記。中身の所有が違う場合は空 dir 推奨、または確認の上で設置者が手で `chown -R`。
- **[low 4] `--home` の文字種**: install-service.sh が `^/[A-Za-z0-9._/-]+$` 以外（空白、`|`、`&`、`;` など）を die。docs にも明記。
- **[low 5] 6.1 の旧 config と再確認**: 旧 config は移行完了まで消さない（旧 server に戻す道を残す。消すのは 6 の後片付けで旧 workspace と一緒に）。旧 server 停止後に `running` の再確認を追加し、残っていれば停止で中断された cap / worker として控え、起動後に center から再 kick する旨を追記。
- **[low 6] 6.2 手順 5**: `config.json` の編集は `sudo -u bantou` で行う（root で編集すると所有が root になり bantou が読めない）と実行主体を明記。
- **[low 7] `workspace: null`**: 揃える先は config.ts（`=== undefined` のみ省略扱い、null はエラー）にした。理由: null は意図的な省略ではなく書き間違いの可能性が高く、起動後に config.ts で落ちるより launcher / supervisor の段階で同じエラーにするほうが一貫する。launcher.mjs / supervisor.mjs の `??` を `=== undefined` に変更し、launcher・supervisor・config の単体テストに null のケースを追加。

### テスト（3 回目）

- protocol を `tsc` でビルド後、packages/server `npm test`: 261 / 261 pass。
- install-service.sh: `bash -n` OK、shellcheck 0.11.0 警告 0。`--home` に空白 / `|` / `&` / `;` / 相対パスを渡すと die、`/var/lib/bantou-x` は通る。
- stub 実走（前回と同じ手順）: 1 回目で設置、同一引数の 2 回目は警告 0・config / gitconfig / unit の sha1 一致・start のみ、`--version 0.6.2` で警告 4 行・restart。
- 未検証は前回と同じ（root での実 useradd / systemd、macOS launchd、移行手順の通し）。
