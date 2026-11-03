//! OS notifications that mean "the center's session list may have changed", forwarded to the
//! frontend as events: wake from sleep, and a change of the network interfaces / addresses.
//!
//! The frontend decides what to do (it re-fetches the list, debounced). Nothing here talks to the
//! center.
//!
//! | event | macOS | Windows | Linux |
//! |---|---|---|---|
//! | `WAKE_EVENT` | `NSWorkspaceDidWakeNotification` | `PowerRegisterSuspendResumeNotification` (`PBT_APMRESUMEAUTOMATIC`) | none |
//! | `NETWORK_EVENT` | `netwatcher` (routing socket `PF_ROUTE`) | `netwatcher` (`NotifyIpInterfaceChange` / `NotifyUnicastIpAddressChange`) | `netwatcher` (netlink) |

use std::sync::Mutex;
use tauri::Emitter;

/// Only macOS and Windows emit it.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub const WAKE_EVENT: &str = "bantou://os-wake";
pub const NETWORK_EVENT: &str = "bantou://os-network-changed";

/// Keeps the OS registrations alive for the life of the app (dropping a `netwatcher` handle stops it).
#[derive(Default)]
pub struct OsEvents {
    network: Mutex<Option<netwatcher::WatchHandle>>,
}

/// Whether a `netwatcher` update is a change worth telling the frontend about: not the initial
/// snapshot, and at least one interface or address added / removed.
fn relevant(is_initial: bool, diff: &netwatcher::UpdateDiff) -> bool {
    if is_initial {
        return false;
    }
    !diff.added.is_empty()
        || !diff.removed.is_empty()
        || diff.modified.values().any(|m| !m.addrs_added.is_empty() || !m.addrs_removed.is_empty())
}

fn watch_network(app: tauri::AppHandle) -> Result<netwatcher::WatchHandle, netwatcher::Error> {
    netwatcher::watch_interfaces_with_callback(move |update| {
        if relevant(update.is_initial, &update.diff) {
            let _ = app.emit(NETWORK_EVENT, ());
        }
    })
}

/// Start the receivers. A receiver that cannot start is logged and skipped: the frontend still
/// refreshes on user action, on settings changes and on its periodic timer.
pub fn start(app: &tauri::AppHandle) {
    match watch_network(app.clone()) {
        Ok(h) => *tauri::Manager::state::<OsEvents>(app).network.lock().unwrap() = Some(h),
        Err(e) => eprintln!("bantou: network change watcher not started: {e}"),
    }
    wake::start(app);
}

#[cfg(target_os = "macos")]
mod wake {
    use super::WAKE_EVENT;
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    use tauri::Emitter;

    pub fn start(app: &tauri::AppHandle) {
        let app = app.clone();
        let block = RcBlock::new(move |_n: NonNull<NSNotification>| {
            let _ = app.emit(WAKE_EVENT, ());
        });
        // NSWorkspace posts its notifications on its own center, not `defaultCenter`. The center
        // retains the observer; the token is dropped on purpose (observation lasts until exit).
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let _token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            )
        };
    }
}

#[cfg(windows)]
mod wake {
    use super::WAKE_EVENT;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use tauri::Emitter;
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC};

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Called by the OS on one of its threads for suspend / resume.
    unsafe extern "system" fn on_power(_ctx: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
        if kind == PBT_APMRESUMEAUTOMATIC {
            if let Some(app) = APP.get() {
                let _ = app.emit(WAKE_EVENT, ());
            }
        }
        0
    }

    pub fn start(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        // The OS keeps reading these parameters for the life of the registration: static.
        static PARAMS: DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
            DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(on_power), Context: std::ptr::null_mut() };
        let mut registration: *mut c_void = std::ptr::null_mut();
        let err = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                &PARAMS as *const _ as *mut c_void,
                &mut registration,
            )
        };
        if err != 0 {
            eprintln!("bantou: resume notification not registered (error {err})");
        }
    }
}

/// No wake notification on other platforms (Linux has no single one; the periodic refresh covers it).
#[cfg(not(any(target_os = "macos", windows)))]
mod wake {
    pub fn start(_app: &tauri::AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use netwatcher::{InterfaceDiff, IpRecord, UpdateDiff};
    use std::collections::HashMap;

    fn modified(added: usize, removed: usize) -> UpdateDiff {
        let rec = |n: usize| IpRecord { ip: std::net::Ipv4Addr::new(10, 0, 0, n as u8).into(), prefix_len: 24 };
        UpdateDiff {
            modified: HashMap::from([(
                2,
                InterfaceDiff {
                    addrs_added: (0..added).map(rec).collect(),
                    addrs_removed: (0..removed).map(rec).collect(),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        }
    }

    #[test]
    fn the_initial_snapshot_is_not_a_change() {
        assert!(!relevant(true, &modified(1, 0)));
    }

    #[test]
    fn an_empty_diff_is_not_a_change() {
        assert!(!relevant(false, &UpdateDiff::default()));
        // only the name / hardware address of an interface changed
        let renamed = UpdateDiff {
            modified: HashMap::from([(2, InterfaceDiff { name_changed: true, ..Default::default() })]),
            ..Default::default()
        };
        assert!(!relevant(false, &renamed));
    }

    #[test]
    fn a_gained_or_lost_address_is_a_change() {
        assert!(relevant(false, &modified(1, 0)));
        assert!(relevant(false, &modified(0, 1)));
    }

    #[test]
    fn an_added_or_removed_interface_is_a_change() {
        let iface = netwatcher::Interface { index: 3, name: "wlan0".into(), hw_addr: String::new(), ips: vec![] };
        let added = UpdateDiff { added: HashMap::from([(3, iface.clone())]), ..Default::default() };
        let removed = UpdateDiff { removed: HashMap::from([(3, iface)]), ..Default::default() };
        assert!(relevant(false, &added));
        assert!(relevant(false, &removed));
    }

    #[test]
    fn the_watcher_starts_on_this_host() {
        // Registers a real watcher (netlink on Linux) and drops it again.
        let h = netwatcher::watch_interfaces_with_callback(|_| {});
        assert!(h.is_ok(), "{:?}", h.err());
    }
}
