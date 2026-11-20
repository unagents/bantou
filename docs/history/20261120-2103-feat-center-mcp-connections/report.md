# feat/center-mcp-connections（M1: 接続の設定・鍵・command）

## 基点

- 基点: `e5a438e38763a12520fc3ac12b4ff445579816f6`（fix/center-mcp-redact の先頭 = M0。作業の終わりまで動いていない）。
- 設計: docs/mcp-connection-design の M1 の節・実装のまとまりの表・review の反映（R-01〜R-22）・実測の章。

## 変えた file（すべて packages/center）

| file | 内容 |
|---|---|
| `src/mcp-json-file.ts`（新） | 3 つの file の共通の読み書き（一時 file → rename、0600、dir は新規の時 0700、mtime/size/inode の cache、壊れた時は理由の種類だけ） |
| `src/mcp-secrets.ts`（新） | `mcp-secrets.json`（鍵の名前 → 値・rev・更新時刻）。値の検査（4096 文字まで、空白・制御・非 ASCII 不可） |
| `src/mcp-connections.ts`（新） | 接続の形（zod）・検査・合成（共通 + session の項目ごとの上書き、null で外す）・`mcp-connections.json` の読み込み・見える道具名（前置き・絞り込み・memory の `event` 隠し）・設定の hash |
| `src/mcp-status.ts`（新） | `mcp-status.json`（分類・道具の数・見える名前・設定の hash・先の一覧の写し 1 MB まで） |
| `src/mcp-probe.ts`（新） | 「試す」の本体（MCP の SDK の client。initialize → tools/list をページを辿って。道具は呼ばない） |
| `src/mcp-cli.ts`（新） | `bantou-center mcp list/get/set/unset/secret/test` |
| `src/cli.ts` | `mcp` の分岐を足しただけ |
| `src/project-settings.ts` | `memoryUrlSchema` に `export` を付けただけ（URL の検査を再利用） |
| `README.md` | 「MCP の接続の設定」の節 |
| `test/mcp-connections.test.ts`（新）・`test/helpers/fake-relay.ts`（新） | test と偽の中継 |

触っていない物: `wrapper.ts`・`remote-control.ts`・`memory-events.ts`・`memory.ts`・`memory-settings.ts`・session / 画面 / web / master-cap の道具、protocol・server・Rust・packages/memory。

## command の使い方

README の節に同じ内容がある。要点:

- `bantou-center mcp set <名前> --url <URL> [--secret <鍵の名前>] [--auth-header H] [--auth-format "Bearer {secret}"] [--header N=V]... [--identity-header H] [--tool-prefix P] [--allow T]... [--deny T]... [--role memory] [--session S] [--off]`
- `printf %s "$KEY" | bantou-center mcp secret set <鍵の名前> --stdin`（または `--file <path>`）。引数に鍵を書くと値を出さずに断る。
- `bantou-center mcp test <名前> [--session S] [--json]`: 終了 code 0 = 取れた、1 = 取れない、2 = 使い方の誤り。結果は `mcp-status.json` に残す。

## 判断

- 新しい接続を作る時、`transport: "http"` は CLI が補う（利用者に書かせない）。
- `--secret` / `--auth-header` / `--auth-format` のどれかを付けると `auth` ができる。`--secret` を省くと鍵の名前は接続の名前（設計の既定どおり）。session の `set` は、その session で有効な合成後の値を元に、触った入れ子の項目を丸ごと上書きに書く（設計の「入れ子は丸ごと置き換え」）。
- `set` の全体の検査は「今までに無かった問題」だけで断る（既存の別の問題で無関係な `set` が止まらないように）。ただし file 自体が壊れている・一部の項目が捨てられた時は、書き込み系の command は断る（壊れた内容を上書きして消さないため）。
- 共通の接続を `unset` する時、session の上書きが残っていれば断る（上書きだけ残ると不完全な定義になるため）。`unset` は鍵を消さない（`secret unset` で別に消す。設計は `memory unset` だけ「他の接続が使っていなければ消す」と書いており、`mcp unset` の鍵の扱いは書いていなかった）。
- 5xx は `unreachable` に分類（設計の分類に 5xx の行き先が無かったため。gateway が落ちている事が多い）。それ以外の 4xx（401 / 403 以外、404 以外）と MCP として読めない応答は `protocol`。鍵が未設定の `auth` 付き接続は、接続せずに `config-error`。
- 「試す」の識別の値: `--session` の値、無ければ `bantou-center-test`。接続に `identity.value` があればそれを優先する（設計の 5.2 は session の値としか書いていない。`identity.value` は合成後の session の上書きで入る agent の ID なので、そちらが実際に使われる値と一致する）。
- http: の公の host の判定は設計の列挙（loopback・RFC 1918・ULA・link-local・`localhost`）だけ。host 名だけの LAN 内の名前は「公」として扱い、`--allow-plain-http` が要る（保存はされない。set の時の確認だけ）。
- `mcp-status.json` の key は `<scope>/<名前>`（scope = `common` か session 名）。

