# bantou-server

**雛形のみ（業務ロジック未実装）。** 起動・設定読込・workspace 準備・終了処理だけを持つ常駐プロセス。

## 役割

- linux / mac で動く npm package（`bantou`）。`npx` で起動する。
- bantou-desktop（`../desktop/`、mac / windows のネイティブアプリ）からの指示を受ける。
- 担当は 2 つ。remote session の起動（`src/session.ts`）と、remote cap（オーケストレーター）の起動（`src/cap.ts`）。
- desktop が指示を出す側。server は受ける側で、自律的に方針を決めない。

## 起動方法

```
npx bantou --config <path>
```

- `--config` 省略時は `~/.config/bantou-server/config.json`。
- それ以外の引数は exit 2。実行時エラーは exit 1。
- SIGTERM / SIGINT で後始末して exit 0。

開発時は `server/` で実行する。

```
npm install
npm run typecheck
npm run build
npm test
npm run dev -- --config <path>
```

dev / test は `node --import tsx` を使う。Node >=22 のみで動き、bun を要しない。

## config.json

```json
{ "workspace": "/path/to/workspace" }
```

- `workspace`（必須）: workspace フォルダの絶対パス。

## workspace レイアウト

```
<workspace>/
  repos/    repo の展開先
```

起動時に `<workspace>/` と `<workspace>/repos/` が無ければ作る。

## 未決定事項

- desktop と server の通信方式
- remote session と remote cap の起動手順の詳細
- 配置先ホスト

## 関連資料

- [`../docs/protocol.md`](../docs/protocol.md)
- [`../docs/guardrail.md`](../docs/guardrail.md)
- [`../desktop/README.md`](../desktop/README.md)
