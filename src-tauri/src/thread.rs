//! Waiting-reply threads.
//!
//! One JSON file per task under `bantou_dir(ws)/threads/<task-id>.json`
//! (outside the workspace).

use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const THREADS_CHANGED_EVENT: &str = "bantou://threads-changed";

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    /// Messenger name of the work session that asked (reply target).
    pub from_name: String,
    #[serde(default)]
    pub from_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<AskOption>,
    pub received_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimelineEntry {
    /// `session` | `bantou` | `user` | `system`
    pub role: String,
    pub text: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Thread {
    pub task_id: String,
    /// `waiting` | `answered`
    pub status: String,
    pub request: Request,
    #[serde(default)]
    pub timeline: Vec<TimelineEntry>,
    /// Claude Code session id of the bantou responder, for `--resume`.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub answer: Option<String>,
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// bantou's own data for workspace `ws`, kept outside the workspace:
/// `~/.local/share/bantou/<ws path with / replaced by ->/`. The workspace
/// itself only ever gets Cork task md files.
pub fn bantou_dir(ws: &Path) -> PathBuf {
    let key = ws.to_string_lossy().replace('/', "-");
    data_root().join(key)
}

#[cfg(not(test))]
fn data_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share/bantou")
}

/// Tests keep their data under the system temp dir, never in the real home.
#[cfg(test)]
fn data_root() -> PathBuf {
    std::env::temp_dir().join("bantou-test-data")
}

fn threads_dir(ws: &Path) -> PathBuf {
    bantou_dir(ws).join("threads")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn thread_path(ws: &Path, task_id: &str) -> CmdResult<PathBuf> {
    if !valid_id(task_id) {
        return Err(CommandError::other(format!("Invalid task id: {task_id}")));
    }
    Ok(threads_dir(ws).join(format!("{task_id}.json")))
}

pub fn load(ws: &Path, task_id: &str) -> CmdResult<Option<Thread>> {
    let p = thread_path(ws, task_id)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(serde_json::from_str(&s).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save(ws: &Path, thread: &Thread) -> CmdResult<()> {
    let _g = WRITE_LOCK.lock().unwrap();
    let p = thread_path(ws, &thread.task_id)?;
    fs::create_dir_all(threads_dir(ws))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(thread).map_err(CommandError::other)?)?;
    fs::rename(&tmp, &p)?;
    Ok(())
}

/// Load, mutate, save. Returns the saved thread.
pub fn modify(
    ws: &Path,
    task_id: &str,
    f: impl FnOnce(&mut Thread),
) -> CmdResult<Thread> {
    let mut t = load(ws, task_id)?
        .ok_or_else(|| CommandError::other(format!("No thread for task {task_id}")))?;
    f(&mut t);
    save(ws, &t)?;
    Ok(t)
}

pub fn push(ws: &Path, task_id: &str, role: &str, text: &str) -> CmdResult<Thread> {
    modify(ws, task_id, |t| {
        t.timeline.push(TimelineEntry {
            role: role.to_string(),
            text: text.to_string(),
            at: now(),
        })
    })
}

pub fn list_all(ws: &Path) -> Vec<Thread> {
    let Ok(rd) = fs::read_dir(threads_dir(ws)) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect()
}

#[tauri::command]
pub fn list_threads(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<Thread>> {
    let ws = state.require_workspace(window.label())?;
    Ok(list_all(&ws))
}

#[tauri::command]
pub fn get_thread(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> CmdResult<Option<Thread>> {
    let ws = state.require_workspace(window.label())?;
    load(&ws, &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> Thread {
        Thread {
            task_id: id.into(),
            status: "waiting".into(),
            request: Request {
                from_name: "s".into(),
                from_id: String::new(),
                question: "q".into(),
                options: vec![],
                received_at: now(),
            },
            timeline: vec![],
            agent_session_id: None,
            answer: None,
        }
    }

    #[test]
    fn save_load_push_round_trip() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), &sample("t-1")).unwrap();
        push(d.path(), "t-1", "user", "hi").unwrap();
        let t = load(d.path(), "t-1").unwrap().unwrap();
        assert_eq!(t.timeline.len(), 1);
        assert_eq!(list_all(d.path()).len(), 1);
    }

    #[test]
    fn rejects_path_traversal_id() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path(), "../x").is_err());
    }
}
