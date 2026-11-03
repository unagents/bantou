# bantou-server 設置手順書（192.168.1.209 向け）

204 で動いている bantou-server を 192.168.1.209 にも設置するための手順書。

- 実測日: 2026-11-03。実測は 204 の読み取り確認のみ（設定・プロセスは変更していない）。
- 記号: **[実測]** = 204 でコマンド・ファイルを確認した事実。**[README]** = bantou の README / agent-messenger のドキュメントの記述。**[推測]** = 裏が取れていない推測。**[推奨案]** = 204 には無い、この手順書の提案。
- token・パスワード・credential の値はこの文書に書かない（有無・長さ・形式のみ）。

## 1. 現状（204 の実際）

### 起動方法 [実測]

- systemd unit も専用 tmux も無い。手動の `npx` 起動。
- 実行 user は `claudeAgent`（uid 1002、gid 1001 `vagrant`、補助 group `wheelnp`）。`/etc/passwd` 上の HOME は `/home/vagrant`（user `vagrant`（uid 1001）と同じ HOME を共有）。シェルは `/bin/bash`。sudo はパスワードが要るため使えない。
- launcher: `npm exec bantou@0.3.1 --config /home/vagrant/work/bantou-server-ws/config.json`（PID 83491、2026-10-31 11:44 起動、ppid 1）。配下に `sh -c bantou ...` と `node ~/.npm/_npx/6dd17400814ef2ed/node_modules/.bin/bantou ...`（launcher 本体、PID 83516、0.3.1）。
- supervisor: `npm exec bantou --supervise --config ...`（PID 935196、ppid 1、2026-11-03 18:42 起動）。配下に `node ~/.npm/_npx/8a24be086865ab0f/node_modules/.bin/bantou --supervise ...`（PID 935209、0.4.1）と、常駐本体 `node .../bantou/bin/bantou.mjs --serve --config ...`（PID 935216、0.4.1）。
- `server.lock` = `{"pid":<supervisor>,"version":"0.4.1","started_at":...,"launcher":<launcher の node>,"child":<--serve>}`。launcher は 0.3.1 のまま、supervisor と常駐本体は自己更新で 0.4.1 になっている。 [実測]
- 起動の経緯（nohup / ssh / 手元の端末のどれか）は**不明**。launcher の ppid が 1 であることしか分からない。
- `~/.npm/_npx/` には過去の版（0.1.0 / 0.2.1 / 0.2.2 / 0.2.3 / 0.3.0 / 0.3.1 / 0.4.0 / 0.4.1）の cache が並ぶ。自己更新が新しい cache を作る [README]。

### launcher / supervisor / lock / 更新 [README]（`~/.npm/_npx/*/node_modules/bantou/README.md`「launcher・supervisor と自己更新」）

- `npx bantou` で起動する bin が launcher。起動時に 1 回だけ supervisor（`--supervise`）を起動し、以後は見張るだけ（SIGTERM / SIGINT は supervisor と lock の pid に中継）。
- supervisor は常駐本体（`--serve`）を子に 1 本持つ。二重起動は `<workspace>/server.lock` で防ぐ（生きている pid があれば `既に起動中 pid=...` で exit 1）。
- 更新（protocol `bantou` の `update_server`）: 取得確認（`npx -y --package=bantou@<版> -- bantou --version`）→ 実行中の cap・worker が全部終わるのを待つ → `update.json` を書いて exit 0 → supervisor が新版を引き継ぐ。ready にならなければ直前の版へ巻き戻す。
- 0.3.0 以前の supervisor は更新で入れ替わらない。launcher は凍結（更新されない）。

### workspace [実測]

`/home/vagrant/work/bantou-server-ws/` 直下: `caps/`、`workers/`、`config.json`、`server.log`、`server.lock`、`server.ready`（`{"pid":<--serve>,"version":"0.4.1"}`）。

- `broker.json`（README の workspace レイアウトに載るファイル）は、実測時点では存在しなかった（食い違い。理由は未確認）。
- ログは `server.log` に追記される（launcher 起動時の標準出力の先）。

### 実行環境 [実測]

