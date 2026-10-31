//! Work sessions: the connected center's `session_list`.
//!
//! The side menu shows what the center (own sidecar, or a pasted remote center) lists, nothing
//! more. bantou keeps no list of its own: only the last list that could be fetched is cached in
//! memory (`SessionCache`), so it can still be shown, flagged as unreachable, when the center
//! cannot be asked. The frontend decides when to re-read (before a user action, after wake /
//! network change, on a settings change, on a long timer).
//!
//! - the center answered: its list replaces the cache (`reachable: true`);
//! - the center could not be asked: the cached list is kept, `reachable: false`, the reason is
//!   carried.
//!
//! A new session is made with `session_create`; it shows up through the next read of the list.

use crate::broker::{self, Brokers};
use crate::center_mcp;
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::Emitter;

pub const SESSIONS_CHANGED_EVENT: &str = "bantou://sessions-changed";

/// A session as the center lists it (`session_list` / `session_create` result; fields bantou uses).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    /// Center's state (`connected`, `starting`, ...).
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub session_url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    /// Center's `lastError` of the session.
    #[serde(default)]
    pub last_error: Option<String>,
}

/// What the side menu shows: the center's list as last fetched, and whether the latest read worked.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<Session>,
    /// false: the center could not be asked at the latest read (`sessions` is the older list).
    pub reachable: bool,
    /// Why the center could not be asked (only with `reachable: false`).
    pub reason: Option<String>,
    /// Counts the changes of the cache. The frontend reads the list from several places (start-up,
    /// the change event, the result of a re-read) in no fixed order; it keeps the highest `rev`,
    /// so an older read that arrives late never replaces a newer list.
    pub rev: u64,
}

impl Default for SessionList {
    fn default() -> Self {
        Self { sessions: Vec::new(), reachable: true, reason: None, rev: 0 }
    }
}

/// Next list after a read (`rev` is carried over; the cache bumps it when the content changed).
/// `listing` is the center's list, or the reason it could not be fetched. Pure.
pub fn apply_listing(prev: &SessionList, listing: Result<&[Session], &str>) -> SessionList {
    match listing {
        Ok(list) => SessionList { sessions: list.to_vec(), reachable: true, reason: None, rev: prev.rev },
        Err(why) => SessionList {
            sessions: prev.sessions.clone(),
            reachable: false,
            reason: Some(why.to_string()),
            rev: prev.rev,
        },
    }
}

/// The last list fetched, in memory, for the whole app (the center is not tied to a window).
#[derive(Default)]
pub struct SessionCache {
    list: Mutex<SessionList>,
}

impl SessionCache {
    pub fn get(&self) -> SessionList {
        self.list.lock().unwrap().clone()
    }
    /// Store the result of a read; the new list and whether it differs from the old one.
    fn apply(&self, listing: Result<&[Session], &str>) -> (SessionList, bool) {
        let mut l = self.list.lock().unwrap();
        let mut next = apply_listing(&l, listing);
        let changed = *l != next;
        if changed {
            next.rev += 1;
        }
        *l = next.clone();
        (next, changed)
    }
}

/// Call a center tool and parse its JSON text result.
async fn center_json(app: &tauri::AppHandle, tool: &str, args: Option<Value>) -> Result<Value, String> {
    let r = center_mcp::center_call(app.clone(), tool.to_string(), args).await.map_err(|e| e.to_string())?;
    let text = r
        .get("content")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| format!("{tool} の結果を読めない: {e}"))
}

async fn fetch_list(app: &tauri::AppHandle) -> Result<Vec<Session>, String> {
    let v = center_json(app, "session_list", None).await?;
    serde_json::from_value(v).map_err(|e| format!("session_list の結果を読めない: {e}"))
}

fn notify(app: &tauri::AppHandle) {
    let _ = app.emit(SESSIONS_CHANGED_EVENT, ());
}

/// Read the center's `session_list` into the cache; tell the frontend when it changed.
async fn read_list(app: &tauri::AppHandle, cache: &SessionCache) -> SessionList {
    let listing = fetch_list(app).await;
    let (next, changed) = cache.apply(listing.as_ref().map(|l| l.as_slice()).map_err(|e| e.as_str()));
    if changed {
        notify(app);
    }
    next
}

/// The cached list, without asking the center.
#[tauri::command]
pub fn list_sessions(cache: tauri::State<'_, SessionCache>) -> SessionList {
    cache.get()
}

/// Re-read the center's `session_list`.
#[tauri::command]
pub async fn refresh_sessions(app: tauri::AppHandle, cache: tauri::State<'_, SessionCache>) -> CmdResult<SessionList> {
    Ok(read_list(&app, &cache).await)
}

/// Create a new session on the center (`session_create`). The center lists it, so the list is
/// read again.
#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    cache: tauri::State<'_, SessionCache>,
    name: String,
) -> CmdResult<Session> {
    let v = center_json(&app, "session_create", Some(serde_json::json!({ "name": name.trim() })))
        .await
        .map_err(CommandError::Other)?;
    let s: Session =
        serde_json::from_value(v).map_err(|e| CommandError::other(format!("session_create の結果を読めない: {e}")))?;
    read_list(&app, &cache).await;
    Ok(s)
}

/// Instruction asking a session to add (and start) a task the user typed in bantou.
pub fn add_task_instruction(title: &str, body: &str) -> String {
    format!(
        "【bantou タスク追加指示】（ユーザーが bantou の画面から送信）\n次のタスクを追加して着手すること。追加したら規約どおり type \"task\"（body 付き）を bantou-core に送ること。確認や質問はこのセッション上で聞かず bantou-core に ask で送ること。\n\nタスク名: {title}\n作業内容:\n{body}"
    )
}

