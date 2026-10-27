require "cask/auditor"
require "cask/cask_loader"
path = "/opt/homebrew/Library/Taps/unagents/homebrew-tap/Casks/bantou.rb"
errors = Cask::Auditor.audit(
  Cask::CaskLoader.load(path),
  audit_strict:   true,
  audit_online:   nil,
  audit_signing:  nil,
  audit_new_cask: nil,
  audit_fix:      nil,
  any_named_args: true,
  only:           [],
  except:         [],
).to_a
puts "ERRORS=#{errors.size}"
errors.each { |e| puts e.to_s }
