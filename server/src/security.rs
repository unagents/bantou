//! Workspace path confinement (stub, not implemented).
//!
//! Counterpart of desktop's `security.rs` (canonicalize and verify that a
//! path lives inside the workspace).

use crate::error::{ServerError, ServerResult};
use std::path::{Path, PathBuf};

/// Canonicalize `path` and verify it lives inside `workspace`.
pub fn ensure_in_workspace(workspace: &Path, path: &Path) -> ServerResult<PathBuf> {
    let ws = std::fs::canonicalize(workspace)?;
    let p = std::fs::canonicalize(path)?;
    if p.starts_with(&ws) {
        Ok(p)
    } else {
        Err(ServerError::AccessDenied)
    }
}
