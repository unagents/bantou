use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;
use tauri_plugin_store::StoreExt;

pub(crate) const SETTINGS_FILE: &str = "settings.json";

/// Persisted as a JSON array of path strings, most recent first.
const WORKSPACE_HISTORY_KEY: &str = "workspace_history";

/// Upper bound on the persisted workspace history. The newest entry sits at
/// index 0; once the list reaches this cap, every subsequent
/// `set_workspace_directory` drops the oldest tail entry to make room (see
/// `prepend_unique_capped`). The number is shared by `RecentWorkspacesList`'s
/// `max-h-72 overflow-y-auto` sizing — bump this and the welcome-page list
/// stays usable, but the on-disk store of any user who shrinks the cap will
/// only truncate on the next write.
const MAX_WORKSPACE_HISTORY: usize = 50;

#[tauri::command]
pub fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_workspace_directory(
    window: tauri::WebviewWindow,
    path: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> CmdResult<()> {
    let dir = PathBuf::from(&path);

    // Do every fallible side-effect *before* touching AppState. If any of
    // the fs-scope registration, the store open, or the store save fails,
    // we return an error with no in-memory state changed — the frontend
    // sees the failure and stays on its previous workspace. The earlier
    // ordering (state mutate → fs_scope → store) left a torn window where
    // AppState already pointed at the new directory while fs_scope hadn't
    // been registered, so the per-window watcher would then refuse to
    // attach despite BoardPage thinking the workspace had switched.
    app.fs_scope()
        .allow_directory(&dir, false)
        .map_err(CommandError::other)?;
    persist_workspace_history(&app, &path)?;

    state.set_workspace(window.label(), dir);
    Ok(())
}

/// Prepend `path` to the persisted recent-workspace history (dedup + cap) and
/// save it. Shared by `set_workspace_directory` (the WelcomePage picker) and
/// the `careery <path>` CLI open path, so a workspace opened from the terminal
/// shows up in "Recent Workspaces" exactly like one opened from the UI.
fn persist_workspace_history(app: &tauri::AppHandle, path: &str) -> CmdResult<()> {
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    let existing = store.get(WORKSPACE_HISTORY_KEY);
    let history = parse_workspace_history(existing.as_ref());
    let updated = prepend_unique_capped(history, path.to_string(), MAX_WORKSPACE_HISTORY);
    store.set(WORKSPACE_HISTORY_KEY, history_to_json(&updated));
    store.save().map_err(CommandError::other)?;
    Ok(())
}

#[tauri::command]
pub fn get_workspace_directory(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Option<String> {
    // No history fallback here: that auto-restore now lives in
    // `seed_window_from_history` (called from `lib.rs::setup` for the `main`
    // window at process start, and from the `RunEvent::Reopen` handler for
    // Dock-revive). Putting the fallback in this command would re-introduce
    // the multi-window bug where a freshly-opened "New Window" window would
    // silently inherit the most-recent workspace instead of starting in the
    // empty welcome state — the command runs per-window and would happily
    // fill in any window that asks.
    state
        .workspace(window.label())
        .map(|dir| dir.to_string_lossy().to_string())
}

/// List of workspaces that the user has previously opened, filtered down to
/// directories that still exist on disk. Backs the "Recent Workspaces" panel
/// on the welcome page.
///
/// The persisted `workspace_history` value is **not** mutated — entries that
/// fail `is_dir()` are merely hidden from this response. A workspace whose
/// disk is temporarily unmounted will reappear in the picker as soon as the
/// drive comes back online, instead of being silently forgotten.
#[tauri::command]
pub fn list_workspace_history(app: tauri::AppHandle) -> Vec<String> {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        return Vec::new();
    };
    let history = parse_workspace_history(store.get(WORKSPACE_HISTORY_KEY).as_ref());
    filter_existing_directories(&history)
}

/// Apply the same `is_dir()` survival check the welcome page uses, without
/// touching the persisted history. Pulled out as a pure helper so the
/// behaviour can be exercised by unit tests without spinning up a Tauri
/// runtime.
fn filter_existing_directories(history: &[String]) -> Vec<String> {
    history
        .iter()
        .filter(|s| PathBuf::from(s).is_dir())
        .cloned()
        .collect()
}

/// Seed a window's workspace from the persisted history. Shared by
/// `lib.rs::setup` (called once at process start to restore `main`) and the
/// macOS Dock-reopen handler (called when the user re-activates careery after
/// closing every window).
///
/// **Order matters at call sites**: the AppState write must complete *before*
/// the corresponding window is built, otherwise the frontend's
/// `useCurrentDir` can race the seed and read `None` from
/// `get_workspace_directory`, dropping the user into WelcomePage when they
/// expected BoardPage.
///
/// History entries that no longer resolve to a directory are skipped (drive
/// unplugged, directory deleted, replaced by a file); the first surviving
/// entry wins. The persisted history itself is left untouched — startup /
/// reopen is a "read the most recent intent" event, not a new open event,
/// so the order remains driven exclusively by `set_workspace_directory`
/// calls.
pub fn seed_window_from_history(app: &tauri::AppHandle, label: &str) {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        return;
    };
    let history = parse_workspace_history(store.get(WORKSPACE_HISTORY_KEY).as_ref());
    let Some(dir) = history
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_dir())
    else {
        return;
    };

    let state = app.state::<AppState>();
    state.set_workspace(label, dir.clone());
    if let Err(e) = app.fs_scope().allow_directory(&dir, false) {
        eprintln!("failed to allow directory in fs scope: {e}");
    }
}

