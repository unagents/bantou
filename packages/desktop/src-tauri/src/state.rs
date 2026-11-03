use crate::error::{CmdResult, CommandError};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// All AppState entries tied to a single window. bantou has no per-window
/// cache (tasks are re-read from disk on every `list_tasks`), so for now
/// this is just the workspace directory — the struct stays so a cache can be
/// added later without changing the locking shape.
#[derive(Default)]
struct WindowState {
    workspace: Option<PathBuf>,
}

/// Process-wide AppState. Per-window slots live in `windows`, keyed by the
/// `WebviewWindow::label()` value of each window, so two windows can hold
/// independent workspaces without interfering with each other.
///
/// `next_window_id` feeds `next_window_label` and is never decremented:
/// every new window (Reopen / `File > New Window`) gets a fresh
/// `workspace-<n>` label. The first window created at process start has the
/// fixed label `"main"` (set by `lib.rs::setup`); every other window picks
/// up the next counter value. The `capabilities/default.json` allowlist
/// matches both `"main"` and the `"workspace-*"` glob so this naming
/// convention is the single source of truth.
pub struct AppState {
    windows: Mutex<HashMap<String, WindowState>>,
    next_window_id: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
            next_window_id: AtomicU64::new(0),
        }
    }

    pub fn workspace(&self, label: &str) -> Option<PathBuf> {
        self.windows
            .lock()
            .unwrap()
            .get(label)
            .and_then(|s| s.workspace.clone())
    }

    pub fn require_workspace(&self, label: &str) -> CmdResult<PathBuf> {
        self.workspace(label).ok_or(CommandError::NoWorkspace)
    }

    /// Replace the workspace for one window, leaving other windows untouched.
    pub fn set_workspace(&self, label: &str, dir: PathBuf) {
        let mut all = self.windows.lock().unwrap();
        let entry = all.entry(label.to_string()).or_default();
        entry.workspace = Some(dir);
    }

    /// Drop the entire `WindowState` for a closed window. Called from the
    /// `WindowEvent::Destroyed` handler in `lib.rs` so the map doesn't grow
    /// indefinitely across an interactive session that opens and closes
    /// many windows.
    pub fn remove_window(&self, label: &str) {
        self.windows.lock().unwrap().remove(label);
    }

    /// Mint a fresh, never-reused window label of the form `workspace-<n>`.
    /// The counter is monotonic for the lifetime of the process — closing a
    /// window does not free its label.
    pub fn next_window_label(&self) -> String {
        let n = self.next_window_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("workspace-{n}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    const MAIN: &str = "main";
    const W1: &str = "workspace-1";

    #[test]
    fn new_starts_empty() {
        let state = AppState::new();
        assert!(state.workspace(MAIN).is_none());
        assert!(matches!(
            state.require_workspace(MAIN),
            Err(CommandError::NoWorkspace)
        ));
    }

    #[test]
    fn set_then_get_round_trips() {
        let state = AppState::new();
        let dir = PathBuf::from("/tmp/careery-test");
        state.set_workspace(MAIN, dir.clone());
        assert_eq!(state.workspace(MAIN), Some(dir.clone()));
        assert_eq!(state.require_workspace(MAIN).unwrap(), dir);
    }

    #[test]
    fn set_replaces_previous_value_for_same_label() {
        let state = AppState::new();
        state.set_workspace(MAIN, PathBuf::from("/tmp/a"));
        state.set_workspace(MAIN, PathBuf::from("/tmp/b"));
        assert_eq!(state.workspace(MAIN), Some(PathBuf::from("/tmp/b")));
    }

    #[test]
    fn workspace_returns_clone_not_reference() {
        let state = AppState::new();
        state.set_workspace(MAIN, PathBuf::from("/tmp/clone-check"));
        let first = state.workspace(MAIN).unwrap();
        let second = state.workspace(MAIN).unwrap();
        assert_eq!(first, second);
        state.set_workspace(MAIN, PathBuf::from("/tmp/after"));
        assert_eq!(state.workspace(MAIN).unwrap(), PathBuf::from("/tmp/after"));
    }

    #[test]
    fn shared_across_threads_via_arc() {
        let state = Arc::new(AppState::new());
        let writers: Vec<_> = (0..8)
            .map(|i| {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    state.set_workspace(MAIN, PathBuf::from(format!("/tmp/w{i}")));
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        let got = state.workspace(MAIN).expect("some writer must have won");
        let s = got.to_string_lossy();
        assert!(s.starts_with("/tmp/w") && s.len() == 7, "unexpected value: {got:?}");
    }

    // --- per-window isolation -------------------------------------------------

    #[test]
    fn workspaces_are_isolated_by_label() {
        let state = AppState::new();
        state.set_workspace(MAIN, PathBuf::from("/tmp/A"));
        state.set_workspace(W1, PathBuf::from("/tmp/B"));
        assert_eq!(state.workspace(MAIN), Some(PathBuf::from("/tmp/A")));
        assert_eq!(state.workspace(W1), Some(PathBuf::from("/tmp/B")));
        state.set_workspace(MAIN, PathBuf::from("/tmp/C"));
        assert_eq!(state.workspace(MAIN), Some(PathBuf::from("/tmp/C")));
        assert_eq!(state.workspace(W1), Some(PathBuf::from("/tmp/B")));
    }

    #[test]
    fn remove_window_clears_only_that_window() {
        let state = AppState::new();
        state.set_workspace(W1, PathBuf::from("/tmp/B"));
        state.set_workspace(MAIN, PathBuf::from("/tmp/A"));
        state.remove_window(W1);
        assert!(state.workspace(W1).is_none());
        assert_eq!(state.workspace(MAIN), Some(PathBuf::from("/tmp/A")));
    }

    #[test]
    fn remove_window_is_no_op_for_unknown_label() {
        let state = AppState::new();
        state.set_workspace(MAIN, PathBuf::from("/tmp/A"));
        state.remove_window("never-existed");
        assert_eq!(state.workspace(MAIN), Some(PathBuf::from("/tmp/A")));
    }

    // --- next_window_label ----------------------------------------------------

    #[test]
    fn next_window_label_is_monotonic() {
        let state = AppState::new();
        assert_eq!(state.next_window_label(), "workspace-1");
        assert_eq!(state.next_window_label(), "workspace-2");
        assert_eq!(state.next_window_label(), "workspace-3");
    }

    #[test]
    fn next_window_label_is_unique_across_threads() {
        let state = Arc::new(AppState::new());
        let n = 32;
        let handles: Vec<_> = (0..n)
            .map(|_| {
                let s = Arc::clone(&state);
                thread::spawn(move || s.next_window_label())
            })
            .collect();
        let mut labels: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        labels.sort();
        labels.dedup();
        assert_eq!(labels.len(), n);
        for label in &labels {
            assert!(label.starts_with("workspace-"), "unexpected label {label}");
        }
    }

    #[test]
    fn next_window_label_continues_after_window_removed() {
        let state = AppState::new();
        let first = state.next_window_label();
        let second = state.next_window_label();
        state.remove_window(&first);
        let third = state.next_window_label();
        assert_eq!(first, "workspace-1");
        assert_eq!(second, "workspace-2");
        assert_eq!(third, "workspace-3");
    }

    #[test]
    fn many_windows_can_coexist() {
        let state = AppState::new();
        for i in 0..16 {
            let label = state.next_window_label();
            state.set_workspace(&label, PathBuf::from(format!("/tmp/w{i}")));
        }
        for i in 0..16 {
            let label = format!("workspace-{}", i + 1);
            assert_eq!(
                state.workspace(&label),
                Some(PathBuf::from(format!("/tmp/w{i}")))
            );
        }
    }

    #[test]
    fn workspace_returns_none_for_unknown_label() {
        let state = AppState::new();
        state.set_workspace(MAIN, PathBuf::from("/tmp/A"));
        assert!(state.workspace("never-existed").is_none());
        assert!(matches!(
            state.require_workspace("never-existed"),
            Err(CommandError::NoWorkspace)
        ));
    }
}
