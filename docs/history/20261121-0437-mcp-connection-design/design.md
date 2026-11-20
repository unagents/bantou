# center の MCP の接続（設計）

2026-11-21。設計のみ（code は変えない）。基点は origin/develop の 2009f18。未 merge の `fix/memory-setting-center-only`（4c51914 / f0245b0 / 9f57726）が develop に入った後の状態を前提にする。

## 0. 要件と結論

要件（利用者の指摘）:

- 外部記憶（memory）の操作は MCP の道具で行う前提なのに、center が「MCP の道具への接続の仕方」を設定として持っていない。
- MCP の中継（1 つの URL の先に複数の MCP の server が並び、鍵 1 本で通る物。以下「中継」）への接続（URL と鍵）を、MCP の道具の設定として仕様に取り込む。
- 画面（desktop / web）が知るのは center への経路だけ。center の内側の運用の設定、とくに秘密の値は center の側だけで扱う。

結論（推奨で進める前提）:

1. center は **「MCP の接続」の一覧**を設定として持つ（`mcp-connections.json`）。1 件 = 名前・種類（HTTP。stdio は形だけ決めて後回し）・URL・鍵を載せる header の名前と値の形・秘密でない固定の header・道具の絞り込み・道具名の前置き・役割（`memory` など）。全 session 共通と session ごと（上書き・無効化）を持つ。
2. 外部記憶は **役割 `memory` を持つ接続の 1 つ**にする。中継経由でも直結でも同じ形（URL・header・前置きが違うだけ）。center 自身の書き込み（MCP の client）も同じ接続を使う。agent の ID は接続の「識別の header」に center が載せる。
3. 鍵は設定の file に書かず、別の **`mcp-secrets.json`（mode 0600、状態 dir は 0700）**に置く。入れるのは center の command だけ（標準入力か file）。
4. session には鍵を渡さない。session は **center の中継の口（`/mcp/conn/<名前>`）**につなぎ、center が鍵と agent の ID を付けて先へ送る（分かれ目 1）。鍵の入れ替えは動いている session にも次の呼び出しから効く。
5. 設定の口は center の command（`bantou-center mcp list|get|set|unset|secret|test`）だけ。画面と session からは書けない。画面に見せるのは「名前・役割・設定済みか・つながるか（最後に試した結果）」だけ。
6. いまの `bantou-center memory get|set|unset` は残し、内部で「名前 `memory`・役割 `memory` の接続」に読み替える。`memory-settings.json` は center の起動時に新しい形へ移す。
7. `messenger`（`bantou-messenger`）と `bantou` の 2 つは center が自分で組み立てる物で、この設定の対象にしない。

## 1. 現状（事実。file:行は fix/memory-setting-center-only の版）

### session に渡す MCP

- `--mcp-config` は `mcpConfigJson` が組み立てる（`packages/center/src/wrapper.ts:71-98`）。entry は 3 つ:
  - `bantou-messenger`: stdio。`npx -y @unagents/messenger@<版> mcp`（`wrapper.ts:73-79`）。
  - `bantou`: http。center の session 向けの口（`/mcp/session`）。`Authorization: Bearer ${BANTOU_SESSION_TOKEN}` と `X-Bantou-Session`（`wrapper.ts:80-86`）。center が http で待ち受けていない時は付けない（`daemon.ts:64-70`）。
  - `memory`: http。外部記憶の URL を直接指す。token があれば `Authorization: Bearer ${BANTOU_MEMORY_TOKEN}`、`X-Agent-Id` は agentId か session 名（`wrapper.ts:87-96`）。
- token の実値は env で渡す（`remote-control.ts:514-517`）。`--mcp-config` には `${…}` の参照だけが入り、claude が env から展開する。
- `--strict-mcp-config` は付けていない（`wrapper.ts:140-157`）。利用者の個人の設定（user / project の scope）の MCP の server も session に載る。
- 許可は `--settings` の `permissions.allow` に `mcp__bantou-messenger__*`・`mcp__bantou__*`・`mcp__memory__*`（`wrapper.ts:110-116`、`remote-control.ts:499`）。
- status と log に出す引数は `--append-system-prompt` だけ伏せる（`remote-control.ts:86-90`、`522`、`555`）。`--mcp-config` の JSON（外部記憶の URL・header の名前・agent の ID）はそのまま status の `args` と center の log に載る。token は `${…}` の参照なので載らない。
- 外部記憶の使い方の指示（system-instructions の部品 `memory@1`）は `mcp__memory__*` の名前を固定で書く（`system-instructions.ts:155-168`）。

### 外部記憶の設定（fix branch の後）

- 保存先は状態 dir の `memory-settings.json`（mode 0600、`common` と `sessions`。session の値があれば共通は使わない）（`memory-settings.ts:14-29`、`84-89`）。
- 書くのは CLI `bantou-center memory get|set|unset` だけ。token は `--token-stdin` か `--token-file`、`--token` は断る（`memory-settings.ts:100-105`、`154`）。表示は URL の origin + path だけ、token は「設定済み / なし」（`memory-settings.ts:116-126`）。
- MCP（画面・web・master-cap）からの更新に `memory` があれば断る（`project-settings.ts:127-134`、`tools.ts:104`、`147`、`170`、`sessions.ts:294`、`326`、`360`）。web は center へ送る前にも断る（center-client `tool-policy.ts`）。
- center は session の起動のたびに読み直す（`remote-control.ts:461-470`）。session の改名・削除で設定を付け替える（`sessions.ts:199-209`、`443`、`493`）。旧形式からの移行あり（`sessions.ts:211-245`）。
- URL は http / https の絶対 URL、`${` と `user:pass@` は不可（`project-settings.ts:61-79`）。

### center 自身の書き込み

- `memory-events.ts` が hook と remote の往復を event にし、`memory.ts` のキューで送る。送り先は `MemoryTarget { url, token?, agentId }`（`memory.ts:37-41`、`memory-events.ts:79-88`）。
- MCP の client（Streamable HTTP）の header は `X-Agent-Id` と `Authorization: Bearer <token>` の固定（`memory.ts:332-334`）。呼ぶ道具の名前は `event` の固定（`memory.ts:361`）。
- 失敗は 1 秒から倍々で最大 60 秒の再試行、lane（宛先）ごとの上限を超えたら古い分から捨てる。`isError` は捨てる（`memory.ts:118-123`、`169-184`、`237`、`263-266`）。

### 外部記憶の service の認証と分離（packages/memory）

