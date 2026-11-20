# bantou web backend 設置手順書

- 対象: `packages/web`（web backend。Nitro の node server）。develop の実装（`packages/web`・`packages/center-client`）に合わせてある。
- 手作業は**設置時の 1 回だけ**。以後の起動・再起動・host 再起動後の復帰は systemd に任せる。
- この文書には host 名・IP・port の実値・user 名・token・Cloudflare の識別子を書かない。`<...>` は設置者が自分の環境の値に置き換える。実測した値は、この文書でなく設置者の記録に残す。
- web backend は center（`bantou-center`）の**クライアント**で、center は起動しない（v1 は `enabled: true` を拒否する）。center は別に用意してあるものとし、その設置はこの文書の範囲外。

## 0. 前提（一般の言葉）

| もの | 前提 |
|---|---|
| OS | systemd が動く Linux |
| node | 22 以上（system 全体に入れた node。`packages/web/package.json` の `engines`）。build の host と実行の host が違ってもよい。実行側に要るのは node だけ（`.output` は自己完結） |
| build の道具 | git、bun（`bun install` 用。repo は bun workspace）。build と実行を同じ host で行うなら両方要る |
| 実行 user | web backend 専用の OS user、または作業用に用意された専用の実行 user。**人が login に使う user では動かさない**。以下 `<run-user>` |
| 常駐 | systemd の **user unit** + **linger**（4 章）。管理者の password を打つ手順は含めない（前提の用意は 0.1） |
| reverse proxy | nginx 相当（TLS 終端は前段）。要件は 6 章 |
| 認証の前段 | Cloudflare Access 相当（JWT を `Cf-Access-Jwt-Assertion` header で渡す）と、そこへ中継する経路（tunnel・中継 host） |
| center | web backend から HTTP で届く center と、その Bearer token（12 文字以上）。置き場は問わない |
| 外向き通信 | backend の host から `<team>.cloudflareaccess.com`（JWT の署名鍵の取得）と、center の url へ |

### 0.1 設置前に管理者が済ませておく事（設置後の運用では不要）

次は 1 回だけの前提で、設置の手順（2〜5 章）は管理者の password を使わずに進む。

1. `<run-user>` が存在し、HOME が `750` 以下（他の user が読めない）。
2. `<run-user>` の linger が有効（`loginctl show-user <run-user> -p Linger` が `Linger=yes`）。**host を再起動しても、login なしで unit が戻る**ための前提。
3. 実行 user と unit の持ち主が違う形（4.2）を使う場合のみ: 2 つの script（`web-run.sh` / `web-stop.sh`）と、`<install-dir>`・`<install-dir>/bin` の親 dir が `<unit-owner>` に書けない事、および引数なしに限った `sudo -n` の許可（4.2 の sudoers 例）。
4. 設置先 dir と env 置き場（2 章）を `<run-user>` が書ける。

## 1. 構成と route（実物）

| route | 内容 |
|---|---|
| `GET /api/me` | JWT を検証して利用者の email を返す |
| `GET /api/health` | center への到達可否（token は出さない） |
| `GET /api/events` | SSE（center の events を全ブラウザへ配る） |
| `POST /api/rpc/:cmd` | 許可リストの command のみ。設定を書く command は既定で拒否（2.3） |
| `GET /api/sessions/:name/output` | SSE（端末の出力。`Last-Event-ID` / `?after=`） |
| `POST /api/sessions/:name/input` / `resize` | 入力・大きさ（JSON、1 MiB まで） |
| `POST /api/sessions/:name/attachments` | 画像 1 枚（png/jpeg/gif/webp、20 MB まで） |

- 守りは**全 route に掛かる**（server middleware）。順序は ①共有鍵 `X-Bantou-Proxy-Key`（無い・違うは 403）→ ②`Cf-Access-Jwt-Assertion` の署名・`iss`・`aud`・`exp`（401）と email の許可一覧（403）→ ③変更系は `Origin` が `Host` と一致（403）。したがって `/api/health` も proxy key と JWT 無しでは見えない。
- **現状の develop は画面（SPA）を持たない**（`pages: false`）。配信するのは `/api/*` だけ。画面が入った後に 6 章の `location /` を足す。