| 項目 | 値 |
|---|---|
| OS | Ubuntu 24.04 LTS、kernel 6.19.0-1-t2-noble |
| node | v22.22.0、`/usr/bin/node`（NodeSource の deb `22.22.0-1nodesource1`。apt source は `/etc/apt/sources.list.d/nodesource.sources` の `https://deb.nodesource.com/node_22.x`） |
| npm / npx | 10.9.4 |
| git | 2.43.0 |
| bun | PATH に無い（server の実行に不要。README の開発手順のみ bun を使う） |
| claude | `/home/vagrant/.local/bin/claude` → `/home/vagrant/.local/share/claude/versions/2.1.317`（`claude --version` = 2.1.317）。`versions/` には 2.1.312 / 2.1.314 / 2.1.316 / 2.1.317 が残る |

## 2. 必要物

- Ubuntu 24.04、実行 user（sudo は初期セットアップのため 209 側では必要。204 では使えない）。
- node 22 以上（README: test は Node >=22）、npm / npx、git。
- claude CLI（Claude Code）。ログイン済みであること（Claude subscription の OAuth）。
- 外向き通信: `https://registry.npmjs.org`（npx の取得と自己更新）、`https://github.com`（repo clone）、Anthropic API（claude）、LAN の messenger broker（`192.168.1.202:7901` 等）。
- 受け入れ port は不要 [推測]（5 章参照）。

## 3. 設定ファイル

### `<workspace>/config.json`（204 の中身。値に秘密は無い） [実測]

```json
{
  "workspace": "/home/vagrant/work/bantou-server-ws",
  "session": {
    "claude": "/home/vagrant/.local/bin/claude",
    "env": { "CLAUDE_CONFIG_DIR": "/home/vagrant/.claude-agent" },
    "extraArgs": ["--model", "sonnet"],
    "timeoutMs": 1200000
  }
}
```

`broker` / `mcp` / `update` は省略（既定値が効く）。

### config の全キー [README]

| キー | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `workspace` | 必須 | - | workspace の絶対パス |
| `broker.port` | 任意 | `7901` | 内蔵 broker の HTTP port（0 はランダム） |
| `broker.bind` | 任意 | `127.0.0.1` | broker の bind アドレス |
| `broker.discovery` | 任意 | `"on"` | UDP discovery の応答（`on` / `off`） |
| `broker.token` | 任意 | `""` | Bearer token（空は認証なし） |
| `mcp.port` | 任意 | `7902` | `/mcp` の HTTP port |
| `mcp.bind` | 任意 | `127.0.0.1` | `/mcp` の bind アドレス |
| `session.claude` | 任意 | `claude` | claude 実行ファイル |
| `session.permissionMode` | 任意 | `auto` | `--permission-mode` |
| `session.timeoutMs` | 任意 | `1800000` | 1 回の実行の打ち切り時間（超えたら SIGKILL） |
| `session.maxRetries` | 任意 | `1` | タイムアウト・起動失敗の再試行回数 |
| `session.allowedTools` / `disallowedTools` | 任意 | `[]` | `--allowedTools` / `--disallowedTools` に渡す |
| `session.extraArgs` | 任意 | `[]` | claude にそのまま付ける追加引数 |
| `session.capBashSandbox` | 任意 | `false` | cap の Bash sandbox（false は sandbox を切る） |
| `session.env` | 任意 | `{}` | claude に渡す追加の環境変数 |
| `update.spec` | 任意 | `"bantou@{version}"` | 自己更新の取得元（通常は指定しない） |

- `--config` 省略時は `~/.config/bantou/config.json` [README]。
- 204 実測の補足: 内蔵 broker は `127.0.0.1:7901`（token 無し、discovery on）、`/mcp` は `127.0.0.1:7902`。UDP 7902 の discovery は `0.0.0.0` で待受（`ss -tulnp` で確認）。起動ログに `WARNING: no AGENT_MESSENGER_TOKEN set — broker is open` が出る（loopback bind なので外からは届かない）。
- 同 port の注意: 内蔵 broker は TCP 7901 / UDP 7902、`/mcp` は TCP 7902。209 に別の agent-messenger broker が同居する場合は port が衝突しうる [推測]。

## 4. 認証

### claude（OAuth） [実測]

