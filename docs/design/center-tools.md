# center の tool 仕様案（ドラフト、2026-10-29）

## 前提（ユーザー確定）

- ユーザーは番頭（bantou）と話し、番頭が全部を切り盛りする。PM（master-cap）を用意するのは番頭。
- master-cap は `claude remote-control` で center 上に起動する。製造はせず指示だけ出す。
- remote-cap は master-cap と本質的に一体。path や server が問題になるのは remote-cap が worker を起動する時から。
- center の tool は 2 種類: (A) 番頭が使う、center 上の session（master-cap）の起動・削除。(B) center が master-cap に持たせる、remote session（remote-cap）の起動・削除の道具。中身は protocol `bantou` で server に指示を送る。前提は `docs/concept.md`。

## A. center 上の session（番頭が使う）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `session_create` | `name`（必須、英数 `_-`）、`path`（省略時 `<workspace>/<name>`、無ければ作る）、`permissionMode`（省略時 `auto`） | `{name, path, state, sessionUrl}` | `claude remote-control --name <name>` を path で起動し、監視対象に加える。center 再起動後も復帰（`--continue`） |
| `session_delete` | `name` | `{name, deleted}` | remote-control を停止し、監視対象から外す。path は消さない |
| `session_list` | なし | `[{name, path, state, pid, sessionUrl, startedAt}]` | 今の `rc_list` 相当 |

- 今の `rc_start` / `rc_stop` / `rc_list` / `rc_status`（config の projects 固定）は A に置き換える。
- 起動した session の一覧は center が自前で保存し、center 再起動時に復帰させる（config の projects には書かない）。

## B. remote session（center が master-cap に持たせる道具）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `remote_create` | `prompt`（必須、最初の指示）、`server`（省略時は自動選択）、`repo` / `branch`（任意） | `{remote_id, server, state}` | server に remote-cap を作らせ、最初の指示で起動する |
| `remote_delete` | `remote_id` | `{remote_id, deleted}` | remote-cap と配下の実行を止め、server の state から外す |
| `remote_list` | なし | `[{remote_id, server, state, owner}]` | 呼んだ master-cap が作った remote session の一覧 |

- 今の `cap_kick`（prompt を渡して結果を待つ）は「既存の remote-cap に指示を送る」操作として残すか、`remote_send` に改めるかは未決。
- `server_list` / `server_status` / `worker_resume` の扱いも未決。

## 未決・確認したい点

1. B を呼んだ master-cap を center がどう識別するか（`owner`）。候補: MCP 接続の header に session 名を入れる、引数で渡す。
2. `remote_create` の server 自動選択の規則（今は protocol `bantou` で見つかった先頭）。指定は許すか。
3. `remote_delete` に server 側の対応（停止と state 削除）が要る。今の server に削除の命令は無い。
4. `session_delete` で path を消すかどうか（案では消さない）。