- `/mcp` への全 request で `Authorization: Bearer <MEMORY_TOKEN>`（定数時間比較）と `X-Agent-Id`（`[\w.@:-]{1,128}`）を検査する。どちらか欠ければ 401（`server/middleware/auth.ts:6-17`、`server/utils/auth.ts:27-36`）。
- 道具の側は **HTTP request ごとの header** から `x-agent-id` を読み直す（`server/utils/tools.ts:9-14`）。
- 読む範囲は認証済みの agent に絞る（SQL の条件 + Row Level Security。`server/utils/recall.ts:80-117`、`162-190`）。他 agent の指定は拒否（`recall.ts:82-83`、`164`）。
- 信頼の境界は token 1 本で、`X-Agent-Id` は自己申告（`packages/memory/README.md:153-155`）。token → 名乗れる agent の対応（`MEMORY_TOKENS`）は「Phase 2 の課題」として未実装。

### protocol

- `packages/protocol` は center と server（remote-cap）の間の約束で、版は `MESSENGER_PROTOCOL 1.8.1`（`protocol/src/server.ts:14`）。memory も MCP の接続も載っていない（grep で確認）。

## 2. 設定の形

### 2.1 保存先

| file | 中身 | 権限 | 書く物 |
|---|---|---|---|
| `<状態 dir>/mcp-connections.json` | 接続の一覧（秘密を含まない） | 0600 | center の command だけ |
| `<状態 dir>/mcp-secrets.json` | 鍵（名前 → 値） | 0600 | center の command だけ |
| `<状態 dir>/mcp-status.json` | 最後に試した結果・道具の一覧の写し（秘密を含まない） | 0600 | center の daemon と command |

- 状態 dir は config と同じ dir（今の `memory-settings.json` と同じ規則。`memory-settings.ts:166`）。作る時は 0700 にする。既にある dir の権限が広ければ log に警告を 1 行出す（直さない。利用者の dir を勝手に変えない）。
- 書き込みは一時 file → rename（今の `memory-settings.ts:83-90` と同じ）。
- center は使うたびに読む（mtime / size / inode が変わった時だけ読み直す。今の `memory-settings.ts:59-79` と同じ）。動いている間に command で変えてよい。

接続と鍵を別の file にする理由: 接続の file は「試す」の表示や不具合の調べで開かれやすい。鍵が同じ file にあると、中身を見せる・貼る・backup する時に一緒に出る。鍵の file は中身を見る理由が無い形にする。

### 2.2 接続の形（`mcp-connections.json`）

```json
{
  "version": 1,
  "common": {
    "memory": {
      "transport": "http",
      "url": "https://<中継>/mcp",
      "auth": { "header": "<鍵を載せる header 名>", "format": "Bearer {secret}", "secret": "relay" },
      "headers": { "<中継の server を選ぶ header 名>": "memory" },
      "identity": { "header": "X-Agent-Id" },
      "toolPrefix": "memory-",
      "tools": { "deny": ["event"] },
      "role": "memory"
    },
    "relay": {
      "transport": "http",
      "url": "https://<中継>/mcp",
      "auth": { "header": "<鍵を載せる header 名>", "format": "Bearer {secret}", "secret": "relay" },
      "tools": { "allow": ["search-*"] }
    }
  },
  "sessions": {
    "<session 名>": {
      "memory": { "identity": { "header": "X-Agent-Id", "value": "<agent の ID>" } },
      "relay": null
    }
  }
}
```

項目:

| 項目 | 型 | 意味 |
|---|---|---|
| 名前（key） | `[a-z0-9][a-z0-9_-]{0,31}` | session から見える entry 名（道具は `mcp__<名前>__<道具>`）。予約: `bantou`・`bantou-messenger`・`mcp`・`conn`（center が組み立てる物と、口の path と重なる物） |
| `transport` | `"http"`（`"stdio"` は形だけ予約） | 今回は HTTP（Streamable HTTP）だけ実装する。stdio は 2.6 |
| `url` | http / https の絶対 URL | 今の `memoryUrlSchema` と同じ検査（空白・制御文字・`${`・`user:pass@` 不可）。加えて query に鍵らしい名前（`key`・`token`・`secret`・`password`・`auth` を含む）があれば断る |
| `auth.header` | header 名（RFC 7230 の token 文字） | 鍵を載せる header。省略時は `Authorization` |
| `auth.format` | 文字列。`{secret}` をちょうど 1 つ含む | 値の形。`Bearer {secret}`（既定）、`{secret}`（そのまま）など。`${` は不可 |
| `auth.secret` | 鍵の名前 | `mcp-secrets.json` の key。省略時は接続の名前。複数の接続で 1 本の鍵を共有できる（中継の鍵 1 本で `memory` と `relay` を分ける時） |
| `auth` 自体を省く | | 鍵なしで接続する |
| `headers` | `{ 名前: 値 }`、10 個まで | 秘密でない固定の header（中継の server の選び方など）。`auth.header`・`identity.header`・`Cookie`・`Proxy-Authorization` と同じ名前は断る。名前に `key`・`token`・`secret`・`auth` を含む物も断る（秘密の置き間違いを防ぐ。秘密は `auth` に入れる） |
| `identity.header` | header 名 | center が session ごとの識別（agent の ID）を載せる header。省略すると載せない |
| `identity.value` | `[A-Za-z0-9_-]{1,64}` | 識別の値。省略時は session 名。session ごとの設定で上書きする（今の `agentId`） |
| `toolPrefix` | 文字列 | 先の server が道具名に付けている前置き（中継が `<server名>-` のように付ける物）。center はこれで道具を絞り、session に見せる時に剥がす（2.4） |
| `tools.allow` / `tools.deny` | 道具名の配列（末尾の `*` だけ許す）、各 50 個まで | 前置きを剥がした後の名前で書く。allow が無ければ全部、deny が勝つ |
| `role` | `"memory"` か省略 | 役割。`memory` は 1 つの session に 1 つだけ（3 章） |
| `timeoutMs` | 1000〜120000 | 先への 1 回の呼び出しの上限。既定 60000 |

全 session 共通と session ごと:

- `common` は全 session に付く。`sessions.<session>.<名前>` は同じ名前の共通の接続を**項目ごとに上書き**する（今の memory は「session の値があれば共通を丸ごと使わない」だが、`identity.value` だけ変えたい場合が多いので項目ごとにする。項目ごとの合成は 1 段（`auth` などの入れ子の中身は丸ごと置き換え）だけ）。
- `sessions.<session>.<名前>: null` はその session でその接続を付けない。
- session にしか無い名前は、その session だけに付く（完全な定義が要る）。
- session の改名・削除で `sessions` の key を付け替える・消す（今の `moveMemory`（`sessions.ts:199-209`）を接続の一覧に広げる）。

### 2.3 中継の先に複数の server が並ぶ場合

中継の作りによって、1 つの URL の先にある server の選び方と道具名の付き方が違う。設定で表せるのは次の 3 つで、どれも上の項目の組み合わせで書ける:

| 中継の作り | 設定の書き方 |
|---|---|
| URL の path で server を選ぶ | `url` を server ごとの path にする |
| header で server を選ぶ | `headers` に選ぶ header を書く |
| 全 server の道具が 1 つの一覧に並ぶ（道具名に server の前置きが付く） | `toolPrefix` で 1 つの server の分だけにする。前置きを付けずに全部を 1 つの接続として見せてもよい（`relay` の例） |

推奨: 外部記憶のように center が意味を持って使う server は、**それだけを指す接続を 1 つ作り、名前を役割に合わせる**（`memory`）。他の道具は別の接続（`relay` など）にまとめ、`tools.allow` で要る物だけ通す。同じ鍵を `auth.secret` で共有する。

### 2.4 session から見える道具の名前

- session の `--mcp-config` に載る entry 名は接続の名前（`memory`・`relay`）。道具は `mcp__<接続名>__<道具名>`。
- center の中継の口（4 章）は、先の道具名から `toolPrefix` を剥がして session に見せ、呼ばれた時に付け直して先へ送る。中継経由でも直結でも、外部記憶の道具は `mcp__memory__recall`・`mcp__memory__context` のまま変わらない。system-instructions の `memory@1` の文面（`system-instructions.ts:164-165`）を変えずに済む。
- 剥がした後の名前が 2 つ以上同じになる時（前置きの無い道具と前置きを剥がした道具が同名など）は、前置きの付いた方だけを見せ、log に 1 行出す。
- 剥がした後の名前は claude の道具名の規則に合う物だけ見せる（英数字と `_` `-`、64 文字以内。合わない物は見せずに log。規則の上限は claude の側の値で、確かめていない。実装の時に公式の docs で確かめる）。

### 2.5 道具の絞り込み

- 絞り込みは center の中継の口で行う（一覧から外す + 呼ばれても断る）。session の `permissions` に頼らない（permissions は利用者の設定と足し合わされ、permission の mode によって効き方が変わるため）。
- 役割 `memory` の接続は `tools.deny` に `event` を既定で入れる（書き込みは center が行う。session が偽の event を書けないようにする。`memory@1` の文面「自分では書き込みの tool を呼ばない」と同じ方針を道具の側でも守る）。外したい時だけ `tools.deny` を明示して上書きする。
- `--settings` の `permissions.allow` には `mcp__<接続名>__*` を入れる（絞り込みは口で済んでいるので、確認の問いを出さない）。

### 2.6 stdio の接続（今回は実装しない）

形だけ決める: `{ "transport": "stdio", "command": "...", "args": [...], "env": { "<名前>": { "secret": "<鍵の名前>" } } }`。center がその process を自分で起動し、中継の口から HTTP として見せる（session の process の下では動かさない。鍵が session の env に入らないようにするため）。cwd が session のフォルダであることを前提にする server とは相性が悪い。需要が出た時に別のまとまりで作る。

## 3. 外部記憶との関係

### 3.1 外部記憶 = 役割 `memory` の接続

- 外部記憶は「役割 `memory` を持つ接続」。その session で有効な接続のうち `role: "memory"` が 1 つあれば、その session に外部記憶がある（system-instructions の `ctx.memory` が真になる）。2 つ以上は設定の誤りとして `set` で断る（共通と session の合成後に検査する）。
- 直結: `url` = 外部記憶の service の `/mcp`、`auth` = `Authorization` / `Bearer {secret}`、`identity.header` = `X-Agent-Id`、`toolPrefix` なし。今の `memory` の設定と同じ意味になる。
- 中継経由: `url` = 中継、`auth` = 中継の鍵の header と形、`headers` / `toolPrefix` = 中継での外部記憶の選び方、`identity.header` = 中継が外部記憶へ渡す識別の header（3.3）。

### 3.2 center 自身の書き込み

- `memory-events.ts` の送り先を「session で有効な役割 `memory` の接続」から作る。`MemoryTarget` を `{ url, headers（鍵・固定の header・識別の header を組み立てた物）, toolName（`toolPrefix` + `event`）, key（lane と接続の再利用の key。鍵の値は含めず、鍵の版の番号を含める） }` に広げる。
- `memory.ts` の `createMcpEventSink` の header の組み立て（`memory.ts:332-334`）と道具名の固定（`361`）を外し、target から受ける。`keyOf`（`324`）は鍵そのものでなく鍵の版で区別する（log やデバッグの出力に key が出ても鍵が漏れない）。
- 書き込みは center の中継の口を通さず、center の process から先へ直接送る（同じ設定・同じ鍵を使う）。
- agent の ID は `identity.value`、無ければ session 名（今と同じ。`memory-events.ts:87`）。

### 3.3 中継を通した時の「agent ごとの分離」（packages/memory の code で確かめた事）

外部記憶は request ごとに次の 2 つを見る（1 章の事実）:

1. `Authorization: Bearer <MEMORY_TOKEN>` が一致する事。
2. `X-Agent-Id` があり、形が正しい事。道具はこの値で読む範囲を絞る（SQL + RLS）。

したがって、中継を通しても分離が保たれる条件は次のとおり（中継の作りに依る。特定の中継で確かめてはいない）:

- (A) 中継が、外部記憶へ送る request の `Authorization` を**中継の側に登録した外部記憶の鍵**に置き換える事（center の中継の鍵をそのまま流すと 401。中継の鍵と外部記憶の鍵を同じ値にする運用は、鍵 1 本の届く範囲がさらに広がるので勧めない）。
- (B) 中継が、client（center）から来た識別の header（`X-Agent-Id`）を**request ごとにそのまま**外部記憶へ渡す事。中継が header を落とすと全 request が 401 になる。中継が識別の header を固定値で付ける設定だと、全 session が 1 つの agent の記憶を共有し、分離は失われる。
- (C) 中継が先への接続（MCP の session）を複数の client で使い回す場合でも、HTTP request ごとに (B) の header が付く事。外部記憶は request ごとに header を読むので（`tools.ts:9-14`）、request に正しい値が付いていれば混ざらない。中継が接続を開いた時の header だけを使い回す作りだと、別の session の agent の ID で読み書きされる。

(A)〜(C) が満たされれば、分離の強さは今と同じ（「鍵を持つ者は任意の agent を名乗れる。分離は取り違えを防ぐ物」。`packages/memory/README.md:153-154`）。ただし鍵を持つ者の範囲は広がる: 外部記憶の鍵は中継が持ち、中継の鍵を持つ者は誰でも任意の agent を名乗って外部記憶に届く。

この設計で手当てする物と、足りない物:

- center の中継の口（4 章）は、識別の header を **center が付け、session から来た同名の header は捨てる**。同じ center の session どうしは、互いの agent を名乗れない（session は中継の鍵も外部記憶の鍵も持たないため）。
- 中継の鍵を持つ別の client（他の center・他の道具）が任意の agent を名乗る事は、この設計では防げない。防ぐには、名乗れる agent を鍵に結び付ける仕組みが要る。どちらか:
  - 中継の側: client の鍵ごとに、外部記憶へ渡す識別の header を中継が固定で付ける（client の申告を使わない）。中継がこの設定を持つ場合だけ使える。center の側では `identity.header` を省く。
  - 外部記憶の側: `MEMORY_TOKENS`（鍵 → 名乗れる agent の対応。README の Phase 2）に加え、中継が client ごとに別の鍵を外部記憶へ渡す形。中継が client の鍵ごとに先の鍵を変えられる場合だけ使える。
- 上の 2 つは運用と中継の作りに依るので、7 章のまとまり M6（任意）と 6 章の「運用の側に頼む事」に入れる。

## 4. 鍵の置き場と扱い

### 4.1 置き場

- `mcp-secrets.json`（0600）。形は `{ "version": 1, "secrets": { "<名前>": { "value": "<鍵>", "rev": <整数>, "updatedAt": "<時刻>" } } }`。`rev` は入れ替えのたびに 1 増やす（接続の再利用の key と表示に使う。値の代わり）。
- 同じ OS の user で動く process（session の Bash の道具を含む）は、権限 0600 でもこの file を読める。0600 で防げるのは別の user だけ。center と session は同じ user で動く（center が子として起動する）。これは 8 章の危険に書き、分かれ目 2 で扱う。

### 4.2 入れ方

```
bantou-center mcp secret set <名前> (--stdin | --file <path>) [--config <path>]
bantou-center mcp secret unset <名前> [--config <path>]
bantou-center mcp secret list [--config <path>]       # 名前・rev・更新時刻・使っている接続。値は出さない
```

- 値を引数に書かせない（`--value` などは「引数に書けない」と断る。今の `--token` の断り（`memory-settings.ts:154`）と同じ）。
- 末尾の改行 1 つを除く。空白・制御文字・非 ASCII は断る（今の `MEMORY_TOKEN_PATTERN` と同じ）。4096 文字まで。
- 誤りの文に入力値を含めない（項目名だけ。今の `memory-settings.ts:191-194` と同じ）。

### 4.3 session への渡し方

推奨（分かれ目 1 の b）: **session に鍵を渡さない**。

- session の `--mcp-config` に載る entry は、接続ごとに center の口を指す:
  `{ "type": "http", "url": "<center>/mcp/conn/<接続名>", "headers": { "Authorization": "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": "<session>" } }`
  （今の `bantou` の entry と同じ認証。session ごとの使い捨ての token（`session-auth.ts`）を使う）
- session の env に入るのは今と同じ `BANTOU_SESSION_TOKEN` だけ。中継の鍵・外部記憶の鍵は env にも `--mcp-config` にも process の引数にも出ない。
- 今の `BANTOU_MEMORY_TOKEN`（`wrapper.ts:60`、`remote-control.ts:516-517`）は廃止し、継承分も消す（`delete env[...]` は残す）。
- center が http で待ち受けていない時（`sessionMcpUrl()` が null、`daemon.ts:64-70`）は、接続を session に付けない（今の `bantou` の entry と同じ扱い。log に 1 行）。

### 4.4 表示・log・error・画面への応答

- command の表示: URL は今の `displayUrl`（origin + path。query と fragment は伏せる）、鍵は「設定済み（rev N）/ なし」、固定の header は名前だけ（値は出さない。秘密でない前提だが念のため）、識別の値は出す（agent の ID は秘密でない）。
- log: 接続名・結果の種類（下の分類）・HTTP の status の数字だけ。URL・header の値・鍵・道具の引数と結果の本文は出さない。
- error: 先から返った error の文をそのまま session や画面へ返さない。分類して返す: `unreachable`（名前解決・接続の失敗）・`timeout`・`auth`（401 / 403）・`not-found`（404）・`protocol`（MCP として読めない）・`tool-error`（道具が `isError` を返した。道具の結果の本文は session には返す。道具の結果は道具の利用者の物なので）・`refused`（絞り込みで断った）。SDK の例外の message は URL を含みうるので使わない。
- status の `args`: `--mcp-config` の値も `<mcp: bantou-messenger, bantou, memory, relay>` のように entry 名だけに伏せる（`redactAppendSystemPrompt` と同じ所で）。center の口の URL しか入らなくなるが、画面が center の内側の構成（どの接続があるか以外）を知る必要は無い。
- 画面への応答: 5.3 の項目だけ。

### 4.5 入れ替え（鍵の更新）

手順（運用の側と組む。6.2）:

1. 中継の側で新しい鍵を発行し、古い鍵と両方が通る期間を作る。
2. `bantou-center mcp secret set <名前> --stdin` で新しい鍵を入れる（rev が増える）。
3. `bantou-center mcp test <接続名>` で新しい鍵で道具の一覧が取れる事を確かめる。
4. 中継の側で古い鍵を止める。

動いている session への効き方:

- center の口（推奨の形）: 口は呼び出しのたびに鍵の file を読み（mtime の cache）、rev が変われば先への接続を閉じて新しい鍵で開き直す。**動いている session にも次の呼び出しから効く**（session の再起動は要らない）。session が持つのは center の口への token だけで、それは変わらない。
- center の書き込み: target の key に rev が入るので、次の送信から新しい鍵の接続になる。古い鍵の lane に残った event は、新しい key の lane へ移さずそのまま再試行し、401 なら古い鍵の接続を閉じて新しい target で送り直す（実装: 401 の時に target を作り直して 1 回だけ再送する）。
- 今の直結の形（`BANTOU_MEMORY_TOKEN`）は session の起動時の env なので、効くのは次の起動から。移行（5.4）までの間だけ残る。

## 5. 設定の口

### 5.1 center の command

```
bantou-center mcp list  [--config <path>] [--session <name>]
bantou-center mcp get   <名前> [--config <path>] [--session <name>]
bantou-center mcp set   <名前> [--config <path>] [--session <name>]
        [--url <url>] [--auth-header <名前>] [--auth-format <形>] [--secret <鍵の名前>] [--no-auth]
        [--header <名前>=<値>]... [--clear-headers]
        [--identity-header <名前>] [--identity <値>] [--no-identity]
        [--tool-prefix <前置き>] [--allow <道具>]... [--deny <道具>]... [--clear-tools]
        [--role memory | --no-role] [--timeout-ms <n>] [--off]
bantou-center mcp unset <名前> [--config <path>] [--session <name>]
bantou-center mcp secret set|unset|list ...（4.2）
bantou-center mcp test  <名前> [--config <path>] [--session <name>] [--json]
```