- `session.env.CLAUDE_CONFIG_DIR` = `/home/vagrant/.claude-agent`。この dir は claudeAgent が書く。
- `~/.claude-agent/.credentials.json` が存在（権限 `-rw-------`、5196 byte）。トップのキーは `claudeAiOauth` と `mcpOAuth`。値は書かない。
- `~/.claude-agent/` の中身は credentials のほか `settings.json` / `CLAUDE.md` / `rules` / `plugins` / `skills` / `hooks` など。claude の設定一式がこの dir に入っている。

### claude のログイン手順 [実測: `claude --help`]

`claude auth --help` の実測:

```
claude auth login [--claudeai | --console] [--email <email>] [--sso]   # --claudeai が既定（Claude subscription）
claude auth status [--json | --text]
claude auth logout
claude setup-token    # 長期 token（Claude subscription 必須）
```

- 204 の credentials は `claudeAiOauth` キーを持つので subscription ログインと一致する（推測を含む: ログイン方法を直接見たわけではない）。
- 209 の手順: `CLAUDE_CONFIG_DIR=<dir> claude auth login` を、対話可能な端末で実行し、表示される URL をブラウザで開いて承認する。headless 端末でのコード受け渡しの挙動は 204 では未検証 **[未確認]**。
- 確認: `CLAUDE_CONFIG_DIR=<dir> claude auth status`。
- `setup-token`（長期 token）は 204 では使っていない（使用の有無は未確認）。使うかは別途判断。

### git / GitHub（agent.gitconfig） [実測]

`/home/vagrant/.config/git/agent.gitconfig`（所有 claudeAgent、権限 664）。`GIT_CONFIG_GLOBAL` で指定して使う。

```
[user]       name = claude.cli / email = claude.cli@local.host
[credential] helper = store --file /home/vagrant/.config/git/agent-credentials
[safe]       directory = *
[url "http://192.168.1.202/gitea/"] insteadOf = gitea:
[credential "https://github.com"]  helper = !gh auth git-credential
```

- `agent-credentials` は 2 行: `github.com`（user `tamamushi`）と `192.168.1.202`（user `claude.cli`）。形式は `https://<user>:<token>@host`（store 形式）。値は書かない。
- `gh` は `tamamushi` で github.com にログイン済み（https）。`gh auth git-credential` が github.com の credential を返す。
- **推奨: 209 では専用の token を新規に作る。204 の token は使い回さない。** 204 の github token は admin 系の scope を含む。209 用は最小権限（対象 repo に限定した fine-grained token で contents の read/write 程度）にする。gitea（192.168.1.202）も 209 用に別の token を発行する。
- 209 で必要な範囲は、server が `repo` 指定の指示で clone / fetch する先と、worker が push する先による（実際に使う repo を確認して絞る）。

## 5. messenger

### 接続の仕組み [README + 実測]

- server は内蔵 broker（127.0.0.1:7901）を立てるが、server 自身の messenger client は内蔵 broker を指名せず、agent-messenger の通常の解決でつなぐ。順序は env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP 発見 → ローカル fallback [README]。
- 204 の `~/.agent-messenger/config.json` [実測]（所有 vagrant、権限 664、128 byte）:

```json
{"brokers":["http://192.168.1.202:7901","http://192.168.1.210:7901","http://100.74.95.112:7901","http://100.102.221.120:7901"]}
```

- 先頭から `/health` に応答する最初の broker を使う [README: agent-messenger]。実測: server.log に `messenger: v0.10.0 host=proA1989 broker=http://192.168.1.202:7901 (remote, via config /home/vagrant/.agent-messenger/config.json)` と `Registered as peer <id>`、`peer 登録: name=bantou-server` が起動ごとに出る。
- 202 = `mini10`、210 = `air-7`（`/health` の id）。両方とも `{"status":"ok","version":"0.12.0",...,"mesh":true}` で応答（実測）。mesh 有効。
- 100.74.95.112 / 100.102.221.120 は 202・210 の別経路（tailscale の IP の可能性）だが、**対応する host は未確認**。
- 注意 [README: agent-messenger]: この `config.json` の読み込みは agent-messenger 0.12.0 で廃止予定（移行先は `~/.agent-messenger/client.json`、`set_broker(url, persist: true)`）。204 の server の messenger client は 0.10.0 で、現時点では config.json が効いている。bantou が client を上げた時に効かなくなる可能性があるので、bantou 側の README / 更新履歴を確認する。
- server から見える接続は 202 への外向きのみ（`ss -tn` で 202:4000 の接続は別件。7901 への常時接続は無く、HTTP の短い接続と見える）。受け側として外から入る port が必要かは次を参照。