## 2. env・設定 file・権限

### 2.1 env 一覧

| 名前 | 必須 | 意味 |
|---|---|---|
| `CF_TEAM` | 必須 | Access の team 名（英数字と `-`）。`iss`（`https://<CF_TEAM>.cloudflareaccess.com`）と鍵の取得先を決める |
| `CF_AUD` | 必須 | Access application の AUD tag |
| `ALLOWED_EMAILS` | 必須 | 許可する email。カンマ区切り（小文字化して照合）。Access の許可一覧と二重にして、ここでも独立に絞る |
| `PROXY_KEY` | 必須 | nginx だけが付ける共有鍵。十分長い乱数。ログに出さない |
| `HOST` | **実質必須** | 待受の address。**`127.0.0.1` を明示する**（Nitro の既定は全 interface。未設定のまま常駐させない） |
| `PORT` | 必須扱い | 待受 port `<web-port>`。空き port を `ss -tlnp` で確かめて選ぶ。nginx の `proxy_pass` と一致させる |
| `WEB_SETTINGS_FILE` | 任意 | center 設定 file の path。未設定なら `$XDG_STATE_HOME/bantou-web/settings.json`（`XDG_STATE_HOME` 未設定なら `$HOME/.local/state/bantou-web/settings.json`） |
| `CENTER_URL` | 任意 | 設定すると file の `remote.url` より優先し、画面・command から変えられない |
| `CENTER_TOKEN` | 任意 | 同上（`remote.token`）。file の token は、**同じ url に向く時だけ**使われる（url を env で変えると file の token は引き継がない） |
| `WEB_CF_CERTS_URL` | **本番では設定しない** | 署名鍵の取得先を差し替える test 用。検証を切る設定ではないが、本番では既定（team から決まる URL）を使う |

- 必須項目（`CF_TEAM` `CF_AUD` `ALLOWED_EMAILS` `PROXY_KEY`）のどれかが空だと、**全 request を 500（`guard_misconfigured`）で拒否する**。検証を緩めて続行はしない。env の値を変えたら process を再起動する（守りの設定は初回に 1 度だけ読む）。
- 検証を切るモードは無い。

### 2.2 置き場と権限

| もの | 場所 | 権限 |
|---|---|---|
| env file | `<env-dir>/web.env`（`KEY=value` の行。引用符を付けない。値の制限は下） | `600`、持ち主 `<run-user>`。dir は `700` |
| 共有鍵（nginx 側） | `<nginx-conf-dir>/bantou-proxy-key.conf`（`proxy_set_header X-Bantou-Proxy-Key "<鍵>";` の 1 行） | nginx の master process だけが読める（例 `640`、group は nginx の読む group）。`<run-user>` の env の `PROXY_KEY` と同じ値 |
| 設定 file | `WEB_SETTINGS_FILE` の path | backend が一時 file→rename で書く（`600`）。親 dir は**設置時に先に作る**（`install -d -m 700 -o <run-user> <settings-dir>`。`<run-user>` として `mkdir -m 700` でもよい） |
| build 物 | `<install-dir>/packages/web/.output` | `<run-user>` が読める。他の user が書けない |

- **env file の値は `[A-Za-z0-9._@,+/=-]` の文字だけにする**（空白・引用符・`$`・バッククォート・`;`・`#`・バックスラッシュを入れない）。systemd の `EnvironmentFile` と shell の `. <file>`（4.2 の script、3 章の手動起動）で読み方が違い、記号入りの値は片方で壊れたり、shell 側で別の command が走ったりするため。`PROXY_KEY` は `openssl rand -hex 32` の出力を使う。`ALLOWED_EMAILS` は email をカンマで繋ぐ（空白なし）。
- 鍵・token・JWT を、コマンドライン引数・unit file の `Environment=`・ログ・shell の履歴に出さない。`EnvironmentFile`（または 4.2 の script が shell で読む env file）だけに置く。
- `WEB_SETTINGS_FILE` は env file に**絶対 path で明示する**（`HOME` の違いで別の場所に書かれるのを避ける）。
- 同じ host の別 user が `/proc/<pid>/environ` を読めない事（一般の Linux の権限）と、`<run-user>` の HOME が `750` 以下である事を設置者が確かめる（8 章 0）。

