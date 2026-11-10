# server: MCP tool `bash`（rm）と TMPDIR

branch: `feat/server-bash-tool`（base: develop）

## 目的

worker / cap の Bash の `rm -rf` が permission 分類器に止められる問題を、範囲を server が保証する MCP tool で避ける。あわせて cap / worker の `TMPDIR` を自分の path の `tmp/` に固定する。

## 設計

### tool `bash`

- 引数 `{ action: string, paths: string[1..100], recursive?: boolean }`。各 path は 1024 文字まで（zod）。任意のシェル文字列は受けない。
- `action` は handler 表（`bash.ts` の `HANDLERS`）で引く。今は `rm` のみ。未知の action（`constructor` など prototype 名も）は throw → `isError`。引数の形の不正（件数・長さ・型）も SDK の検証で `isError`。
- 返り値 `{ removed: string[], skipped: [{ path, reason }] }`。全部拒否でも `isError` にしない。
- cap / worker の両方に載せる（header で判定。header 無しには載せない）。起動時の `--allowedTools` に `mcp__bantou__bash` を足した。workspace 未設定（起動中・終了中）は `isError`。

### rm の範囲と判定の順序（`rmOne`）

1. 文字列の検査: NUL・絶対パス・`~`・drive 指定・バックスラッシュを拒否。
2. 範囲の決定: 自分の path（worker `workers/<id>/`、cap `caps/<id>/`）。cap だけ `worker:<id>/<path>` で自分の worker（`logs/owner.json` の `cap_id` が自分）を指せる。他の cap の worker・存在しない worker・不正 id は拒否。worker の `worker:` 接頭辞は拒否。
3. 字面の正規化: 空と `.` を落とし、`..` が 1 つでもあれば拒否。何も残らない（`.`・空・`./`・`worker:w1`）= path そのもの → 拒否。
4. 先頭要素が `logs` / `state.json`（小文字化して比較）なら拒否。`./logs`・`logs/`・`LOGS`・`logs/../x`・`x/../logs`・`logs/mcp.json` が該当。
5. 親を `realpath` で解決し、範囲の `realpath` の中か確認。外なら拒否（親 symlink 経由の脱出）。解決後の相対 path の先頭要素にも 4 を再適用（自分の dir 内の別名 symlink → `logs/` を拒否）。
6. 対象を `lstat`（symlink は辿らない）。dir は `recursive: true` の時だけ。
7. 削除直前に `lstat` と親の `realpath` を取り直し、ino / dev / 親が 5・6 と同じか確認。違えば拒否。
8. 非 dir は `unlink`（symlink は link 自体）、dir は `rm({ recursive: true })`（node の rm は symlink を辿らない）。

### TOCTOU

7 で窓を狭めるだけで、7 と 8 の間の差し替えは原理的に残る（path ベースの API のため。fd ベースの `unlinkat` は node に無い）。残る場合の最悪は「範囲内に在った名前の親が、検査後に外を指す symlink に差し替わる」こと。cap / worker 自身の claude が同時に動いている時だけ起こりうる。

### 将来の action 追加

`HANDLERS` に `(ws, caller, args) => BashResult` を 1 つ足す。zod の `action` は文字列のままなので mcp.ts の変更は不要（入力の形が変わる action は schema を足す）。範囲の判定は `rmOne` の 1〜5 を関数として切り出して使い回す想定（今は rm だけなので切り出していない）。

### TMPDIR

- `agents.ts` の実行ループで、`runExtras`（clone などの準備）の後、`runner.run` の直前に毎回 `ensureTmpDir(dir)`。new でも resume でも、再試行でも作る。
- 無ければ mode 700 で作る（chmod で umask に左右されない）。在れば何もしない（mode を保つ）。symlink・file だった場合は外を指しうるので、それ自体を消して dir を作り直す。
- env は `{...process.env, ...session.env, TMPDIR}` の順。`session.env` で上書きできない。
- `tmp/` は `bash` の rm の範囲内（protected は `logs` と `state.json` のみ）。`tmp` 自体の削除は `recursive: true` で許可、無しの dir は拒否。
- worker の掃除（`removeNonKept`）は logs/ と state.json 以外を消すので、`tmp/` も消える（コード変更なし。test で固定）。
- clone 時に `.git/info/exclude` へ `tmp/` を追記（`git add -A` で tmp を拾わないため）。既存の clone には入らない。
- system prompt（`CAP_GUIDE` / `WORKER_GUIDE`、`docs/design/cap-orchestration.md`）に「一時物は作業 dir の中に置く。`$TMPDIR` を使い /tmp 直書きはしない。削除は Bash の rm でなく `mcp__bantou__bash` の rm」を追加。

## 変更点

- 新規: `server/utils/bantou/bash.ts`、test `bash.test.ts`（17）/ `tmpdir.test.ts`（6）。
- 変更: `mcp.ts`（tool 登録）、`daemon.ts`（workspace 設定・allowedTools）、`agents.ts`（TMPDIR・exclude）、`paths.ts`（`ensureTmpDir`）、`prompts.ts`、README（tool 表・workspace レイアウト・exclude）、`docs/design/cap-orchestration.md`。
- 既存 test の更新: `mcp.test.ts`（tool 一覧に `bash`）、`cleanup.test.ts`（起動後の空 dir に `tmp/` が在る）。
- 変更なし: `docs/protocol.md`、protocol 版、version、bun.lock、center / desktop / memory。

## テスト結果

- `cd packages/server && npm test`: 337 tests / 337 pass / 0 fail。
- `npm run typecheck`: 6 error（`test/.../default-config.test.ts` の PathLike。develop 時点と同数・同内容。増減なし）。
- 一時 dir は test 専用（cwd 配下 / os tmpdir）。本物の workspace には触れていない。

## 残課題

- 7 と 8 の間の差し替え（上記 TOCTOU）は残る。
- 既存の clone の `.git/info/exclude` に `tmp/` は入らない（新規 clone のみ）。
- header（`x-bantou-cap-id` / `x-bantou-worker-id`）で呼び出し元を判定する既存方式のまま（認証は全体で後回し）。header を偽れる相手は他の cap / worker の path を指せる。
- 実機の claude での `mcp__bantou__bash` の許可・`TMPDIR` の効きは未確認（unit test と MCP 経由 test まで）。