### mesh と token [README: agent-messenger]

- mesh に参加するのは `AGENT_MESSENGER_MESH=on` で起動した broker のみ。同期は `POST /mesh/sync`。相手の発見は UDP 7902（announce）。
- mesh は**同じ token の broker だけ**を相手にする（`AGENT_MESSENGER_TOKEN` を全 broker で同じ値にする）。
- 202・210 は `mesh: true`。token の有無は**未確認**（`/health` は認証なしで応答した）。LAN 常設 broker に token があるかは、204 から確認できていない。もし token がある場合、209 の client に `AGENT_MESSENGER_TOKEN` を揃える方法（server の env か config）は**未確認**。bantou の config は `broker.token` を持つが、これは内蔵 broker 用で、client が使うかは未確認。
- 209 の内蔵 broker は mesh を使わない（`AGENT_MESSENGER_MESH` を設定しない。204 も同じ）。

### 注意: 同じ peer 名 [推測]

- 204 の server は `bantou-server` という名前で peer 登録する。209 の server も同じ名前で登録すると、center の `server_peers` / `remote_list` で 2 台が同名になる可能性がある。名前の重複の扱い（peer id で区別されるか）は**未確認**。確認方法は 8 章。

## 6. firewall

- 204: root が使えず firewall の設定は読めなかった **[未確認]**。
- 209: 未確認。
- server は 202 へ出ていく通信が主で、外から入る port は不要と考えられる **[推測]**。裏付け: 内蔵 broker と `/mcp` は 127.0.0.1 bind、center からの指示は peer 経由（broker 越し）で届く。
- 例外: 209 の内蔵 broker の UDP 7902 discovery は `0.0.0.0` で待受するが、LAN の他 host からの発見に使われるだけで、server の動作に必須かは未確認。
- 209 で出る通信（許可が要る場合）: TCP 192.168.1.202:7901 / 192.168.1.210:7901（messenger）、TCP 443（npm / GitHub / Anthropic）、必要なら TCP 192.168.1.202:80（gitea）。

## 7. OS / user

- OS は Ubuntu 24.04、kernel は 204 が 6.19.0-1-t2-noble。209 の kernel は問わない（未確認）。
- 204 の user 構成: `claudeAgent`（uid 1002）が server を動かす。`/home/vagrant` を `vagrant`（uid 1001）と共有し、gid 1001 `vagrant` と `wheelnp` に所属。`/home/vagrant` は `drwxr-x---`（所有 vagrant）。`~/.ssh` は `vagrant` のみ読める（claudeAgent からは Permission denied）。
- 209 では HOME を共有する必要は無く、**[推奨案]** 専用 user を 1 つ作り、その user の HOME で動かす。以下の手順では user 名を `claudeAgent` としているが、`HOME=/home/claudeAgent`（通常の HOME）とする。HOME を共有する 204 の構成を再現したい場合は別途判断する。

## 8. ssh の確認結果（204 → 209）

実行: `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new <user>@192.168.1.209 true`（204 の claudeAgent から）

| user | 結果 |
|---|---|
| `claudeAgent` | `claudeAgent@192.168.1.209: Permission denied (publickey,password).` |
| `vagrant` | `vagrant@192.168.1.209: Permission denied (publickey,password).` |

- 209 への ping は応答あり、TCP 22 は開いている（`nc -vz` 成功）。認証方式は publickey と password。
- 204 の claudeAgent が使える鍵は無い（`~/.ssh` は vagrant のみ読める）。パスワード入力・鍵の生成・配布は行っていない。
- 結論: 204 から 209 へはログインできず、手順書の実機検証は未実施。209 には人が直接（またはパスワードで）入る必要がある。

## 9. 209 で実行する順番付きの手順

前提: 209 に管理者権限（sudo）で入れる人が行う。以下の `<WS>` は workspace の絶対パス（例 `/home/claudeAgent/work/bantou-server-ws`）。user は `claudeAgent` とする（204 と合わせる [推奨案]）。

### 手順 0: 事前確認