### 2.3 center 設定（設定 file）

内容は desktop の `center` 設定と同じ形の JSON。reverse proxy の背後の web では、**設定を書く経路（`center_set_settings`）は既定で閉じている**ので、運用者が file か env を編集する。

```json
{
  "enabled": false,
  "port": <port>,
  "workspace": "<abs-path>",
  "token": "",
  "remote": { "url": "<center-url>", "token": "<center-token>" }
}
```

- 親 dir（`<settings-dir>`）が `700`・持ち主 `<run-user>` で存在する事を、起動前に確かめる（2.2）。
- 実際に使うのは `remote`（`url` と `token`）。他は互換の項目で、`enabled` は **false のまま**（true は検証で拒否される）。file が無い・壊れている時は既定（接続先なし）として扱われ、backend は起動する。
- `remote.url` は `http(s)://` で、`/mcp` に正規化される。url に userinfo（`user:pass@`）を入れない。
- 接続先は**呼び出しのたびに file から選ぶ**ので、file の `remote` を書き換えても再起動は要らない（env の `CENTER_URL` / `CENTER_TOKEN` を変えた時は再起動）。
- 設定 file は `600`、持ち主 `<run-user>`。token は画面・`/api/health`・ログに出ない作りだが、確認は 8 章 15 で行う。

## 3. build と起動 command

```bash
# 設置者の作業 dir に clone（<install-dir> は <run-user> が読める場所）
git clone https://github.com/unagents/bantou.git <install-dir>
cd <install-dir>
git checkout <tag-or-commit>          # 版を決める
bun install
cd packages/web && bun run build      # = nuxt build。出力は packages/web/.output
```

- build は `packages/web` だけでよい（`packages/center-client` と `packages/ui` の型はソースのまま build に取り込まれる。別の build は要らない）。
- 起動 command（実物）: `node .output/server/index.mjs`。cwd は `<install-dir>/packages/web`。env は 2.1。
- 手で動かして確かめる時も、env は 2.2 の file から読む（値を command line に書かない）:
  ```bash
  # <run-user> として、cwd は <install-dir>/packages/web
  set -a; . <env-dir>/web.env; set +a
  exec node .output/server/index.mjs
  ```
  値の制限（2.2）を守れば、この読み方と systemd の `EnvironmentFile` で同じ値になる。

## 4. 常駐（systemd user unit + linger）

web backend は `<run-user>` で動かし、systemd の **user unit** として常駐させる。linger が有効なので、host の再起動後も login 無しで戻る。unit の置き場は **unit の持ち主の** `~/.config/systemd/user/bantou-web.service`。

### 4.1 持ち主 = 実行 user の場合（基本形）

`<run-user>` 自身の user manager に unit を置く。