- `--session` を省くと全 session 共通。`--session` を付けた `set` は項目ごとの上書き。`--off` は `null`（その session で付けない）。
- `list` は共通・session ごと・各 session で有効な合成後の一覧（名前・役割・transport・URL の表示形・鍵の状態・識別の header の名前と値・絞り込みの件数・最後に試した結果）。
- `set` は合成後の検査（役割 `memory` が 1 つまで、`auth.secret` の鍵があるか（無ければ警告で保存はする）、予約名）を通った時だけ保存する。
- center が動いている間に変えてよい。session の起動時に読む物（どの接続を `--mcp-config` に載せるか、`memory@1` の有無）は次の起動から効く。center の口と center の書き込みが読む物（URL・鍵・header・絞り込み）は次の呼び出しから効く。表示の文にこの違いを書く。
- 同梱の center を使う人の `--config` の扱いは今の `bantou-center memory` と同じ（README の 1 か所にまとめる）。

### 5.2 「試す」

`bantou-center mcp test <名前> [--session <s>]`:

1. 合成後の設定と鍵で、MCP の client（Streamable HTTP）として先へ接続する（識別の header は `--session` の値、無ければ `bantou-center-test`。外部記憶は試すだけでは何も書かない）。
2. `initialize` → `tools/list`（ページを辿る）。
3. 表示: 結果の分類（4.4）、HTTP の status、先の server の名前と版（`initialize` の応答の `serverInfo`）、道具の数、`toolPrefix` と絞り込みを当てた後に session に見える道具の名前の一覧、役割 `memory` なら `event`（前置き込み）が先にあるか。所要時間。
4. 結果を `mcp-status.json` に残す（時刻・分類・道具の数・見える道具名。秘密を含まない）。
5. 終了 code: 0 = 一覧が取れた、1 = 取れない、2 = 使い方の誤り。

- 試すのは command を動かした host から（= center と同じ host で動かす前提。README に書く）。
- center の daemon も、起動時と 10 分ごと（session に付いている接続だけ）に同じ確かめを行い `mcp-status.json` を更新する（画面の「つながるか」に使う。道具の一覧の写しは 8.4 にも使う）。

### 5.3 画面と session から書き換えられない事・画面に見せる物

- 書く口は command だけ。center の `/mcp`（画面・web・master-cap が使う）にも `/mcp/session` にも、接続と鍵を書く道具を作らない。今の `project-settings` の更新（`session_create` の settings、`session_settings_update`、`center_settings_update`）に `mcp` / `mcpConnections` の項目が来たら、`memory` と同じく理由つきで断る（`assertNoMemory` を `assertCenterOnly` に広げる）。web の `tool-policy.ts` の引数の検査も同じ名前を足す。
- 読む口は `/mcp` に 1 つだけ足す: `mcp_connections_status`（引数なし、または `session`）。返す物:

| 項目 | 例 |
|---|---|
| `name` | `memory` |
| `role` | `memory` / なし |
| `scope` | `common` / `session` / `off` |
| `configured` | 鍵が要る接続で鍵があるか（真偽） |
| `reachable` | `ok` / `unreachable` / `auth` / `timeout` / `protocol` / `unknown`（未確認） |
| `checkedAt` | 最後に確かめた時刻 |
| `toolCount` | session に見える道具の数 |

  URL・header の名前と値・鍵の名前・rev・識別の値は返さない。画面は「どの接続があり、使えるか」だけ分かれば足りる。直し方は「center を動かす host で `bantou-center mcp test` を使う」という定型の案内だけ出す。
- `/mcp/session`（master-cap の session 向け）には何も足さない。session は自分の接続を `mcp__<名前>__*` の道具として使うだけ。

### 5.4 既存の物との関係・移行

`bantou-center memory`（fix branch の command）:

- 残す（分かれ目 3）。内部で「名前 `memory`・役割 `memory`・直結の形」の接続に読み替える:
  - `memory set --url U [--agent-id A] [--token-stdin|--token-file F|--clear-token]` = `mcp set memory --url U --auth-header Authorization --auth-format "Bearer {secret}" --secret memory --identity-header X-Agent-Id [--identity A] --role memory` + `mcp secret set memory`（`--session S` の時は鍵の名前を `memory.S`。session ごとに別の鍵を持てる今の動きを保つ）。
  - `memory get` = `mcp get memory` を今の 1 行の形で出す。中継経由など直結の形で表せない設定になっている時は「`bantou-center mcp get memory` を使う」と出す。
  - `memory unset` = `mcp unset memory`（鍵は他の接続が使っていなければ消す）。
- usage と README に「新しい command は `bantou-center mcp`」と書く。消す時期は決めない。

移行（center の起動時、1 回だけ）:

1. `memory-settings.json` があり、`mcp-connections.json` に名前 `memory` が無い時に行う。
2. `common` → `common.memory`（直結の形）、鍵 → `mcp-secrets.json` の `memory`。
3. `sessions.<s>` → `sessions.<s>.memory`。今の規則は「session の値があれば共通を丸ごと使わない」なので、移した session の entry は全項目を持つ（項目ごとの上書きにしても同じ結果になる）。鍵が共通と違えば `memory.<s>`、同じなら `memory` を指す。
4. 両方の file を書けたら `memory-settings.json` を消す（今の旧形式の移行（`sessions.ts:211-245`）と同じ「移して元から消す」）。書けなければ旧 file を残し、center は旧 file を読む今の経路で動く（log に理由だけ。値は出さない）。
5. 移行の後、`memory-settings.json` を読む code（`memory-settings.ts` の `createMemoryFile`、`remote-control.ts` の `memoryOf`）は外す。`project-settings.ts` の `memorySchema` は `memory` command の入力検査として残す。

center が組み立てる物（対象外）:

- `bantou-messenger`（stdio）と `bantou`（center の session 向けの口）は、この設定の対象にしない。名前は予約名にして、同じ名前の接続を作れないようにする。`--mcp-config` の組み立ても今のまま（接続の entry を足すだけ）。

利用者の個人の設定（center の管理の外）:

- user / project の scope に利用者が足した MCP の server は、今どおり session に載る（`--strict-mcp-config` は付けない）。center は読まない・書かない・数えない。
- 同じ名前の entry が `--mcp-config` と個人の設定の両方にある時、claude がどちらを使うかは確かめていない。予約名と別に、center の command は「個人の設定と同じ名前を避ける」事を usage に書くだけにする（center は個人の設定を読まない方針のため検査しない）。
- 利用者が個人の設定で同じ中継を自分の鍵で足していると、同じ道具が 2 つの名前で見える。center は関与しない。README に「center の接続に寄せる」と書く。

## 6. LAN の外で動く場合

### 6.1 何がどこへつなぐか

