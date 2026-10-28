//! bantou-center sidecar.
//!
//! The center (`packages/center`, a bun-compiled binary bundled as
//! `externalBin`) is started by the app when `center.enabled` is set. Settings
//! live in the shared `SETTINGS_FILE` store under `CENTER_KEY`; the frontend
//! only talks to the commands below. The sidecar reads a config JSON that is
//! regenerated from the settings on every (re)start.

use crate::error::{CmdResult, CommandError};
use crate::workspace::SETTINGS_FILE;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

const CENTER_KEY: &str = "center";
const SIDECAR_NAME: &str = "bantou-center";
const DEFAULT_PORT: u32 = 7910;
const DEFAULT_BIND: &str = "127.0.0.1";
/// Lines kept for the status panel.
const LOG_LINES: usize = 20;
/// Grace for SIGTERM before SIGKILL. The center's own shutdown waits stopGraceMs (5 s)
/// for its remote-control children and then hard-exits after another 5 s, so we must
/// outlast that (10 s) with margin or we would SIGKILL a center that is still cleaning up.
const STOP_GRACE: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);

const SPAWN_MODES: [&str; 3] = ["same-dir", "worktree", "session"];
const PERMISSION_MODES: [&str; 6] = [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "default",
    "dontAsk",
    "plan",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterProject {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CenterSettings {
    pub enabled: bool,
    pub port: u32,
    pub bind: String,
    pub projects: Vec<CenterProject>,
    /// Absolute path of the claude executable. Unset: the center resolves it via a login shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
    /// Center on another host this desktop will connect to (stored only for now).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

impl Default for CenterSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            bind: DEFAULT_BIND.to_string(),
            projects: Vec::new(),
            claude_path: None,
            remote_url: None,
        }
    }
}

/// Reject settings the center would refuse (mirrors `packages/center/src/config.ts`),
/// and normalise empty optionals to `None`.
pub fn validate_settings(mut s: CenterSettings) -> Result<CenterSettings, String> {
    if !(1..=65535).contains(&s.port) {
        return Err(format!("port は 1〜65535: {}", s.port));
    }
    s.bind = s.bind.trim().to_string();
    if s.bind.is_empty() || s.bind.chars().any(char::is_whitespace) {
        return Err("bind が不正".to_string());
    }
    let mut seen = HashSet::new();
    for p in &mut s.projects {
        p.name = p.name.trim().to_string();
        p.path = p.path.trim().to_string();
        if p.name.is_empty() || !p.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!("project 名は英数字と _ - のみ: \"{}\"", p.name));
        }
        if !seen.insert(p.name.clone()) {
            return Err(format!("project 名が重複: {}", p.name));
        }
        if !Path::new(&p.path).is_absolute() {
            return Err(format!("project {} の path は絶対パスで指定する", p.name));
        }
        p.spawn = p.spawn.take().filter(|v| !v.is_empty());
        if let Some(v) = &p.spawn {
            if !SPAWN_MODES.contains(&v.as_str()) {
                return Err(format!("project {} の spawn が不正: {v}", p.name));
            }
        }
        p.permission_mode = p.permission_mode.take().filter(|v| !v.is_empty());
        if let Some(v) = &p.permission_mode {
            if !PERMISSION_MODES.contains(&v.as_str()) {
                return Err(format!("project {} の permissionMode が不正: {v}", p.name));
            }
        }
    }
    s.claude_path = s.claude_path.take().map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &s.claude_path {
        if !Path::new(p).is_absolute() {
            return Err("claudePath は絶対パスで指定する".to_string());
        }
    }
    s.remote_url = s.remote_url.take().map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &s.remote_url {
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err("remoteUrl は http(s):// で始める".to_string());
        }
    }
    Ok(s)
}

/// Config file for the center. Every project autostarts: remote-control is
/// started by the center when the desktop starts it.
pub fn build_config(s: &CenterSettings) -> serde_json::Value {
    let projects: Vec<_> = s
        .projects
        .iter()
        .map(|p| {
            let mut o = serde_json::json!({ "name": p.name, "path": p.path, "autostart": true });
            if let Some(v) = &p.spawn {
                o["spawn"] = v.clone().into();
            }
            if let Some(v) = &p.permission_mode {
                o["permissionMode"] = v.clone().into();
            }
            o
        })
        .collect();
    let mut remote_control = serde_json::json!({});
    if let Some(v) = &s.claude_path {
        remote_control["claude"] = v.clone().into();
    }
    serde_json::json!({ "projects": projects, "remoteControl": remote_control, "servers": [] })
}

