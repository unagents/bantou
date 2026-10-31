//! Work sessions added from the center.
//!
//! The user picks sessions from the target center's `session_list` (or names a new one, created
//! with `session_create`). bantou keeps what was added in memory only (nothing is written to a
//! file) and re-reads the center's list at several moments (the frontend decides when: before a
//! user action, after wake / network change, on a settings change, on a long timer). Each re-read
//! is reconciled against what was added (`reconcile`):
//!
//! - in the center's list: kept, state updated (`Link::Listed`);
//! - not in the list: shown as lost (`Link::Lost`), kept so the user sees it went away;
//! - the list could not be fetched: `Link::Unreachable`, told apart from lost. The previous state
//!   is kept and the reason is carried.
//!
//! A lost session that is listed again is `Listed` again (the center took it back).

use crate::broker::{self, Brokers};
use crate::center_mcp;
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::Emitter;

pub const SESSIONS_CHANGED_EVENT: &str = "bantou://sessions-changed";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Link {
    /// In the center's list at the last read.
    Listed,
    /// The center answered and the session is not in its list.
    Lost,
    /// The center could not be asked.
    Unreachable,
}

/// A session as the center lists it (`session_list` / `session_create` result; fields bantou uses).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterEntry {
    pub name: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub session_url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// A session the user added.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub link: Link,
    /// Center's state (`connected`, `starting`, ...) at the last successful read.
    pub state: Option<String>,
    pub session_url: Option<String>,
    pub source: Option<String>,
    /// Center's `lastError` of the session at the last successful read.
    pub last_error: Option<String>,
    /// Why the center could not be asked (only with `Link::Unreachable`).
    pub reason: Option<String>,
    pub added_at: String,
}

impl Session {
    pub fn from_entry(e: &CenterEntry, added_at: String) -> Self {
        Self {
            name: e.name.clone(),
            link: Link::Listed,
            state: e.state.clone(),
            session_url: e.session_url.clone(),
            source: e.source.clone(),
            last_error: e.last_error.clone(),
            reason: None,
            added_at,
        }
    }
}

/// Compare what was added with a fresh read of the center's list. `listing` is the list, or the
/// reason it could not be fetched. Pure.
pub fn reconcile(added: &[Session], listing: Result<&[CenterEntry], &str>) -> Vec<Session> {
    added
        .iter()
        .map(|s| match listing {
            Err(why) => Session { link: Link::Unreachable, reason: Some(why.to_string()), ..s.clone() },
            Ok(list) => match list.iter().find(|e| e.name == s.name) {
                Some(e) => Session { link: Link::Listed, reason: None, ..Session::from_entry(e, s.added_at.clone()) },
                None => Session { link: Link::Lost, reason: None, ..s.clone() },
            },
        })
        .collect()
}

/// Added sessions, in memory, for the whole app (the center is not tied to a window).
#[derive(Default)]
pub struct Sessions {
    list: Mutex<Vec<Session>>,
}