```bash
cat /etc/os-release | head -3
uname -r
node -v; npm -v; git --version
ss -tulnp | grep -E ':790[12]\b'     # 7901 / 7902 の衝突確認
sudo ufw status                       # firewall の有無（使っていれば出る）
```

### 手順 1: user 作成

```bash
sudo adduser --disabled-password --gecos "" claudeAgent
```

- sudo は付けない（204 の claudeAgent も sudo 不可）。
- 追加の group は必須でない。204 の `wheelnp` の役割は未確認なので再現しない。

### 手順 2: node 22 を入れる

204 は NodeSource の deb（`22.22.0-1nodesource1`）。同じ方法にする。

```bash
# NodeSource の node_22.x リポジトリを追加（公式手順に従う）。その後:
sudo apt-get install -y nodejs git
node -v   # v22.x であること
```

- NodeSource のセットアップスクリプトの手順は NodeSource の公式ドキュメントで確認すること（この手順書では取得コマンドを検証していない）。
- 版: 204 は 22.22.0。NodeSource の候補は 22.23.3（204 の apt 実測）。22 系なら動く想定だが、server は 22.22.0 で確認済み。差が気になる場合は 22.22.0 に固定する（`apt-get install nodejs=22.22.0-1nodesource1`）。
- bun は不要。

### 手順 3: claude を入れる（版固定）

claudeAgent で実行する。

```bash
sudo -iu claudeAgent
claude install --help      # 実測: `claude install [target]`。target は stable / latest / 版番号
```

- 204 の claude は `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.317`（native build。`claude install` が作る配置と同じ形）。
- 版を合わせるなら `claude install 2.1.317`（target に版番号を指定できる: `claude install --help` 実測）。ただし最初の `claude` を入手する経路（インストーラ）は 204 では確認していない **[未確認]**。Claude Code の公式セットアップ手順（Anthropic の公式ドキュメント）で入手すること。
- 自動更新: `versions/` に 2.1.312 〜 2.1.317 が並ぶので 204 の claude は自動更新されている [実測。推測: claude 自身の更新機能]。固定したい場合は claude の更新設定を公式ドキュメントで確認すること **[未確認]**。
- 確認: `~/.local/bin/claude --version`、`PATH` に `~/.local/bin` が通ること。

### 手順 4: CLAUDE_CONFIG_DIR とログイン

```bash
mkdir -p ~/.claude-agent
CLAUDE_CONFIG_DIR=$HOME/.claude-agent claude auth login      # URL を開いて承認（subscription）
CLAUDE_CONFIG_DIR=$HOME/.claude-agent claude auth status
ls -l ~/.claude-agent/.credentials.json                      # 存在と -rw------- を確認（中身は見ない）
```

- 204 の `~/.claude-agent/` には settings / rules / skills / plugins なども入っているが、これらを 209 へ複製するかは別判断（この手順書の範囲外）。最小構成は認証のみ。
- 204 の credentials をコピーしてはいけない（OAuth のセッション共有になる。同じ account の別 host ログインは `claude auth login` で行う）。

### 手順 5: agent.gitconfig と credentials

```bash
mkdir -p ~/.config/git
cat > ~/.config/git/agent.gitconfig <<'EOF'
[user]
	name = claude.cli
	email = claude.cli@local.host
[credential]
	helper = store --file /home/claudeAgent/.config/git/agent-credentials
[safe]
	directory = *
[url "http://192.168.1.202/gitea/"]
	insteadOf = gitea:
[credential "https://github.com"]
	helper = !gh auth git-credential
EOF
chmod 600 ~/.config/git/agent.gitconfig
```

- `/home/claudeAgent/...` は 209 の HOME に合わせる。
- 204 の `credential.helper` は `store --file <path>`。`agent-credentials` は 209 用の token を使って作る（`git credential-store` 形式 `https://<user>:<token>@<host>`。値はこの文書に書かない）。作成後 `chmod 600`。
  - github.com 用: 209 専用の最小権限 token（4 章の推奨）。`gh auth login`（`gh` が要る場合は `apt` で入れる）でも可。204 の token は使い回さない。
  - gitea（192.168.1.202）用: 209 専用の token。
- 確認: `GIT_CONFIG_GLOBAL=~/.config/git/agent.gitconfig git ls-remote https://github.com/unagents/bantou.git HEAD`（token の値は出力に出ない）。