pub fn sidecar_args(s: &CenterSettings, config: &Path) -> Vec<String> {
    vec![
        "--transport".into(),
        "http".into(),
        "--port".into(),
        s.port.to_string(),
        "--bind".into(),
        s.bind.clone(),
        "--config".into(),
        config.to_string_lossy().into_owned(),
    ]
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| format!("HOME を解決できない: {e}"))?;
    Ok(home.join(".local/share/bantou/center.json"))
}

/// Whether applying `new` needs a stop/start. `running_with` is the settings the live
/// center was started with (None when not running). `remote_url` is not passed to the
/// center, so it never forces a restart. `claude_path` changes the child, so it does.
pub fn needs_restart(running_with: Option<&CenterSettings>, new: &CenterSettings) -> bool {
    match running_with {
        Some(old) => {
            !new.enabled || old.port != new.port || old.bind != new.bind
                || old.projects != new.projects
                || old.claude_path != new.claude_path
        }
        None => new.enabled,
    }
}

fn write_config(s: &CenterSettings, path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&build_config(s)).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum RunState {
    Stopped,
    Running,
    Error,
}

#[derive(Debug, Serialize)]
pub struct CenterStatus {
    state: RunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    logs: Vec<String>,
}

struct Inner {
    state: RunState,
    child: Option<CommandChild>,
    /// Settings the running process was started with.
    started_with: Option<CenterSettings>,
    pid: Option<u32>,
    error: Option<String>,
    logs: VecDeque<String>,
    /// Bumped per spawn so a late `Terminated` of an old process is ignored.
    generation: u64,
    /// Set while we are the ones ending the process (exit is then not an error).
    stopping: bool,
}

pub struct Center {
    inner: Mutex<Inner>,
    /// Serialises start / stop / restart.
    lifecycle: tokio::sync::Mutex<()>,
}

impl Default for Center {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                state: RunState::Stopped,
                child: None,
                started_with: None,
                pid: None,
                error: None,
                logs: VecDeque::new(),
                generation: 0,
                stopping: false,
            }),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

fn push_log(inner: &mut Inner, line: String) {
    if inner.logs.len() >= LOG_LINES {
        inner.logs.pop_front();
    }
    inner.logs.push_back(line);
}

impl Center {
    fn status(&self) -> CenterStatus {
        let g = self.inner.lock().unwrap();
        CenterStatus {
            state: g.state,
            pid: g.pid,
            error: g.error.clone(),
            logs: g.logs.iter().cloned().collect(),
        }
    }

    fn set_error(&self, msg: String) {
        let mut g = self.inner.lock().unwrap();
        g.state = RunState::Error;
        g.error = Some(msg);
    }

    /// Wait until the process is gone (its `Terminated` event clears `child`).
    async fn wait_gone(&self, limit: Duration) -> bool {
        let mut waited = Duration::ZERO;
        while waited < limit {
            if self.inner.lock().unwrap().child.is_none() {
                return true;
            }
            tokio::time::sleep(POLL).await;
            waited += POLL;
        }
        self.inner.lock().unwrap().child.is_none()
    }

