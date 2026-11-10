# desktop の署名 identity（ローカルネットワーク許可を更新で失わないために）

- 更新: 2026-11-10
- 対象: mac200 の koube で行う release（`packages/desktop/scripts/release.sh`）。
- この手順は **Linux host では検証できていない**（mac で未実施）。「未確認」と書いた点は、最初の release で実機確認する。

## 1. 症状と切り分け

- 症状: app 更新の直後から、bantou.app 配下のプロセス（center・messenger MCP の node など）の **LAN（192.168.x.x）宛て TCP だけ** `EHOSTUNREACH`（No route to host）。internet と 127.0.0.1 は通る。`curl` / `ping` など Terminal 配下は通る。
- 切り分け: Terminal から同じ宛先へ `curl` が通り、app 配下からだけ落ちるなら、macOS の Local Network privilege（ローカルネットワーク許可）の外れを疑う。
- 直し方: System 設定 > プライバシーとセキュリティ > ローカルネットワーク で bantou を OFF→ON し、bantou.app を再起動する。
- header の messenger 表示にカーソルを載せると、broker への接続が EHOSTUNREACH で失敗した時に「ローカルネットワークの許可を確認」と出る（この変更を含む版以降）。

## 2. 原因（根拠つき）

- Apple TN3179「Local network privacy tracks the identity of your program using its code signature. This presents a challenge on macOS, which allows for unsigned code and ad hoc signed code … To ensure that local network privacy reliably tracks the identity of your macOS program, sign it with an Apple-issued code-signing identity.」
  https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- Apple TN3127「Ad hoc signed code … has a DR but it's tied to that specific version of the code. … macOS can't reliably track the identity of the code.」DR（designated requirement）は更新をまたいで同じ app と見なす基準。
  https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
- bantou は `signingIdentity: "-"`（ad-hoc）なので、版ごとに code identity が変わり、前の版への許可が引き継がれない（上の 2 文からの帰結。0.1.44 の実機症状と一致）。

## 3. 方針

- **自己署名の code signing 証明書を 1 回作り、release の署名に使う**（Developer ID が無い前提）。証明書は版をまたいで同じなので、DR が版をまたいで一定になる。
- 未確認: 自己署名 identity で、Local Network の許可が更新をまたいで**実際に保たれるか**。Apple の文書は「Apple-issued」を勧めており、自己署名の場合の保証は書いていない。最初の更新（例 0.1.45→0.1.46）で実機確認する。保たれなければ Apple Developer Program の Developer ID が必要。
- 参考: TN3179 は macOS 15.5 以降の `AllowedWiFiLocalNetworkAddresses` / `AllowedEthernetLocalNetworkAddresses`（`com.apple.network.local-network`、`sudo defaults write`、再起動要）で、特定の LAN を「許可制の対象外」にできると書く。app の署名によらない別の手段。これは host 全体の設定変更なので、この手順では使わない。

## 4. 証明書を作る（mac200 の koube、1 回）

Apple「Code Signing Guide: Procedures」の手順（Certificate Assistant）:
https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html

1. koube で GUI にログインし、アプリケーション > ユーティリティ > キーチェーンアクセスを開く。
2. メニュー キーチェーンアクセス > 証明書アシスタント > 証明書を作成。
3. 名前: `bantou dev signing`。
4. 固有名のタイプ（Identity Type）: 自己署名ルート（Self Signed Root）。証明書のタイプ: コード署名（Code Signing）。
5. 「デフォルトを無効にする」を ON にして続ける。シリアルは任意（同名で重複しない値）。**有効期間は長く（例 3650 日）** に変える（短いと期限切れで DR が変わる）。残りは既定。
6. 保存先は「ログイン」キーチェーン。
7. 確認: `security find-identity -p codesigning`（`-v` 無しで全件）に `bantou dev signing` が出る。
   - `-v`（有効のみ）に出ない場合の扱いは**未確認**。キーチェーンアクセスで証明書を開き「信頼」>「コード署名」を「常に信頼」にして `-v` に出るか試す。

