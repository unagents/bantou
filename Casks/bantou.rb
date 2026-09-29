cask "bantou" do
  version "0.1.2"
  sha256 "fd541435df58aecb8d5176759a75a96f6bada50a210eb5c0bd360d59154ba25d"

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
