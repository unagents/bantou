//! Cork-format task files.
//!
//! A workspace is a flat folder; every `*.md` directly under it is one task.
//! The file stem is the title (Cork's `encode_title_to_stem` /
//! `decode_stem_to_title` rules: `/` is swapped for U+2215). Frontmatter
//! carries Cork's `status` / `order` / `tags` / `date`, plus one bantou key:
//! `id`, a stable task id that survives title renames (Cork keeps unknown
//! frontmatter keys on update, see Cork `frontmatter.rs`
//! `update_preserves_unrelated_fields`).
//!
//! Session grouping uses `tags`: every tag value is a session name.

use crate::error::{CmdResult, CommandError};
use crate::frontmatter;
use crate::security;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const TITLE_SLASH_SENTINEL: char = '\u{2215}';
const CORK_CONFIG_FILE: &str = ".cork.json";
const DEFAULT_STATUSES: [&str; 3] = ["Todo", "Doing", "Done"];

#[derive(Clone, Debug, Serialize)]
pub struct Task {
    /// frontmatter `id`. Empty when the file has none yet.
    pub id: String,
    /// Absolute path of the `.md` file.
    pub path: String,
    pub title: String,
    pub status: String,
    pub order: Option<f64>,
    pub tags: Vec<String>,
    pub date: Option<String>,
    pub body: String,
}

#[derive(Deserialize, Default)]
struct TaskFrontmatter {
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    order: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    date: Option<serde_json::Value>,
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub(crate) fn encode_title_to_stem(title: &str) -> CmdResult<String> {
    let encoded: String = title
        .chars()
        .filter(|&c| c != '\0')
        .map(|c| if c == '/' { TITLE_SLASH_SENTINEL } else { c })
        .collect();
    let trimmed = encoded.trim().to_string();
    if trimmed.is_empty() {
        return Err(CommandError::other("Title is empty"));
    }
    Ok(trimmed)
}

fn decode_stem_to_title(stem: &str) -> String {
    stem.replace(TITLE_SLASH_SENTINEL, "/")
}

pub(crate) fn read_task(path: &Path) -> CmdResult<Task> {
    let content = fs::read_to_string(path)?;
    let (fm, body): (Option<TaskFrontmatter>, String) = frontmatter::parse(&content);
    let fm = fm.unwrap_or_default();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    Ok(Task {
        id: fm.id.as_ref().map(value_to_string).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        title: decode_stem_to_title(stem),
        status: fm.status.unwrap_or_else(|| DEFAULT_STATUSES[0].to_string()),
        order: fm.order,
        tags: fm.tags.unwrap_or_default(),
        date: fm.date.as_ref().map(value_to_string).filter(|s| !s.is_empty()),
        body,
    })
}

pub(crate) fn scan_tasks(dir: &Path) -> CmdResult<Vec<Task>> {
    let mut tasks = Vec::new();
    for entry in fs::read_dir(dir)?.flatten() {
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Ok(t) = read_task(&p) {
                tasks.push(t);
            }
        }
    }
    tasks.sort_by(|a, b| {
        let ao = a.order.unwrap_or(f64::MAX);
        let bo = b.order.unwrap_or(f64::MAX);
        ao.partial_cmp(&bo)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(tasks)
}

pub(crate) fn find_task_by_id(dir: &Path, id: &str) -> CmdResult<Option<Task>> {
    Ok(scan_tasks(dir)?.into_iter().find(|t| t.id == id))
}

pub(crate) fn new_task_id() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    let s: String = (0..8)
        .map(|_| CHARS[rng.random_range(0..CHARS.len())] as char)
        .collect();
    format!("t-{s}")
}

fn today() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!("{:04}-{:02}-{:02}", now.year(), u8::from(now.month()), now.day())
}

/// Create a task file. `id` is minted when `None`.
pub(crate) fn create_task_file(
    dir: &Path,
    title: &str,
    status: &str,
    tags: &[String],
    id: Option<&str>,
    body: &str,
) -> CmdResult<Task> {
    let stem = encode_title_to_stem(title)?;
    let path = dir.join(format!("{stem}.md"));
    if path.exists() {
        return Err(CommandError::other(format!("Task already exists: {title}")));
    }
    let max_order = scan_tasks(dir)?
        .iter()
        .filter(|t| t.status == status)
        .filter_map(|t| t.order)
        .fold(-1.0_f64, f64::max);
    let id = id.map(str::to_string).unwrap_or_else(new_task_id);
    let fm = serde_json::json!({
        "id": id,
        "status": status,
        "order": max_order + 1.0,
        "tags": tags,
        "date": today(),
    });
    let content = frontmatter::ensure_trailing_newline(format!(
        "---\n{}---\n\n{}",
        frontmatter::serialize(&fm),
        body
    ));
    fs::write(&path, content)?;
    read_task(&path)
}

#[tauri::command]
pub fn list_tasks(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<Task>> {
    let dir = state.require_workspace(window.label())?;
    scan_tasks(&dir)
}

#[tauri::command]
pub fn get_statuses(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<String>> {
    let dir = state.require_workspace(window.label())?;
    let from_config = fs::read_to_string(dir.join(CORK_CONFIG_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("statuses").cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get("label").and_then(|l| l.as_str()).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());
    Ok(from_config.unwrap_or_else(|| DEFAULT_STATUSES.iter().map(|s| s.to_string()).collect()))
}

#[tauri::command]
pub fn create_task(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    title: String,
    status: String,
    tags: Vec<String>,
) -> CmdResult<Task> {
    let dir = state.require_workspace(window.label())?;
    create_task_file(&dir, &title, &status, &tags, None, "")
}

#[tauri::command]
pub fn update_task_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    path: String,
    status: String,
) -> CmdResult<Task> {
    let dir = state.require_workspace(window.label())?;
    let canonical = security::check_in_workspace(
        &security::canonical_workspace(&dir)?,
        &PathBuf::from(&path),
    )?;
    let content = fs::read_to_string(&canonical)?;
    let updated = frontmatter::update(&content, &[("status", serde_json::json!(status))]);
    fs::write(&canonical, updated)?;
    read_task(&canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_scan_keeps_id_and_tags() {
        let dir = tempfile::tempdir().unwrap();
        let t = create_task_file(
            dir.path(),
            "a/b",
            "Doing",
            &["sess".to_string()],
            Some("t-fixed"),
            "body",
        )
        .unwrap();
        assert_eq!(t.title, "a/b");
        let all = scan_tasks(dir.path()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "t-fixed");
        assert_eq!(all[0].tags, vec!["sess".to_string()]);
        assert_eq!(all[0].status, "Doing");
        assert_eq!(all[0].body.trim(), "body");
    }

    #[test]
    fn status_update_preserves_id() {
        let dir = tempfile::tempdir().unwrap();
        let t = create_task_file(dir.path(), "x", "Todo", &[], None, "").unwrap();
        let content = fs::read_to_string(&t.path).unwrap();
        let updated = frontmatter::update(&content, &[("status", serde_json::json!("Doing"))]);
        fs::write(&t.path, updated).unwrap();
        let again = read_task(Path::new(&t.path)).unwrap();
        assert_eq!(again.id, t.id);
        assert_eq!(again.status, "Doing");
    }
}
