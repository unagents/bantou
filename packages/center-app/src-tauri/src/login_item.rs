//! Self-registration as a launchd agent (docs/design/center-graphql-server.md #14 = A, 2.7.2).
//!
//! `SMAppService.agent(plistName:)` registers the plist inside this app's bundle
//! (`Contents/Library/LaunchAgents/<PLIST_NAME>`, see `launchd/` and `bundle.macOS.files` in tauri.conf.json).
//! Idempotent: an already registered agent is left alone, so launching the app twice never registers twice.
//! The result goes to the log (the app has no window). When the user turned the agent off in System Settings
//! (Login Items) it stays off: the app only logs that (#17: no new notification).

use crate::log;

/// The plist inside the bundle (`launchd/jp.grrow.bantou-center.plist`; its Label is the same without `.plist`).
pub const PLIST_NAME: &str = "jp.grrow.bantou-center.plist";

/// What to do for each state of the agent.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Registered and enabled: nothing to do.
    Nothing,
    /// Registered but not approved (the user turned it off): not forced, only logged.
    LogDisabled,
    /// Not registered (or the plist was not found): register.
    Register,
}

/// The raw `SMAppServiceStatus` values: 0 not registered, 1 enabled, 2 requires approval, 3 not found.
pub fn action_for(status: isize) -> Action {
    match status {
        1 => Action::Nothing,
        2 => Action::LogDisabled,
        _ => Action::Register,
    }
}

#[cfg(target_os = "macos")]
pub fn ensure_registered() {
    use objc2_foundation::NSString;
    use objc2_service_management::SMAppService;

    let name = NSString::from_str(PLIST_NAME);
    // SAFETY: plain AppKit-side calls on a service object created here; no pointers are kept.
    let service = unsafe { SMAppService::agentServiceWithPlistName(&name) };
    let status = unsafe { service.status() };
    log::line(&format!("launchd の登録の状態: {status:?}"));
    match action_for(status.0) {
        Action::Nothing => log::line("launchd に登録済み"),
        Action::LogDisabled => log::line("launchd の登録は承認待ちか無効（System Settings > Login Items で許可する）。次の login から自動では起動しない"),
        Action::Register => match unsafe { service.registerAndReturnError() } {
            Ok(()) => log::line("launchd に登録した"),
            Err(e) => log::line(&format!("launchd に登録できない: {}", e.localizedDescription())),
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_registered() {
    log::line("macOS 以外では launchd に登録しない");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_only_when_not_registered() {
        assert_eq!(action_for(0), Action::Register);
        assert_eq!(action_for(3), Action::Register);
        assert_eq!(action_for(1), Action::Nothing);
        assert_eq!(action_for(2), Action::LogDisabled);
    }
}
