# bantou の概念（ユーザー確定、2026-10-29）

設計判断の前提。ここに反する決め事を作らない。実装手段は「今はこう」であり、概念ではない。

## 登場者

```
ユーザー ── 番頭（bantou） ── center ── master-cap ┄┄ remote-cap ── worker
          1 対 1（仮）              （PM、複数）     （server 上）
```

- 番頭: どこにも属さず、ユーザーの面倒だけを見る。ユーザーは番頭と話し、番頭が全部を切り盛りする。PM（master-cap）を用意するのも番頭。
- center: MCP サーバー。desktop と基本は一体。master-cap が住む場所（生存圏）で、master-cap の起動と管理を持つ。
- master-cap: プロジェクトの PM。ドメイン知識を注入され、考えて指示を出す。製造はしない。考える点を除けば、ただの中継役。
- remote-cap: 本質的には master-cap と一体の、仕組みの上の存在。server が作って起動する。
- worker: remote-cap が起動する作業者。

## 原則

1. master-cap に要るのは「考えて指示を出す」ことだけ。実体（素の Claude session であること、起動場所、path）は本質ではない。
2. center は master-cap に必要な道具を持たせてよい（起動時に付ける、center のコマンドにする等）。master-cap を素の session のまま置く理由は薄い。
3. ユーザーから master-cap までは対話の session があればよい。desktop にとって center や server がどこにあるかは関心事ではない。
4. path や server が問題になるのは、remote-cap が worker や session を起動する時から。
5. どの server で作業するか、worker を何本使うかを、ユーザーからはできるだけ見えなくしてプロジェクトを回す。これが bantou スタイル。master-cap に見えること自体は問題ない。
6. 資源を無駄にしない。session ごとに重い仕組みを抱えさせない。共有できるものは center が持つ。

## 「今は」の実装（いずれ変わり得る）

- master-cap の起動手段: `claude remote-control`。最善でも確定でもない。
- 通信基盤: agent-messenger（protocol `bantou`）。インフラとしては長く使うかもしれない。
- 目指す形: agent-messenger の通信部分（client、broker との接続）は center が持つ。master-cap には protocol と、それを使う MCP tool の function だけを持たせる。master-cap ごとに agent-messenger の MCP を抱えさせない。
- master-cap から server への指示は protocol `bantou` で送る。送る道具は center が master-cap に持たせる。
- worker の実プロセスは server が remote-cap の依頼（server の `/mcp` の tool）で起動する。起動すると決めるのは remote-cap（登場者の定義は変わらない）。
- 生存は `claude -p --output-format stream-json` の出力が続いているかで見る。server が remote-cap と worker の出力を要約し、protocol `bantou` の `activity` 通知で center に送る。center が保持して desktop に見せる。

## 判断の手順

- 新しい決め事を作る前に、それが概念（上の原則）か、「今は」の実装かを分けて書く。
- 実装都合を概念に格上げしない。概念に反する実装は、「今は」として理由と移行先を書く。
