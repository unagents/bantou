cask "bantou" do
  version "0.1.4"
  sha256 "3abe85fa5f893f3be3785cb48cf4b6dbb7b161befefdd5446121a19dfcebf1a6"

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