```ini
# <run-user> の ~/.config/systemd/user/bantou-web.service
[Unit]
Description=bantou web backend
# user unit では After=network-online.target は効かない（system の target を待てない）ので書かない。
# 起動時に center へ届かなくても backend は起動し、/api/health が到達不可を返す

[Service]
Type=simple
WorkingDirectory=<install-dir>/packages/web
EnvironmentFile=<env-dir>/web.env
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

```bash
# <run-user> として（管理者の password は使わない）
systemctl --user daemon-reload
systemctl --user enable --now bantou-web
systemctl --user status bantou-web
journalctl --user -u bantou-web -e
```

- `Restart=on-failure`（`always` にしない）。`node` の path は `command -v node` の結果に合わせる。
- 他の unit（center を同じ host に置く場合など）との順序は `After=` / `Wants=` だけにして `Requires=` にしない（center が落ちても web は起動し、`/api/health` が到達不可を返す）。

### 4.2 持ち主 ≠ 実行 user の場合（実行 user として動かし、実行 user として止める）

unit は持ち主（`<unit-owner>`）の user manager に置くが、**process は `<run-user>` として動かす**。`<unit-owner>` の systemd は、別 user の process を直接は止められないので、**停止処理を unit に持たせる**。

準備（0.1 で管理者が 1 回だけ。以後 password は要らない）:

1. `<install-dir>/bin/web-run.sh` と `web-stop.sh` を置く。**持ち主は `<run-user>` か root で、`<unit-owner>` が書き換えられない**事（書き換えられると `<run-user>` の権限を取れる）。script だけでなく、**`<install-dir>` と `<install-dir>/bin` の親 dir も `<unit-owner>` が書けない**ようにする（dir に書けると rename で script を差し替えられる）。`<install-dir>` は symlink を含まない実 path で書く。
2. sudoers に、`<unit-owner>` が `<run-user>` として**この 2 つの script だけ**を password 無しで実行する許可を書く。

```sudoers
# 末尾の "" は「引数なし」に限る指定
<unit-owner> ALL=(<run-user>) NOPASSWD: <install-dir>/bin/web-run.sh "", <install-dir>/bin/web-stop.sh ""
```

```sh
#!/bin/sh
# <install-dir>/bin/web-run.sh（<run-user> として実行される）
set -eu
umask 077
pid_file="<run-dir>/web.pid"
web_dir="<install-dir>/packages/web"

# 旧 process が生きていたら起動しない（orphan を作らない）。判定は stop script と同じ
if [ -f "$pid_file" ]; then
  old="$(cat "$pid_file")"
  if [ -r "/proc/$old/cmdline" ] \
     && [ "$(readlink "/proc/$old/cwd")" = "$web_dir" ] \
     && tr '\0' ' ' < "/proc/$old/cmdline" | grep -q '\.output/server/index\.mjs'; then
    echo "bantou-web: 旧 process (pid $old) が動いている。web-stop.sh で止めてから起動する" >&2
    exit 1
  fi
fi

set -a; . "<env-dir>/web.env"; set +a
cd "$web_dir"
echo $$ > "$pid_file"
exec /usr/bin/node .output/server/index.mjs
```

（env は `set -a` の行で **shell として** 読む（2.2 の値の制限が前提）。`exec` するので pid file の pid がそのまま node の pid になる。pid file が残っていても、その pid が上の 3 条件に合わない（stale）なら上書きして起動する。）

```sh
#!/bin/sh
# <install-dir>/bin/web-stop.sh（<run-user> として実行される）。残っていなければ何もせず成功
pid_file="<run-dir>/web.pid"
web_dir="<install-dir>/packages/web"
[ -f "$pid_file" ] || exit 0
pid="$(cat "$pid_file")"
# pid が今も web backend のものか（pid の使い回しで別の process を殺さない）。
# cmdline に加えて cwd が <install-dir>/packages/web である事も条件にする
if [ -r "/proc/$pid/cmdline" ] \
   && [ "$(readlink "/proc/$pid/cwd")" = "$web_dir" ] \
   && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q '\.output/server/index\.mjs'; then
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
fi
rm -f "$pid_file"
```

```ini
# <unit-owner> の ~/.config/systemd/user/bantou-web.service
[Unit]
Description=bantou web backend (runs as <run-user>)
# user unit では After=network-online.target は効かないので書かない

[Service]
Type=simple
ExecStart=/usr/bin/sudo -n -H -u <run-user> <install-dir>/bin/web-run.sh
# 停止: unit の持ち主は <run-user> の process を直接止められないので、実行 user として止める
ExecStop=/usr/bin/sudo -n -H -u <run-user> <install-dir>/bin/web-stop.sh
# 異常終了・sudo だけ死んだ時にも process を残さない（残っていれば止め、無ければ何もしない）
ExecStopPost=/usr/bin/sudo -n -H -u <run-user> <install-dir>/bin/web-stop.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillMode=control-group