/// macOS window dressing applied to both the `main` window (in `lib.rs::setup`)
/// and to every subsequent `workspace-<n>` window opened via the menu or the
/// Reopen handler. Pulled out so the two call sites can't drift apart
/// visually.
#[cfg(target_os = "macos")]
fn apply_macos_window_chrome(window: &WebviewWindow) {
    use objc2_app_kit::{NSColor, NSWindow};

    if let Ok(ns_window_ptr) = window.ns_window() {
        let ns_window_ptr = ns_window_ptr as *mut NSWindow;
        // SAFETY: Tauri's `ns_window()` returns a valid `NSWindow*` for the
        // lifetime of the WebviewWindow. We only deref it for the duration of
        // the call to set the background colour and immediately let the
        // reference go.
        let ns_window = unsafe { &*ns_window_ptr };
        let bg_color = NSColor::colorWithRed_green_blue_alpha(
            2.0 / 255.0,
            6.0 / 255.0,
            23.0 / 255.0,
            1.0,
        );
        ns_window.setBackgroundColor(Some(&bg_color));

        // Tauri's `traffic_light_position` only sticks for tao's `drawRect:`
        // path; AppKit relayouts triggered by window-level screen recording
        // (the traffic lights are hidden while capturing and re-shown when
        // it stops) bypass that path, leaving the buttons at AppKit's default
        // top-left position. Hook NSNotificationCenter to snap them back.
        unsafe { install_traffic_light_repositioner(ns_window) };
    }
}

/// Logical-point offset of the top-left traffic light from the window's
/// top-left corner. Must mirror the literal passed to `traffic_light_position`
/// in `build_workspace_window` — Tauri/tao set the initial position; we
/// restore the same offset on every subsequent relayout.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 20.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 28.0;
/// macOS traffic-light spacing. Hard-coded — the live `miniaturize.x - close.x`
/// delta is unreliable once close has been moved to our offset (the next
/// reapply would read a clustered delta and snap the other two buttons in).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_SPACING: f64 = 20.0;
/// Nominal traffic-light button height. Used to size the private titlebar
/// container view in `reapply_traffic_light_position`. Reading the live
/// `close.frame().size.height` returns 0 while AppKit is mid-transition
/// (notably during recording start), collapsing the container.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_BUTTON_HEIGHT: f64 = 15.0;

/// NSWindow pointers we've installed our notification observer for. The
/// observer block ignores any other window — necessary because the
/// notification filter is by raw NSWindow address, and macOS happily reuses a
/// freed NSWindow's address for unrelated windows (e.g. `rfd`'s open panel).
/// Without this check the stale observer would mangle their titlebars.
#[cfg(target_os = "macos")]
static OBSERVED_WINDOWS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<usize>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn observed_windows() -> &'static std::sync::Mutex<std::collections::HashSet<usize>> {
    OBSERVED_WINDOWS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Drop the registry entry for a window that's about to be destroyed, so the
