# packages/ 配置への統一

branch: `refactor/packages-layout`（base: develop `42ee71f`）。commit は 2 つ（1: `git mv` のみ、2: path 修正と workspace 化）+ この report。

## 最終の配置

```
packages/desktop   （Tauri + Nuxt。package 名は bantou-desktop に変更）
packages/server    （npm の bantou。version 0.4.0 のまま）
packages/center    （そのまま）
packages/protocol  （そのまま）
packages/pty-wrapper（そのまま）
packages/plugin    （plugin/bantou）
docs/ README.md CLAUDE.md LICENSE package.json bun.lock は root
```

## workspaces と server の依存

- root `workspaces`: `["packages/*"]`。server も入る。
- server の protocol 依存: `file:../packages/protocol` → `"^0.2.0"`（devDependencies のまま）。
  - 比較した案: (A) `workspace:*`、(B) 通常の semver（`^0.2.0`）、(C) `file:../protocol` のまま。
  - (A) は npm が `workspace:` を解釈できず、`npm pack` が package.json をそのまま tgz に入れる。bun 専用で npm と辻褄が合わない。
  - (C) は bun が workspace 化せず、protocol の dist を写した別コピーを使う（center が今この状態）。
  - (B) は bun も npm も、名前と版が合う workspace package にリンクする。bun は `packages/server/node_modules/@agent-hand/bantou-protocol -> ../../../protocol`（リンク）を作り、protocol の dist 更新が即反映される。採用。
  - protocol は devDependency なので publish した package の runtime 依存には出ない。同梱は従来通り `files` の `protocol/`（`scripts/copy-protocol.mjs` が `packages/protocol/messenger/` をコピー）。壊していない。
- center の `file:../protocol` は触っていない（依頼外）。bun.lock では center だけ protocol の写しを持つ。protocol を直したら `bun install --force` が要る点は従来通り。

### bun と npm の辻褄で見つかった点

1. desktop と server が同じ package 名 `bantou` で、bun が `Workspace name "bantou" already exists` で install を拒否した。server は npm 名なので変えず、private の desktop を `bantou-desktop` に改名した（`packages/desktop/package.json` の name のみ。参照箇所は grep で無し。Cargo の crate 名 `bantou`、tauri の productName は別物で不変）。
2. bun の既定は isolated linker で、server の test が直接 import する `h3` が（nuxt の依存として）見えず、`mcp.test.ts` と `model.test.ts` が `ERR_MODULE_NOT_FOUND` で落ちた（185 件中 2 ファイル fail）。server が直接 import しているので `h3: ^1.15.11`（解決済みは 1.15.11）を devDependencies に足した。bunfig で hoisted にする案は全 package に波及するので採らなかった。
3. bun の workspace 下では `npm install` が `Cannot read properties of null (reading 'name')` で失敗する（実測）。server の依存は root の `bun install` が入れるので、`npm install` は不要。`release.sh` と `packages/server/README.md` の `npm install` を外した。`npm test` / `npm run build` / `npm pack` / `npm publish` はそのまま動く。
4. bun.lock の workspace key は `desktop` → `packages/desktop`。release.sh の bun.lock 書き換え awk の正規表現もこれに合わせた。bun.lock は旧 lock が実 package.json とずれていたため（center 0.1.0→0.2.0、xterm の範囲）、`bun install` で再生成され、その差分も入っている。

## npm pack / publish の確認

- `npm pack --dry-run` と実 pack: `bantou-0.4.0.tgz`（1.5 MB、515 files）。`package/protocol/{protocol.json,PROTOCOL.md}`、`package/bin/*`、`.output` を含む。
- 別 dir（worker 作業 dir 内の `tmp-verify/inst`）で `npm install <tgz>` → `node_modules/.bin/bantou --version` が `0.4.0`、`--help` が usage を出す。`node_modules/bantou/protocol/` に 2 file。
- 比較用の旧配置での pack は取っていない（tgz の中身が protocol/bin/.output を含むことで確認）。

## 直した path

- `packages/desktop/scripts/release.sh`: clone 後の `packages/desktop/…`（package.json、src-tauri、Cargo.toml/lock、Casks、scripts）、`packages/server/package.json`、`(cd packages/server && …)`、bun.lock の awk、server の `npm install` を削除、Usage 行、コメント。
- `packages/desktop/scripts/publish-cask.sh`: コメントの正本 path（`REPO_ROOT` は相対なので変更なし）。
- `packages/desktop/scripts/make-latest-json.sh`: path 直書きなし。変更なし。
- `packages/desktop/scripts/build-sidecar.ts`: `packagesDir` を `join(desktopDir, "..")` に、server の package.json 参照、エラー文言。
- `packages/center/src/pair.ts` と `test/pair.test.ts`: `../../../server/package.json` → `../../server/package.json`、コメント。
- `packages/center/scripts/e2e.ts`: 直書きの `serverDir`（`…/develop/server` → `…/develop/packages/server`）。
- `packages/server/scripts/copy-protocol.mjs`: `../../packages/protocol/messenger/` → `../../protocol/messenger/`。
- `packages/server/test/…/{daemon,protocol-registration,update-flow}.test.ts`: `../../../../../packages/protocol/…` → `../../../../../protocol/…`。
- `packages/server/package.json`: `repository.directory`（`packages/server`）、protocol 依存、h3。
- `packages/server/bin/bantou.mjs`: コメントのみ。
- docs: root `CLAUDE.md`（Map、役割分離、資料ポインタ、publish 方針、注意。workspace と package 名の注意を 2 行追記）、root `README.md`、`docs/architecture.md`、`docs/handoff.md`、`packages/desktop/CLAUDE.md`（rsync・ssh・scp・release.sh の呼び出し path）、`packages/desktop/README.md`、`packages/server/README.md`（相対リンク `../../docs/…`、開発手順）、`packages/center/README.md`、`packages/protocol/README.md`。

