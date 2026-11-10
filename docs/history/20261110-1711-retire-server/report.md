# 退役（server を center から外す）

center から server を退役させる手段の追加。branch `feat/retire-server`。前半（protocol / server）を w-ret-server、後半（center / desktop）を w-ret-center が担当する。

## protocol / server

### 設計

**message（protocol 1.8.0、`MESSENGER_PROTOCOL` のみ版を上げた。package の version は触っていない）**

- `retire_server`（center → server）: `{bantou:1,type:"retire_server",server_id?,reason?}`。`server_id` が server 自身と違えば `error` で何も止めない（全 server が peer 名 `bantou-server` で、名前宛ては版も不明なので誤爆の保険）。
- `retire_result`（server → center）: `{ok:true,state:"retiring",stopped:{caps,workers},exit_at,exit_code:76,host_steps:[1..3],service?:{manager,name?,detected?},server_id?,host?,user?,workspace?}`。
- `error` に optional `retiring: true`（退役中の拒否。`retryable:false`）。`ErrorCode` は増やしていない: 旧 center の `isErrorCode` が未知 code の error を捨てるため。`error.command` に `"retire_server"` を追加。
- export: `RETIRE_MIN_PROTOCOL="1.8.0"` / `RETIRE_EXIT_CODE=76` / `supportsRetire(version|undefined)`（版不明・不正は false）/ `isRetireServerCommand`。
- 版の門: `retire_server` は `update_server` と同じ control 扱い（版違いの server にも送れる）。ただし旧 server は未知指示として無返信で無視し、center が「退役した」と誤認する。center は `supportsRetire(peer.version)` が true の時だけ送り、無返信を退役済みとしない（退役成功 = `retire_result` 受信 → peer が消える）。

**退役の順序（server、`retire.ts` の `createRetireController`、依存注入で mock 検証）**

1. `server_id` 確認（違えば error）。
2. `<workspace>/server.retired` を書く。**書けなければ error で何も止めない**（server は動き続ける）。以降は全段 best-effort で、必ず終了まで進む。
3. 受付停止: 更新予約の取消（`update.close()`。取消さないと停止後の idle で update が再起動を始める）、新規 `kick_cap` / `task` / `worker_reply` / `update_server` を `error(retiring:true)` で拒否、MCP `worker_start` / `report` を拒否。`hello` / `status` / `stop_cap` / 再度の `retire_server` は通す。
4. 実行中の cap / worker の数を数え、`manager.shutdown()`（既存の停止経路）で全部止める。
5. `retire_result` を返信（2 回目の `retire_server` は同じ返信）。
6. 返信後 3 秒（messenger client の poll 間隔 1 秒 ×2 を見込む猶予）待ち、`stop()`（protocol 登録解除 → client 解除 → mcp / broker 停止）→ **exit 76**。返信が送れなくても、受付から最長 15 秒で 6 へ進む（居座らない）。plugin の 5 秒 hard timeout も exit 76 で抜ける。

**launcher への伝え方 / exit code**

- 追加の通信なし。`--serve` の子が exit 76 → 既存の supervisor（`result = 子の exit code` → `server.exit {launcher, code}`）→ launcher（`server.exit.code` で終了）で、そのまま launcher の終了コードが 76 になる。**launcher / supervisor は無変更**（凍結物、版をまたぐ取り決めを触らない）。host lock は launcher 終了で解放、`server.lock` は supervisor が消す。
- systemd: unit に `RestartPreventExitStatus=75 76`。
- 再起動の保険: `<workspace>/server.retired` がある間、`bin/bantou.mjs`（launcher 経路、host lock より前）は起動せず **exit 75**。75 は host lock 競合と同じで、配布済みの旧 unit も持つ → 旧 unit は 76 で一度だけ（10 秒後）起動し直されるが、この拒否の 75 で止まる。印を消せば再び起動できる。
- launchd: `KeepAlive` を `PathState`（`@HOME@/server.retired` が無い間だけ起動し直す）に変更。根拠は launchd.plist(5)（keith.github.io/xcode-man-pages で確認）: 「PathState: If the value of the key is true, then the job will be kept alive as long as the path exists」、false は逆の条件、「If multiple keys are provided, launchd ORs them」、ThrottleInterval 既定 10 秒。**macOS 実機は未検証**（この host は linux）。
- 自分の unit は無効化しない: 専用ユーザーで動き権限が無く、試行しても失敗するだけ。代わりに `host_steps`（unit 削除 → user 削除 → workspace 削除。値は shell quote、`rm -rf` は短い path で出さない、root / 不正な user 名の削除は出さない）。unit 名は `/proc/self/cgroup`（`INVOCATION_ID` がある時）/ `XPC_SERVICE_NAME` から取り、取れなければ `install-service.sh` の既定名（`service.detected:false`）。

