cask "bantou" do
  version "0.1.66"
  sha256 "85400a09a10f9bfa6d4101d84329d1179b513216b2c058a0a05b7200005a7f3c"

  url "https://github.com/unagents/bantou/releases/download/v#{version}/bantou_#{version}_aarch64.dmg"
  name "bantou"
  desc "Multi-agent task bridge on a Cork-format task board"
  homepage "https://github.com/unagents/bantou"

  auto_updates true

  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "bantou.app"

  preflight_steps do
    # ad-hoc 署名アプリのため quarantine 属性のみ除去する（再署名は hardened runtime のフラグを壊すため行わない）
    run "xattr", args: ["-dr", "com.apple.quarantine", "{{staged_path}}/bantou.app"]
  end

  zap trash: [
    "~/Library/Application Support/jp.grrow.bantou",
    "~/Library/Caches/jp.grrow.bantou",
  ]
end
