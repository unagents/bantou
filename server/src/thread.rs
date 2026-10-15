//! Waiting-reply threads (stub, not implemented).
//!
//! Counterpart of desktop's `thread.rs` (one record per task for an `ask`
//! that waits for the user's reply): the server-side state of such asks.

use crate::task::TaskId;

/// A thread is keyed by the task it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadKey(pub TaskId);
