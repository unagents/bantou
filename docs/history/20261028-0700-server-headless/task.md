# 指示書: bantou-server を stroke 方式の headless 実行層へ転換（204）

- 日付: 2026-10-28
- 発行: main cap（Mac）
- 宛先: 204 の remote cap（tmux `wcap-bantou`、cwd `/home/vagrant/work/bantou/develop`）
- 置き場: `docs/history/20261028-0700-server-headless/task.md`

## お前の立場

前回と同じ。remote cap として worker（Agent ツールのサブエージェント、実装は `sonnet`、調査は `opus`、`model` 明示）に委譲して統括。質問するな。迷う点は推奨案で進め、報告書に「判断した点」として残せ。

## 背景

`docs/architecture.md`（同時に置いた。先に読め）が確定事項。要点:
- 人が tmux に attach する運用は無い。server は tmux を使わない。全エージェントは headless（`claude -p`）
- server は stroke 方式（Gitea `grrowapp/stroke` の `server/utils/stroke/`）を発展させる。`runClaude`（claude.ts）は単独 import 可。`ai.ts` / `invoke.ts` / `running.ts` / `reap*.ts` / `live-processes.ts` も参考にする。clone は `/home/vagrant/work/bantou/` 配下に一時的に置き、終わったら削除
- claudep（Agent SDK `query()`）方式は今回は interface だけ用意し、実装しない
- server を Nuxt（Nitro）へ寄せる件は大枠合意済みだが、今回の指示の範囲外。素の TypeScript のまま進める（Nuxt 化は次の指示）

## 目的

今の tmux 起動を捨て、kick を受けて headless の remote cap を起動し、cap の返答で worker を resume 継続できる実行層にする。

## 要件

1. tmux 依存の削除: `session.ts` の tmux 起動・一覧を削除。`launch_session` / `list_sessions` は廃止し、下記コマンドに置き換える。protocol の型（`packages/protocol/src/server.ts`）も合わせて更新する。
2. path 分離: cap ごとに `<workspace>/caps/<cap-id>/` を作る。`cap-id` は `[A-Za-z0-9_-]`。`repo` 指定があれば clone（既存なら fetch）。worker 用は `<workspace>/workers/<worker-id>/`（同様）。
3. headless 起動: `runClaude` 相当を移植する（`spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", "--session-id"|"--resume", id, "--", prompt])`、cwd は該当 path、stdout の最終 result エンベロープで success / error 判定、timeout で SIGKILL、`No conversation found with session ID` の検知）。permission mode は config `session.permissionMode`（既定 `auto`）。`--allowedTools` 等の制限は config で渡せるようにし、既定は制限なし。
4. コマンド（messenger 経由、text は JSON、`bantou: 1`）:
   - `kick_cap`: `{ cap_id, repo?, branch?, prompt, reason? }`。cap の path を用意し、state.json に session_id が無ければ `--session-id <新 UUID>`、あれば `--resume` で起動。同じ cap への kick は直列化（キュー）。結果を送信元へ `cap_result` `{ cap_id, session_id, ok, result_text, error? }` で返す。
   - `resume_worker`: `{ worker_id, prompt }`。worker の path と state.json の session_id で `--resume` 起動（session_id 無しなら `--session-id` で新規）。結果を `worker_result` で返す。
   - `status`: cap / worker の一覧（path、session_id、state、最終実行時刻）を返す。
5. state: `<path>/state.json` に `{ session_id, state: idle|running|failed|error, last_started_at, last_finished_at, last_error?, retries }` を原子的に書く（temp → rename）。
6. 孤児回収: 起動時に `ps` の argv 照合で自分が起動したはずの `claude -p` を見つけたら SIGKILL し、該当 state を `failed` にする（stroke の reap の考え方）。
7. retry は最小: timeout / 起動失敗で 1 回だけ再試行（config `session.maxRetries`、既定 1）。
8. 既存の broker 内蔵・peer 登録・SIGTERM 終了・ログ形式は維持。`bind` 既定は `127.0.0.1` に変更し、LAN 公開は config で明示（前回のレビュー指摘の対応）。
9. テスト:
   - unit: コマンドの型ガード、state.json の読み書き、path 検証、ps 照合のマッチ関数。
   - e2e（`npm run e2e`、204 で実行）: 内蔵 broker（port 0、bind 127.0.0.1、discovery off）で server を起動 → `kick_cap` を送る（prompt は「`echo kicked` を実行して結果を 1 行で返せ」程度の軽いもの） → `cap_result` に ok と result_text が返ること、`state.json` に session_id が入ることを確認 → 同じ cap に 2 回目の kick（`--resume` 経路）→ `resume_worker` を 1 回 → `status` → SIGTERM で exit 0。一時物は削除。実際に claude を起動するので、`claudeAgent` の claude ログインを使う。
10. README 更新: 実行モデル（architecture.md の要約）、コマンドと返信の形、config 全項目、e2e 手順。
11. commit は英語の通常文、`origin develop` へ push。`docs/architecture.md` と本指示書も同じ commit か先行 commit に含める。

## 禁止

- tmux の使用。`desktop/`、`plugin/`、`docs/`（`architecture.md` と history 以外）の変更。
- LAN の本番 broker への登録・送信。e2e は内蔵 broker のみ。
- `claude remote-control`（server mode）の起動。これは center の担当。
- sudo、systemd、/etc、python。
- ユーザーへの質問。

## 完了条件

- `cd server && npm run typecheck && npm run build && npm test` と `packages/protocol` の同コマンドが通る。
- e2e が 204 で通り、ログ抜粋が報告書にある。
- develop に push 済み。

## 報告

- `docs/history/20261028-0700-server-headless/report.md`（commit して push）。必須: 変更ファイル一覧、コマンド結果、e2e ログ抜粋、commit hash、判断した点、範囲外の問題。
- 報告後、次の指示まで待機。