## 設計書・指示との食い違い

- 設計は `test` の `mcp-status.json` に「道具の一覧の写し（1 MB まで）」を求めている。実装した（`toolsCopy`）。口が返す側（M3）は未実装。
- 設計の「`--expose-memory-write`」は `--no-expose-memory-write` も足した（外す手段が無かったため）。`--no-tool-prefix`・`--allow-plain-http` も同様に足した（設計の usage に無いが、設計の本文が要求する動き）。
- 設計の 5.1 の `memory` command の読み替え（`bantou-center memory` → `mcp`）は M4 なのでしていない。`bantou-center memory` の動きは変えていない。
- 設計は「表示の文に、次の起動から効く物と次の呼び出しから効く物の違いを書く」とあるが、M1 は session にも書き込みにも使われないので、代わりに「この版は使わない」旨を `set` の出力・usage・README に書いた（役割 `memory` の時は設計が指定した文意）。
- 指示にあった `mcp_connections_status` や `assertCenterOnly` の変更は M0 / M5 の範囲で、この branch では触っていない。

## 確認

- `packages/protocol` を `tsc` で build 済み。`packages/center` の `tsc --noEmit`: 0 件。
- `node --import tsx --test test/*.test.ts`（packages/center 全体）: 703 件、702 pass、1 fail。落ちたのは既知の不安定 test「center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される」だけ（指示で既知の不安定とされた test。M1 の変更は触っていない所）。
- 新しい test は 24 件（`test/mcp-connections.test.ts`）、すべて pass。内訳: 検証 9（予約の名前、形の崩れた URL、鍵付きの平文の http、`{secret}` の数、固定の header、役割 memory の重複、入力値を含まない誤りの文、合成、見える道具）、設定・鍵の往復と権限 3、鍵が出ない 3（引数の拒否、不正な鍵、全出力 + 状態 file の検索）、試す 9（3 つの鍵の形 + ページ、401、403/404/503/壊れた応答/落ちている/遅い、config-error、使い方の誤り、識別の header と `event` を呼ばない、session の上書き）。
- 偽の中継: `test/helpers/fake-relay.ts`（127.0.0.1 の空き port だけ。鍵の header 名と形の切り替え、受けた header の記録、drop / 401 / 403 / 404 / 503 / 遅い / 壊れた応答、ページ、道具の呼び出しの記録）。実の中継・実の外部記憶には接続していない。

## 変異の確認（入れて落ちる事を確かめて戻した）

| 変異 | 落ちた test |
|---|---|
| `get` / `list` の鍵の状態の表示に鍵の値を足す | 往復、全出力の検索（2 件） |
| 401 の分類を外す（`auth` → `protocol`） | 「鍵が違うと auth」 |
| file の mode を 0644 に | 「file は 0600」 |
| 役割 memory の重複検査を外す | 「役割 memory は 1 つまで」と入力値を含まない文の test |

戻した後の `git status` は変異の痕跡なし。

## 気づいた事

- `--value` などの拒否は、`REFUSED` に当たらなくても「不明な引数」で断られるので、値は出ない（二重の防御）。
- `bun install` の後、per-package の `node_modules` に `.bin` ができる形だった（root の `node_modules/.bin` は無い）。`tsc` は `packages/*/node_modules/.bin/tsc` を直接呼んで確認した。
