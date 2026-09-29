cask "bantou" do
  version "0.1.3"
  sha256 "fa2a06253bc09fdbdc98914749f2a4edcc1926e27236ed8b89f82a8942de5d49"

  url "http://192.168.1.202/gitea/agent-hand/bantou/releases/download/v#{version}/bantou_#{version}_aarch64.dmg"
  name "bantou"
  desc "Multi-agent task bridge on a Cork-format task board"
  homepage "http://192.168.1.202/gitea/agent-hand/bantou"

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
