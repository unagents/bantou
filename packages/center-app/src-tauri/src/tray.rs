//! The menu bar item (tray, #18 = A). Two entries only: "stop" and "open the config file".
//!
//! "Stop" stops the center and ends the app with status 0: launchd's KeepAlive is `SuccessfulExit: false`,
//! so a normal end is not restarted. No settings screen and no status display (#18).

use crate::{center, log};
use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

pub const ID_STOP: &str = "stop";
pub const ID_OPEN_CONFIG: &str = "open-config";

/// The entries of the menu, in order: (id, label).
pub const ITEMS: [(&str, &str); 2] = [(ID_STOP, "止める"), (ID_OPEN_CONFIG, "設定の file を開く")];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    Stop,
    OpenConfig,
}

/// The action of a menu entry id (None: not one of ours).
pub fn action_of(id: &str) -> Option<Action> {
    match id {
        ID_STOP => Some(Action::Stop),
        ID_OPEN_CONFIG => Some(Action::OpenConfig),
        _ => None,
    }
}

/// The end status of the app for "stop": 0, so that launchd does not restart it.
pub const STOP_EXIT_CODE: i32 = 0;

/// The config file the second entry opens.
pub fn config_path() -> PathBuf {
    log::state_dir().join(center::CONFIG_NAME)
}

fn run(app: &AppHandle, action: Action) {
    match action {
        // `exit` ends the runtime: `RunEvent::Exit` then stops the center (`center::stop`).
        Action::Stop => {
            log::line("menu: 止める");
            app.exit(STOP_EXIT_CODE);
        }
        Action::OpenConfig => {
            let path = config_path();
            log::line(&format!("menu: 設定の file を開く: {}", path.display()));
            // `open <file>`: the default app of the file (macOS).
            if let Err(e) = std::process::Command::new("open").arg(&path).spawn() {
                log::line(&format!("設定の file を開けない: {} ({e})", path.display()));
            }
        }
    }
}

/// Puts the menu bar item up. A failure is logged only: the center keeps running without it.
pub fn setup(app: &AppHandle) {
    if let Err(e) = build(app) {
        log::line(&format!("menu bar の項目を作れない: {e}"));
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for (id, label) in ITEMS {
        menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/32x32.png"))
        .menu(&menu)
        .on_menu_event(|app, event| {
            if let Some(action) = action_of(event.id().as_ref()) {
                run(app, action);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_has_stop_and_open_config_only() {
        let ids: Vec<&str> = ITEMS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, [ID_STOP, ID_OPEN_CONFIG]);
        assert_eq!(ITEMS[0].1, "止める");
        assert_eq!(ITEMS[1].1, "設定の file を開く");
    }

    #[test]
    fn every_item_has_an_action() {
        assert_eq!(action_of(ID_STOP), Some(Action::Stop));
        assert_eq!(action_of(ID_OPEN_CONFIG), Some(Action::OpenConfig));
        assert_eq!(action_of("other"), None);
    }

    #[test]
    fn stop_ends_normally_so_launchd_does_not_restart() {
        // KeepAlive is `SuccessfulExit: false`: only a non-zero end is restarted.
        assert_eq!(STOP_EXIT_CODE, 0);
        assert_eq!(STOP_EXIT_CODE, center::exit_code_after_center(true));
    }

    #[test]
    fn config_is_the_servers_own_file_in_the_state_dir() {
        let p = config_path();
        assert_eq!(p.file_name().unwrap(), "center-server.json");
        assert_eq!(p.parent().unwrap(), log::state_dir());
    }
}
