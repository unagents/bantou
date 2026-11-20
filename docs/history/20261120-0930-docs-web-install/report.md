# docs/web-install（まとまり 7: web backend の設置手順書）

- branch: `docs/web-install`（基点 origin/develop 7e086d7d574ee7db8a18f3fb34a7951f4d1740c4）
- 成果物: `docs/ops/web-install.md`。docs のみ（コード・version は変えていない）。
- HEAD の full SHA: report を含む commit の SHA は report 内に書けないため、cap への報告に載せる。

## 内容
前提（一般の言葉）／env 一覧・置き場・権限・設定 file／build と起動／常駐（systemd user unit + linger、持ち主 = 実行 user と持ち主 ≠ 実行 user の 2 形）／更新／nginx の server block 例と要件表／前段（認証・中継）の登録の種類／合格条件つきの確認表（設計書 13 章を再編）／トラブル時の見方。host 名・IP・port・user 名・token は `<...>` の placeholder。

## 設計書と実装の食い違い（実装を正とした所）
1. **起動 command と build**: 設計書 9.1 は「protocol/center-client/ui/web の build」。実物は `packages/web` で `nuxt build` のみ（center-client・ui はソースのまま取り込まれる）。起動は `node .output/server/index.mjs`（cwd `packages/web`）。
2. **画面（SPA）が無い**: develop の `packages/web` は `pages: false` で `/api/*` だけ。設計書 8.3 の `location /`（SPA）は現状対象が無いので、nginx 例には「画面が入った版で足す」と書いた。
3. **守りは全 route に掛かる**: `/api/health` も proxy key + JWT が要る。設置時の疎通確認が、設置 host 内からの単独の HTTP 要求では出来ない事を明記。
4. **env 名**: 設計書 5.5 の `CF_TEAM` `CF_AUD` `ALLOWED_EMAILS` `PROXY_KEY` `PORT` `WEB_SETTINGS_FILE` `CENTER_URL` `CENTER_TOKEN` は実物と一致。実物にあって設計書に無い/弱い所: `HOST`（Nitro の既定は全 interface なので `127.0.0.1` を明示させた）、`WEB_CF_CERTS_URL`（test 用、本番では設定しない）。必須 4 項目が空だと全 request 500。
5. **設定 file の既定 path**: `$XDG_STATE_HOME/bantou-web/settings.json`（無ければ `$HOME/.local/state/bantou-web/settings.json`）。
6. **設定を書く経路**: 実物は `allowSettingsWrite` が既定 false で、`center_set_settings` は既定で拒否される（設計書 5.5 の設定画面からの変更は未配線）。設置は file か env の編集のみと書き、確認表 17 に入れた。
7. **env の url 変更時の token**: file の token は同じ url の時だけ使う（実物の挙動を記載）。
8. 設計書 13 章のうち、まとまり 8/S/6 の画面・desktop・https listener に関わる項目（旧 15・17・20 の B・21）は対象外として落とした。

## 利用者の決定との食い違い（決定を正とした所）
- 設計書 9.1 の例は「専用 user + user unit」だが、実行 user と unit の持ち主が違う場合の記述が無い。決定に従い 4.2 を追加: unit の持ち主の user manager から `sudo -n -u <run-user>` で起動 script を実行し、ExecStop / ExecStopPost で実行 user として pid 照合のうえ停止する script を呼ぶ。sudoers の許可は 2 つの script に限る。env は実行 user 専用 file を script が読む（unit の `EnvironmentFile` は使わない）。
- 設計書 11 章 判断 6 の議論（system unit か user unit か、既存 server との HOME 共有）は持ち込まず、「人の login 用 user で動かさない」「linger は管理者が前提として用意」とした。
- 設計書の固有名（特定 host・中継・他 app の呼び名・port 候補）は持ち込んでいない。

## 確かめられなかった事（docs のみ。どの host にも触れていない）
- 手順書の command は実行していない（build・systemd・sudo・nginx 設定すべて未実行）。特に 4.2 の script（pid 照合・stop）と sudoers 行は実機での検証が無い。
- `.output` の自己完結（実行側に node だけで足りる）は、test の起動方法（`node .output/server/index.mjs`）からの推測。
- `HOST` / `PORT` が Nitro の既定 env である事は test の起動 env に依拠。他の名前（`NITRO_HOST` 等）は未確認。
- nginx 例は実 nginx で確かめていない。
- 設計書 13 章の実測項目（JWT の到達、SSE の束、idle、添付上限、Access session 切れ等）はすべて設置者が確かめる。

## review 指摘の反映（2 回目の commit）
1. env file の読み方の差（systemd `EnvironmentFile` と shell の `.`）: 値を `[A-Za-z0-9._@,+/=-]` だけに制限し、`PROXY_KEY` は `openssl rand -hex 32` を指定（2.2）。4.2 の script は shell で読む旨を注記。
2. `web-run.sh`: 起動前に pid file の pid が web backend（cmdline・cwd 一致）なら失敗終了。stale なら上書き。
3. stop / run の pid 照合に `readlink /proc/$pid/cwd` = `<install-dir>/packages/web` を追加（`<install-dir>` は実 path）。
4. sudoers の Cmnd を空引数 `""` で引数なしに限定。script と `<install-dir>`・`bin/` の親 dir を `<unit-owner>` が書けない事を 0.1・4.2 に明記。
5. `sudo -n -H -u`、加えて env に `WEB_SETTINGS_FILE` を絶対 path で明示する旨（2.2）。
6. user unit の `After=network-online.target` を外し、注記。
7. 設定 file の親 dir を `700` で先に作る手順（2.2・2.3）。
8. 手動起動の env の読み方 `set -a; . <env-dir>/web.env; set +a` を 3 章に追加。
9. 確認表 8-3: 許可内 200・許可外 403（か前段で停止）の両方を確かめる。
10. 確認表 8-15 に nginx の access/error log に JWT・共有鍵が出ない事、6 章に「log_format に `$http_*` を入れない」を追加。
未実行（実機検証なし）である点は前回と同じ。