/// observer no longer reacts if the NSWindow's address gets recycled. Called
/// from `lib.rs::on_window_event` on `WindowEvent::Destroyed`. Best-effort:
/// `ns_window()` failing means there's nothing to deregister.
#[cfg(target_os = "macos")]
pub(crate) fn deregister_traffic_light_window<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Ok(ptr) = window.ns_window() else { return };
    observed_windows().lock().unwrap().remove(&(ptr as usize));
}

/// Subscribe to `NSWindowDidUpdateNotification` and re-apply the traffic-light
/// offset whenever any of the three standard buttons drifts. Post-layout, so
/// the steady-state path is a single guard check; AppKit isn't fought.
#[cfg(target_os = "macos")]
unsafe fn install_traffic_light_repositioner(ns_window: &objc2_app_kit::NSWindow) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWindow, NSWindowDidUpdateNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    observed_windows()
        .lock()
        .unwrap()
        .insert(ns_window as *const _ as usize);

    let center = NSNotificationCenter::defaultCenter();
    let window_filter: &AnyObject =
        unsafe { &*(ns_window as *const _ as *const AnyObject) };

    let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
        let notification = unsafe { notification.as_ref() };
        let Some(obj) = notification.object() else {
            return;
        };
        let posting_window: &NSWindow =
            unsafe { &*(&*obj as *const AnyObject as *const NSWindow) };
        if !observed_windows()
            .lock()
            .unwrap()
            .contains(&(posting_window as *const _ as usize))
        {
            return;
        }
        unsafe { reapply_traffic_lights_if_needed(posting_window) };
    });
    // NotificationCenter retains the observer strongly; the token we discard
    // here only loses our extra reference. Observation continues until app
    // termination — `deregister_traffic_light_window` short-circuits the
    // block body for windows that are gone.
    let _token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidUpdateNotification),
            Some(window_filter),
            None,
            &block,
        )
    };
}

/// Verify all three traffic lights sit at the offsets we want, and reapply
/// when they don't. Combines the guard and the apply step so the steady-state
/// path is three `standardWindowButton` + three `frame` reads — and nothing
/// else. AppKit's recording-end relayout can reset only one or two buttons,
/// so the guard must inspect all three.
///
/// SAFETY: Caller must pass a live `NSWindow` with a titlebar style.
/// Missing buttons (`Closable` / `Miniaturizable` stripped from the style
/// mask) are treated as "no work to do" — no reapply attempt is made.
#[cfg(target_os = "macos")]
unsafe fn reapply_traffic_lights_if_needed(ns_window: &objc2_app_kit::NSWindow) {
    use objc2_app_kit::NSWindowButton;
    use objc2_foundation::NSPoint;
    const EPS: f64 = 0.5;

    let close = ns_window.standardWindowButton(NSWindowButton::CloseButton);
    let miniaturize = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton);
    let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);
    let (Some(close), Some(miniaturize), Some(zoom)) = (close, miniaturize, zoom) else {
        return;
    };

    let buttons = [&close, &miniaturize, &zoom];
    let at_target = buttons.iter().enumerate().all(|(i, b)| {
        let want = TRAFFIC_LIGHT_X + (i as f64) * TRAFFIC_LIGHT_SPACING;
        (b.frame().origin.x - want).abs() < EPS
    });
    if at_target {
        return;
    }

    // close → its superview → the private titlebar container view (port of
    // tao's `inset_traffic_lights`).
    let Some(title_bar_container_view) = (unsafe { close.superview() })
        .and_then(|sv| unsafe { sv.superview() })
    else {
        return;
    };

    let title_bar_frame_height = TRAFFIC_LIGHT_BUTTON_HEIGHT + TRAFFIC_LIGHT_Y;
    let mut title_bar_rect = title_bar_container_view.frame();
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = ns_window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    for (i, button) in buttons.iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = TRAFFIC_LIGHT_X + (i as f64) * TRAFFIC_LIGHT_SPACING;
        button.setFrameOrigin(NSPoint::new(origin.x, origin.y));
    }
}

/// Build a workspace-flavoured `WebviewWindow`. This is the single source of
/// truth for window sizing, title-bar style, and macOS background colour — if
/// you tweak any visual property here it propagates to every window the app
/// can open (startup `main`, `New Window` menu, Dock reopen).
pub(crate) fn build_workspace_window(
    app: &tauri::AppHandle,
    label: &str,
) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("")
        .inner_size(1280.0, 800.0);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        ));

    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    apply_macos_window_chrome(&window);

    Ok(window)
}

