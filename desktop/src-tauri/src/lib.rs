mod agent;
mod broker;
mod center;
mod center_mcp;
mod center_snippet;
mod error;
mod frontmatter;
mod menu;
mod os_events;
mod security;
mod session;
mod state;
mod task;
mod thread;
mod workspace;
#[cfg(test)]
mod live_e2e;

use state::AppState;
use tauri::Manager;

/// Fixed label used for the very first window created in `setup`. Every
/// subsequent window (the `New Window` menu, the macOS Dock reopen path)
/// gets a fresh `workspace-<n>` label from `AppState::next_window_label` —
/// `main` is never reused, even after that window has been closed. The
/// `capabilities/default.json` allowlist matches both `"main"` and the
/// `"workspace-*"` glob to cover this naming convention.
const MAIN_WINDOW_LABEL: &str = "main";

/// Install the rustls crypto provider once. reqwest (feature `rustls-no-provider`, enabled by
/// `tauri-plugin-updater`) panics on `Client::build` while none is installed; the updater only
/// installs one lazily on its first check. Call before building any `reqwest::Client`.
pub(crate) fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

pub fn run() {
    ensure_crypto_provider();
    let app = tauri::Builder::default()
        // MUST be the first plugin registered (per the plugin's contract). When
        // the `bantou` CLI launches the app binary while an instance is
        // already running, this intercepts the second launch, forwards its
        // argv to the live instance via a Unix socket, and exits the spawned
        // process. The callback fires on a background task, so window work is
        // marshalled onto the main thread. The cold-start counterpart lives in
        // `setup`, which reads this process's own `std::env::args()`.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || {
                workspace::handle_cli_invocation(&handle, &argv);
            }) {
                eprintln!("failed to dispatch CLI invocation to the main thread: {e}");
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new())
        .manage(broker::Brokers::default())
        .manage(broker::Pings::default())
        .manage(agent::Agents::default())
        .manage(session::Sessions::default())
        .manage(os_events::OsEvents::default())
        .manage(center::Center::default())
        .manage(center_mcp::CenterClient::default())
        .invoke_handler(tauri::generate_handler![
            workspace::pick_directory,
            workspace::set_workspace_directory,
            workspace::get_workspace_directory,
            workspace::list_workspace_history,
            task::list_tasks,
            task::get_statuses,
            task::create_task,
            task::update_task_status,
            thread::list_threads,
            thread::get_thread,
            broker::broker_connect,
            broker::broker_status,
            broker::list_pings,
            agent::agent_open,
            agent::agent_close,
            agent::agent_say,
            agent::agent_answer,
            session::list_sessions,
            session::refresh_sessions,
            session::add_sessions,
            session::create_session,
            session::unregister_session,
            session::instruct_add_task,
            center::center_get_settings,
            center::center_set_settings,
            center::center_status,
            center::center_regenerate_token,
            center_snippet::center_local_ips,
            center::center_ip_status,
            center_snippet::center_connect_snippets,
            center_snippet::center_parse_connect,
            center_mcp::center_call,
            center_mcp::center_connection,
        ])
        .on_window_event(|window, event| {
            // `Destroyed` (not `CloseRequested`) is the right hook:
            // `CloseRequested` can be cancelled by `prevent_close()`.
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<AppState>().remove_window(window.label());
                #[cfg(target_os = "macos")]
                workspace::deregister_traffic_light_window(window);
            }
        })
        .setup(|app| {
            // Seed the `main` window's workspace into AppState *before* the
            // window is built, so the frontend's first `get_workspace_directory`
            // call already sees it.
            //
            // `bantou <path>` launched while the app was *not* already running
            // takes the cold path: this process's argv carries the directory.
            // A bare launch falls through to restoring the most recent
            // workspace from history.
            match workspace::workspace_arg_from_argv(&std::env::args().collect::<Vec<_>>()) {
                Some(dir) if dir.is_dir() => {
                    workspace::seed_window_with_workspace(app.handle(), MAIN_WINDOW_LABEL, &dir);
                }
                _ => workspace::seed_window_from_history(app.handle(), MAIN_WINDOW_LABEL),
            }

            workspace::build_workspace_window(app.handle(), MAIN_WINDOW_LABEL)?;

            menu::setup(app)?;

            center::autostart(app.handle());

            os_events::start(app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        // The wildcard arm is mandatory: `RunEvent` is `#[non_exhaustive]`.
        match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                workspace::handle_macos_reopen(app_handle);
            }
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                // Keep the process alive after the last window closes (macOS
                // convention). Programmatic exits carry `code: Some(N)` and
                // terminate as requested.
                api.prevent_exit();
            }
            tauri::RunEvent::Exit => {
                // SIGTERM the center so it can stop its remote-control children.
                tauri::async_runtime::block_on(app_handle.state::<center::Center>().stop());
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod updater_config_tests {
    //! The updater settings live in `tauri.conf.json` (`plugins.updater`) and are
    //! only parsed at runtime, so a typo would otherwise surface in a release build.
    use serde_json::Value;

    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is valid JSON")
    }

    #[test]
    fn updater_plugin_config_loads() {
        let conf = conf();
        let updater = conf["plugins"]["updater"].clone();
        let cfg: tauri_plugin_updater::Config =
            serde_json::from_value(updater).expect("plugins.updater deserializes into the plugin Config");
        assert_eq!(
            cfg.endpoints.iter().map(|u| u.as_str()).collect::<Vec<_>>(),
            ["https://github.com/unagents/bantou/releases/latest/download/latest.json"]
        );
        assert!(!cfg.pubkey.is_empty());
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], Value::Bool(true));
    }

    #[test]
    fn capabilities_allow_updater_and_relaunch() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(perms.contains(&"updater:default"));
        assert!(perms.contains(&"process:default"));
    }
}