注意:
- 秘密鍵はこの mac の login keychain にしか無い。バックアップ（.p12 の書き出し）をするなら鍵の扱いに注意する（この文書に鍵・パスワードは書かない）。**鍵を失う／証明書を作り直すと DR が変わり、許可は 1 回外れる**。
- ssh 経由の release では login keychain が locked だと codesign が失敗する場合がある。その場合は `security unlock-keychain ~/Library/Keychains/login.keychain-db` を実行してから release する（man security）。鍵に codesign のアクセスを許可する確認ダイアログが出る場合は、一度 GUI で「常に許可」にする。いずれも**未確認**。

## 5. release で使う

Tauri は環境変数 `APPLE_SIGNING_IDENTITY` を読み、`tauri.conf.json` の `bundle.macOS.signingIdentity` を**上書き**する。
- Tauri docs（環境変数）: 「APPLE_SIGNING_IDENTITY: The identity used to code sign. Overwrites `tauri.conf.json > bundle > macOS > signingIdentity`.」 https://v2.tauri.app/reference/environment-variables/
- 実装: tauri-cli `interface/rust.rs` が `std::env::var_os("APPLE_SIGNING_IDENTITY")` を先に見て、無ければ `config.macos.signing_identity` を使う。https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/interface/rust.rs
- よって **`tauri.conf.json` は変えない**（`"-"` のまま＝証明書が無い環境は今までどおり ad-hoc で build できる）。
- `tauri.conf.json` に `${VAR}` のような環境変数の置換は使えない（Tauri v2 の docs 〔config reference・環境変数〕に、config 内の環境変数展開の記述は見つからなかった）。上書きは上の環境変数で行う。

`release.sh` は、`~/.config/bantou/signing-identity`（1 行、証明書の名前。例 `bantou dev signing`）があれば、その値を `APPLE_SIGNING_IDENTITY` として `tauri build` に渡す。無ければ従来どおり ad-hoc。

```
mkdir -p ~/.config/bantou
printf '%s\n' 'bantou dev signing' > ~/.config/bantou/signing-identity
```

release.sh は署名ビルドの後に `codesign -dr -` で app の DR を表示する。identity を指定したのに DR が `cdhash` のまま（＝ ad-hoc のまま）なら止まる。

## 6. 更新後の確認（初回は実機確認が必要）

1. 証明書で署名した版 A を入れ、ローカルネットワークを許可して、center が LAN の broker に繋がることを確認。
2. 次の版 B に更新する（B も同じ証明書）。
3. 許可を触らずに center が broker に繋がれば成功。外れたら 1. の「直し方」で復旧し、結果を docs/history に残して Developer ID を検討する。
4. 署名の確認: `codesign -dvv /Applications/bantou.app` の Authority が `bantou dev signing`、`codesign -dr - /Applications/bantou.app` が証明書 leaf を指す（`cdhash` ではない）こと。

## 7. updater との関係

- アプリ更新の検証（tauri-plugin-updater）は minisign の鍵（`TAURI_SIGNING_PRIVATE_KEY` / `tauri.conf.json` の `plugins.updater.pubkey`）で行い、macOS の code signing identity とは別。Tauri docs「Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled.」https://v2.tauri.app/plugin/updater/
- docs は両者が独立と明記してはいない（未確認）。ただし bantou の build は署名 identity と updater 鍵を別の入力（`APPLE_SIGNING_IDENTITY` / `TAURI_SIGNING_PRIVATE_KEY`）で渡しており、identity を変えても updater の鍵・pubkey は変わらない。
- 旧版（ad-hoc）から自己署名版への最初の更新は、updater の検証（minisign）は通る。許可は、ad-hoc 版には引き継がれる元が無いので、**最初の 1 回だけ**許可の操作（OFF→ON）が要る。

## 8. notarization・Developer ID

- Tauri docs: 「Notarization is required when using a Developer ID Application certificate.」「A signing certificate is only valid if associated with your Apple ID.」自己署名は notarize できない。https://v2.tauri.app/distribute/sign/macos/
- Developer ID を取る場合は `APPLE_SIGNING_IDENTITY` を `Developer ID Application: …` にし、notarize 用の `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` を release の環境に足す。この文書の範囲外。