### 変更点

- protocol: `src/server.ts`（型・guard・定数）、`messenger/protocol.json` / `PROTOCOL.md`（1.8.0）、`test/server.test.mjs`。
- server: `server/utils/bantou/retire.ts`（新規）、`daemon.ts`（指示分岐・拒否・`Daemon.exitCode()`）、`plugins/01.bantou.ts`（終了コード）、`bin/bantou.mjs`（印があれば exit 75）、`scripts/service/` の unit / plist。
- test: `retire.test.ts`（順序・冪等・server_id 違い・印を書けない・停止失敗でも finish・deadline・拒否 error・host_steps・service 検出・unit/plist/印の名前の突き合わせ）、`retire-chain.test.ts`（本物の `bin/` を一時 dir にコピーし常駐本体だけ偽物に差し替え: 子 exit 76 → launcher exit 76、server.lock / host lock 解放、再起動拒否 75 で子が増えない、印を消すと再起動できる、通常終了は印を作らない）、`launcher.test.ts`（exit 76 が launcher の code）、`host-lock.test.ts`（unit が `75 76`）、`daemon.test.ts`（版 1.8.0）。
- docs: `docs/protocol.md`、`packages/protocol/messenger/PROTOCOL.md`、`packages/server/README.md`（「退役」）、`docs/ops/server-install.md`（4.6 退役）。

### 互換性

- 新 field は全て optional。旧形式の `error` / `hello_result` / `status_result` はそのまま受理（test あり）。
- 新 server → 旧 center: `error` の `retiring` は未知 field で無視される。`retire_result` は旧 center が知らない type（無視される）。
- 旧 server に `retire_server`: 無返信（center 側の門で送らない）。
- 旧 unit: 76 で一度戻るが印の拒否 75 で止まる。**旧 unit かつ `--version` で旧版固定**の組は、起動し直しで走る旧版 `bantou.mjs` が印を見ず server が戻る（docs に明記。固定を外すか host で unit を先に消す）。
- 旧 plist（`KeepAlive true`）は 10 秒ごとに起動し直す（exit 75 message が log に残る）。`install-service.sh` の再実行で更新。

### テスト結果

- `packages/protocol`: `npm run build && npm test` 38 pass / 0 fail（develop 時点 32 → +6）。
- `packages/server`: `npm test` 311 pass / 0 fail（develop 時点 292 → +19）。
- `packages/server` typecheck: error 7 件（develop 時点と同じ。`default-config.test.ts` 6 + `launcher.test.ts` の `workspaceOf` 型宣言 1。増減なし）。
- bun が host に無いため `npm install --no-package-lock -w packages/protocol -w packages/server` で代用（bun.lock は変更なし）。test は `TMPDIR` を作業 dir 内にして実行。本物の server の lock / workspace は触っていない。

### 判断（迷った点）

- exit code は専用 76 とし、起動拒否は 75 に分けた（旧 unit の救済のため）。
- `ErrorCode` を増やさず `retiring` flag にした（旧 center の parse を壊さない）。
- 返信の到達確認 API は messenger に無い（`send` は broker 受理まで、受信側は 1 秒 poll）ため、固定の猶予 3 秒 + 最長 15 秒の deadline とした。**center が server の内蔵 broker 経由でなく別 broker を使う構成では、この猶予は不要だが害も無い。**

### 残課題

- launchd の `PathState` は実機（macOS）未検証。
- 退役後の `server.log` と workspace は残る（host_steps で消す）。
- 印は workspace に固定。workspace を変えて起動し直すと別 server として起動できる（意図どおり）。
- center / desktop 側の操作（tool・ボタン・確認 dialog）は w-ret-center の節。