### 手順 6: `~/.agent-messenger/config.json`

```bash
mkdir -p ~/.agent-messenger
cat > ~/.agent-messenger/config.json <<'EOF'
{"brokers":["http://192.168.1.202:7901","http://192.168.1.210:7901","http://100.74.95.112:7901","http://100.102.221.120:7901"]}
EOF
curl -s http://192.168.1.202:7901/health      # {"status":"ok",...} が返ること
```

- 204 と同じ 4 つ・同じ順序（実測）。後ろ 2 つの host は 209 から届くか未確認。届かなくても先頭が応答すれば使われない。
- 202・210 に token がある場合の追加設定は**未確認**（5 章）。`/health` が通っても peer 登録が拒否される場合はここを確認する。

### 手順 7: workspace と config.json

```bash
mkdir -p /home/claudeAgent/work/bantou-server-ws
cat > /home/claudeAgent/work/bantou-server-ws/config.json <<'EOF'
{
  "workspace": "/home/claudeAgent/work/bantou-server-ws",
  "session": {
    "claude": "/home/claudeAgent/.local/bin/claude",
    "env": { "CLAUDE_CONFIG_DIR": "/home/claudeAgent/.claude-agent" },
    "extraArgs": ["--model", "sonnet"],
    "timeoutMs": 1200000
  }
}
EOF
```

- 204 の config をパスだけ 209 に置き換えたもの。`broker` / `mcp` は省略（127.0.0.1:7901 / 7902）。
- `caps/` と `workers/` は起動時に自動作成される [README]。

### 手順 8: npx で bantou を起動する

204 は launcher を `bantou@0.3.1` で起動し、自己更新で 0.4.1 に上がった。209 は新規なので現行版で始めてよい。

```bash
npm view bantou version           # 公開されている最新版の確認
cd /home/claudeAgent/work/bantou-server-ws
npx -y bantou --version           # 取得確認（版が 1 行出る）
npx bantou --config /home/claudeAgent/work/bantou-server-ws/config.json
```

- 版の選び方: launcher は凍結で更新されない [README]。204 が 0.3.1 のままなのは「最初に起動した版」。新規は最新版から始める方が古い launcher を残さない（推測を含む）。版を固定するなら `npx bantou@<版> ...`。
- 起動後の確認:

```bash
cat <WS>/server.lock ; cat <WS>/server.ready
tail -n 30 <WS>/server.log
```

  `server.log` に次が出ること: `bantou: 起動`、`broker 起動: port=7901 bind=127.0.0.1 ...`、`mcp 起動: url=http://127.0.0.1:7902/mcp`、`messenger: ... broker=http://192.168.1.202:7901 (remote, via config ...)`、`messenger: Registered as peer <id>`、`peer 登録: name=bantou-server`、`protocol 登録: bantou@...`。
- 前景で動かして確認 → 手順 9 の常駐化へ進む。

### 手順 9: 常駐化（選択肢と推奨）

204 は常駐化の仕組みを持たず手動 `npx`（起動の経緯は不明）。以下は**推奨案**であり 204 の実態ではない。

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| A. systemd user unit + linger | claudeAgent の user unit。`loginctl enable-linger claudeAgent`（root 要） | 再起動で自動起動。`systemctl --user` で状態・停止・ログ確認 | linger の有効化に sudo が要る。自己更新（supervisor 引き継ぎ）と unit の process 管理の相性は未検証 |
| B. systemd system unit（`User=claudeAgent`） | root が `/etc/systemd/system` に置く | 一番標準的 | root が要る。自己更新の引き継ぎ（子 process が入れ替わる）との相性は未検証 |
| C. nohup / 手動（204 と同じ） | 手で起動 | 204 と同じ | 再起動で止まる。実態が追えない |

**推奨: A（systemd user unit）**。理由: 再起動で戻る、sudo は linger の 1 回だけ。

注意（自己更新との相性）[README + 推測]:

- launcher（`npx bantou`）が supervisor を起動し、supervisor は更新で入れ替わる（新 supervisor の npx は launcher の外で残る）。systemd が追うのは launcher だけにするため、`KillMode=` の扱いで更新後の supervisor が巻き込まれる可能性がある **[未検証]**。unit 化したら、更新（`update_server`）を 1 回試して、更新後も server が生きていること・systemd が二重起動しないことを確認する。
- `Type=simple`、`ExecStart` は npx の絶対パス + `bantou --config <WS>/config.json`、`Restart=on-failure` を起点にする案（**未検証の草案**）:

