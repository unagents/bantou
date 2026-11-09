# session / MCP の PATH 補完

## 症状
macOS の bantou.app から起動した center sidecar が起動する session の PATH が `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、bun / node / npx / gh が見えない。MCP `bantou-messenger`（`command: npx`）が `Executable not found in $PATH: npx` で接続失敗する。

## PATH が決まる箇所（base 8985073）
- `packages/desktop/src-tauri/src/center.rs:538-543` sidecar を `app.shell().sidecar(..).spawn()`。env を触らず GUI 起動の最小 PATH を継承する（Rust は変更しない）
- `packages/center/src/remote-control.ts:299-300` `childEnv = mergeChildEnv(process.env, rc.env, project.env)`。子の PATH は center の `process.env.PATH` から来る
- `packages/center/src/remote-control.ts:212-222` `mergeChildEnv`（PATH の補完なし）。spawn は `:375`
- `packages/center/src/wrapper.ts:60-68` `bantou-messenger` は `npx` を PATH 任せで起動。claude（session）の PATH を使う
- `packages/center/src/claude-path.ts` claude 本体のみ login shell で解決。PATH は補わない

## 修正
- 新規 `packages/center/src/path-env.ts`: `resolveSessionPath` / `composePath` / `parseLoginShellPath` / `fixedPathCandidates`
- `packages/center/src/daemon.ts`: 起動時に 1 回 `process.env.PATH` を補う（center 自身の npx 等の解決と、子の継承を兼ねる）

## 規則
- 対象は macOS / Linux のみ。他 OS は変えない
- `$SHELL -lc` で PATH を 1 回取得（`SHELL` 未設定は `/bin/sh`、5 秒打ち切り）。stdout は目印 `__BANTOU_PATH_BEGIN__`〜`__BANTOU_PATH_END__` の間だけ採る（rc の余計な出力を無視。複数組なら最後。絶対パスでない要素は捨てる）
- 取れた時: login PATH → 現在の PATH → 固定候補（存在・未掲載）
- 取れない時: 固定候補（存在するもの）→ 現在の PATH
- 固定候補: macOS `/opt/homebrew/bin` `/usr/local/bin` `~/.local/bin` `~/.cargo/bin` `/opt/homebrew/opt/rustup/bin`（Homebrew の rustup の proxy。`~/.cargo/bin` の次）`~/.bun/bin`、Linux は `~/.` 3 つ
- 重複排除（先勝ち）、空要素は捨てる
- config の `env.PATH`（project.env > remoteControl.env）は既存の `mergeChildEnv` の順序でそのまま優先。補わない

## テスト結果
- root `bun install` → `packages/protocol` build → `packages/center` typecheck 成功、test 447 件 pass（追補後）。当初は 446 件 pass / 0 fail
- 新規 `test/path-env.test.ts`: 存在チェック、重複排除、順序、login shell 優先、失敗（reject / 目印なし / 空）での固定リスト、ノイズ出力、SHELL 未設定、Linux、対象外 OS
- `test/remote-control.test.ts` 追加 2 件: PATH が `/usr/bin:/bin:/usr/sbin:/sbin` だけでも spawn された session の env.PATH に追加 dir が入る / config の env.PATH が補完より優先される
- 実機の login shell（bash）で `resolveSessionPath` が `login-shell` で PATH を返すことを確認（Linux）

## 残り
- macOS 実機（bantou.app 経由）での確認は未実施。確認項目: session の PATH に `/opt/homebrew/bin` が入る、`bantou-messenger` が接続する
- fish の login shell: `"$PATH"` のクォート展開で `:` 区切りになる想定だが未検証（失敗時は固定リストに落ちる）
- desktop の Rust は触っていない（cargo test 対象外）

## review 指摘と対応
（未着手）

## 追補（cap 指示）
- macOS の固定候補に `/opt/homebrew/opt/rustup/bin` を `~/.cargo/bin` の次に追加（他の順序は不変）。存在チェック・重複排除は他と同じ。unit test と packages/center/README.md を更新
