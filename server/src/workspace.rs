//! Workspace folder layout.
//!
//! `<workspace>/repos/` is the space where repositories are expanded.
//! (Desktop's `workspace.rs` handles window / folder selection; the server
//! has no UI, so this module only prepares the directory tree.)

use crate::error::ServerResult;
use std::path::{Path, PathBuf};

pub const REPOS_DIR: &str = "repos";

#[derive(Debug, PartialEq)]
pub struct Layout {
    pub root: PathBuf,
    pub repos: PathBuf,
}

/// Create `<workspace>` and `<workspace>/repos/` if missing.
pub fn prepare(workspace: &Path) -> ServerResult<Layout> {
    let repos = workspace.join(REPOS_DIR);
    std::fs::create_dir_all(workspace)?;
    std::fs::create_dir_all(&repos)?;
    Ok(Layout {
        root: workspace.to_path_buf(),
        repos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_workspace_and_repos() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("ws");
        let layout = prepare(&ws).unwrap();
        assert!(ws.is_dir());
        assert!(layout.repos.is_dir());
        assert_eq!(layout.repos, ws.join("repos"));
        // idempotent
        prepare(&ws).unwrap();
    }
}