推奨の形（center の口を通す）では、master-cap の session は center が同じ host で起動する子なので、session の位置 = center の位置になる。session が直接つなぐ先は center の口（同じ host の loopback）だけ。

```
[画面: desktop / web]
      │  center への経路だけ（今のまま。center の URL と接続の鍵（pair））
      ▼
[center]  ── 同じ host ──  [master-cap の session]
   │   ▲                        │
   │   └── /mcp/conn/<名前>  ◄──┘  session の使い捨て token だけ
   │
   │  接続の設定と鍵（center の中だけ）
   ├──► [MCP の中継]（TLS。LAN の外から届く場所）
   │        ├──► [外部記憶の service]（LAN の中。中継だけが届く）
   │        └──► [他の MCP の server]
   │
   └──► [外部記憶の service]（直結の形。center と同じ網にある時だけ）
```

場合ごと:

| 場合 | session → | center → | 要る物 |
|---|---|---|---|
| center も session も LAN の中 | center の口 | 外部記憶へ直結、または中継 | 今と同じ。直結のままでよい |
| center が LAN の外（session も同じ host） | center の口 | 中継（LAN の外から届く URL） | 中継に外部記憶が登録されている事。center の接続を中継の形に変える（`mcp set memory --url <中継> ...`） |
| 画面だけが LAN の外 | — | — | 画面は center への経路だけ持つ。接続の設定には関係しない |
| remote-cap（server 上の session） | 対象外 | 対象外 | server は外部記憶に書かない・つながない（`docs/design/external-memory.md` の「server は書かない」）。今回も変えない |

分かれ目 1 で a（直結）を採った場合は、session も中継へ直接つなぐ。session と center は同じ host なので、届く先は同じだが、鍵が session の env に入る（8 章）。

### 6.2 運用の側に頼む事（環境に依らない言い方）

1. 外部記憶の service を中継の先の server として登録する。外部記憶の service 自体は中継からだけ届く網に置いたままにする（LAN の外へ直接出さない）。
2. 中継が外部記憶へ送る request の `Authorization` を、中継の側に置いた外部記憶の鍵（`Bearer <外部記憶の鍵>`）にする。client から来た鍵の header を外部記憶へ流さない。
3. 中継が client から来た識別の header（既定 `X-Agent-Id`）を、request ごとに変えずに外部記憶へ渡す。先への接続を使い回す場合も、request ごとに付ける。できない場合はそう伝えてもらう（できなければ中継経由の外部記憶は使えない。3.3）。
4. center 用の鍵を 1 本発行し、届く先を要る server（外部記憶と、使わせたい道具の server）だけに絞る。可能なら、外部記憶の `event` は center の鍵だけに許し、他の client には許さない。
5. center に伝える物: 中継の URL（LAN の外から届く物と中の物の両方があれば両方）、鍵を載せる header の名前と値の形、server の選び方（path / header / 道具名の前置き）と前置きの規則、TLS の証明書が公に信頼される物かどうか。
6. 鍵の入れ替えの時、新旧の鍵が両方通る期間を作る（4.5）。
7. 中継が request の header と本文を記録するか、記録するなら残す期間と見られる人。外部記憶へ送る本文は会話の全文なので、記録の扱いを確かめる。
8. （任意。3.3）鍵ごとに名乗れる agent を固定する設定が中継にあれば、使えるかどうか。

## 7. 危険と手当て

### 7.1 鍵の漏れる経路

| 経路 | 今（fix branch の後） | この設計の後 |
|---|---|---|
| process の引数（`ps` で見える） | `--mcp-config` に外部記憶の URL・header の名前・agent の ID（鍵は `${…}` で載らない） | `--mcp-config` は center の口の URL と entry 名だけ。鍵も中継の URL も載らない |
| session の env | `BANTOU_MEMORY_TOKEN` に外部記憶の鍵 | 中継・外部記憶の鍵は入らない（`BANTOU_SESSION_TOKEN` だけ） |
| session の会話 | session の Bash の道具は env を継承すると考えられ（確かめていない）、`BANTOU_MEMORY_TOKEN` を読める | env に無い。ただし同じ user なので `mcp-secrets.json` を読む事はできる（下） |
| 状態 dir の file | `memory-settings.json`（0600）に鍵 | `mcp-secrets.json`（0600）だけ。接続の file には鍵が無い |
| center の log・status の `args` | `--mcp-config` の JSON が載る（鍵は無い） | entry 名だけに伏せる。log は分類と status の数字だけ |
| error の文 | — | 分類して返す。SDK の例外の message を使わない |
| 画面への応答 | memory を返さない（fix branch） | `mcp_connections_status` の項目だけ |
| command の履歴（shell の history） | `--token` を断る | 同じ（値を引数に書かせない） |
| 記録の file（外部記憶の event） | 会話の本文を送る | 同じ。利用者が会話に鍵を貼れば外部記憶に残る（この設計の範囲外。README に注意を書く） |
| claude の側の記録 | `--mcp-config` を claude がどこかに書き残すかは確かめていない | 残っても center の口の URL だけ |

同じ user の process から鍵の file を読める事: center と session は同じ OS の user で動くため、session（とくに確認なしの permission の mode）が `mcp-secrets.json` を読めば鍵が見える。0600 では防げない。この設計で減らせるのは「意図せず見える」経路（env・引数・log・画面）までで、読もうとする session を止める境界ではない。強くするには分かれ目 2 の b（OS の鍵の保管庫）か、center を別の OS の user で動かす事が要る（後者は設置の形を変えるので範囲外）。system-instructions に「center の状態 dir の file を読まない」と書く事は手当てにならない（守らせる仕組みでないため）ので足さない。

### 7.2 中継の鍵 1 本で届く範囲が広い

- 直結の形で鍵を session に渡すと、session は中継の先の全 server の全道具に届く（`curl` で直接呼べる）。center の口の形なら、session が使えるのは `tools.allow` / `tools.deny` を通った道具だけ。
- 推奨: 中継の側でも鍵の届く範囲を絞ってもらう（6.2 の 4）。center の側では、`relay` のような汎用の接続は `tools.allow` を必須にする（allow が無い接続を `set` する時、役割 `memory` 以外なら「全部の道具が見える」と警告し、`--allow '*'` を明示した時だけ通す）。

### 7.3 道具の名前の衝突

- center の接続どうし: entry 名（接続名）が違えば `mcp__<接続名>__` で分かれる。同じ名前は作れない。
- 中継の中の server どうし: 前置きを剥がした後の重なりは 2.4 の規則（前置き付きを優先、log）。
- center の組み立てる物: 予約名で防ぐ。
- 個人の設定: 5.4 のとおり確かめていない。usage で避けるよう書く。

