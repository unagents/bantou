//! Task files (stub, not implemented).
//!
//! Counterpart of desktop's `task.rs` (Cork-format `*.md` task files, stable
//! frontmatter `id`, `tags` = session names): the server-side view of the
//! tasks handed to work sessions on this host.

/// Stable task id (= frontmatter `id`; `[A-Za-z0-9_-]` only).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TaskId(pub String);
