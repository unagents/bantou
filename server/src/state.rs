//! Process-wide server state (stub, not implemented).
//!
//! Counterpart of desktop's `AppState` (per-window workspace slots); the
//! server has a single workspace, so this will hold the resolved layout and
//! shared handles.

use crate::workspace::Layout;

#[derive(Debug)]
pub struct ServerState {
    pub layout: Layout,
}
