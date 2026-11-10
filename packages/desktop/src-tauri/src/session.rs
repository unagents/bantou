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

use crate::center_mcp;
use crate::error::{CmdResult, CommandError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::Emitter;

pub const SESSIONS_CHANGED_EVENT: &str = "bantou://sessions-changed";

/// Max length (chars) of a project setting `instructions` (same limit as the center).
pub const SESSION_INSTRUCTIONS_MAX: usize = 16_000;

/// Check a project settings object (`{ instructions?: string | null, … }`, same shape as the
/// center's `settings`). Only `instructions` is known now; other keys pass through unchanged.
/// A blank `instructions` text becomes `null` (the center removes the item), over the limit is an error.
fn normalize_settings(settings: Value) -> Result<Value, String> {
    let Value::Object(mut map) = settings else {
        return Err("設定はオブジェクトで渡す".to_string());
    };
    match map.get("instructions") {
        None | Some(Value::Null) => {}
        Some(Value::String(t)) => {
            if t.trim().is_empty() {
                map.insert("instructions".into(), Value::Null);
            } else if t.chars().count() > SESSION_INSTRUCTIONS_MAX {
                return Err(format!("追加指示は {SESSION_INSTRUCTIONS_MAX} 文字以内"));
            }
        }
        Some(_) => return Err("追加指示は文字列で渡す".to_string()),
    }
    Ok(Value::Object(map))
}

/// Body of the center's `session_create`: `path` only when it is not blank (the center then
/// uses `<workspace>/<name>`), `settings` only when it holds something to set
/// (a `null` item means none, so it is not sent on create).
fn create_args(name: &str, path: Option<&str>, settings: Option<Value>) -> Value {
    let mut a = serde_json::json!({ "name": name });
    if let Some(p) = path.map(str::trim).filter(|p| !p.is_empty()) {
        a["path"] = Value::String(p.to_string());
    }
    if let Some(Value::Object(m)) = settings {
        let m: serde_json::Map<String, Value> = m.into_iter().filter(|(_, v)| !v.is_null()).collect();
        if !m.is_empty() {
            a["settings"] = Value::Object(m);
        }
    }
    a
}

/// Body of the center's `session_settings_update` (a `null` item removes it).
fn update_args(name: &str, settings: Value) -> Value {
    serde_json::json!({ "name": name, "settings": settings })
}

/// Body of the center's `session_update`: only what is given. `move` goes with `path` only.
fn rename_args(name: &str, new_name: Option<&str>, path: Option<&str>, move_dir: Option<bool>) -> Value {
    let mut a = serde_json::json!({ "name": name });
    if let Some(n) = new_name.map(str::trim).filter(|n| !n.is_empty()) {
        a["newName"] = Value::String(n.to_string());
    }
    if let Some(p) = path.map(str::trim).filter(|p| !p.is_empty()) {
        a["path"] = Value::String(p.to_string());
        if let Some(m) = move_dir {
            a["move"] = Value::Bool(m);
        }
    }
    a
}

/// The `settings` of the center's `{ name, settings }` answer (`{}` when absent).
fn settings_of(answer: &Value) -> Value {
    match answer.get("settings") {
        Some(v @ Value::Object(_)) => v.clone(),
        _ => serde_json::json!({}),
    }
}

/// The project settings of `name`, kept by the center (`session_settings_get`).
#[tauri::command]
pub async fn session_get_settings(app: tauri::AppHandle, name: String) -> CmdResult<Value> {
    let v = center_json(&app, "session_settings_get", Some(serde_json::json!({ "name": name.trim() })))
        .await
        .map_err(CommandError::Other)?;
    Ok(settings_of(&v))
}

/// Merge `settings` into the project settings of `name` on the center (`session_settings_update`) and
/// return the whole settings after the update. Takes effect from the next start of the session.
#[tauri::command]
pub async fn session_update_settings(app: tauri::AppHandle, name: String, settings: Value) -> CmdResult<Value> {
    let settings = normalize_settings(settings).map_err(CommandError::Other)?;
    let v = center_json(&app, "session_settings_update", Some(update_args(name.trim(), settings)))
        .await
        .map_err(CommandError::Other)?;
    Ok(settings_of(&v))
}

/// The center's context usage of a session's claude (`contextUsage` of `session_list`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: u64,
    /// None when the center cannot tell the model's window.
    #[serde(default)]
    pub window_tokens: Option<u64>,
    #[serde(default)]
    pub percent: Option<f64>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

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
    /// The folder the session runs in (center's `path`; on the center's host). None when the center sends none.
    #[serde(default)]
    pub path: Option<String>,
    /// Center's `lastError` of the session.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Context usage of the session's claude; None when the center has none (or is older than this field).
    #[serde(default)]
    pub context_usage: Option<ContextUsage>,
    /// Whether the session was started with instructions (`--append-system-prompt`). false when the center says no or is older than this field.
    #[serde(default)]
    pub instructions: bool,
    /// Center's work state (`working` / `needs-input` / `idle` / `unknown`). None when the center is older than this field.
    #[serde(default)]
    pub activity: Option<String>,
    /// When `activity` last changed (ISO string); None when unknown.
    #[serde(default)]
    pub activity_at: Option<String>,
    /// Work the session left on remote-caps (`running` servers with pending work, `waitingReply` unanswered worker asks). None when the center is older than this field.
    #[serde(default)]
    pub remote: Option<SessionRemote>,
    /// Center's `auth` of the session's claude (`ok`, `login_required`, `keychain_locked`).
    #[serde(default)]
    pub auth: Option<String>,
    /// Center's `loginUrl` (the `/login` URL while a login is in progress).
    #[serde(default)]
    pub login_url: Option<String>,
    /// Center's `loginError` (why the last `/login` failed).
    #[serde(default)]
    pub login_error: Option<String>,
}