### 7.4 中継が落ちた時

- session の起動: 止めない。`--mcp-config` に載るのは center の口なので、中継が落ちていても claude は口に接続できる。口は `tools/list` に `mcp-status.json` の最後の写し（前回取れた一覧に絞り込みを当てた物）を返す（分かれ目 5）。写しが無ければ空の一覧を返す。道具を呼ぶと `unreachable` の error が返る。中継が戻れば次の呼び出しから通る（claude の側で session の再起動は要らない）。
  - 先の一覧が写しと変わった時に、口から `notifications/tools/list_changed` を送る。claude がこれを受けて一覧を取り直すかは確かめていない。取り直さない場合は、次の起動まで古い一覧のまま（呼ぶと先の error が返る）。
- 外部記憶の書き込み: 今のキューのまま（再試行、上限を超えたら古い分から捨てて log）。中継が落ちている間の event は lane に溜まり、上限を超えた分は失われる。捨てた件数は `mcp_connections_status` に出さない（画面に内部の数を出さない方針）。log だけ。
- `memory@1` の指示は「起動時に context / recall を呼ぶ」。呼んで error になった時、session は外部記憶なしで進む（指示を変えない。error の文は分類だけで、先の詳細は出ない）。
- 中継の応答が遅い時: 1 回の呼び出しは `timeoutMs`（既定 60 秒）で切る。口の `tools/list` は 5 秒で切って写しを返す（起動を待たせない）。

### 7.5 その他

- session からの header の持ち込み: 口は session から来た `Authorization`・`X-Bantou-Session` を自分の認証にだけ使い、先へは渡さない。識別の header と同じ名前の header が session から来ても捨てる。
- 中継の応答の大きさ: 1 回の結果を 4 MB で切る（越えたら `protocol` の error）。center の memory 使用量を守るため。
- 外部記憶の `event` を session から隠す（2.5）。
- center が http で待ち受けていない時は接続を付けない（4.3）。

## 8. 実装のまとまり

| # | 名前 | 依存 | 変える package | protocol の版 | 中身 |
|---|---|---|---|---|---|
| M1 | 接続の設定・鍵・command（list/get/set/unset/secret/test） | なし | center | 変えない | `mcp-connections.ts`（形・検査・合成・保存）、`mcp-secrets.ts`、`mcp-status.ts`、`cli.ts` に `mcp` を足す、README。session と書き込みの動きは変えない |
| M2 | center の書き込みを接続経由に | M1 | center | 変えない | `memory.ts` の target を header・道具名の組み立て済みの形に、`memory-events.ts` の送り先を役割 `memory` の接続から作る（無ければ今の `memory-settings.json`） |
| M3 | center の中継の口 `/mcp/conn/<名前>` | M1 | center | 変えない | `mcp-proxy.ts`（先への client の保持・鍵の rev での開き直し・絞り込み・前置きの剥がし・識別の header・一覧の写し・error の分類）、`http.ts` に path を足す（認証は `/mcp/session` と同じ） |
| M4 | session の起動に接続を載せる・旧 memory の移行 | M2、M3 | center | 変えない | `wrapper.ts`（entry を口へ。`BANTOU_MEMORY_TOKEN` を外す）、`bantouAllowRules`、`ctx.memory` の判定、status / log の `--mcp-config` を伏せる、`memory-settings.json` の移行、`bantou-center memory` の読み替え、`assertCenterOnly`、改名・削除の付け替え |
| M5 | 画面の表示（読むだけ） | M1（M3 があれば reachable が埋まる） | center、center-client、ui | 変えない | `/mcp` に `mcp_connections_status`、center-client の許可の一覧と引数の検査に足す、設定ダイアログの「全 session 共通」に一覧（名前・役割・設定済み・つながるか・確かめた時刻）と定型の案内。古い center に当たった時は欄を出さない |
| M6 | 名乗れる agent を鍵に結び付ける（任意） | なし | memory | 変えない | `MEMORY_TOKENS`、または中継が付ける識別の header の扱い。運用の答え（6.2 の 3・8）を見て決める |
| M7 | stdio の接続（後回し） | M3 | center | 変えない | 2.6 |

- protocol（`packages/protocol`、`MESSENGER_PROTOCOL 1.8.1`）は center と server の間の約束で、どのまとまりも触らない。server（remote-cap）も変えない。
- desktop の Rust は center の道具を素通しする（fix branch の report の閉じた経路の表 #3〜#5）ので変えない（M5 の新しい道具も `center_call` で通る。確かめていない。実装の時に確かめる）。
- center の `/mcp` の道具が 1 つ増える（M5）。web の許可の一覧に足さないと web からは見えない。

**最初に出す物: M1**。理由: 動いている session と書き込みの動きを変えずに、「center が中継への接続を設定として持ち、つながるかを試せる」状態を作れる。運用の側の準備（中継への外部記憶の登録・識別の header の受け渡し）を、M1 の `test` で確かめながら進められる。M2 で center の書き込みが中継経由になり、LAN の外の center から外部記憶へ書ける。M3 + M4 で session の読みも中継経由になる。

### 確かめ方

偽の中継を test で立てる（`packages/center/test/helpers/fake-relay.ts`）:

- node の http server + MCP の SDK の server（Streamable HTTP）。設定で鍵の header 名と形（`Authorization: Bearer <鍵>`、独自の header 名に `Bearer <鍵>`、値そのまま）を切り替えられる。server の選び方（path / header / 前置き）も切り替えられる。
- 道具: `memory-event`・`memory-recall`・`memory-context`・`search-find`・`admin-drop`（絞り込みの確認用）。前置きを剥がすと衝突する名前（`recall` と `memory-recall`）も 1 組持つ。
- 受けた request の header を記録する（識別の header の値、session から来た header が届いていない事の確認）。
- 「落ちている」「401 を返す」「遅い」「MCP として壊れた応答」を切り替えられる。

M1:

- `set` / `get` / `list` / `unset` / `secret` の往復。検査（予約名・`{secret}` の数・`${`・鍵らしい固定の header・役割 `memory` が 2 つ）。
- `test` が偽の中継の 3 つの鍵の形で一覧を取れる。401・落ちている・遅い・壊れた応答で分類が正しい。
- 鍵の文字列が、command の標準出力・標準エラー・`mcp-connections.json`・`mcp-status.json` のどこにも出ない（全出力を集めて鍵の文字列で検索する test）。`--value` などを断る。
- file の mode が 0600。

M2: 偽の中継経由で event が `memory-event` に届き、識別の header が agent の ID になる。rev を変えると次の送信から新しい鍵。401 の後に作り直して再送。落ちている間は溜まり、戻ると送られる。

