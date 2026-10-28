mod agent;
mod broker;
mod center;
mod center_mcp;
mod center_snippet;
mod error;
mod frontmatter;
mod menu;
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

pub fn run() {
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .manage(broker::Brokers::default())
        .manage(broker::Pings::default())
        .manage(agent::Agents::default())
        .manage(session::Sessions::default())
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
            session::list_peers,
            session::register_sessions,
            session::unregister_session,
            session::instruct_add_task,
            center::center_get_settings,
            center::center_set_settings,
            center::center_status,
            center::center_regenerate_token,
            center_snippet::center_connect_hosts,
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
