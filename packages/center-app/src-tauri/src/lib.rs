//! bantou-center.app: the windowless app (the "server" form (b) of the center, docs/design/center-graphql-server.md 2.7).
//!
//! Started, it keeps one center process running (`center.rs`) and registers itself as a launchd
//! agent (`login_item.rs`, #14 = A). No window and no Dock icon (#15 = X): the app is only the
//! parent of the center. launchd restarts the app after an abnormal exit (KeepAlive), and the
//! app ends with the center's exit status, so a center that ended normally (e.g. its port is
//! already in use) is not restarted in a loop (#16).

mod center;
mod log;
mod login_item;
mod tray;

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
            login_item::ensure_registered();
            tray::setup(app.handle());
            center::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building bantou-center");

    app.run(|_app, event| match event {
        // No window ever exists, so the runtime would quit on its own: only an explicit exit (`code` set) quits.
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => center::stop(),
        _ => {}
    });
}