## 残した path とその理由

- `packages/desktop/src-tauri/tauri.conf.json` の `beforeBuildCommand`（`bun run build:sidecar && bun run generate`）: desktop dir 基準の相対コマンドで path を含まない。変更不要。`frontendDist` `../.output/public` も desktop 内で完結。
- `packages/desktop/CLAUDE.md` の `work/bantou-mono/`（mac200 の clone 先名）: 配置が変わっても mac200 側の dir 名は変わらない。その下の path だけ直した。
- `packages/server/server/utils/…`、test の `../../../../server/utils/…`、README の `server/utils/bantou/`・`server/plugins/…`: Nuxt の server dir（`packages/server/server/`）で、package 内の相対。移動の影響なし。
- `docs/architecture.md` の `server/utils/stroke/claude.ts`: 外部 repo（Gitea `grrowapp/stroke`）の path。
- `docs/handoff.md` の `~/work/desktop/bantou`: 過去の作業 dir の記録。
- `packages/center/README.md` の `../protocol/messenger/…`、`../../docs/protocol.md`: packages/center からの相対で、移動後も正しい。
- `packages/protocol/messenger` 等の `packages/…` 表記: 元から packages 配下。
- `docs/history/` と `packages/server/docs/history/` の過去 report: 履歴なので書き換えない（`packages/server/docs/history` は server の history で、git mv で packages/server 配下に移っただけ）。
- `packages/desktop/src/` 内の `desktop/` `server/` 風の文字列: grep で該当なし。
- Cargo の crate 名 `bantou`（Cargo.toml、release.sh の awk `name = "bantou"`）: Rust 側の名前で npm の package 名とは別。
- GitHub workflows は `.github/` が無いので対象なし。center が plugin/ を session に配る path は center/server の src に無し。`.gitignore` は各 package 内のみで root は path 参照なし（変更なし）。tsconfig / vitest / playwright の config は package 内相対のみで変更なし。

## テスト（repo root で `bun install` → `packages/protocol` で `npm run build` → `bun install --force`）

- protocol: `npm test` 23 件 通過 / 失敗 0
- center: `bun run test` 269 件 通過 / 失敗 0。`bun run typecheck` エラーなし
- server: `npm test` 202 件 通過 / 失敗 0（以前の report の 202 と同数）。`npm run typecheck` エラーなし
- desktop: `bun run build:sidecar` 成功（center の compile、pty-wrapper の cargo build、`src-tauri/binaries/` に 2 つ）。`src-tauri` で `cargo test` 245 件 通過 / 失敗 0 / ignored 5
- desktop e2e: `bun run generate` の静的ビルドを簡易静的サーバー（port 1420）で配信し、`ms-playwright/chromium-1243` を一時 config で指定。77 件 通過 / 失敗 0
- 新規 clone した branch でも、`bun install` → protocol build → `bun install` → `packages/server` で `npm test` 202 件 通過。bun.lock は変化なし（release.sh の `git checkout -- bun.lock` 後の状態と同じ）。
- `release.sh`: 署名鍵が無く実行不可。`bash -n` で release.sh・publish-cask.sh・make-latest-json.sh の構文 OK。clone 後に参照する path（`packages/desktop/{package.json,src-tauri/Cargo.toml,src-tauri/Cargo.lock,scripts/make-latest-json.sh,scripts/publish-cask.sh,Casks/bantou.rb}`、`packages/server/package.json`、`packages/protocol`、`packages/center/src/cli.ts`、`packages/pty-wrapper`、`bun.lock`）が新配置に存在することを `ls` で確認。bun.lock に `"packages/desktop": {` が 1 つあることも確認。実行 bit も保持。

## merge 後に人手で要る作業

- mac200 の `work/bantou-mono` を rsync し直す（`packages/desktop/CLAUDE.md` の手順 1）。`--delete` は `--exclude node_modules --exclude target` の除外 file を消さないため、旧 `desktop/`（node_modules と src-tauri/target）など、除外 file を含む旧 dir が残る（推測。mac200 で `ls` して確認する）。確認の上で手で消す。`packages/desktop/src-tauri/target` は新位置で cargo の初回フルビルドになる。
- release.sh の呼び出し path を `work/bantou-mono/desktop/scripts/release.sh` から `work/bantou-mono/packages/desktop/scripts/release.sh` に変える。clone 後の中身は release.sh が新配置で処理する。
- 初回 release の dry-run（`release.sh --dry-run <ver>`）を mac200 で確認する。署名と npm publish 周りはここでは未検証。
- server の npm 版（0.4.0 が npm に無ければ release.sh が publish する）。version は上げていない。
- center の protocol 依存を workspace 化するかは未決（今回は触っていない）。

## 後始末と残存物

- worker 作業 dir の `tmp-verify/`（pack した tgz、別 dir への install、検証用 clone、一時 playwright config、静的サーバー）は `find … -delete` で削除。静的サーバー（port 1420）は停止。
- 一時 config は commit していない。clone 内の生成物（`node_modules`、`.nuxt`、`.output`、`src-tauri/binaries`、`src-tauri/target`）は `.gitignore` 対象で commit していない。clone `bantou/` は worker 作業 dir に残す。