/// Open a brand-new welcome window. Wired up to the `File > New Window` menu
/// item — *not* exposed as a Tauri command, because v1 has no frontend caller
/// for this path. The new window is deliberately left without a workspace
/// seeded into `AppState`, so the frontend boots into WelcomePage and lets
/// the user choose between the directory picker and the Recent Workspaces
/// list.
pub(crate) fn open_new_window_impl(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let label = state.next_window_label();
    build_workspace_window(app, &label)
}

/// Mint a fresh window label, seed it via `seed`, then build the window —
/// cleaning up the AppState entry if the build fails. The shared skeleton
/// behind both the Dock-reopen history restore and the `careery <path>` CLI open;
/// the only thing that differs between them is how the label is seeded.
///
/// **Seed FIRST, build SECOND**: the webview's JS execution starts as soon as
/// `build()` returns, so a seed-after-build sequence would let `useCurrentDir`
/// race and read `None` before the AppState write lands, dropping the user into
/// WelcomePage. On build failure the seeded entry must be removed explicitly —
/// no `WindowEvent::Destroyed` fires for a window that never came up, so the
/// entry would otherwise leak for the process's lifetime.
fn build_seeded_window(
    app: &tauri::AppHandle,
    seed: impl FnOnce(&tauri::AppHandle, &str),
) -> tauri::Result<WebviewWindow> {
    let label = app.state::<AppState>().next_window_label();
    seed(app, &label);
    match build_workspace_window(app, &label) {
        Ok(window) => Ok(window),
        Err(e) => {
            app.state::<AppState>().remove_window(&label);
            Err(e)
        }
    }
}

#[cfg(target_os = "macos")]
fn reopen_with_history_restore(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    build_seeded_window(app, seed_window_from_history)
}

/// macOS Dock-icon reactivation path. Called from the `RunEvent::Reopen`
/// handler in `lib.rs::run` whenever AppKit's
/// `applicationShouldHandleReopen:hasVisibleWindows:` reports
/// `hasVisibleWindows == false`.
///
/// That single signal covers three distinct user states — all windows closed,
/// the app hidden via `Cmd+H`, every window minimised via `Cmd+M` — and the
/// correct response differs:
///
/// - **Truly zero windows**: open a fresh `workspace-<n>` window and seed it
///   with the most recent live workspace so the user is dropped right back
///   where they left off, mirroring the cold-start UX.
/// - **Hidden or minimised**: every window still exists, so don't pile a new
///   one on top — instead un-minimise, un-hide, and refocus each existing
///   window. Creating another window in this branch would be the headline
///   bug this whole helper exists to avoid.
#[cfg(target_os = "macos")]
pub(crate) fn handle_macos_reopen(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        if let Err(e) = reopen_with_history_restore(app) {
            eprintln!("failed to open a window in response to Dock reopen: {e}");
        }
        return;
    }
    for (_, window) in windows {
        raise_window(&window);
    }
}

/// Bring a window to the foreground. The order is load-bearing: un-minimise and
/// show *before* focusing, because tao's `set_focus` (which also activates the
/// app via `activateIgnoringOtherApps:`) is a no-op on a minimised or hidden
/// window — so raising careery from the background would otherwise silently fail.
/// Shared by the Dock-reopen path and the `careery` CLI handler.
fn raise_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Extract the workspace-directory argument from a process argv vector. argv[0]
/// is the executable path; the `careery` CLI passes the workspace as the first
/// positional. Anything starting with `-` is skipped so a stray launch flag
/// (e.g. a legacy macOS `-psn_*` process-serial argument) can never be mistaken
/// for a directory. Returns `None` when there's no positional — the
/// "open a new empty window" case.
///
/// Pure (no IO) so the cold-start and warm-start argv parsing share one tested
/// implementation. Both call sites feed it an absolute path (the CLI
/// canonicalizes before launching), so no working-directory context is needed.
pub(crate) fn workspace_arg_from_argv(argv: &[String]) -> Option<PathBuf> {
    argv.iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
}

