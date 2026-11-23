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

/// Whether launchd runs (or now will run) the agent.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Registration {
    /// Registered and enabled (already, or just now): launchd's instance keeps the center.
    Launchd,
    /// Registration failed, or the agent is not approved: nothing from launchd will run the center.
    NotLaunchd,
}

/// The environment value launchd sets (`XPC_SERVICE_NAME`) for a job: the label of the plist.
pub fn is_launchd_job(xpc_service_name: Option<&str>) -> bool {
    xpc_service_name == Some(PLIST_NAME.trim_end_matches(".plist"))
}

/// Whether this instance starts the center. A launchd's instance always does. Any other one (Finder) does only
/// when launchd will not run the agent; otherwise it leaves the center to launchd's instance (no double start).
pub fn should_start_center(launchd_job: bool, reg: Registration) -> bool {
    launchd_job || reg == Registration::NotLaunchd
}

#[cfg(target_os = "macos")]
pub fn ensure_registered() -> Registration {
    use objc2_foundation::NSString;
    use objc2_service_management::SMAppService;

    let name = NSString::from_str(PLIST_NAME);
    // SAFETY: plain AppKit-side calls on a service object created here; no pointers are kept.
    let service = unsafe { SMAppService::agentServiceWithPlistName(&name) };
    let status = unsafe { service.status() };
    log::line(&format!("launchd の登録の状態: {status:?}"));
    match action_for(status.0) {
        Action::Nothing => {
            log::line("launchd に登録済み");
            Registration::Launchd
        }
        Action::LogDisabled => {
            log::line("launchd の登録は承認待ちか無効（System Settings > Login Items で許可する）。次の login から自動では起動しない");
            Registration::NotLaunchd
        }
        Action::Register => match unsafe { service.registerAndReturnError() } {
            Ok(()) => {
                log::line("launchd に登録した");
                Registration::Launchd
            }
            Err(e) => {
                log::line(&format!("launchd に登録できない: {}", e.localizedDescription()));
                Registration::NotLaunchd
            }
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_registered() -> Registration {
    log::line("macOS 以外では launchd に登録しない");
    Registration::NotLaunchd
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

    #[test]
    fn launchd_job_is_known_by_its_label() {
        assert!(is_launchd_job(Some("jp.grrow.bantou-center")));
        assert!(!is_launchd_job(Some("application.jp.grrow.bantou-center.123.456")));
        assert!(!is_launchd_job(Some("0")));
        assert!(!is_launchd_job(None));
    }

    #[test]
    fn finder_instance_starts_the_center_only_when_launchd_will_not() {
        // launchd's own instance: always.
        assert!(should_start_center(true, Registration::Launchd));
        assert!(should_start_center(true, Registration::NotLaunchd));
        // Finder's instance: leaves it to launchd once registered; starts it itself when registration failed.
        assert!(!should_start_center(false, Registration::Launchd));
        assert!(should_start_center(false, Registration::NotLaunchd));
    }
}