M3: 一覧の絞り込みと前置きの剥がし、絞り込みで外した道具を呼ぶと断る、`event` が session から見えない、session から来た識別の header と鍵の header が先へ届かない、別の session の token では口に入れない、鍵の入れ替えが動いている口に次の呼び出しから効く、落ちている時に写しを返す、error の文に URL も鍵も出ない。

M4: `--mcp-config` に中継の URL・鍵・`${BANTOU_MEMORY_TOKEN}` が無い、env に `BANTOU_MEMORY_TOKEN` が無い（継承分も）、status の `args` と log の `--mcp-config` が伏せられている、`memory-settings.json` の移行（共通・session・鍵が違う session・書けない時に旧のまま動く）、`bantou-center memory` の読み替え、改名で付け替わる。既存の `remote-control-wrapper.test.ts`・`memory-settings.test.ts`・`sessions.test.ts` を直す。

M5: center-client の test（許可の一覧と引数の検査）、desktop の e2e（設定ダイアログに一覧が出る、URL と鍵が画面に無い。e2e の mock の center に道具を足す）。

変異の確かめ（fix branch の report と同じやり方）: 鍵を伏せる処理・識別の header を捨てる処理・絞り込みを無効にすると、上の test が落ちる事。

## 9. 利用者から見た結果が変わる分かれ目

### 分かれ目 1: session への鍵の渡し方

- a. 直結（今の外部記憶と同じ）: session が中継へ直接つなぎ、鍵は session の env。
  - 見える物: session は中継の先の全道具に届く（絞り込みは permissions だけ）。鍵の入れ替えは session を起動し直すまで効かない。session の Bash から鍵が読める。center の作りは小さい。
- b. center の口を通す（**推奨**）: session は center の口につなぎ、鍵と agent の ID は center が付ける。
  - 見える物: session に見える道具は絞った物だけ。中継経由でも道具名は `mcp__memory__recall` のまま。鍵の入れ替えは動いている session にも次の呼び出しから効く。中継が落ちていても session は起動し、道具は前回の一覧で見える（呼ぶと error）。center の作りは大きくなる（M3）。
- 推奨の理由: 「秘密の値は center の側だけで扱う」という要件に合うのは b だけ。中継の鍵は外部記憶の鍵より届く範囲が広く、a で session の env に置く危険が今より大きい。

### 分かれ目 2: 鍵の置き場

- a. 状態 dir の 0600 の file（**推奨**）: 見える物: 今の `memory-settings.json` と同じ扱い。どの OS でも同じ。同じ user の process（session を含む）は読める。
- b. OS の鍵の保管庫: 見える物: macOS では session が読もうとすると確認の dialog が出る形にできる（確かめていない）。Linux では保管庫が無い・headless で使えない環境がある。設置の手順が増える。
- c. center の process の env: 見える物: 設置のたびに起動の仕組み（launchd / systemd）に鍵を書く。session に継承されないよう center が消す必要がある。
- 推奨の理由: center は desktop に同梱される場合と headless の場合があり、a はどちらでも同じ手順で動く。b は後から `auth.secret` の参照先を増やす形で足せる（形を変えずに済む）。同じ user から読める事は 7.1 に明記する。

### 分かれ目 3: `bantou-center memory` の扱い

- a. 残して内部で接続 `memory` に読み替える（**推奨**）: 見える物: 今の手順書・README の command がそのまま使える。中継経由に変える時だけ `bantou-center mcp` を使う。
- b. 置き換える（`mcp` だけにする）: 見える物: command が 1 系統になるが、fix branch で決めた手順が使えなくなる。
- 推奨の理由: fix branch が develop に入った直後で、手順を 2 回変えさせない。読み替えは小さい。

### 分かれ目 4: 中継経由の道具名

- a. 先の名前のまま（`mcp__memory__memory-recall`）: 見える物: 中継の前置きが道具名に残る。直結と中継で名前が変わり、`memory@1` の文面を接続ごとに作る必要がある。
- b. center の口で前置きを剥がす（**推奨**）: 見える物: どちらでも `mcp__memory__recall`。文面を変えない。
- 推奨の理由: 接続先を変えても session の振る舞い（指示・許可）が変わらない。分かれ目 1 で b を採れば追加の費用は小さい。

### 分かれ目 5: 中継が落ちている時の session の道具

- a. 前回の一覧の写しを見せる（**推奨**）: 見える物: 道具は見え、呼ぶと「つながらない」error。中継が戻れば同じ session のまま使える。
- b. 空にする / 口が error を返す: 見える物: その session ではずっと道具が無い（claude が一覧を取り直さない場合。確かめていない）。中継が戻っても session の起動し直しが要る。
- 推奨の理由: 一時的な停止で session を起動し直させない。

### 分かれ目 6: 画面に見せる範囲

- a. 名前・役割・設定済みか・つながるか・確かめた時刻・道具の数（**推奨**）。
- b. a + URL の host。見える物: どこへつないでいるかが画面で分かるが、内側の構成が画面の側に出る。
- 推奨の理由: 要件「画面が知るべきなのは center への経路だけ」。直すのは center の host の command なので、画面で host を知っても直せない。

### 分かれ目 7: 汎用の接続の絞り込み

- a. allow が無い接続は警告し、`--allow '*'` を明示した時だけ通す（**推奨**）。見える物: 中継の全道具を session に見せるには明示が要る。
- b. 何も言わずに全部見せる。見える物: 設定は短いが、中継に server が足されると session の道具が黙って増える。
- 推奨の理由: 7.2。

## 10. 確かめていない事

- claude が `--mcp-config` の entry と個人の設定の同名の entry のどちらを使うか。
- claude の Bash の道具が claude の process の env（`BANTOU_SESSION_TOKEN`・今の `BANTOU_MEMORY_TOKEN`）を継承するか（継承すると考えて設計した）。
- claude が `notifications/tools/list_changed` を受けて一覧を取り直すか。`tools/list` が失敗した MCP の server を session の途中で取り直すか。
- claude の道具名の上限（文字数・使える文字）。
- claude が `--mcp-config` の内容をどこかに書き残すか。
- 特定の中継が (A) 鍵の置き換え (B) 識別の header の受け渡し (C) 接続の使い回し時の header を満たすか（3.3）。中継ごとに運用の側に確かめてもらう。
- 中継が道具名に付ける前置きの形（中継ごとに違う。`toolPrefix` で表せない形（前置きでなく後置き、区切りの変換など）がありうる。その時は形を足す）。
- desktop の Rust の `center_call` が新しい道具を素通しするか（M5）。
- status の `args` が画面・web の応答にどこまで載るか（`packages/ui` は `.args` を参照していない事は grep で見た。web の backend の応答は確かめていない）。M4 で伏せるので、どちらでも結果は同じ。
- この設計の test・build はこの Mac で回していない（設計のみ）。
