# server: host 単位の多重起動 guard と worker 常設制約

基点 develop e6d7a241e5841049ec426dea4f810584affca7ad / branch fix/server-single-instance

## 変更点
- packages/server/bin/host-lock.mjs（新規）: host 単位の lock。
- packages/server/bin/bantou.mjs: 既定モード（launcher）の起動直前に `guardHostLock` を呼ぶ。競合なら message を stderr に出し exit 1。終了時に解放。
- packages/server/server/utils/bantou/prompts.ts:63-70 `WORKER_GUIDE` に「[常設の制約]」節を追加（worker の system prompt。daemon.ts:234 が `--append-system-prompt-file` で渡す）。
- docs/ops/server-install.md: 「多重起動 guard（host lock）」1 段落。
- test: test/server/utils/bantou/host-lock.test.ts（10 件）、test/fixtures/host-lock-cli.mjs、prompts.test.ts に 1 件。

## worker 指示の雛形の箇所
- `packages/server/server/utils/bantou/prompts.ts` の `WORKER_GUIDE`（worker 側 system prompt。daemon.ts:234 で kind=worker に使う）。cap の `CAP_GUIDE`（同ファイル:27 付近）は「kick_cap の prompt にある制約は worker への指示にも書き写す」とあり、制約を worker prompt に自動では渡さないため、常設分は worker 側の雛形に置いた。
- 文言: 「bantou-server / bantou-center を install・起動・停止・再起動しない。必要なら report で報告するだけにする。」既存の制約（repo 引数・一時物・GIT_CONFIG_GLOBAL・version bump）は CAP_GUIDE 側にあり、重複・矛盾なし。
- 既存テストの期待値は変更不要（部分一致のみ）。

## lock の方式
- 場所: 固定 `/tmp/bantou-server.lock`（user をまたぐため。os.tmpdir() は macOS で user ごとの /var/folders になり、Linux も TMPDIR で変わるので使わない。/tmp が無ければ os.tmpdir()）。test 用に env `BANTOU_SERVER_HOST_LOCK` で差し替え。
- 取得: 全内容を書いた一時ファイルを `link()` で置く（atomic、EEXIST で競合判定）。mode 0666。内容は pid / user / started_at / start（起動時刻 token）/ workspace / version。
- 生存確認: `kill(pid,0)`（EPERM は生存）+ 起動時刻 token（Linux: /proc/<pid>/stat の starttime、macOS: `ps -o lstart=`）の一致。pid 再利用は token 不一致で stale。token が読めない時は pid の生存のみ。
- stale 取り直し: sticky な /tmp では他 user の file を unlink できないため、内容を上書き（縮めない）し、60ms 後に読み直して自分か確認する。同時に取り直した 2 者のうち後に書いた方が残り、先の方は読み直しで負けを知る。
- 解放: 正常終了で unlink（失敗したら released に上書き）。SIGKILL・OOM は stale で回収。
- 外し方: `BANTOU_SERVER_ALLOW_MULTI=1`（取得も解放もしない）。
- exit→再起動との相性: lock の持ち主は launcher の pid。自己更新で supervisor が替わっても launcher は残るので衝突しない。systemd の Restart で launcher が落ちて再起動した場合は旧 pid が死んでいて stale として取り直す。同一 pid の再取得は再入で成功。

## 既存 server.lock との関係
- `<workspace>/server.lock`: workspace 単位。supervisor の交代・引き継ぎ（next.token）と launcher の見張りに使う。user・workspace が違えば別 lock なので、別 user・別 workspace の 2 つ目は止められなかった（今回の事故）。
- host lock: host 単位。launcher の起動前に 1 回取るだけ。server.lock の仕様・launcher 契約は変えていない。役割: host lock = 「host に 1 つ」、server.lock = 「workspace 内の supervisor 系列」。

## 回したテストと結果
- bun install（bun.lock の変更は commit せず戻した）→ packages/protocol `npm run build` → `cd packages/server && bun run test`: 272 pass / 0 fail。
- `bun run typecheck`: host-lock 関連の error なし。既存の 7 件（default-config.test.ts の型 6、launcher.test.ts の workspaceOf import 1）は develop 時点から。
- test の lock は mkdtemp した専用 dir の中。本物の `/tmp/bantou-server.lock` は触っていない（実行後も無いことを確認）。本物の bantou-server は起動・停止していない（子プロセスは fixture のみ）。

## 残課題
- 既に動いている旧 launcher は guard を持たない。launcher は起動時に凍結されるため、自己更新だけでは host lock は付かず、再起動（launcher の入れ替え）後に有効になる。
- guard は launcher 経路のみ。`--supervise` / `--serve` の手起動は従来の server.lock のみ。
- 競合時の systemd 配下は `Restart=always` で 10 秒ごとに失敗を繰り返す（2 つ目の unit は無効にする運用。docs に記載）。
- stale の同時取り直しは 60ms の読み直しで判定する確率的な窓が残る（極めて狭い）。
- 既存の typecheck error 7 件は未対応（範囲外）。

## review 指摘と対応
（後で追記）
