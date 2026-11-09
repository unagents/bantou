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
- launchd は exit code ごとの再起動除外ができない（KeepAlive の SuccessfulExit / Crashed は 75 だけを除外できず、Crashed にすると通常の異常終了も再起動しなくなる）ため、競合時は ThrottleInterval 10 秒で再試行し続ける。docs に制約を明記（対応は見送り）。
- stale の同時取り直しは 60ms の読み直しで判定する確率的な窓が残る（極めて狭い）。
- 既存の typecheck error 7 件は未対応（範囲外）。

## review 指摘と対応

### 第 1 回（HEAD e1fa22e）
- M1 [medium] overwriteInPlace が symlink を辿る → 対応済み。lock の open は全て O_NOFOLLOW、fstat で通常 file・nlink=1 を確認（自分の link() 直後の nlink=2 は 20ms × 5 回見直す）。不正なら HostLockError で取らずに終了（exit 75）。symlink・hardlink・dir の test を追加（victim file が無傷なことも確認）。
- M2 [medium] 他 user が先に置いた lock で起動不能・EACCES で stack trace → 対応済み。読めない/書けない（EACCES・EPERM）は HostLockError にして guardHostLock が catch、stack trace なしの message で exit 75。message に「root が rm <path>」と BANTOU_SERVER_ALLOW_MULTI=1 を常に出す。競合 message に lock の owner uid を出し、token 無しで owner が root でも自分でもない lock は「信頼できない lock の可能性」と明示（挙動は止める側のまま）。0000 / 0444 の stale、token 無し pid:1 の test を追加。
- M3 [medium] 競合時の systemd 10 秒ループ → 対応済み（systemd）。競合・信頼できない lock は exit 75（EXIT_CONFLICT）。scripts/service/bantou-server.service.in に RestartPreventExitStatus=75 を追加し、unit 雛形と定数の一致を test。install-service.sh は bash -n 通過、--dry-run（--user bantoutest --home /home/bantoutest）で RestartPreventExitStatus=75 が描画されることを確認（shellcheck は未導入）。launchd は上記のとおり同等の設定ができず、docs に制約を明記。docs/ops/server-install.md の段落を更新（専用 exit code、unit 設定、無効にし忘れた 2 つ目は 75 で止まる、既存 unit は install-service.sh 再実行で更新）。
- L2 [low] 止め方の順序 → 対応済み。systemctl stop / launchctl bootout を先、kill -TERM は「手起動の場合のみ」と明記。
- L5 [low] この節を実際の指摘と対応で更新 → 対応済み。
- L4 [low] launcher 経路の配線 test → 対応済み。bin/bantou.mjs を存在しない config で起動し、競合時に 75 で終了すること（launcher を起動しない）を test。
- 追加で発見・修正: test fixture の SIGTERM handler 登録前に held を出していたため、親が即 SIGTERM すると解放前に落ちて flaky になっていた。handler を先に登録するよう fixture を修正。

### 残り（直さない low）
- L1 stale の同時取り直しに 60ms 読み直しの窓が残る。
- L3 startToken の boot_id（host 再起動をまたぐ starttime の一致）は未対応。
- 稼働中の旧 launcher は guard を持たない（上記残課題）。
