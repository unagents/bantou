//! bantou-center.app: the windowless app (the "server" form (b) of the center, docs/design/center-graphql-server.md 2.7).
//!
//! Started, it keeps one center process running (`center.rs`) and registers itself as a launchd
//! agent (`login_item.rs`, #14 = A). No window and no Dock icon (#15 = X): the app is only the
//! parent of the center. launchd restarts the app after an abnormal exit (KeepAlive). When the
//! center ends, the app ends with 0 if another center uses the configured port now (it yields,
//! no restart loop, #16), and with 1 otherwise (launchd restarts it).
//! An instance started from Finder, once registered, leaves the center to launchd's instance and exits 0.

mod center;
mod log;
mod login_item;
mod tray;

use std::sync::atomic::{AtomicI32, Ordering};
use tauri::RunEvent;

pub fn run() {
    let app = tauri::Builder::default()
        // Already running (launchd started it, then someone opens the app): do nothing (#16).
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .setup(|app| {
            // No Dock icon, no menu bar of its own.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            log::line("start");
            let reg = login_item::ensure_registered();
            let launchd_job = login_item::is_launchd_job(std::env::var("XPC_SERVICE_NAME").ok().as_deref());
            if !login_item::should_start_center(launchd_job, reg) {
                // Registered: launchd's instance keeps the center. Not started by this (Finder's) instance, so no double start.
                log::line("launchd の instance に任せて終わる");
                std::process::exit(0);
            }
            tray::setup(app.handle());
            center::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building bantou-center");

    // `app.exit(code)` only ends the event loop: tauri-runtime-wry sets `ControlFlow::Exit` and drops `code`,
    // so the process would end with 0 (launchd then sees a successful exit and does not restart). The code is
    // kept here and the process ends with it after the loop (`run_return`, not `run`).
    app.run_return(|_app, event| match event {
        // No window ever exists, so the runtime would quit on its own: only an explicit exit (`code` set) quits.
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            } else {
                remember_exit_code(&EXIT_CODE, code);
            }
        }
        RunEvent::Exit => center::stop(),
        _ => {}
    });
    std::process::exit(EXIT_CODE.load(Ordering::SeqCst));
}

/// The end status of the process, set by the explicit exit (`app.exit(code)`).
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

/// Keeps the code of an explicit exit (`None`: not an explicit exit, nothing kept).
fn remember_exit_code(slot: &AtomicI32, code: Option<i32>) {
    if let Some(c) = code {
        slot.store(c, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_exit_code_is_kept_for_the_process_end() {
        let slot = AtomicI32::new(0);
        remember_exit_code(&slot, None);
        assert_eq!(slot.load(Ordering::SeqCst), 0);
        remember_exit_code(&slot, Some(1));
        assert_eq!(slot.load(Ordering::SeqCst), 1);
        // The code the app picks after the center ended is what the process ends with.
        remember_exit_code(&slot, Some(center::exit_code_after_center(false)));
        assert_eq!(slot.load(Ordering::SeqCst), 1);
        remember_exit_code(&slot, Some(center::exit_code_after_center(true)));
        assert_eq!(slot.load(Ordering::SeqCst), 0);
    }
}