[Install]
WantedBy=default.target
```

- `<run-dir>` は `<run-user>` だけが書ける dir（pid file 用）。`/tmp` を使わない。
- `EnvironmentFile=` は使わない（env file は `<run-user>` 専用で `<unit-owner>` は読めない。読むのは `web-run.sh`）。
- `<unit-owner>` の linger が有効である事（0.1 の 2）。`<unit-owner>` として `systemctl --user enable --now bantou-web`。
- **sudo の経路が使えない時は、この形を取らず 4.1 にする**（unit の持ち主を `<run-user>` にする）。

### 4.3 常駐の確認

- 起動後、`ss -tlnp` で `<web-port>` が `127.0.0.1` だけで LISTEN している（`0.0.0.0` や外向き address でない）。
- 停止（`systemctl --user stop bantou-web`）の後、`pgrep -u <run-user> -f 'index\.mjs'` が空で、`<web-port>` が解放されている。
- 再起動（`restart`）の後、同じ確認で 1 process だけが居る（二重起動なし）。

## 5. 更新の手順

web backend だけを止める。center と session には影響しない（center は別の process）。ブラウザ側は SSE が切れて自動で再接続し、`after` で続きから受ける。

```bash
cd <install-dir>
git fetch --tags && git checkout <new-tag-or-commit>
bun install
(cd packages/web && bun run build)
systemctl --user restart bantou-web      # 4.2 の形でも同じ command（unit の持ち主として）
```

- build は動いている `.output` の上に書き込むので、**build が失敗した時は restart しない**（旧版の `.output` が壊れていないか確認）。
- 戻す時は前の tag を checkout して build し直し、restart する。
- 更新後は 8 章の確認のうち、1・4・11・14 を最低限やり直す。env の項目が増えた版では、起動前にこの文書の 2.1 を見直す。
- env（鍵・許可 email など）だけ変えた時は、build 無しで restart する。

## 6. nginx の server block（例）

前提: 前段の中継は、この host の `:80` に平文 HTTP で来る（TLS は前段で終端）。`server_name` と `Host` は前段の route に合わせる。要件ごとの意味を併記する。

```nginx
# WebSocket の Upgrade 用（v1 は使わない。将来 WebSocket 化する時に nginx を触らずに済む）
map $http_upgrade $connection_upgrade { default upgrade; '' ''; }