/// Handle a `careery` CLI invocation forwarded to the already-running instance by
/// `tauri-plugin-single-instance`. No path → open a fresh welcome window (the
/// `File > New Window` behaviour). A path → focus the window already hosting
/// that workspace, or open a new window seeded with it. Either way the
/// resulting window is raised so careery comes to the foreground in front of the
/// terminal the command was typed into.
///
/// **Must run on the main thread.** The single-instance callback fires on a
/// background task (`tauri::async_runtime::spawn`), but window creation on
/// macOS has to happen on the main thread — `lib.rs` marshals this call through
/// `AppHandle::run_on_main_thread`.
pub(crate) fn handle_cli_invocation(app: &tauri::AppHandle, argv: &[String]) {
    // `filter(is_dir)` mirrors the cold-start guard in `lib.rs::setup`: a path
    // that no longer resolves to a directory — deleted or unmounted in the race
    // between the CLI validating it and this forwarded argv arriving — is
    // treated like a bare `careery` and opens a fresh welcome window, rather than
    // seeding a dead workspace and pushing the dead path into Recent
    // Workspaces. Without this, the warm path diverged from the cold path,
    // which already falls back when the directory is gone.
    let window = match workspace_arg_from_argv(argv).filter(|dir| dir.is_dir()) {
        Some(dir) => open_or_focus_workspace(app, &dir),
        None => match open_new_window_impl(app) {
            Ok(window) => Some(window),
            Err(e) => {
                eprintln!("failed to open new window from CLI: {e}");
                None
            }
        },
    };

    if let Some(window) = window {
        raise_window(&window);
    }
}

/// Focus the window already showing `dir`, or open a new one seeded with it.
/// Returns the window to raise (`None` only if opening a new window failed).
fn open_or_focus_workspace(app: &tauri::AppHandle, dir: &Path) -> Option<WebviewWindow> {
    if let Some(label) = find_window_for_workspace(app, dir) {
        if let Some(window) = app.get_webview_window(&label) {
            return Some(window);
        }
    }
    match open_workspace_window(app, dir) {
        Ok(window) => Some(window),
        Err(e) => {
            eprintln!("failed to open workspace window from CLI: {e}");
            None
        }
    }
}

/// Find an existing window whose workspace resolves to the same directory as
/// `target`, so `careery <path>` focuses an open workspace instead of opening a
/// duplicate. Both sides are canonicalized before comparison because a stored
/// workspace may carry symlinks or `.`/`..` segments the picker never resolved.
fn find_window_for_workspace(app: &tauri::AppHandle, target: &Path) -> Option<String> {
    let target = canonical_or_raw(target);
    let state = app.state::<AppState>();
    app.webview_windows().into_keys().find(|label| {
        state
            .workspace(label)
            .is_some_and(|ws| canonical_or_raw(&ws) == target)
    })
}

