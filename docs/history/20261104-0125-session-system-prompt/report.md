# master-cap の session に追加指示（--append-system-prompt）

branch: `feature/session-system-prompt`（base: develop `888d06a`）。commit: `e24519c`（chore: center の protocol 依存）、`c554923`（feat）、この report。

## 仕様

- center の config（`center.json`）の `remoteControl.sessionInstructions`（文字列、省略可、空文字は無しと同じ、16000 文字以内）。
- center が wrapper 経由の session（master-cap）を起動するたび、値があれば claude の引数に `--append-system-prompt <値>` を足す。新規・再起動・`--continue`（restore と異常終了後の再起動）・resume 失敗後の素の起動のすべて。無ければ足さない。config 由来の project（`claude remote-control` 直起動）は対象外。
- `rc_status` と `session_list` に `instructions`（真偽、起動時に付けたか）。本文は出さず、`rc_status` の `args` と起動ログでも値は `<N 文字>` に伏せる。
- desktop: 設定画面（center の節）に複数行入力欄「master-cap への追加指示（system prompt に追記）」。保存で `settings.json` の `center.sessionInstructions` に入り、`center.json` の `remoteControl.sessionInstructions` に書き出される。欄の下に「動いている session には効かない（自動では再起動しない）」の注意。
- desktop の一覧: `instructions` が true の session は、サイド行と見出しに小さな巻物アイコン（tooltip「追加指示つきで起動した」）。簡単に足せたので入れた。
- cwd に `CLAUDE.md` は書かない。

## 渡し方の根拠

- 比較: (A) CLAUDE.md を書く（採らない指定）、(B) `--append-system-prompt-file` で center の状態 dir のファイルを指す、(C) `--append-system-prompt` を argv で渡す。
- (C) を採用。argv が shell を通らないことをコードで確認した: center → wrapper は `child_process.spawn(command, args[])`（`remote-control.ts`、shell なし）、wrapper → claude は `portable_pty::CommandBuilder::new(program).args(rest)`（`packages/pty-wrapper/src/main.rs`、shell なし）。直す箇所は無かった。複数行・引用符・`$`・`;` を含む文字列が 1 要素のまま届くことをテストで確認。
- `--append-system-prompt-file`（B）は置き場・書き込み・掃除が増えるだけで、今の長さでは得が無い。引数長の上限は Linux が 1 引数 128 KiB、Windows がコマンドライン全体で約 32K 文字（推測、公式資料で未確認）。余裕を見て config で 16000 文字に制限した。超える要望が出たら (B) に替える。

## 判断が要った点（要確認）

- desktop は `sessionInstructions` の変更だけでは center を再起動しない（`needs_restart` に入れていない）。center の停止は master-cap の session を止める（`docs/design/master-cap-session.md` 決定 2）ため、再起動すると session を自動で再起動することになり、「自動再起動はしない」に反するので。結果、保存した値は center の次の起動（アプリ再起動、center の ON/OFF、port などで再起動した時）から効く。center は config を起動時に 1 度しか読まないため、動いている center の下で session だけ再起動しても古い値のまま。「保存したら次の session 起動から効く」にしたい場合は、center が config を再読込するか、desktop が center を再起動する（session も止まる）必要がある。どちらにするか指示を待つ。
- center の `--append-system-prompt` を足すのは `buildWrapperArgs` の `--mcp-config` の前。

## 変更ファイル

- center: `src/config.ts`（`sessionInstructions`、`SESSION_INSTRUCTIONS_MAX`）、`src/wrapper.ts`（`appendSystemPrompt`）、`src/remote-control.ts`（引数に足す、`RcStatus.instructions`、`redactAppendSystemPrompt`）、`src/sessions.ts`（`SessionInfo.instructions`）、`test/{config,remote-control-wrapper,sessions}.test.ts`、`README.md`
- desktop: `src-tauri/src/center.rs`（`CenterSettings.session_instructions`、検証、`build_config`、`needs_restart` のコメント、テスト）、`src-tauri/src/session.rs`（`Session.instructions`）、`src/types/index.ts`、`src/composables/useBoard.ts`、`src/components/{SettingsDialog,SessionColumn}.vue`、`src/pages/index.vue`、`e2e/mock/bantou.ts`、`e2e/session-instructions.spec.ts`、`README.md`
- docs: `docs/design/master-cap-session.md`（決定 13〜15）
- chore: `packages/center/package.json`（protocol 依存 `file:../protocol` → `^0.2.0`）、`bun.lock`（center の protocol 写しの行が消え、workspace 解決になった）。`packages/center/node_modules/@agent-hand/bantou-protocol` は `../../../protocol` へのリンク。

## テスト

- center `bun run test`: 276 件 通過 / 失敗 0（269 + 新規 7: config 1、wrapper 引数 1、起動 4〔値あり・複数行、空と未指定、再起動と resume、fallback〕、一覧 1）。`bun run typecheck` エラーなし。
- desktop `bun run build:sidecar`: 成功（center の compile、pty-wrapper の build）。`^0.2.0` 化の影響なし。
- `src-tauri` `cargo test`: 250 件 通過 / 失敗 0 / ignored 5（245 + 新規 5: 設定の往復と既定、検証、config 書き出し、再起動不要、session の `instructions`）。
- desktop e2e（`bun run generate` の静的ビルド + 簡易静的サーバー、ms-playwright の chromium-1243、一時 config）: 80 件 通過 / 失敗 0（77 + 新規 3: 入力欄の表示・保存・注意文、保存値の表示と空への変更、印）。
- `bun run typecheck`（desktop、`nuxt typecheck`）: この環境で `vue-tsc` が `MODULE_NOT_FOUND`（bun の isolated linker。今回の変更前からか未確認）で実行できず、未確認。