impl Sessions {
    pub fn list(&self) -> Vec<Session> {
        self.list.lock().unwrap().clone()
    }
    /// Add (or replace by name).
    fn add(&self, s: Session) {
        let mut l = self.list.lock().unwrap();
        match l.iter_mut().find(|x| x.name == s.name) {
            Some(x) => *x = s,
            None => l.push(s),
        }
    }
    fn remove(&self, name: &str) {
        self.list.lock().unwrap().retain(|s| s.name != name);
    }
    /// Store the reconciled list; false when nothing changed.
    fn replace(&self, next: Vec<Session>) -> bool {
        let mut l = self.list.lock().unwrap();
        let changed = *l != next;
        *l = next;
        changed
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

async fn fetch_list(app: &tauri::AppHandle) -> Result<Vec<CenterEntry>, String> {
    let v = center_json(app, "session_list", None).await?;
    serde_json::from_value(v).map_err(|e| format!("session_list の結果を読めない: {e}"))
}

fn notify(app: &tauri::AppHandle) {
    let _ = app.emit(SESSIONS_CHANGED_EVENT, ());
}

#[tauri::command]
pub fn list_sessions(roster: tauri::State<'_, Sessions>) -> Vec<Session> {
    roster.list()
}

/// Re-read the center's `session_list` and reconcile. With nothing added it asks nobody.
#[tauri::command]
pub async fn refresh_sessions(app: tauri::AppHandle, roster: tauri::State<'_, Sessions>) -> CmdResult<Vec<Session>> {
    let added = roster.list();
    if added.is_empty() {
        return Ok(added);
    }
    let listing = fetch_list(&app).await;
    // Snapshot again: sessions may have been added while the center was being asked.
    let added = roster.list();
    let next = reconcile(&added, listing.as_ref().map(|l| l.as_slice()).map_err(|e| e.as_str()));
    if roster.replace(next.clone()) {
        notify(&app);
    }
    Ok(next)
}

/// Add sessions of the center's list by name.
#[tauri::command]
pub async fn add_sessions(
    app: tauri::AppHandle,
    roster: tauri::State<'_, Sessions>,
    names: Vec<String>,
) -> CmdResult<Vec<Session>> {
    let list = fetch_list(&app).await.map_err(CommandError::Other)?;
    for n in &names {
        let e = list
            .iter()
            .find(|e| &e.name == n)
            .ok_or_else(|| CommandError::other(format!("center の一覧に無い: {n}")))?;
        roster.add(Session::from_entry(e, crate::thread::now()));
    }
    notify(&app);
    Ok(roster.list())
}

/// Create a new session on the center (`session_create`) and add it.
#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    roster: tauri::State<'_, Sessions>,
    name: String,
) -> CmdResult<Session> {
    let v = center_json(&app, "session_create", Some(serde_json::json!({ "name": name.trim() })))
        .await
        .map_err(CommandError::Other)?;
    let e: CenterEntry =
        serde_json::from_value(v).map_err(|e| CommandError::other(format!("session_create の結果を読めない: {e}")))?;
    let s = Session::from_entry(&e, crate::thread::now());
    roster.add(s.clone());
    notify(&app);
    Ok(s)
}

#[tauri::command]
pub fn unregister_session(app: tauri::AppHandle, roster: tauri::State<'_, Sessions>, name: String) {
    roster.remove(&name);
    notify(&app);
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

    fn entry(name: &str, state: &str) -> CenterEntry {
        CenterEntry {
            name: name.into(),
            state: Some(state.into()),
            session_url: Some(format!("https://claude.ai/code/{name}")),
            source: Some("session".into()),
            last_error: None,
        }
    }

    fn added(name: &str) -> Session {
        Session::from_entry(&entry(name, "starting"), "t0".into())
    }

    #[test]
    fn listed_session_is_kept_and_its_state_updated() {
        let next = reconcile(&[added("a")], Ok(&[entry("a", "connected")]));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].link, Link::Listed);
        assert_eq!(next[0].state.as_deref(), Some("connected"));
        assert_eq!(next[0].added_at, "t0");
    }

    #[test]
    fn session_missing_from_the_list_is_lost_and_kept() {
        let next = reconcile(&[added("a"), added("b")], Ok(&[entry("b", "connected")]));
        assert_eq!(next[0].name, "a");
        assert_eq!(next[0].link, Link::Lost);
        assert_eq!(next[0].reason, None);
        // the last known state stays visible
        assert_eq!(next[0].state.as_deref(), Some("starting"));
        assert_eq!(next[1].link, Link::Listed);
    }

    #[test]
    fn empty_list_loses_everything_but_unreachable_does_not() {
        let roster = [added("a")];
        assert_eq!(reconcile(&roster, Ok(&[]))[0].link, Link::Lost);
        let next = reconcile(&roster, Err("接続できない"));
        assert_eq!(next[0].link, Link::Unreachable);
        assert_eq!(next[0].reason.as_deref(), Some("接続できない"));
        assert_eq!(next[0].state.as_deref(), Some("starting"));
    }

    #[test]
    fn unreachable_then_answered_decides_between_listed_and_lost() {
        let unreachable = reconcile(&[added("a"), added("b")], Err("x"));
        let next = reconcile(&unreachable, Ok(&[entry("a", "connected")]));
        assert_eq!(next[0].link, Link::Listed);
        assert_eq!(next[0].reason, None);
        assert_eq!(next[1].link, Link::Lost);
    }

    #[test]
    fn lost_then_listed_again_is_listed() {
        let lost = reconcile(&[added("a")], Ok(&[]));
        let next = reconcile(&lost, Ok(&[entry("a", "connected")]));
        assert_eq!(next[0].link, Link::Listed);
    }

    #[test]
    fn lost_stays_lost_while_unreachable_overrides_it_until_answered() {
        let lost = reconcile(&[added("a")], Ok(&[]));
        let unreachable = reconcile(&lost, Err("x"));
        assert_eq!(unreachable[0].link, Link::Unreachable);
        // the answer after that says it is still not there
        assert_eq!(reconcile(&unreachable, Ok(&[]))[0].link, Link::Lost);
    }

    #[test]
    fn reconcile_without_roster_is_empty() {
        assert!(reconcile(&[], Ok(&[entry("a", "connected")])).is_empty());
        assert!(reconcile(&[], Err("x")).is_empty());
    }

    #[test]
    fn center_entry_reads_the_center_json() {
        let e: CenterEntry = serde_json::from_str(
            r#"{"name":"pm-a","path":"/p","state":"connected","pid":1,"sessionUrl":"https://u","startedAt":null,"source":"session","lastError":"x"}"#,
        )
        .unwrap();
        assert_eq!(e.session_url.as_deref(), Some("https://u"));
        assert_eq!(e.last_error.as_deref(), Some("x"));
        let bare: CenterEntry = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(bare.state, None);
    }

    #[test]
    fn session_serializes_for_the_frontend() {
        let v = serde_json::to_value(reconcile(&[added("a")], Ok(&[]))).unwrap();
        assert_eq!(v[0]["link"], "lost");
        assert_eq!(v[0]["sessionUrl"], "https://claude.ai/code/a");
        assert_eq!(v[0]["addedAt"], "t0");
    }

    #[test]
    fn roster_adds_replaces_removes_and_reports_changes() {
        let r = Sessions::default();
        r.add(added("a"));
        r.add(Session::from_entry(&entry("a", "connected"), "t1".into()));
        assert_eq!(r.list().len(), 1);
        assert_eq!(r.list()[0].state.as_deref(), Some("connected"));
        let same = r.list();
        assert!(!r.replace(same));
        assert!(r.replace(reconcile(&r.list(), Ok(&[]))));
        r.remove("a");
        assert!(r.list().is_empty());
    }
}
