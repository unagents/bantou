# 報告: master-cap を pty wrapper で起動し、出力を desktop に配信する

- 日付: 2026-11-01 / 実行: 204 remote cap（worker は sonnet: w-wrapper、w-center、w-desktop、w-list）
- 正本: `docs/design/master-cap-session.md`。worker 間の契約: 同 dir の `interfaces.md`（A: wrapper ↔ center、C: center HTTP、D: desktop、E: 追加指示 1）。
- 追加指示 1（`task-add-1.md`）と追加指示 2（`task-add-2.md`、報告は `report-add-2.md`）を含む。

## develop への統合状況

| 部分 | 状態 |
|---|---|
| wrapper（`packages/pty-wrapper`、sidecar の staging） | develop に commit 済み（2b8731b） |
| center（窓口分離、使い捨て token、core、wrapper 経由の起動） | develop に commit 済み（1f8d25e） |
| center `GET /events`（追加指示 1） | develop に commit 済み（43eedd0） |
| 設計書の 7（追加指示 1）、指示書、interfaces、本報告 | 本報告の commit |
| desktop（3 列、xterm、Rust の SSE、指示ボタン廃止、`center-sessions-changed`） | **未統合**。local branch `worktree-agent-a9734fb447a1dbf69`（31994e9・f2f3e04、43eedd0 の上）。追加指示 2 に従い、`fix/session-list-from-center` が develop に入った後にその上へ合わせる |
| desktop のセッション一覧（追加指示 2） | branch `fix/session-list-from-center` を push 済み（7874b50・3051bb2） |

## 変更ファイル

### wrapper（新規 `packages/pty-wrapper`）

- `Cargo.toml`、`Cargo.lock`、`.gitignore`、`src/{lib,main,proto,strip,utf8}.rs`、`tests/cli.rs`。
- 依存: `portable-pty` 0.9、`serde`、`serde_json`、`base64`、`libc`（unix）。
- `desktop/scripts/build-sidecar.ts`: center に続けて wrapper を `cargo build --release` し、`binaries/bantou-pty-wrapper-<triple>` に置く。
- `desktop/src-tauri/tauri.conf.json`: `externalBin` に `binaries/bantou-pty-wrapper` を追加。

### center（`packages/center`）

- 新規: `src/core.ts`、`src/session-auth.ts`、`src/wrapper.ts`、`src/events.ts`。
- 変更: `src/http.ts`、`src/tools.ts`、`src/server.ts`、`src/remote-control.ts`、`src/sessions.ts`、`src/daemon.ts`、`README.md`。
- テスト: 新規 `test/core.test.ts`、`test/remote-control-wrapper.test.ts`。更新 `test/http.test.ts`、`test/tools.test.ts`、`test/sessions.test.ts`。
- 窓口:
  - `/mcp`（外向け）は 12 tool。`remote_create`・`remote_delete`・`cap_kick` を外し、`remote_list` は読み取り専用で残した。
  - `/mcp/session` は `remote_create`・`remote_delete`・`remote_list`。認証は、セッションに紐づく使い捨て token と `X-Bantou-Session` の組。

### desktop（未統合の branch の内容）

- Rust: 新規 `src-tauri/src/terminal.rs`、`src-tauri/src/center_events.rs`。変更 `lib.rs`、`session.rs`（`instruct_add_task` を削除）。
- front:
  - 新規 `api/terminal.ts`、`components/TerminalView.vue`、`composables/terminalBuffer.ts`、`composables/useTerminalStore.ts`。
  - 変更 `pages/index.vue`（3 列）、`RemoteActivity.vue`（owner で絞る）、`SessionColumn.vue`、`api/index.ts`、`api/sessions.ts`、`useSessionRefresh.ts`。
  - 依存に `@xterm/xterm` 6.0.0 と `@xterm/addon-fit` 0.11.0 を追加。
- 削除: `InstructTaskDialog.vue`、`e2e/session-instruct.spec.ts`、mock の `instruct_add_task`。
- e2e: 新規 `terminal.spec.ts`、`terminal-buffer.spec.ts`。変更 `mock/bantou.ts`、`session-add.spec.ts`。

## テスト結果

| 対象 | 前 | 後 | 確認 |
|---|---|---|---|
| wrapper `cargo test` | - | 32 passed（unit 22、統合 10） | worker |
| center `npm test` | 196 passed | 230 passed / 0 failed（develop 43eedd0） | cap が再実行 |
| center `npm run typecheck` | - | エラー無し | cap が再実行 |
| desktop `cargo test`（develop） | 214 passed / 5 ignored | 214 passed / 5 ignored（externalBin 追加後） | worker |
| desktop `cargo test`（desktop branch） | 214 passed / 5 ignored | 238 passed / 5 ignored | worker |
| desktop e2e（desktop branch） | 57 passed | 68 passed / 0 failed | worker |

- e2e は、204 の sandbox では通常の手順で回せなかった。
  - sandbox が unix socket の listen と Chrome の socket を EPERM で拒否するため、`nuxt dev` が起動しない。
  - 代わりに `nuxt generate` の静的ビルドを簡易静的サーバーで配信し、chromium headless shell で回した。
  - 通常の `playwright.config.ts` での実行は mac200 で未実施。
- 3 列画面のスクリーンショットは desktop worktree の `desktop/node_modules/.cache/bantou-e2e/shots/three-columns.png` にある（commit していない）。
  - 左はサイドメニュー。
  - 中央は owner 一致の remote と、その下の Cork 形式のタスク一覧。
  - 右は xterm。