server {
    listen 80;
    server_name <web-hostname>;                  # 前段の route の Host と一致させる

    # 送信元の制限: 前段の中継 host からだけ受ける
    allow <relay-source-ip>;
    deny  all;

    client_max_body_size 21m;                    # 添付 20 MB（既定は 1 MB で 413 になる）

    location /api/ {
        proxy_pass         http://127.0.0.1:<web-port>;
        proxy_http_version 1.1;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Host       $host;           # backend の Origin 検査が使う
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_buffering    off;                  # SSE を溜めない
        proxy_cache        off;
        gzip               off;
        proxy_read_timeout 3600s;                # SSE（center の keep-alive は 15 秒間隔）

        # 共有鍵 header を付ける（値は別 file。PROXY_KEY と同じ）
        include <nginx-conf-dir>/bantou-proxy-key.conf;

        # Cf-Access-Jwt-Assertion は上書き・削除しない（そのまま backend へ渡す）
    }

    # 画面（SPA）が入った版で、ここに location / を足す。現状の backend は /api/* だけを返す
}
```

要件の確認表:

| 要件 | 設定 | 理由 |
|---|---|---|
| 送信元の制限 | `allow` / `deny all` | 同じ network の他の機器が `Host` を偽って直接来るのを防ぐ（backend の共有鍵と JWT の検証は、これが破られた時の予備） |
| SSE を溜めない | `proxy_buffering off`、`proxy_http_version 1.1`、`Connection` 空（または map）、`gzip off`。backend も `X-Accel-Buffering: no` を返す | 出力と keep-alive が束にならない |
| read timeout | `proxy_read_timeout 3600s` | nginx の既定（60 秒）より長く。SSE が無音で切られない |
| body の上限 | `client_max_body_size 21m` | 添付の 20 MB を通す |
| 共有鍵 header | `X-Bantou-Proxy-Key`（別 file を include） | nginx を飛ばして backend の loopback port に直接来る process を 403 にする |
| JWT の header | 触らない | `Cf-Access-Jwt-Assertion` が backend の検証に届く |
| `Host` | `proxy_set_header Host $host` | 変更系の `Origin` 検査が `Host` と比べる |

- **access log の format に header の値（`$http_cf_access_jwt_assertion`・`$http_x_bantou_proxy_key` など `$http_*`）を入れない**。JWT と共有鍵がログに残る。
- 他の vhost と同居する時は、`default_server` に Host の合わない要求が行って、他の app に届かないか確認する。
- `nginx -t` が通ってから reload する。設置の前後で、既存の URL の応答が変わらない事を確かめる（8 章 5）。

## 7. 前段（認証・中継）で要る登録（種類だけ。値は書かない）

| 種類 | 内容 |
|---|---|
| hostname | web 用の hostname と、その DNS |
| 中継の route | hostname → この host の `:80`（平文 HTTP）。`Host` を保つ（`http_host_header` 相当）。path の振り分けは使わない |
| tunnel の ingress | 上の hostname の受け口（tunnel を使う構成の場合） |
| Access の application | web 用の application（または既存の共有）と、その **team 名**・**AUD tag** → backend の `CF_TEAM` / `CF_AUD` |
| 利用者の許可 | Access の policy と、中継の許可一覧に許可する email → backend の `ALLOWED_EMAILS`。**Access を通れる人 = center の全操作ができる人**なので、管理者の一覧として扱う |
| 送信元 | 中継 host の送信元 address → nginx の `allow` |
| 外向き通信 | backend の host から `<team>.cloudflareaccess.com` と center の url |

## 8. 設置の時に確かめる項目（合格条件つき）

実測は設置者が行い、結果（合格・不合格・値の置き換え先）を設置者の記録に残す。**未確認のまま公開しない**。順序は 1→…。

| # | 確かめること | 合格条件 |
|---|---|---|
| 0 | 前提と権限（0・2 章）: `<run-user>` が人の login 用 user でない。HOME が `750` 以下。env file が `600`。linger 有効 | `loginctl show-user <run-user> -p Linger` が `Linger=yes`。他の user が env file と HOME 配下を読めない |
| 1 | team 名と AUD tag（Access の application） | backend の env に入れた値で、本物の JWT の `aud` / `iss` が一致する（本物の JWT で `GET /api/me` が 200 と email を返す） |
| 2 | `Cf-Access-Jwt-Assertion` が backend まで届くか（前段 → 中継 → nginx → backend） | backend が受けた request に header がある（8-1 が通れば届いている）。**届かない場合は、nginx の送信元制限と共有鍵だけの運用に切り替えるか、中継を飛ばす構成にするかを、設置者が実測で決める**（backend は JWT 無しを 401 で拒否するので、そのままでは動かない） |
| 3 | 許可外の email の扱い | **許可内の email は 200（`/api/me` が email を返す）、許可外の email は 403 か前段で止まる**の両方を確かめる。許可外は backend（nginx の access log）まで届かないか、届いても 403（`email_not_allowed`）で止まる |
| 4 | 送信元の制限が効くか（中継 host の address と、nginx が見る送信元） | 同じ network の別端末から `:80` を `Host` 付きで直接打つと 403。前段経由は通る（NAT・`X-Forwarded-For` の有無も確認） |
| 5 | nginx の構成（`default_server`、他の vhost への影響、`nginx -t`） | 既存の URL が設置前後で同じ応答 |
| 6 | SSE が溜まらず届くか（前段 → 中継 → nginx → backend） | `GET /api/sessions/<name>/output` と `/api/events` を開き、端末の出力と keep-alive（`: ka`、15 秒間隔）が **1 秒以内**に手元に届く（束にならない） |
| 7 | 長時間 idle の挙動 | 5 分・30 分無操作で SSE が切れても、自動で再接続し、`after` で続きが来て出力が欠けない |
| 8 | 添付 20 MB が通るか（前段のプラン別の body 上限、中継、nginx） | 20 MB 以下の画像が保存され、path が pty に打たれる。超えた時は 413 が読める文言で出る |
| 9 | Access の session 期間と、切れた後の SSE・fetch の挙動 | 切れたら画面が再読込で Access の login に戻り、login 後に端末が再開する（画面が入った版で確認） |
| 10 | backend の host から `<team>.cloudflareaccess.com` への外向き通信 | 本物の JWT で検証が通る（401 `jwt_unknown_kid` が出ない） |
| 11 | 同じ host の別 user の process から backend の loopback port を直接叩く（nginx を飛ばす） | `X-Bantou-Proxy-Key` が無い要求は 403（`proxy_key`）。鍵の値が `ps`・ログ・`<run-user>` 以外が読める file に出ていない |
| 12 | web 用 hostname の DNS・ingress・route | ブラウザで開くと Access の login が出て、許可した利用者だけ通る |
| 13 | 空き port・arch・toolchain | `ss -tlnp` で `<web-port>` が衝突しない。`node -v` が 22 以上 |
| 14 | 待受 address と常駐（4.3） | `<web-port>` が `127.0.0.1` だけで LISTEN。stop 後に process・port が残らない。host を再起動した後、login なしで戻る |
| 15 | 設定 file の `remote`（url と token）を与えて起動する | `/api/health` が到達可を返し、center につながる。**ブラウザの DevTools（ネットワーク・storage）、`/api/health`、backend のログ（`journalctl`）のどこにも token が出ない。nginx の access / error log にも、JWT（`Cf-Access-Jwt-Assertion`）と共有鍵（`X-Bantou-Proxy-Key`）の値が出ていない**（`log_format` に `$http_*` を入れていない） |
| 16 | 接続先が空（設定なし）で起動し、後から file に `remote` を書く | backend は起動し、`/api/health` は「接続先なし」を返す。file に書くと、再起動なしで次の呼び出しから届く |
| 17 | 設定を書く経路が閉じているか | `POST /api/rpc/center_set_settings` が拒否される（接続先は file か env でだけ変えられる） |
| 18 | 更新の手順（5 章）を 1 回通す | restart 後に再接続して端末が続く。center の session は止まらない |
| 19 | スマホ実機での入力・画像選択・端末の高さ（画面が入った版） | 入力が崩れず、端末が潰れず、画像が添付できる |

補足: 8-1・8-3・8-6〜8-9 は本物の JWT が要るので、ブラウザ（前段経由）で確かめる。設置した host の中から proxy key と JWT 無しで叩くと、backend は 403（`proxy_key`）か 401（`jwt_missing`）を返す。これは「守りが効いている」ことの確認であって、疎通の確認ではない。

## 9. トラブル時の見方

| 症状 | 見る所 |
|---|---|
| 全 request が 500 | env の必須項目（`CF_TEAM` `CF_AUD` `ALLOWED_EMAILS` `PROXY_KEY`）が空。`journalctl --user -u bantou-web -e` |
| 403 `proxy_key` | nginx の include が効いていない、または `PROXY_KEY` と値が違う |
| 401 `jwt_missing` | `Cf-Access-Jwt-Assertion` が届いていない（8-2）。経路のどこかが落としている |
| 401 `jwt_aud` / `jwt_iss` | `CF_AUD` / `CF_TEAM` が違う |
| 401 `jwt_unknown_kid` | 署名鍵を取れない（外向き通信、8-10） |
| 403 `email_not_allowed` | `ALLOWED_EMAILS` |
| 403 `origin`（変更系） | nginx が `Host` を保っていない、または前段が `Origin` を変えている |
| 413（添付） | nginx の `client_max_body_size`、前段の body 上限 |
| SSE が遅れる・束になる | どこかの層の buffering（8-6）。nginx は `proxy_buffering off` |
| `/api/health` が到達不可 | center の url・token（2.3）、center の bind・経路 |
