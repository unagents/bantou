//! Server error type shared by every module (counterpart of desktop's
//! `CommandError`, minus the Tauri command serialization).

use std::fmt;

#[derive(Debug)]
pub enum ServerError {
    /// Bad CLI arguments or an unusable config.
    Config(String),
    /// The path escapes the workspace.
    AccessDenied,
    Io(std::io::Error),
    Other(String),
}

pub type ServerResult<T> = Result<T, ServerError>;

impl fmt::Display for ServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(m) => write!(f, "config error: {m}"),
            Self::AccessDenied => write!(f, "access denied"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ServerError {}

impl From<std::io::Error> for ServerError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