```ini
# ~/.config/systemd/user/bantou-server.service  （推奨案・未検証）
[Unit]
Description=bantou-server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/claudeAgent/work/bantou-server-ws
ExecStart=/usr/bin/npx bantou --config /home/claudeAgent/work/bantou-server-ws/config.json
Restart=on-failure
RestartSec=10
Environment=PATH=/home/claudeAgent/.local/bin:/usr/bin:/bin
StandardOutput=append:/home/claudeAgent/work/bantou-server-ws/server.log
StandardError=append:/home/claudeAgent/work/bantou-server-ws/server.log

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger claudeAgent                 # root で 1 回
systemctl --user daemon-reload
systemctl --user enable --now bantou-server
systemctl --user status bantou-server
```

### 手順 10: 停止 / 更新

停止 [README]:

- 前景起動なら Ctrl-C。それ以外は launcher の PID に SIGTERM / SIGINT（launcher が supervisor と lock の pid に中継）。実行中の claude を止め、peer 解除・broker 停止して exit 0（5 秒で打ち切り）。
- 確認: `pgrep -af bantou`、`ss -tulnp | grep -E ':790[12]\b'`、`<WS>/server.lock` の pid が消えていること。
- 二重起動防止の `server.lock` が残った場合: pid が死んでいれば次の起動で取り直される [README]。

更新 [README]:

- 通常は center / client から protocol `bantou` の `update_server` を送る（`docs/protocol.md`）。server が取得確認 → 実行中の cap / worker / report の終了を待つ → 再起動。待機中の `kick_cap` は `updating` で断られる。
- 手で入れ替える場合: 停止 → 新しい版で `npx bantou@<版> --config ...` で起動。
- 失敗時は自動で直前の版に巻き戻る。結果は `hello_result.last_update` と `<WS>/update.json`。

## 10. center から見えることの確認方法

1. 209 の `<WS>/server.log` で次を確認する。
   - `messenger: ... broker=http://192.168.1.202:7901 (remote, via config ...)`
   - `messenger: Registered as peer <id>` と `peer 登録: name=bantou-server`
   - `protocol 登録: bantou@...`
   - center が来たら `指示受信: type=hello from=bantou-center(...)`（204 の server.log で同形式を実測）。
2. center の MCP tool で確認する（tool 名は依頼元の情報。この文書では tool の挙動を検証していない）。
   - `server_peers`: 209 の server が peer として出ること。
   - `remote_list`: 209 の server が出ること。
3. 同名 `bantou-server` が 204 と 209 で 2 つになるため、`workspace`（summary は `<host> <workspace>` [README]）や peer id で区別できるか確認する。区別できない・競合する場合は**未確認事項**に追記して cap に報告する。

## 11. 未確認事項一覧

- 204 の server の起動経緯（nohup / ssh / 端末）。
- 204 / 209 の firewall（root 不可で読めない。209 は未調査）。
- 202 / 210 の broker に token があるか。ある場合の client 側の揃え方。
- 100.74.95.112 / 100.102.221.120 の host と、209 から届くか。
- `~/.agent-messenger/config.json`（旧）が agent-messenger 0.12.0 で廃止される件と、bantou server 側 client への影響。
- 同名 peer `bantou-server` を 2 台で登録した時の center 側の見え方。
- headless 端末での `claude auth login` の手順（コード貼り付け等）。`claude setup-token` を使うか。
- claude の最初の入手経路（インストーラ）。claude の自動更新を止める設定。
- `~/.claude-agent` の設定一式（rules / skills / plugins 等）を 209 に持ち込むか。
- 204 の workspace に `broker.json` が無い理由（README では存在するはずのファイル）。
- 209 の OS / node / port 7901・7902 の使用状況。
- systemd unit での自己更新（supervisor 引き継ぎ）との相性。草案は未検証。
- 209 の実機検証。204 から ssh できず（vagrant・claudeAgent とも `Permission denied (publickey,password)`）、本書の手順は 209 で実行していない。
