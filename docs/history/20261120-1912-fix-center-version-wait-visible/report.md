# fix-center-version-wait-visible

基点: origin/develop 2009f187c27196bfa694a1b847143f1d73657aea（branch fix/center-version-wait-visible）

## 変えた file（packages/center のみ）
- src/follow.ts: ServerVersionInfo / versionNoteOf / Follow.versionOf / Follow.noteOf を追加（更新の指示の動きは変えない）
- src/server-link.ts: versionMismatchError に note を足し、setVersionNote で差し込む（門の判定は同じ）
- src/daemon.ts, src/server.ts: follow を link / session 向け MCP へ配線
- src/tools.ts: session 向け remote_list / task_status に版の状態を足す（説明文も更新）
- src/remotes.ts: RemoteView に server_version_state?（型のみ。remotes.list() は付けない）
- src/task-status.ts: task_status に servers（1 行ずつ、最大 10 件、1 行 200 字）を足し、6000 字の判定に含める
- test: follow / server-link / task-status

## 仕様
- (a) version_mismatch の error 文に「更新の状態: <指示済み・終了待ち／失敗／…>（<since> から）。<detail>」を足す。detail に cap / worker の件数・更新先・直近の失敗の内容が入る。未確認なら「未確認」。
- (b) remote_list の各 cap に server_version_state { center_protocol, server_protocol, server_version, state, detail(200 字まで), update, since }。task_status に servers: string[]。照合は server_id、無ければ peer id。server の事実だけで、他 session の名前・内容は入らない（task_status の servers は owner の cap の server のみ）。
- remote_list は既存の limitRemoteList の上限（20000 字）の前に付けるので、既存の段階で収まる。

## 判断
- error 文への足し方は link に setVersionNote を差し込む形（setGate と同じ流儀）にし、follow の詳細を link が知らなくて済むようにした。
- detail は follow が作った文を再利用（件数・失敗内容を含む）。server の error 文が長い場合に備え 200 字で切る。
- updating 中の「直近の失敗」は follow が保持していないため出ない（failed 状態の時だけ出る）。範囲外として触れていない。

## test
- center typecheck: 通過（先に packages/protocol を tsc で build）
- center 全体: 664 件 / pass 663 / fail 1（既知の不安定「center を SIGKILL すると rc が孤児で残り…」のみ）
- 追加 test: 9 件（follow 4、server-link 1、task-status 4）
- 変異（入れて落ちる事を確認し戻した）:
  1. error 文へ note を足さない → server-link の新 test が落ちる
  2. task_status の servers で owner の絞りを外す → 他 session の server が出て落ちる
  3. detail の 200 字切りを外す → versionOf の test が落ちる
  4. servers を 6000 字の判定から外す → 上限の test が落ちる
- center-client / 他 package: RemoteView・buildTaskStatus・ServerLink を参照する物は center 外に無く、型の影響なし（grep で確認）。center-client の test は回していない。

## app の更新の調べ（変更なし）
結論: 自動で適用されない。確認（check）だけが自動で、ダウンロード・適用・再起動は利用者がボタンを押した時だけ。
- 自動: packages/ui/composables/useUpdater.ts の onMounted（main window のみ）が runCheck("auto") を起動時と 6 時間ごと（RECHECK_INTERVAL_MS、20 行）に呼ぶ（約 146〜160 行、64 行の timer）。runCheck は checkForUpdate() を呼び、結果を state "available" にするだけ（78〜83 行）。
- 適用: installAndRestart（114 行〜）が downloadAndInstall と relaunchApp を呼ぶ唯一の経路。呼び元は packages/desktop/src/pages/index.vue:97（@install-update）← packages/desktop/src/components/AppHeader.vue:96-99 の「アップデートして再起動」ボタンの @click のみ。他に downloadAndInstall の呼び出しは無い（ui/api/updater.ts:13、desktop/src/tauri/platform.ts:44 は薄い wrapper）。
- Rust 側（packages/desktop/src-tauri/src/lib.rs）に download_and_install / check の呼び出しは無く、プラグイン登録（84 行）と設定の test のみ。tauri.conf.json の plugins.updater は endpoints と pubkey のみ。