## 実測（204、claude 2.1.316、実 center + 実 wrapper + 実 claude）

| 確かめたこと | 結果 |
|---|---|
| pty の中の対話型 `claude --remote-control <name>` | Remote Control 有効。204 でも実測できた |
| 決定 4: session URL と接続状態を wrapper の文字列から拾う | 拾えた。`state: connected` になり、`sessionUrl` に `https://claude.ai/code/session_…` が入った |
| 窓口の分離 | 外向けの tool 一覧に `remote_create`・`remote_delete`・`cap_kick` が無い |
| `--mcp-config` の文字列、`${BANTOU_SESSION_TOKEN}` の展開、`/mcp/session` への接続 | claude の `/mcp` 画面で `✔ bantou 3 tools` |
| desktop から入力（`POST /sessions/<name>/input`） | 指示 "Reply with just OK" に `● OK` が返った。出力は SSE で受信（reset、チャンク ID 1〜51） |
| center 停止時に master-cap が止まるか | stop メッセージで止まり、claude は残らなかった |
| 決定 5: 対話型 `claude --continue --remote-control <name>` で続きから再開 | **未確定**。下記 |

- 決定 5 の詳細:
  - center の再起動で `--continue` 付きの起動までは行われた。
  - claude が `No conversation found to continue` で終了し、center は素の起動へ fallback した。
  - 原因は sandbox にあると見ている。sandbox が `~/.claude-agent/projects` への会話記録の書込を拒否していた。
  - 204 の今の環境では確かめられないため、Mac main cap（mac200）に回す。
- 信頼していないフォルダでは、claude が起動時にフォルダ信頼の確認画面を出した（mac200 の実測には無い）。
  - 自動応答はしていない。
  - desktop の右の列（入力 POST）から答えられることを確かめた。
  - 204 の sandbox では信頼の記録も残らず、起動のたびに再び出た。

## 要判断事項

1. center は wrapper の場所を、環境変数 `BANTOU_PTY_WRAPPER` で上書きできるようにした（決定 12 への追加。dev/test 用）。
2. フォルダ信頼の確認画面への自動応答はしていない。新しいフォルダで作った master-cap は、ユーザーが右の列で答えるまで接続しない。
3. remote-control 有効化の確認への自動応答は `y\r` を pty へ送る。対話型でこの確認が実際に出るかは未確認。
4. stdio transport で起動した center には `/mcp/session` が無い。そのため `--mcp-config` を付けずに master-cap を起動する（ログを出す）。
5. `/mcp/session` の token は、master-cap を起動するたびに作り直す。終了・停止すると失効する。
6. wrapper の text メッセージは `\t` を残す。spawn に失敗したら、`{"code":null,"signal":null}` の exit メッセージを出して終了コード 1 で終わる。子の終了後、残りの出力を最大 500ms 待つ。
7. `packages/center/scripts/e2e.ts` は `cap_kick` に依存していて、外向けから外したため実行すると失敗する見込み。未修正（本物の server と claude が要る）。`worker_resume` に替えるかは判断が要る。
8. desktop の Rust にあった `instruct_add_task` も削除した。UI からしか呼ばれず、孤児になるため。
9. desktop は再接続中・つながらない状態を `session-output-status` event で画面に出す。設計書の 4・5 には無い追加。
10. center の Tauri command の引数名は camelCase（`dataB64`）。interfaces.md D の表記（`data_b64`）と違う。
11. 文書と実装のずれ（文書は未編集）:
    - `docs/design/center-tools.md` と `docs/concept.md` が、`remote_*`・`cap_kick` を外向けとしている。窓口が 1 つの前提でもある。
    - 設計書冒頭の「未実装」。
12. 指示書の worktree パスには作れなかった（`report-add-2.md` の要判断事項 4）。
13. worker の worktree からの commit は、`GIT_CONFIG_GLOBAL` 付きだと worktree のガードに拒否された。そのため author は既定値になっている（agent.gitconfig と同じ `claude.cli`）。

## 後始末

- 実測で起動した center、wrapper、claude（`bt-measure`、`bt-probe-204`）は停止した。残存なし（pgrep で確認）。claude.ai 側にはその 2 つの remote session の記録が残る。
- worker が起動した dev server、静的サーバー、playwright は、各 worker が停止を確認した。
- 以下は `rm` が権限で拒否され、残っている。
  - `/tmp/claude-1002/` の下: `tmp.wZGyymHC5L/`、`mcw/`（実測の config・script・log）、`cargo-home/`（約 170MB）、`npmcache/`、`bunc/`、`w-sl/`、`desktop-test.log`、`static.mjs`、`base.log`、`after.log`、`gen.log`、`nuxt.log`、`cargo.log`、`e.mjs`、`e2.mjs`、`edit-*.mjs`、`three-columns.png`。
  - `develop/.claude/worktrees/` の下の worktree 3 つ。
    - center 用 `agent-a3329c6e724849a4a`: 統合済み。
    - desktop 用 `agent-a9734fb447a1dbf69`: 未統合の commit を持つので残す。
    - w-list 用 `agent-aafdaaa90addceff2`: push 済み。
  - 各 worktree の中の未追跡物: `package-lock.json`、`desktop/playwright.local.config.ts`、`desktop/pw.local.config.ts`、`desktop/.output/`。
