//! Registered work sessions (stub, not implemented).
//!
//! Counterpart of desktop's `session.rs`: the roster of work sessions
//! (messenger peers, by name) that this host's orchestration manages.

/// Name of a work session (= messenger peer name).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SessionName(pub String);
