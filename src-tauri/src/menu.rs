use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, Emitter, EventTarget, Manager};

/// Pick the WebviewWindow that currently has keyboard focus, if any. Tauri
/// 2.11 only exposes a direct `get_focused_window` on the `Manager` trait
/// behind the `unstable` feature flag; we don't want to enable that for one
/// helper, so we walk every managed webview and ask each one whether it's
/// focused.
fn focused_webview_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    // Blank `short_version` so the About panel doesn't show "Version X (X)".
    let about_metadata = AboutMetadataBuilder::new()
        .version(Some(app.package_info().version.to_string()))
        .short_version(Some(String::new()))
        .build();

    let settings_item = MenuItemBuilder::with_id("settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let new_task_item = MenuItemBuilder::with_id("new_task", "New Task")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

    let new_window_item = MenuItemBuilder::with_id("new_window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;

    let reload_item = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "bantou")
        .about(Some(about_metadata))
        .separator()
        .item(&settings_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_task_item)
        .separator()
        .item(&new_window_item)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View").item(&reload_item).build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;

    app.set_menu(menu)?;

    // Events are scoped to the focused window via
    // `emit_to(EventTarget::webview_window(label), …)`; the frontend must
    // listen through `getCurrentWebviewWindow().listen` for the target
    // filter to discriminate.
    app.on_menu_event(|app, event| match event.id().0.as_str() {
        "settings" => {
            if let Some(window) = focused_webview_window(app) {
                let target = EventTarget::webview_window(window.label());
                let _ = app.emit_to(target, "menu:open-settings", ());
            }
        }
        "new_task" => {
            if let Some(window) = focused_webview_window(app) {
                let target = EventTarget::webview_window(window.label());
                let _ = app.emit_to(target, "menu:open-create-task", ());
            }
        }
        "new_window" => {
            if let Err(e) = crate::workspace::open_new_window_impl(app) {
                eprintln!("failed to open new window from menu: {e}");
            }
        }
        "reload" => {
            if let Some(window) = focused_webview_window(app) {
                if let Err(e) = window.reload() {
                    eprintln!("failed to reload window: {e}");
                }
            }
        }
        _ => {}
    });

    Ok(())
}