## 実機で確かめること

- 設定に複数行の指示を入れて center を起動し、master-cap を新規作成して、実際に指示が system prompt に効いているか（claude の応答で確認）。
- master-cap を center ごと再起動（`--continue` での再開）しても効くか。
- 保存後、動いている session は変わらず、center の再起動後に変わること（上の「要確認」）。
- サイド行と見出しの印の見た目。

## 後始末と残存物

- worker 作業 dir の `tmp-e2e/`（静的サーバーのスクリプト、一時 playwright config）は静的サーバー停止後に `find … -delete`。clone 内の一時 config `playwright.tmp.config.ts` も削除済み（commit していない）。port 1420 は解放確認済み。
- clone `bantou/` は worker 作業 dir に残す。生成物（`node_modules`、`.nuxt`、`.output`、`src-tauri/binaries`、`src-tauri/target`）は `.gitignore` 対象。
- push は `feature/session-system-prompt` のみ。develop・main へは push・merge していない。version bump なし。

## 追記: 設定の読み直し

不具合: center は config を起動時に 1 度しか読まず、desktop で `sessionInstructions` を保存しても center の再起動まで次の session 起動に効かなかった（上の「判断が要った点」）。center の再起動は全 session の停止になるので採らない。

### 直し方

- center（`remote-control.ts`、`config.ts`、`daemon.ts`）: session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動。すべて `launch` を通る）に `center.json` を `loadConfigSync` で読み直し、その時点の `remoteControl` を使う。読み直しに失敗（ファイル無し・JSON 破損・検証 NG）したら、直前に読めた値（未取得なら起動時の値）で起動し、`config の読み直しに失敗。直前の値で起動: project=… <理由>` を `center.log` に残す。本文は log に出ない。
- desktop（`center.rs`）: 実装中に判明した点。desktop は `center.json` を center の起動時にしか書いておらず、再起動しない保存（`sessionInstructions` のみの変更など）ではファイルが古いままだった。center の読み直しだけでは効かないので、再起動しない保存でも center が動いていれば `center.json` を書き直す（`apply` の `refresh_config`）。center へ知らせる経路（HTTP route 等）は無く、足していない。
- desktop の注意文を「保存後に起動する session から効く。動いている session には効かない」に変更（`SettingsDialog.vue`、README、e2e）。
- 根拠（比較）: (A) 起動時 1 度のまま、(B) 保存のたび center 再起動（session が全部止まる）、(C) 起動のたび読み直し、(D) 保存時に center へ通知（route が無い）。(C) は取りこぼしが無く、要件を満たす。

### 効く項目と効かない項目

- 読み直しで効く（その session の起動時点の値）: `remoteControl.sessionInstructions` / `model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`。
- 起動時にしか効かない: `remoteControl.claude`、`remoteControl.stopGraceMs`、`projects`、`servers`、`logDir`、`workspace`、`token`、port / bind。
- docs: `docs/design/master-cap-session.md` 決定 14 の改訂と決定 16、`packages/center/README.md`（表と「config の読み直し」節）、`packages/desktop/README.md`。

### 前回 commit の破損の修復

`c554923` で `docs/design/master-cap-session.md` と `packages/center/README.md` が壊れていた（JS の `String.replace` で置換文字列の `` $` `` が展開され、ファイル先頭からの本文が文中に複製された。両ファイルとも約 130 / 90 行の混入）。`888d06a` との差分が意図した追記だけになるよう、混入部分を除いて `` `$` `` を元に戻した。他のファイルの差分は規模が妥当で、同様の破損は無かった。

### テスト

- center: `bun run test` 280 件 通過 / 失敗 0（276 + 新規 4: 保存後の起動〔再起動・resume 失敗後の素の起動〕で新しい値と model が使われ動いている session は変わらない、空に変えると付かない、壊れた JSON・検証 NG・ファイル無しで直前の値と log、configPath 無しは従来どおり）。`bun run typecheck` エラーなし。
- `src-tauri` `cargo test`: 251 件 通過 / 失敗 0 / ignored 5（250 + 新規 1: 再起動しない保存で書き直した `center.json` に新しい値が入る）。`bun run build:sidecar` 成功。
- desktop e2e（`bun run generate` の静的ビルド + 簡易静的サーバー、ms-playwright chromium-1243、一時 config）: 80 件 通過 / 失敗 0（注意文の検証を新文言に変更）。
- 未実施: 実機の center + master-cap で、保存後に起動した session に新しい指示が効くこと。desktop の `nuxt typecheck` は前回同様 `vue-tsc` の問題で未確認。

### 残存物

- 一時の静的サーバー（port 1420）は停止、`tmp-e2e/` と clone 内の `playwright.tmp.config.ts` は `find -delete` で削除済み（commit していない）。プロセス・port 1420 の残りなし。
- clone `bantou/` は worker 作業 dir に残す（生成物は `.gitignore` 対象）。
- push は `feature/session-system-prompt` のみ。develop・main へは push・merge していない。version bump なし。