/// Mirror of the center's `session_list[].remote`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemote {
    #[serde(default)]
    pub running: u32,
    #[serde(default)]
    pub waiting_reply: u32,
    /// Caps whose server does not answer (center's `remote.unreachable`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreachable: Vec<SessionRemoteIssue>,
    /// Caps the server reported lost (center's `remote.lost`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lost: Vec<SessionRemoteIssue>,
}

/// One remote-cap in trouble: `last_ok_at` is the last answer of the unreachable server (ISO; None: none yet), `at` when the cap was reported lost.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemoteIssue {
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub remote_id: String,
    #[serde(default)]
    pub last_ok_at: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
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
    match &listing {
        Ok(l) => log::info!("session list refresh: {} sessions", l.len()),
        Err(e) => log::warn!("session list refresh failed (cached list kept): {e}"),
    }
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

/// What the add dialog needs about the folder field: the center's `workspace` (its default parent
/// folder; None when unknown / not set / an older center without `center_info`) and whether this PC's
/// folder dialog makes sense (only for the own sidecar center, on macOS / Windows).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHints {
    pub workspace: Option<String>,
    pub can_pick: bool,
}

/// `workspace` of the center's `center_info` answer (None when absent / null / blank).
fn workspace_of(answer: &Value) -> Option<String> {
    answer.get("workspace").and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty()).map(String::from)
}

/// The folder dialog picks a folder on this PC, so it only helps when the center runs here (sidecar).
fn can_pick_folder(source: Option<center_mcp::TargetSource>, os_has_dialog: bool) -> bool {
    os_has_dialog && source == Some(center_mcp::TargetSource::Sidecar)
}

#[tauri::command]
pub async fn session_path_hints(app: tauri::AppHandle) -> CmdResult<PathHints> {
    let source = center_mcp::current_source(&app).ok();
    let workspace = center_json(&app, "center_info", None).await.ok().as_ref().and_then(workspace_of);
    Ok(PathHints { workspace, can_pick: can_pick_folder(source, cfg!(any(target_os = "macos", target_os = "windows"))) })
}

