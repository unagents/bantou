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
- **設置後は ssh しない**（人が bantou の HOME に入る運用にしない）。やむを得ず状態を見る時は、設置者が sudo で `sudo tail server.log`（server と npx の出力の本体。起動失敗の原因もここ）、`sudo systemctl status bantou-server`（active/failed と直近の行）、`sudo journalctl -u bantou-server -e`（systemd の起動/停止メッセージ程度。server の出力は出ない）を見る。bantou ユーザーでログインはしない（パスワードログイン不可）。
- 起動は `npx -y bantou@<ver> --config $HOME/config.json`。既存の `--supervise` 自己更新はそのまま動き、その上に OS 監督が乗る。
- Linux は **systemd の system unit**（`User=bantou`、`Restart=always`、`WantedBy=multi-user.target`）に決めた。user unit + linger は使わない（linger の設定漏れで host 再起動後に戻らない事故を避けるため）。macOS は launchd の **LaunchDaemon**（`UserName=bantou`、`KeepAlive`）。
- server 本体の対応: config の `workspace` を省略すると config.json のある dir が root になり、その場合 `session.env.CLAUDE_CONFIG_DIR` の既定は `<root>/.claude`。`--config` を省略すると `$BANTOU_HOME`（無ければ `$HOME`）の `config.json` を使う。そこに無く、旧既定の `~/.config/bantou/config.json` があればそれを使う（後方互換）。`--config` と `workspace` を明示する従来の指定もそのまま動く。install script は明示形の config を書く（root 既定に未対応の公開版でも動く）。

## 2. 事前条件（設置者が host に入れておくもの）

