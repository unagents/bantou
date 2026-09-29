cask "bantou" do
  version "0.1.1"
  sha256 "e1591f8074fe810832c116299ec990bc432b0e09a77927c96cdbc856b12f1e21"

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
