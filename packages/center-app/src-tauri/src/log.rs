//! The app has no window, so what it did (registration result, center start / exit) goes to a log file
//! next to the center's state (`~/.local/share/bantou/center-app.log`) and to stderr.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// The center's state dir (docs/design/center-graphql-server.md #9: the same `~/.local/share/bantou/` the desktop uses).
pub fn state_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("bantou")
}

pub fn log_path() -> PathBuf {
    state_dir().join("center-app.log")
}

/// One line, prefixed with the unix time in seconds.
pub fn line(msg: &str) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let text = format!("[{secs}] {msg}");
    eprintln!("[bantou-center] {text}");
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{text}");
    }
}