/// Send a registered session an instruction to add a task.
#[tauri::command]
pub async fn instruct_add_task(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
    session: String,
    title: String,
    body: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::other("タスク名が空"));
    }
    let url = brokers.url(&ws).ok_or_else(|| CommandError::other("broker 未接続"))?;
    let me = brokers
        .peer_id(&ws)
        .ok_or_else(|| CommandError::other("broker 未接続"))?;
    broker::send(&url, &me, &session, &add_task_instruction(title, body.trim()))
        .await
        .map_err(CommandError::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_task_instruction_carries_title_and_body() {
        let m = add_task_instruction("列マッピング", "手順1\n手順2");
        assert!(m.starts_with("【bantou タスク追加指示】（ユーザーが bantou の画面から送信）\n"));
        assert!(m.contains(r#"type "task"（body 付き）を bantou-core に送ること"#));
        assert!(m.ends_with("\n\nタスク名: 列マッピング\n作業内容:\n手順1\n手順2"));
    }

    fn entry(name: &str, state: &str) -> Session {
        Session {
            name: name.into(),
            state: Some(state.into()),
            session_url: Some(format!("https://claude.ai/code/{name}")),
            source: Some("session".into()),
            last_error: None,
        }
    }

    #[test]
    fn answered_list_is_shown_as_is() {
        let prev = SessionList { sessions: vec![entry("old", "connected")], reachable: true, reason: None, rev: 0 };
        let next = apply_listing(&prev, Ok(&[entry("a", "connected"), entry("b", "starting")]));
        assert_eq!(next.sessions.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(next.reachable);
        assert_eq!(next.reason, None);
    }

    #[test]
    fn center_side_sessions_appear_and_disappear_with_the_list() {
        let first = apply_listing(&SessionList::default(), Ok(&[entry("a", "connected")]));
        let second = apply_listing(&first, Ok(&[entry("a", "connected"), entry("made-elsewhere", "connected")]));
        assert_eq!(second.sessions.len(), 2);
        let third = apply_listing(&second, Ok(&[entry("made-elsewhere", "connected")]));
        assert_eq!(third.sessions.len(), 1);
        assert_eq!(third.sessions[0].name, "made-elsewhere");
        // an empty answer is an empty list (nothing is kept as lost)
        assert!(apply_listing(&third, Ok(&[])).sessions.is_empty());
    }

    #[test]
    fn unreachable_keeps_the_last_list_and_says_why() {
        let ok = apply_listing(&SessionList::default(), Ok(&[entry("a", "connected")]));
        let next = apply_listing(&ok, Err("接続できない"));
        assert_eq!(next.sessions, ok.sessions);
        assert!(!next.reachable);
        assert_eq!(next.reason.as_deref(), Some("接続できない"));
        // answered again: back to reachable, the list is the center's
        let back = apply_listing(&next, Ok(&[]));
        assert!(back.reachable);
        assert_eq!(back.reason, None);
        assert!(back.sessions.is_empty());
    }

    #[test]
    fn rev_counts_changes_only() {
        let c = SessionCache::default();
        assert_eq!(c.get().rev, 0);
        assert_eq!(c.apply(Ok(&[entry("a", "connected")])).0.rev, 1);
        // same answer: no change, same rev
        assert_eq!(c.apply(Ok(&[entry("a", "connected")])).0.rev, 1);
        assert_eq!(c.apply(Err("x")).0.rev, 2);
        assert_eq!(c.apply(Err("x")).0.rev, 2);
        assert_eq!(c.apply(Err("y")).0.rev, 3);
        assert_eq!(c.apply(Ok(&[entry("a", "connected")])).0.rev, 4);
        assert_eq!(c.get().rev, 4);
    }

    #[test]
    fn unreachable_before_any_list_is_empty() {
        let next = apply_listing(&SessionList::default(), Err("x"));
        assert!(next.sessions.is_empty());
        assert!(!next.reachable);
    }

    #[test]
    fn cache_reports_whether_a_read_changed_anything() {
        let c = SessionCache::default();
        assert_eq!(c.get(), SessionList::default());
        let (_, changed) = c.apply(Ok(&[entry("a", "connected")]));
        assert!(changed);
        let (_, changed) = c.apply(Ok(&[entry("a", "connected")]));
        assert!(!changed);
        let (next, changed) = c.apply(Err("x"));
        assert!(changed);
        assert_eq!(next.sessions.len(), 1);
        assert_eq!(c.get(), next);
        // the same failure again is no change
        assert!(!c.apply(Err("x")).1);
    }

    #[test]
    fn session_reads_the_center_json() {
        let e: Session = serde_json::from_str(
            r#"{"name":"pm-a","path":"/p","state":"connected","pid":1,"sessionUrl":"https://u","startedAt":null,"source":"session","lastError":"x"}"#,
        )
        .unwrap();
        assert_eq!(e.session_url.as_deref(), Some("https://u"));
        assert_eq!(e.last_error.as_deref(), Some("x"));
        let bare: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(bare.state, None);
    }

    #[test]
    fn session_list_serializes_for_the_frontend() {
        let v = serde_json::to_value(apply_listing(&SessionList::default(), Ok(&[entry("a", "connected")]))).unwrap();
        assert_eq!(v["reachable"], true);
        assert_eq!(v["sessions"][0]["sessionUrl"], "https://claude.ai/code/a");
        assert_eq!(v["sessions"][0]["state"], "connected");
        let v = serde_json::to_value(apply_listing(&SessionList::default(), Err("x"))).unwrap();
        assert_eq!(v["reachable"], false);
        assert_eq!(v["reason"], "x");
    }
}
