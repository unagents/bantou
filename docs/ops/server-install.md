# bantou-server 設置手順書（標準形: 専用ユーザーの HOME = server root）

- 更新: 2026-11-08（旧版は 192.168.1.209 向け手順書。204 の実測を元にしていた）。
- 手作業は**設置時の 1 回だけ**。以後の起動・再起動・host 再起動後の復帰は OS の監督（systemd / launchd）に任せる。
- token・パスワード・credential の値はこの文書に書かない。

## 1. 標準形

host ごとに server 専用の OS ユーザー（既定名 `bantou`）を 1 つ作る。このユーザーの **HOME が server の root dir**。次を全部その配下に置く。

| もの | 場所 |
|---|---|
| config | `$HOME/config.json` |
| log / lock / ready | `$HOME/server.log` / `server.lock` / `server.ready`（`server.exit`, `update.json` も） |
| cap 記録・worker 作業 dir | `$HOME/caps/`、`$HOME/workers/` |
| claude の設定・認証 | `$HOME/.claude`（`CLAUDE_CONFIG_DIR`） |
| git の身元・credential | `$HOME/.config/git/gitconfig`（`GIT_CONFIG_GLOBAL`）、`credentials` |
| messenger の broker 指定 | `$HOME/.agent-messenger/config.json` |
| claude CLI / toolchain | `$HOME/.local/bin/claude`、`$HOME/.bun/bin` など |

- host の他ユーザー（vagrant など）と HOME も ACL も共有しない（HOME は `750`）。
- 起動は `npx -y bantou@<ver> --config $HOME/config.json`。既存の `--supervise` 自己更新はそのまま動き、その上に OS 監督が乗る。
- Linux は **systemd の system unit**（`User=bantou`、`Restart=always`、`WantedBy=multi-user.target`）に決めた。user unit + linger は使わない（linger の設定漏れで host 再起動後に戻らない事故を避けるため）。macOS は launchd の **LaunchDaemon**（`UserName=bantou`、`KeepAlive`）。
- server 本体の対応: config の `workspace` を省略すると config.json のある dir が root になり、その場合 `session.env.CLAUDE_CONFIG_DIR` の既定は `<root>/.claude`。`--config` を省略すると `$BANTOU_HOME`（無ければ `$HOME`）の `config.json` を使う。`--config` と `workspace` を明示する従来の指定もそのまま動く。install script は明示形の config を書く（root 既定に未対応の公開版でも動く）。

## 2. 事前条件（設置者が host に入れておくもの）

- Linux(systemd) または macOS。root（sudo）で入れる設置者。
- node 22 以上と npm/npx、git を **system 全体**に（`/usr/bin/node` 等。bantou ユーザーの PATH に入る場所）。
- 外向き通信: `registry.npmjs.org`、`github.com`、Anthropic API、LAN の messenger broker。
- 同じ host に既に別の bantou server が居る場合は port が衝突する（内蔵 broker 7901、mcp 7902、UDP 7902 discovery）。第 2 instance には `--broker-port` / `--mcp-port` / `--discovery off` を付ける。

## 3. 設置（1 回だけ）

repo の `packages/server/scripts/install-service.sh` を使う（unit の雛形は `scripts/service/`）。

```bash
# まず dry-run（何も変更しない）
sudo packages/server/scripts/install-service.sh --dry-run

sudo packages/server/scripts/install-service.sh \
  [--user bantou] [--home /home/bantou] [--version 0.6.2] \
  [--broker http://192.168.1.202:7901 ...] \
  [--broker-port N --mcp-port N --discovery off]
```

- 既定: user=`bantou`、home=`/home/bantou`（macOS は `/Users/bantou`。`/var/lib/bantou` にしたい時は `--home`）、version=`latest`。本番は `--version` で版を固定することを勧める（自己更新で追従する）。
- やること: ユーザー作成（パスワードログイン不可）→ HOME 配下の雛形（`.claude` `.config/git` `.agent-messenger` `.local/bin`）→ `config.json` / `gitconfig` 生成 → unit（plist）配置 → enable・起動 → 「次に手でやること」を表示。
- 冪等: 既存のユーザー・config.json・gitconfig・認証は上書きしない。unit は内容が変わった時だけ置き換えて restart する。HOME が違う既存ユーザーには die する。
- macOS(launchd) は script を用意したが**実機では未検証**（209 は Linux）。初回は dry-run で内容を確認すること。

### 設置後に手でやること（正規手順）

```bash
# 1. claude を入れて（bantou ユーザーで、公式手順。~/.local/bin/claude）ログイン。対話が要る
sudo -u bantou -H env CLAUDE_CONFIG_DIR=/home/bantou/.claude claude auth login
sudo -u bantou -H env CLAUDE_CONFIG_DIR=/home/bantou/.claude claude auth status

# 2. GitHub の鍵/credential は bantou の HOME 配下に、この host 専用のものを置く
#    /home/bantou/.config/git/credentials  （https://<user>:<token>@github.com 形式、chmod 600）
#    または sudo -u bantou -H gh auth login
#    token は最小権限（対象 repo の contents read/write 程度）。他 host の token を使い回さない。

# 3. 認証を置いた後 restart
sudo systemctl restart bantou-server        # macOS: sudo launchctl kickstart -k system/com.unagents.bantou
```

他ユーザーの claude credentials のコピーは正規手順ではない（OAuth セッションの共有になる）。

## 4. 起動・再起動・停止（以後の運用）