    async fn stop_locked(&self) {
        let pid = {
            let mut g = self.inner.lock().unwrap();
            if g.child.is_none() {
                return;
            }
            g.stopping = true;
            g.pid
        };
        // SIGTERM first: the center stops its own remote-control children.
        let termed = pid.map(terminate).unwrap_or(false);
        if termed && self.wait_gone(STOP_GRACE).await {
            return;
        }
        // Fallback (and non-unix): `CommandChild::kill()` is SIGKILL.
        let child = {
            let mut g = self.inner.lock().unwrap();
            g.state = RunState::Stopped;
            g.pid = None;
            g.started_with = None;
            g.child.take()
        };
        if let Some(c) = child {
            let _ = c.kill();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    pub async fn stop(&self) {
        let _l = self.lifecycle.lock().await;
        self.stop_locked().await;
    }

    async fn start_locked(&self, app: &tauri::AppHandle, s: &CenterSettings) -> Result<(), String> {
        let path = config_path(app)?;
        write_config(s, &path)?;
        let cmd = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|e| e.to_string())?
            .args(sidecar_args(s, &path));
        let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
        let generation = {
            let mut g = self.inner.lock().unwrap();
            g.generation += 1;
            g.pid = Some(child.pid());
            g.child = Some(child);
            g.started_with = Some(s.clone());
            g.state = RunState::Running;
            g.error = None;
            g.stopping = false;
            g.logs.clear();
            g.generation
        };
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let center = handle.state::<Center>();
                let mut g = center.inner.lock().unwrap();
                match ev {
                    CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                        push_log(&mut g, String::from_utf8_lossy(&b).trim_end().to_string());
                    }
                    CommandEvent::Error(e) => push_log(&mut g, format!("[error] {e}")),
                    CommandEvent::Terminated(p) => {
                        if g.generation == generation {
                            g.child = None;
                            g.started_with = None;
                            g.pid = None;
                            if g.stopping || p.code == Some(0) {
                                g.state = RunState::Stopped;
                            } else {
                                g.state = RunState::Error;
                                g.error = Some(format!("exit code {:?}, signal {:?}", p.code, p.signal));
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }

    /// Stop whatever runs, then start again if `s.enabled`. A running center that was
    /// started with equivalent settings is left alone.
    pub async fn apply(&self, app: &tauri::AppHandle, s: &CenterSettings) {
        let _l = self.lifecycle.lock().await;
        let running_with = {
            let g = self.inner.lock().unwrap();
            if g.child.is_some() { g.started_with.clone() } else { None }
        };
        if !needs_restart(running_with.as_ref(), s) {
            return;
        }
        self.stop_locked().await;
        if !s.enabled {
            return;
        }
        if let Err(e) = self.start_locked(app, s).await {
            self.set_error(e);
        }
    }
}

/// SIGTERM via `kill(1)`; returns whether the signal was sent.
#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn terminate(_pid: u32) -> bool {
    false
}

fn load_settings(app: &tauri::AppHandle) -> CmdResult<CenterSettings> {
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    // A stored value that no longer parses falls back to the defaults.
    Ok(store
        .get(CENTER_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

/// Called from `setup`: start the sidecar if enabled.
pub fn autostart(app: &tauri::AppHandle) {
    let Ok(s) = load_settings(app) else { return };
    if !s.enabled {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle.state::<Center>().apply(&handle, &s).await;
    });
}

#[tauri::command]
pub fn center_get_settings(app: tauri::AppHandle) -> CmdResult<CenterSettings> {
    load_settings(&app)
}

#[tauri::command]
pub async fn center_set_settings(
    app: tauri::AppHandle,
    settings: CenterSettings,
) -> CmdResult<CenterSettings> {
    let s = validate_settings(settings).map_err(CommandError::Other)?;
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    store.set(CENTER_KEY, serde_json::to_value(&s).map_err(CommandError::other)?);
    store.save().map_err(CommandError::other)?;
    app.state::<Center>().apply(&app, &s).await;
    Ok(s)
}

#[tauri::command]
pub fn center_status(center: tauri::State<'_, Center>) -> CenterStatus {
    center.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, path: &str) -> CenterProject {
        CenterProject {
            name: name.into(),
            path: path.into(),
            spawn: None,
            permission_mode: None,
        }
    }

    #[test]
    fn defaults() {
        let s = CenterSettings::default();
        assert!(!s.enabled);
        assert_eq!(s.port, 7910);
        assert_eq!(s.bind, "127.0.0.1");
        assert!(validate_settings(s).is_ok());
    }

    #[test]
    fn partial_json_uses_defaults() {
        let s: CenterSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(s.enabled);
        assert_eq!(s.port, 7910);
    }

    #[test]
    fn rejects_bad_port_bind_and_remote_url() {
        let ok = CenterSettings::default();
        for port in [0, 65536] {
            assert!(validate_settings(CenterSettings { port, ..ok.clone() }).is_err());
        }
        assert!(validate_settings(CenterSettings { bind: " ".into(), ..ok.clone() }).is_err());
        assert!(validate_settings(CenterSettings { remote_url: Some("ftp://x".into()), ..ok.clone() }).is_err());
        let s = validate_settings(CenterSettings { remote_url: Some("  ".into()), ..ok }).unwrap();
        assert_eq!(s.remote_url, None);
    }

    #[test]
    fn rejects_bad_projects() {
        let with = |projects| validate_settings(CenterSettings { projects, ..Default::default() });
        assert!(with(vec![project("a b", "/x")]).is_err());
        assert!(with(vec![project("a", "rel/path")]).is_err());
        assert!(with(vec![project("a", "/x"), project("a", "/y")]).is_err());
        let mut p = project("a", "/x");
        p.spawn = Some("nope".into());
        assert!(with(vec![p]).is_err());
        let mut p = project("a", "/x");
        p.permission_mode = Some("nope".into());
        assert!(with(vec![p]).is_err());
    }

    #[test]
    fn empty_optionals_become_none() {
        let mut p = project("a", "/x");
        p.spawn = Some(String::new());
        p.permission_mode = Some(String::new());
        let s = validate_settings(CenterSettings { projects: vec![p], ..Default::default() }).unwrap();
        assert_eq!(s.projects[0].spawn, None);
        assert_eq!(s.projects[0].permission_mode, None);
    }

    #[test]
    fn config_json_writes_claude_path_only_when_set() {
        let s = CenterSettings { claude_path: Some("/opt/claude".into()), ..Default::default() };
        assert_eq!(build_config(&s)["remoteControl"], serde_json::json!({ "claude": "/opt/claude" }));
        assert_eq!(build_config(&CenterSettings::default())["remoteControl"], serde_json::json!({}));
    }

    #[test]
    fn claude_path_validation() {
        let with = |p: &str| validate_settings(CenterSettings { claude_path: Some(p.into()), ..Default::default() });
        assert!(with("claude").is_err());
        assert!(with("./claude").is_err());
        assert_eq!(with(" /a/claude ").unwrap().claude_path.as_deref(), Some("/a/claude"));
        // empty / blank means unset
        assert_eq!(with("  ").unwrap().claude_path, None);
    }

    #[test]
    fn config_json_marks_projects_autostart() {
        let mut p = project("a", "/x");
        p.spawn = Some("worktree".into());
        p.permission_mode = Some("plan".into());
        let s = CenterSettings { projects: vec![p, project("b", "/y")], ..Default::default() };
        assert_eq!(
            build_config(&s),
            serde_json::json!({
                "projects": [
                    { "name": "a", "path": "/x", "spawn": "worktree", "permissionMode": "plan", "autostart": true },
                    { "name": "b", "path": "/y", "autostart": true },
                ],
                "remoteControl": {},
                "servers": [],
            })
        );
    }

    #[test]
    fn restart_only_on_effective_change() {
        let on = CenterSettings { enabled: true, projects: vec![project("a", "/x")], ..Default::default() };
        // running, identical or remoteUrl-only change: no restart
        assert!(!needs_restart(Some(&on), &on));
        let remote = CenterSettings { remote_url: Some("http://h:1".into()), ..on.clone() };
        assert!(!needs_restart(Some(&on), &remote));
        // running, effective change: restart
        assert!(needs_restart(Some(&on), &CenterSettings { port: 7911, ..on.clone() }));
        assert!(needs_restart(Some(&on), &CenterSettings { bind: "0.0.0.0".into(), ..on.clone() }));
        assert!(needs_restart(Some(&on), &CenterSettings { projects: vec![], ..on.clone() }));
        assert!(needs_restart(Some(&on), &CenterSettings { claude_path: Some("/x/claude".into()), ..on.clone() }));
        // running, disabled: stop
        assert!(needs_restart(Some(&on), &CenterSettings { enabled: false, ..on.clone() }));
        // not running: start only when enabled
        assert!(needs_restart(None, &on));
        assert!(!needs_restart(None, &CenterSettings::default()));
    }

    #[test]
    fn sidecar_args_follow_the_cli_contract() {
        let s = CenterSettings { port: 8000, bind: "0.0.0.0".into(), ..Default::default() };
        assert_eq!(
            sidecar_args(&s, Path::new("/c.json")),
            ["--transport", "http", "--port", "8000", "--bind", "0.0.0.0", "--config", "/c.json"]
        );
    }
}