/// Create a new session on the center (`session_create`). `path` is the folder on the center's
/// host (blank: not sent, the center decides). The center lists it, so the list is read again.
#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    cache: tauri::State<'_, SessionCache>,
    name: String,
    path: Option<String>,
    settings: Option<Value>,
) -> CmdResult<Session> {
    let name = name.trim().to_string();
    let settings = settings.map(normalize_settings).transpose().map_err(CommandError::Other)?;
    let v = center_json(&app, "session_create", Some(create_args(&name, path.as_deref(), settings)))
        .await
        .map_err(CommandError::Other)?;
    let s: Session =
        serde_json::from_value(v).map_err(|e| CommandError::other(format!("session_create の結果を読めない: {e}")))?;
    read_list(&app, &cache).await;
    Ok(s)
}

/// Rename a session and / or change its folder on the center (`session_update`). `move_dir` only
/// counts with `path` (true: move the current folder there, false: only make the new folder).
/// The center lists the result, so the list is read again.
#[tauri::command]
pub async fn session_update(
    app: tauri::AppHandle,
    cache: tauri::State<'_, SessionCache>,
    name: String,
    new_name: Option<String>,
    path: Option<String>,
    move_dir: Option<bool>,
) -> CmdResult<Session> {
    let args = rename_args(name.trim(), new_name.as_deref(), path.as_deref(), move_dir);
    let v = center_json(&app, "session_update", Some(args)).await.map_err(CommandError::Other)?;
    let s: Session =
        serde_json::from_value(v).map_err(|e| CommandError::other(format!("session_update の結果を読めない: {e}")))?;
    read_list(&app, &cache).await;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_body_carries_only_what_is_given_and_move_only_with_path() {
        assert_eq!(rename_args("a", None, None, Some(true)), serde_json::json!({"name":"a"}));
        assert_eq!(rename_args("a", Some(" b "), Some(" "), None), serde_json::json!({"name":"a","newName":"b"}));
        assert_eq!(
            rename_args("a", None, Some(" /x/y "), Some(false)),
            serde_json::json!({"name":"a","path":"/x/y","move":false})
        );
        assert_eq!(rename_args("a", None, Some("/x"), None), serde_json::json!({"name":"a","path":"/x"}));
    }

    fn entry(name: &str, state: &str) -> Session {
        Session {
            name: name.into(),
            state: Some(state.into()),
            session_url: Some(format!("https://claude.ai/code/{name}")),
            source: Some("session".into()),
            path: Some(format!("/ws/{name}")),
            last_error: None,
            context_usage: None,
            instructions: false,
            activity: None,
            activity_at: None,
            remote: None,
            auth: Some("ok".into()),
            login_url: None,
            login_error: None,
        }
    }

    #[test]
    fn settings_are_checked_and_blank_instructions_become_null() {
        use serde_json::json;
        assert_eq!(normalize_settings(json!({ "instructions": "  \n\t" })).unwrap(), json!({ "instructions": null }));
        assert_eq!(normalize_settings(json!({ "instructions": "a\n  b " })).unwrap(), json!({ "instructions": "a\n  b " }));
        assert_eq!(normalize_settings(json!({ "instructions": null })).unwrap(), json!({ "instructions": null }));
        assert_eq!(normalize_settings(json!({})).unwrap(), json!({}));
        // an item this desktop does not know passes through
        assert_eq!(normalize_settings(json!({ "outputStyle": "x" })).unwrap(), json!({ "outputStyle": "x" }));
        assert!(normalize_settings(json!({ "instructions": "あ".repeat(SESSION_INSTRUCTIONS_MAX) })).is_ok());
        assert!(normalize_settings(json!({ "instructions": "あ".repeat(SESSION_INSTRUCTIONS_MAX + 1) })).is_err());
        assert!(normalize_settings(json!({ "instructions": 1 })).is_err());
        assert!(normalize_settings(json!("x")).is_err());
    }

    #[test]
    fn create_body_carries_settings_only_when_something_is_set() {
        use serde_json::json;
        assert_eq!(create_args("a", None, None), json!({ "name": "a" }));
        assert_eq!(create_args("a", None, Some(json!({}))), json!({ "name": "a" }));
        assert_eq!(create_args("a", None, Some(json!({ "instructions": null }))), json!({ "name": "a" }));
        let v = create_args("a", None, Some(json!({ "instructions": "x\ny" })));
        assert_eq!(v["name"], "a");
        assert_eq!(v["settings"]["instructions"], "x\ny");
        assert!(v.get("instructions").is_none());
        assert!(serde_json::to_string(&v).unwrap().contains("x\\ny"));
    }

    #[test]
    fn create_body_carries_path_only_when_not_blank() {
        use serde_json::json;
        assert_eq!(create_args("a", Some("/w/a"), None), json!({ "name": "a", "path": "/w/a" }));
        assert_eq!(create_args("a", Some("  /w/a \n"), None), json!({ "name": "a", "path": "/w/a" }));
        assert_eq!(create_args("a", Some(""), None), json!({ "name": "a" }));
        assert_eq!(create_args("a", Some("   "), None), json!({ "name": "a" }));
        assert_eq!(create_args("a", None, None), json!({ "name": "a" }));
        let v = create_args("a", Some("/w/a"), Some(json!({ "instructions": "x" })));
        assert_eq!(v["path"], "/w/a");
        assert_eq!(v["settings"]["instructions"], "x");
    }

    #[test]
    fn workspace_is_read_from_center_info_and_folder_dialog_only_for_the_own_center() {
        use crate::center_mcp::TargetSource::{Remote, Sidecar};
        use serde_json::json;
        assert_eq!(workspace_of(&json!({ "workspace": "/ws" })).as_deref(), Some("/ws"));
        assert_eq!(workspace_of(&json!({ "workspace": null })), None);
        assert_eq!(workspace_of(&json!({ "workspace": " " })), None);
        assert_eq!(workspace_of(&json!({})), None);
        assert!(can_pick_folder(Some(Sidecar), true));
        assert!(!can_pick_folder(Some(Remote), true));
        assert!(!can_pick_folder(None, true));
        assert!(!can_pick_folder(Some(Sidecar), false));
    }

    #[test]
    fn update_body_and_answer_round_trip() {
        use serde_json::json;
        let body = update_args("a", json!({ "instructions": null }));
        assert_eq!(body, json!({ "name": "a", "settings": { "instructions": null } }));
        let set = update_args("a", json!({ "instructions": "t" }));
        assert_eq!(set["settings"]["instructions"], "t");
        // the center answers { name, settings }: the whole settings after the update, unknown items kept
        let answer = json!({ "name": "a", "settings": { "instructions": "t", "skills": ["s"] } });
        assert_eq!(settings_of(&answer), json!({ "instructions": "t", "skills": ["s"] }));
        assert_eq!(settings_of(&json!({ "name": "a" })), json!({}));
        assert_eq!(settings_of(&json!({ "name": "a", "settings": 3 })), json!({}));
    }

    #[test]
    fn instructions_flag_is_read_and_false_when_absent() {
        let on: Session = serde_json::from_str(r#"{"name":"a","instructions":true}"#).unwrap();
        assert!(on.instructions);
        let off: Session = serde_json::from_str(r#"{"name":"a","instructions":false}"#).unwrap();
        assert!(!off.instructions);
        let old: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert!(!old.instructions);
    }

    #[test]
    fn remote_is_read_when_the_center_sends_it_and_none_otherwise() {
        let s: Session = serde_json::from_str(r#"{"name":"a","remote":{"running":2,"waitingReply":1}}"#).unwrap();
        assert_eq!(s.remote, Some(SessionRemote { running: 2, waiting_reply: 1, ..Default::default() }));
        assert_eq!(serde_json::to_value(&s).unwrap()["remote"]["waitingReply"], 1);
        let old: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(old.remote, None);
        let bad: Session = serde_json::from_str(r#"{"name":"a","remote":{"running":0,"waitingReply":0,"unreachable":[{"server":"host-a","remoteId":"c-1-a","lastOkAt":"2026-11-10T20:57:00.000Z"}],"lost":[{"server":"host-b","remoteId":"c-1-b","at":"2026-11-10T21:26:00.000Z"}]}}"#).unwrap();
        let r = bad.remote.unwrap();
        assert_eq!(r.unreachable[0].server, "host-a");
        assert_eq!(r.unreachable[0].last_ok_at.as_deref(), Some("2026-11-10T20:57:00.000Z"));
        assert_eq!(r.lost[0].remote_id, "c-1-b");
        let part: Session = serde_json::from_str(r#"{"name":"a","remote":{"running":1}}"#).unwrap();
        assert_eq!(part.remote, Some(SessionRemote { running: 1, waiting_reply: 0, ..Default::default() }));
    }

    #[test]
    fn activity_is_read_when_the_center_sends_it_and_none_otherwise() {
        let s: Session =
            serde_json::from_str(r#"{"name":"a","activity":"needs-input","activityAt":"2026-11-09T00:00:00.000Z"}"#).unwrap();
        assert_eq!(s.activity.as_deref(), Some("needs-input"));
        assert_eq!(s.activity_at.as_deref(), Some("2026-11-09T00:00:00.000Z"));
        let old: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!((old.activity, old.activity_at), (None, None));
        let null: Session = serde_json::from_str(r#"{"name":"a","activity":"unknown","activityAt":null}"#).unwrap();
        assert_eq!((null.activity.as_deref(), null.activity_at), (Some("unknown"), None));
        // the camelCase names are what the webview reads
        assert_eq!(serde_json::to_value(&s).unwrap()["activityAt"], "2026-11-09T00:00:00.000Z");
    }

    #[test]
    fn context_usage_is_read_when_the_center_sends_it_and_none_otherwise() {
        let with: Session = serde_json::from_str(
            r#"{"name":"a","state":"connected","contextUsage":{"usedTokens":84000,"windowTokens":200000,"percent":42,"updatedAt":"t"}}"#,
        )
        .unwrap();
        let u = with.context_usage.unwrap();
        assert_eq!((u.used_tokens, u.window_tokens, u.percent), (84000, Some(200000), Some(42.0)));
        let unknown: Session =
            serde_json::from_str(r#"{"name":"a","contextUsage":{"usedTokens":5,"windowTokens":null,"percent":null}}"#).unwrap();
        assert_eq!(unknown.context_usage.unwrap().window_tokens, None);
        let old: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(old.context_usage, None);
        let null: Session = serde_json::from_str(r#"{"name":"a","contextUsage":null}"#).unwrap();
        assert_eq!(null.context_usage, None);
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
            r#"{"name":"pm-a","path":"/p","state":"connected","pid":1,"sessionUrl":"https://u","startedAt":null,"source":"session","lastError":"x","auth":"login_required","loginUrl":"https://claude.com/cai/oauth/authorize?x","loginError":"Invalid code"}"#,
        )
        .unwrap();
        assert_eq!(e.session_url.as_deref(), Some("https://u"));
        assert_eq!(e.last_error.as_deref(), Some("x"));
        assert_eq!(e.path.as_deref(), Some("/p"));
        assert_eq!(e.auth.as_deref(), Some("login_required"));
        assert_eq!(e.login_url.as_deref(), Some("https://claude.com/cai/oauth/authorize?x"));
        assert_eq!(e.login_error.as_deref(), Some("Invalid code"));
        let bare: Session = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(bare.state, None);
        assert_eq!(bare.auth, None);
        assert_eq!(bare.login_url, None);
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