| 操作 | Linux | macOS |
|---|---|---|
| 状態 | `systemctl status bantou-server` | `sudo launchctl print system/com.unagents.bantou` |
| 再起動 | `sudo systemctl restart bantou-server` | `sudo launchctl kickstart -k system/com.unagents.bantou` |
| 停止 | `sudo systemctl stop bantou-server` | `sudo launchctl bootout system/com.unagents.bantou` |
| 自動起動の確認 | `systemctl is-enabled bantou-server` | plist が `/Library/LaunchDaemons` にあること |

host 再起動後は OS が自動で起動し、server が peer 登録して center の discovery（`server_peers` / `remote_list`）に再び現れる。**peer id は起動のたびに変わる**ので、再起動後は新しい id を見る。peer 名は全 instance 共通の `bantou-server`（host 名は messenger の host で区別）。

版の更新は従来どおり protocol `bantou` の `update_server`（center から）。unit が追うのは launcher で、launcher は更新の間も残るため systemd と競合しない。launcher を固定する版（`--version`）を上げたい時は script を `--version` 付きで再実行する（unit が変わり restart される）。

## 5. トラブル時に見る場所

- `/home/bantou/server.log`（起動・設定読込・broker・`peer 登録: name=bantou-server id=...`・`指示受信`/`返信`）。なお systemd が開くため所有は root のことがある（`sudo tail`）。
- `journalctl -u bantou-server -e`（macOS は server.log のみ）。
- `systemctl status bantou-server` が failed → 直前の journal。`Restart=always` / `RestartSec=10` なので連続失敗でも 10 秒間隔で再試行する。
- 起動しない: `config.json` の JSON と `workspace`、node ≥ 22 が bantou の PATH にあるか、ポート衝突（`ss -tulnp | grep -E ':79[01][0-9]'`）。
- 「既に起動中 pid=...」: `server.lock` の pid が生きている。旧手動プロセスが残っていないか `pgrep -af bantou`。
- messenger に出ない: `$HOME/.agent-messenger/config.json` の broker に host から届くか（`curl <broker>/health`）。
- claude が動かない: `sudo -u bantou -H env CLAUDE_CONFIG_DIR=$HOME/.claude claude auth status`。
- git/push できない: `sudo -u bantou -H env GIT_CONFIG_GLOBAL=$HOME/.config/git/gitconfig git ls-remote <repo>`。

## 6. 移行手順

### 6.1 204（claudeAgent が /home/vagrant を共用していた構成。廃止対象）

旧構成: `claudeAgent` が `/home/vagrant/work/bantou-server-ws` を workspace に、手動 `npx` で起動（unit 無し）。claude の設定は `/home/vagrant/.claude-agent`。

1. 新ユーザーを設置: `sudo install-service.sh --version <ver>`（204 は sudo がパスワード要。設置者が実行）。旧 server と同時に動かす間は `--broker-port` 等で port を分けるか、先に旧を止める（手順 3）。
2. 旧 workspace の caps 記録を移す（新 server を止めた状態で）:
   ```bash
   sudo systemctl stop bantou-server
   sudo rsync -a /home/vagrant/work/bantou-server-ws/caps/ /home/bantou/caps/
   sudo chown -R bantou:bantou /home/bantou/caps
   ```
   cap の記録に旧パス（`/home/vagrant/...`）が入っている場合、そのパスは bantou から読めないので、進行中の cap が無い状態で移すこと。
3. 旧プロセスを停止: `pgrep -af bantou` で launcher の PID を確認し、launcher に SIGTERM（cap/worker が全部終わってから）。`server.lock` の pid が消えたことを確認。旧 unit は無いので unit の撤去は不要。
4. `sudo systemctl start bantou-server` → `server.log` に `peer 登録` が出て center の discovery に現れることを確認。
5. claude login（`sudo -u bantou`）と GitHub 鍵を 3 章の手順で bantou の HOME に用意する。claudeAgent / vagrant の credentials は共有しない。
6. 数日 center から問題なく見えたら旧 workspace（`/home/vagrant/work/bantou-server-ws`）と `claudeAgent` ユーザーを片付ける（設置者判断）。

### 6.2 209 / 206 / mini10（vagrant 直で動かしている構成）

同じ標準形へ移行する。209 の場合、vagrant 配下の server は worker（cap）自身を動かしているので、**新 instance を先に別 port で立ち上げて動作確認し、切替は cap が空の時に行う**。

1. `install-service.sh` を `--broker-port` / `--mcp-port` / `--discovery off` 付きで実行し、第 2 instance として起動・確認（209 でこの手順を実施済み。`docs/history/20261108-*-service-user-install/report.md`）。
2. claude login と GitHub 鍵を bantou の HOME に用意。
3. 旧 workspace の `caps/` を新 HOME に移し（6.1 の手順 2）、旧プロセスを cap 完了後に停止。
4. 新 instance の port を既定に戻したい場合は `config.json` の `broker` / `mcp` を消して restart（旧が止まっていること）。
5. 旧 workspace は退避してから削除。

## 7. 参考: 旧手順書の要点（204 実測 2026-11-03）

- 204 は systemd 無し・手動 `npx`・claudeAgent が vagrant の HOME を共有。launcher は凍結（更新されない）、supervisor と常駐本体は自己更新。
- messenger は先頭から `/health` に応答する broker を使う（`~/.agent-messenger/config.json`）。202（mini10）・210（air-7）は mesh 有効。token の有無は未確認。
- config の全キーと既定値は `packages/server/README.md`。