- Linux(systemd) または macOS。root（sudo）で入れる設置者。
- node 22 以上と npm/npx、git を **system 全体**に（`/usr/bin/node` 等。bantou ユーザーが実行できる場所）。**NVM など人の HOME 配下の node は不可**（bantou から実行できない。script は `sudo -u bantou test -x <node>` で検査して die する）。
  Ubuntu 24.04 での node 22（NodeSource。[nodesource/distributions](https://github.com/nodesource/distributions) の手順）:
  ```bash
  sudo apt install -y curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
  sudo -E bash nodesource_setup.sh
  sudo apt install -y nodejs        # npm / npx も入る（/usr/bin/node）
  rm nodesource_setup.sh
  node -v                           # v22.x
  ```
- 外向き通信: `registry.npmjs.org`、`github.com`、Anthropic API、LAN の messenger broker。
- 同じ host に既に別の bantou server が居る場合は port が衝突する（内蔵 broker 7901、mcp 7902、UDP 7902 discovery）。第 2 instance には `--broker-port` / `--mcp-port` / `--discovery off` を付ける。

## 3. 設置（1 回だけ）

`packages/server/scripts/install-service.sh` を使う（unit の雛形は `scripts/service/`）。npm package `bantou` に `scripts/` は入らないので、**作業用に repo を git clone して実行し、終わったら消す**。repo（https://github.com/unagents/bantou）は公開で、clone に認証は要らない（未認証の HTTPS で 200 を確認済み）。

```bash
# 設置者の作業 dir に clone（設置後は消す。bantou の HOME には置かない）
WORK="$(mktemp -d)"
git clone --depth 1 https://github.com/unagents/bantou.git "$WORK/bantou"
S="$WORK/bantou/packages/server/scripts/install-service.sh"

# まず dry-run（何も変更しない）
sudo "$S" --dry-run

sudo "$S" \
  [--user bantou] [--home /home/bantou] [--version 0.6.2] \
  [--broker http://192.168.1.202:7901 ...] \
  [--broker-port N --mcp-port N --discovery off] [--no-start]

# 設置が済んだら clone を消す（unit は /etc/systemd/system に置かれ、clone を参照しない）
rm -rf "$WORK"
```

- 既定: user=`bantou`、home=`/home/bantou`（macOS は `/Users/bantou`。`/var/lib/bantou` にしたい時は `--home`）、version=`latest`。**`--version` での固定は非推奨**（下記）。
- やること: ユーザー作成（パスワードログイン不可。HOME が先にあって所有が違えば `chown` で bantou にする。**HOME 直下の 1 つだけで再帰しない**）→ bantou から node が実行できるか検査 → HOME 配下の雛形（`.claude` `.config/git` `.agent-messenger` `.local/bin`、`server.log` を bantou 所有・`640` で先に作成）→ `config.json` / `gitconfig` 生成 → unit（plist）配置 → enable・起動 → 「次に手でやること」を表示。
- `latest` が既定なのは、`update_server` による自己更新と整合するため。unit の `ExecStart` は `npx -y bantou@<version>` で、restart / host 再起動のたびにこの版を起動する。`latest` なら自己更新後も追従する。`--version` で固定すると、自己更新で版を上げても **restart / host 再起動で固定版に戻る**。
- 冪等: 既存のユーザー・config.json・gitconfig・認証は上書きしない。HOME が違う既存ユーザーには die する。unit は内容が変わった時だけ置き換えて **restart する**。内容が同じなら start のみ。
  - 特に **`--version` で固定して設置した後に、`--version` 無しで再実行すると unit が `latest` に変わり restart される**（逆に `--version` を付け直しても同じ）。script は設置の作業に入る**前**に「既存 unit の内容が変わる / restart する / `update_server` で上げた版は unit の版に戻る」を警告表示する。確認だけなら `--dry-run`。
  - restart で実行中の cap / worker は中断されるので、再実行は cap が空の時に行う。
  - `--no-start`: unit の配置と enable までで起動しない（移行で caps を移してから起動する用。6.1）。
  - 値の検査: `--broker-port` / `--mcp-port` は 0..65535 の整数、`--discovery` は `on` / `off`、`--broker` は `http(s)://host[:port]` 形式でなければ die する。
- 既存の HOME を `--home` に指定する場合は、空の dir を推奨する。HOME 直下の所有しか直さないので、中身の所有が違う（別ユーザーのファイルが入っている）なら、事前に中身を整理するか、設置者が `sudo chown -R bantou: <home>` を手で行う（中身が本当に bantou のものでよいか確認してから）。
- `--home` は絶対パスで、使える文字は英数字と `. _ / -` のみ（空白や `|` `&` などは sed 置換と systemd の `ExecStart` / `Environment` を壊すため die する）。
- macOS(launchd) は script を用意したが**実機では未検証**（209 は Linux）。初回は dry-run で内容を確認すること。

### 設置後に手でやること（正規手順）

以下の `/home/bantou` は既定の HOME。`--home` / `--user` を変えた場合は、パスとユーザー名を読み替える（`/home/bantou` → `--home` の値、`bantou` → `--user` の値）。5・6 章のパスも同じ。

```bash
# 1. claude CLI を bantou ユーザーで入れる（公式 native installer。/home/bantou/.local/bin/claude に入る。
#    https://code.claude.com/docs/en/setup の "Native Install"）
sudo -u bantou -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
sudo -u bantou -H /home/bantou/.local/bin/claude --version
#    ログイン（対話が要る。browser が開けない host は、表示された URL を別端末で開き、出た code を貼る）
sudo -u bantou -H env CLAUDE_CONFIG_DIR=/home/bantou/.claude /home/bantou/.local/bin/claude auth login
sudo -u bantou -H env CLAUDE_CONFIG_DIR=/home/bantou/.claude /home/bantou/.local/bin/claude auth status

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

版の更新は従来どおり protocol `bantou` の `update_server`（center から）。unit が追うのは launcher で、launcher は更新の間も残るため systemd と競合しない。

- 既定の `latest` なら、自己更新で上がった版が restart / host 再起動後も保たれる（`npx -y bantou@latest`）。
- `--version` で固定した場合、`update_server` で上げた版は **restart / host 再起動で固定版に戻る**。固定版自体を上げたい時は script を新しい `--version` 付きで再実行する（unit が変わり restart される。script が警告を出す）。固定は非推奨。

### 多重起動 guard（host lock）

1 host に bantou-server は 1 つだけ。launcher は起動時に host 共通の lock `/tmp/bantou-server.lock`（user をまたぐ固定パス。0666、中身は pid / user / workspace / 起動時刻）を取り、既に別の bantou-server が生きていれば、既存の pid・user・止め方を stderr（`server.log`）に出して **専用の exit code 75** で終了する。symlink・hardlink・通常 file でない・読めない/書けない lock（他 user が置いた不正な file を含む）も、辿らず/触らず同じく 75 で止まり、message に消し方（root が `rm /tmp/bantou-server.lock`）が出る。systemd unit には `RestartPreventExitStatus=75` が入っており、無効にし忘れた 2 つ目の unit は 75 で再起動が止まる（`Restart=always` でも 10 秒ごとに `npx` が走り続けない）。launchd の plist は exit code ごとの再起動除外ができないため同等の設定は無く、2 つ目を無効にし忘れると `ThrottleInterval` の 10 秒ごとに再試行して `server.log` に message が追記され続ける（`sudo launchctl bootout system/com.unagents.bantou` で止める）。test・開発で意図して複数動かす時だけ env `BANTOU_SERVER_ALLOW_MULTI=1` で外せる（取得も解放もしない）。lock は正常終了で消え、SIGKILL・OOM・host 再起動で残った lock は、pid の生存と起動時刻（pid 再利用の判別）で stale と判断して次の起動が取り直すため、手で消す必要はない。`<workspace>/server.lock` は別物で、supervisor の交代・引き継ぎを workspace 内で守るもの（host lock は launcher の寿命の間だけ保持され、自己更新で supervisor が替わっても自分の lock と衝突しない）。既に配置済みの unit には `RestartPreventExitStatus=75` が無いので、`install-service.sh` を再実行して unit を更新する。

## 5. トラブル時に見る場所

見るのは設置者が sudo で（ssh して bantou の HOME に入らない。1 章）。

- `/home/bantou/server.log`（起動・設定読込・broker・`peer 登録: name=bantou-server id=...`・`指示受信`/`返信`）。所有は bantou、`640`（script が先に作る）。他ユーザーは読めないので `sudo tail -f /home/bantou/server.log`。
  - 運用メモ: `server.log` は追記のみでローテーションしない。放置すると無限に伸びるので、`du -h /home/bantou/server.log` を時々見て、大きければ設置者が `sudo logrotate` 等で整理する（`copytruncate` が安全。`append:` で開いたままなので mv だけでは書き先が変わらない）。
- `sudo journalctl -u bantou-server -e`: systemd の起動/停止/再起動のメッセージ程度。unit は `StandardOutput` / `StandardError` を `append:` で `server.log` に向けているので、**server と npx の出力（起動失敗の本文を含む）は journal に出ず `server.log` にだけ出る**。起動失敗の原因は必ず `server.log` を見る（macOS は `server.log` のみ）。
- `sudo systemctl status bantou-server` が failed → 原因は `server.log` の末尾（`sudo tail -n 50 /home/bantou/server.log`）。journal は「いつ落ちて再起動したか」の確認用。`Restart=always` / `RestartSec=10` なので連続失敗でも 10 秒間隔で再試行する。
- 起動しない: `config.json` の JSON と `workspace`、node ≥ 22 が bantou の PATH にあるか、ポート衝突（`ss -tulnp | grep -E ':79[01][0-9]'`）。
- 「既に起動中 pid=...」: `server.lock` の pid が生きている。旧手動プロセスが残っていないか `pgrep -af bantou`。
- messenger に出ない: `$HOME/.agent-messenger/config.json` の broker に host から届くか（`curl <broker>/health`）。
- claude が動かない: `sudo -u bantou -H env CLAUDE_CONFIG_DIR=$HOME/.claude $HOME/.local/bin/claude auth status`。
- git/push できない: `sudo -u bantou -H env GIT_CONFIG_GLOBAL=$HOME/.config/git/gitconfig git ls-remote <repo>`。

## 6. 移行手順

### 6.1 204（claudeAgent が /home/vagrant を共用していた構成。廃止対象）

旧構成: `claudeAgent` が `/home/vagrant/work/bantou-server-ws`（以下 `$WS`）を workspace に、手動 `npx` で起動（unit 無し）。claude の設定は `/home/vagrant/.claude-agent`。204 は **先に旧 server を止めてから**移す（並走しない）。順序は「旧 server 停止 → caps 移送 → 新 server 起動」。設置者が sudo で行う（204 の sudo はパスワードが要る）。

**0. 事前確認**

```bash
WS=/home/vagrant/work/bantou-server-ws
command -v rsync || sudo apt install -y rsync      # 無ければ入れる（代わりに cp -a でも可）
# 進行中の cap / worker が無いこと（state が running のものが 0 件）
sudo sh -c "grep -l '\"state\": \"running\"' $WS/caps/*/state.json $WS/workers/*/state.json"   # 何も出なければ OK
```

- 旧パスの記録について（実コードの確認結果）: `caps/*/state.json` のフィールドは `session_id` / `state` / `last_started_at` / `last_finished_at` / `last_error`（任意）/ `retries` だけで、**パスのフィールドは無い**。`logs/center.json`（center の peer）、`logs/task.json`、worker の `logs/owner.json`（`cap_id`）にもパスは無い。
- 旧パスが効くのは `session_id` の先。cap / worker は `<root>/caps/<id>`（`workers/<id>`）を cwd に claude を `resume` する。claude の会話記録は旧 `CLAUDE_CONFIG_DIR`（`/home/vagrant/.claude-agent`）側にあり、新 HOME の `.claude` には無い。そのため移した cap を再開すると `session が無いので新規に切り替え`（`server.log`）となり、**会話の文脈は引き継がれず新しい session で始まる**。cap の作業 dir の中身（clone など）と `logs/` は移る。進行中の cap があると中断されるので、上の確認で 0 件にしてから移す。

**1. 旧 server を止める**

```bash
# 旧の起動引数（--config の指定）と launcher を控える。launcher の PID は server.lock の launcher フィールド
sudo cat "$WS/server.lock"          # 例: {"pid":1234,"version":"0.6.2","started_at":"...","launcher":1200}
L="$(sudo node -p "JSON.parse(require('fs').readFileSync('$WS/server.lock','utf8')).launcher")"
ps -o pid,user,args -p "$L"          # node ... bantou（launcher）であること。--config の値を控える
# launcher フィールドが無い（旧い launcher）時は lock の pid（supervisor）を使う
sudo kill -TERM "$L"
# server.lock が消えるまで待つ（最大 60 秒）
timeout 60 bash -c "while [ -e '$WS/server.lock' ]; do sleep 1; done" && echo "lock 消えた"
pgrep -af bantou                     # 旧プロセスが残っていないこと
# 0 章の確認から停止までの間に cap が走り出した可能性があるので、停止後にもう一度確認する
sudo sh -c "grep -l '\"state\": \"running\"' $WS/caps/*/state.json $WS/workers/*/state.json"
```

- 停止後の再確認で `running` が残っていたら、その cap / worker は停止で中断されたもの（state が `running` のまま残る）。どの cap かを控え、移送・起動の後に center から再度 kick する。

**2. 旧 config を退避する**（新 HOME には使わない）

旧 config は、上で控えた `--config` の指定先。省略して起動していた場合は旧既定の `~/.config/bantou/config.json`（起動ユーザーの HOME 側）、claudeAgent 側にあればそれ。

```bash
mkdir -p ~/bantou-migration                       # 設置者の HOME。bantou の HOME ではない
cp -a <旧 config.json> ~/bantou-migration/config.json.old
# 中の broker / mcp / discovery / model 等の値を控え、新 config は script の引数で作る（旧 config を /home/bantou に置かない）
```

旧 config は**移行が完了するまで消さない**（問題があれば旧 server をこの config で起動し直して戻せるようにする）。消すのは 6 の後片付けで、旧 workspace と一緒に。

**3. 新ユーザーを設置（起動はしない）**

旧 server は止まっているので既定 port のままでよい。`--no-start` で unit の配置と enable までにし、caps を移す前に新 server が空の caps で起動しないようにする。

```bash
sudo "$S" --no-start --broker <旧 config の broker> ...      # $S は 3 章の script
```

**4. caps を移す**（新 server は未起動）

```bash
sudo rsync -a "$WS/caps/" /home/bantou/caps/
sudo rsync -a "$WS/workers/" /home/bantou/workers/        # worker の owner 記録（logs/owner.json）を引き継ぐため
sudo chown -R bantou:bantou /home/bantou/caps /home/bantou/workers
# HOME は 750 だが bantou 自身が所有者なので読める。確認:
sudo -u bantou ls /home/bantou/caps | head
sudo -u bantou sh -c 'for f in /home/bantou/caps/*/state.json; do test -r "$f" || echo "NG $f"; done'
```

**5. 認証を用意して起動**

claude CLI の導入・login と GitHub 鍵を 3 章の手順で bantou の HOME に用意する（claudeAgent / vagrant の credentials は共有しない）。

```bash
sudo systemctl start bantou-server
sudo tail -n 30 /home/bantou/server.log          # 「起動」と「peer 登録」
```

center の discovery（`server_peers` / `remote_list`）に現れることを確認する。

**6. 後片付け**

数日 center から問題なく見えたら旧 workspace（`$WS`）と `claudeAgent` ユーザー、`~/bantou-migration` を片付ける（設置者判断）。

### 6.2 209 / 206 / mini10（vagrant 直で動かしている構成）

同じ標準形へ移行する。vagrant 配下の server は worker（cap）自身を動かしていることがあるので、**新 instance を先に別 port で立ち上げて動作確認し、切替は cap が空の時に行う**。順序は 6.1 と同じ「旧 server 停止 → caps 移送 → 新 server 起動」で、旧と新を並走させてよいのは移送前の動作確認だけ。**旧が動いている間は caps を rsync しない**。

1. `install-service.sh` を `--broker-port` / `--mcp-port` / `--discovery off` 付きで実行し、第 2 instance として起動・確認（209 でこの手順を実施済み。`docs/history/20261108-*-service-user-install/report.md`）。この時の caps は空。
2. claude CLI の導入・login と GitHub 鍵を bantou の HOME に用意（3 章）。
3. cap が空になるのを待つ（6.1 の 0 章の確認。running が 0 件）。旧 server を停止する（6.1 の 1 章。`server.lock` の `launcher` に SIGTERM、`server.lock` が消えるまで待つ）。旧 config は 6.1 の 2 章のとおり退避する。
4. 新 instance を止めて旧 workspace の `caps/` と `workers/` を移す（6.1 の 4 章。旧パスの扱いも同じ）。
5. 新 instance の port を既定に戻す: `config.json` の `broker` / `mcp` を **`sudo -u bantou` で**消し（例: `sudo -u bantou -H nano /home/bantou/config.json`。root で編集すると所有が root になり bantou が読めなくなる）、`sudo systemctl restart bantou-server`（旧は 3 で止まっているので衝突しない）。
6. 旧 workspace は退避してから削除。

## 7. 参考: 旧手順書の要点（204 実測 2026-11-03）

- 204 は systemd 無し・手動 `npx`・claudeAgent が vagrant の HOME を共有。launcher は凍結（更新されない）、supervisor と常駐本体は自己更新。
- messenger は先頭から `/health` に応答する broker を使う（`~/.agent-messenger/config.json`）。202（mini10）・210（air-7）は mesh 有効。token の有無は未確認。
- config の全キーと既定値は `packages/server/README.md`。