/// Canonicalize for comparison, falling back to the path as-is when
/// canonicalization fails (e.g. the directory was unmounted). Routes through
/// `security::canonical_workspace` so all workspace-path canonicalization stays
/// funnelled through the security module; the fallback degrades matching to
/// plain path equality rather than panicking.
fn canonical_or_raw(path: &Path) -> PathBuf {
    crate::security::canonical_workspace(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Open a new window seeded with an explicit workspace directory (the
/// `careery <path>` CLI path). The explicit-directory counterpart of
/// `reopen_with_history_restore`: same `build_seeded_window` skeleton, but the
/// workspace comes from the CLI argument rather than the persisted history.
fn open_workspace_window(app: &tauri::AppHandle, dir: &Path) -> tauri::Result<WebviewWindow> {
    build_seeded_window(app, |app, label| seed_window_with_workspace(app, label, dir))
}

/// Seed a window's AppState with an explicit workspace directory, register its
/// fs scope, and record it in the recent-workspace history. The explicit-path
/// sibling of `seed_window_from_history`: a `careery <path>` open is a genuine
/// open event (like the WelcomePage picker), so unlike the history-restore
/// path it *does* push onto the history. Best-effort — fs-scope and history
/// failures are logged but don't block the window from opening, mirroring
/// `seed_window_from_history`.
pub(crate) fn seed_window_with_workspace(app: &tauri::AppHandle, label: &str, dir: &Path) {
    let state = app.state::<AppState>();
    state.set_workspace(label, dir.to_path_buf());
    if let Err(e) = app.fs_scope().allow_directory(dir, false) {
        eprintln!("failed to allow directory in fs scope: {e}");
    }
    if let Err(e) = persist_workspace_history(app, &dir.to_string_lossy()) {
        eprintln!("failed to record workspace history: {e}");
    }
}

/// Lenient on input shape: a missing key, a non-array value, or non-string
/// array entries produce an empty list rather than an error. The history is
/// best-effort UX state — refusing to start because of a hand-edited
/// settings file would be worse than dropping the bad entries and letting
/// the next write rebuild it cleanly.
fn parse_workspace_history(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

fn prepend_unique_capped(mut list: Vec<String>, new: String, cap: usize) -> Vec<String> {
    list.retain(|p| p != &new);
    list.insert(0, new);
    list.truncate(cap);
    list
}

fn history_to_json(history: &[String]) -> serde_json::Value {
    serde_json::Value::Array(
        history
            .iter()
            .cloned()
            .map(serde_json::Value::String)
            .collect(),
    )
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    // --- filter_existing_directories -------------------------------------------

    #[test]
    fn filter_existing_directories_keeps_only_real_dirs() {
        // Build a small mix on a real temp filesystem so `is_dir()` actually
        // discriminates: two real dirs, one missing path, one regular file.
        let tmp = TempDir::new().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        let file_c = tmp.path().join("c.txt");
        let missing = tmp.path().join("does-not-exist");
        std::fs::create_dir(&dir_a).unwrap();
        std::fs::create_dir(&dir_b).unwrap();
        std::fs::write(&file_c, "").unwrap();

        let history = vec![
            dir_a.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
            dir_b.to_string_lossy().to_string(),
            file_c.to_string_lossy().to_string(),
        ];

        let result = filter_existing_directories(&history);
        assert_eq!(
            result,
            vec![
                dir_a.to_string_lossy().to_string(),
                dir_b.to_string_lossy().to_string(),
            ],
        );
    }

    #[test]
    fn filter_existing_directories_preserves_order() {
        // Same survival check, but the relative order of the survivors must
        // not change — Recent Workspaces UI presents most-recent-first.
        let tmp = TempDir::new().unwrap();
        let dir_first = tmp.path().join("first");
        let dir_last = tmp.path().join("last");
        std::fs::create_dir(&dir_first).unwrap();
        std::fs::create_dir(&dir_last).unwrap();
        let missing = tmp.path().join("ghost");

        let history = vec![
            dir_first.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
            dir_last.to_string_lossy().to_string(),
        ];

        let result = filter_existing_directories(&history);
        assert_eq!(result[0], dir_first.to_string_lossy().to_string());
        assert_eq!(result[1], dir_last.to_string_lossy().to_string());
    }

    #[test]
    fn filter_existing_directories_empty_input_returns_empty() {
        assert!(filter_existing_directories(&[]).is_empty());
    }

    #[test]
    fn filter_existing_directories_does_not_mutate_input() {
        // The persisted history list must stay intact — survival filtering
        // is a *view* of the history, not a clean-up pass.
        let tmp = TempDir::new().unwrap();
        let dir_alive = tmp.path().join("alive");
        std::fs::create_dir(&dir_alive).unwrap();
        let missing = tmp.path().join("gone");

        let original = vec![
            dir_alive.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        let cloned = original.clone();
        let _ = filter_existing_directories(&original);
        assert_eq!(original, cloned);
    }

    #[test]
    fn parse_workspace_history_returns_empty_for_none() {
        assert!(parse_workspace_history(None).is_empty());
    }

    #[test]
    fn parse_workspace_history_parses_array_of_strings() {
        let value = json!(["/a", "/b", "/c"]);
        let parsed = parse_workspace_history(Some(&value));
        assert_eq!(parsed, vec!["/a", "/b", "/c"]);
    }

    #[test]
    fn parse_workspace_history_drops_non_string_entries() {
        let value = json!(["/a", 1, null, "/b", true, {}]);
        let parsed = parse_workspace_history(Some(&value));
        assert_eq!(parsed, vec!["/a", "/b"]);
    }

    #[test]
    fn parse_workspace_history_returns_empty_for_non_array() {
        for v in [json!("not array"), json!({}), json!(42), json!(null)] {
            assert!(
                parse_workspace_history(Some(&v)).is_empty(),
                "expected empty for {v}"
            );
        }
    }

    #[test]
    fn prepend_unique_inserts_into_empty_list() {
        let result = prepend_unique_capped(Vec::new(), "/a".to_string(), 10);
        assert_eq!(result, vec!["/a".to_string()]);
    }

    #[test]
    fn prepend_unique_pushes_new_entry_to_front() {
        let result = prepend_unique_capped(
            vec!["/b".to_string(), "/c".to_string()],
            "/a".to_string(),
            10,
        );
        assert_eq!(
            result,
            vec!["/a".to_string(), "/b".to_string(), "/c".to_string()]
        );
    }

    #[test]
    fn prepend_unique_dedupes_and_moves_existing_entry_to_front() {
        let result = prepend_unique_capped(
            vec!["/b".to_string(), "/a".to_string(), "/c".to_string()],
            "/a".to_string(),
            10,
        );
        assert_eq!(
            result,
            vec!["/a".to_string(), "/b".to_string(), "/c".to_string()]
        );
    }

    #[test]
    fn prepend_unique_is_noop_when_entry_already_at_front() {
        let result = prepend_unique_capped(
            vec!["/a".to_string(), "/b".to_string()],
            "/a".to_string(),
            10,
        );
        assert_eq!(result, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn prepend_unique_truncates_to_cap() {
        let result = prepend_unique_capped(
            vec!["/x".to_string(), "/y".to_string(), "/z".to_string()],
            "/a".to_string(),
            2,
        );
        assert_eq!(result, vec!["/a".to_string(), "/x".to_string()]);
    }

    #[test]
    fn prepend_unique_dedupes_entries_past_the_cap() {
        // Dedup runs before truncation, so an existing entry currently sitting
        // beyond `cap` is still removed before promotion — preventing it
        // from re-appearing alongside the new front entry.
        let result = prepend_unique_capped(
            vec!["/x".to_string(), "/y".to_string(), "/a".to_string()],
            "/a".to_string(),
            2,
        );
        assert_eq!(result, vec!["/a".to_string(), "/x".to_string()]);
    }

    #[test]
    fn prepend_unique_caps_at_one_keeps_only_the_new_entry() {
        let result = prepend_unique_capped(
            vec!["/x".to_string(), "/y".to_string()],
            "/a".to_string(),
            1,
        );
        assert_eq!(result, vec!["/a".to_string()]);
    }

    #[test]
    fn history_to_json_emits_plain_string_array() {
        // Pins the on-disk shape so a future refactor of `history_to_json`
        // can't silently break existing users' settings files.
        let value = history_to_json(&["/a".to_string(), "/b".to_string()]);
        assert_eq!(value, json!(["/a", "/b"]));
    }

    #[test]
    fn history_to_json_roundtrips_through_parse() {
        let original = vec!["/a".to_string(), "/b".to_string(), "/c".to_string()];
        let value = history_to_json(&original);
        let parsed = parse_workspace_history(Some(&value));
        assert_eq!(parsed, original);
    }

    // --- workspace_arg_from_argv -----------------------------------------------

    #[test]
    fn workspace_arg_returns_none_when_only_the_binary_is_present() {
        // Bare `careery` (and any normal Dock/Finder launch) → new empty window.
        assert_eq!(workspace_arg_from_argv(&["/path/to/careery".to_string()]), None);
    }

    #[test]
    fn workspace_arg_returns_none_for_empty_argv() {
        assert_eq!(workspace_arg_from_argv(&[]), None);
    }

    #[test]
    fn workspace_arg_picks_the_first_positional() {
        let argv = vec!["/path/to/careery".to_string(), "/work/board".to_string()];
        assert_eq!(
            workspace_arg_from_argv(&argv),
            Some(PathBuf::from("/work/board"))
        );
    }

    #[test]
    fn workspace_arg_skips_leading_flags() {
        // A stray launch flag (e.g. a legacy macOS `-psn_*` argument) must not
        // be mistaken for the workspace directory.
        let argv = vec![
            "/path/to/careery".to_string(),
            "-psn_0_12345".to_string(),
            "/work/board".to_string(),
        ];
        assert_eq!(
            workspace_arg_from_argv(&argv),
            Some(PathBuf::from("/work/board"))
        );
    }

    #[test]
    fn workspace_arg_returns_none_when_every_arg_is_a_flag() {
        let argv = vec!["/path/to/careery".to_string(), "-psn_0_12345".to_string()];
        assert_eq!(workspace_arg_from_argv(&argv), None);
    }
}
