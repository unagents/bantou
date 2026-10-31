//! bantou-center sidecar.
//!
//! The center (`packages/center`, a bun-compiled binary bundled as
//! `externalBin`) is started by the app when `center.enabled` is set. Settings
//! live in the shared `SETTINGS_FILE` store under `CENTER_KEY`; the frontend
//! only talks to the commands below. The sidecar reads a config JSON that is
//! regenerated from the settings on every (re)start.

use crate::error::{CmdResult, CommandError};
use crate::workspace::SETTINGS_FILE;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

const CENTER_KEY: &str = "center";
const SIDECAR_NAME: &str = "bantou-center";
const DEFAULT_PORT: u32 = 7910;
/// What the center listens on: always every address (LAN, Tailscale ...); the token guards it.
/// The IP the user picks (`CenterSettings::bind`) only decides the host of the connection settings.
const LISTEN_BIND: &str = "0.0.0.0";
/// Shortest token the center accepts (mirrors `MIN_TOKEN_LEN` in `packages/center/src/config.ts`).
pub const MIN_TOKEN_LEN: usize = 12;
const GENERATED_TOKEN_LEN: usize = 32;
const BASE62: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// Lines kept for the status panel.
const LOG_LINES: usize = 20;
/// Grace for SIGTERM before SIGKILL. The center's own shutdown waits stopGraceMs (5 s)
/// for its remote-control children and then hard-exits after another 5 s, so we must
/// outlast that (10 s) with margin or we would SIGKILL a center that is still cleaning up.
/// (The center's hard-exit timer also SIGKILLs its children's process groups first, so a
/// center that is allowed to reach it leaves no orphan; a center SIGKILLed by us does, and the
/// next center reaps it at start.)
const STOP_GRACE: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);
/// Auto-restart after an abnormal exit: first delay, doubled per consecutive failure, capped.
const RESTART_BASE: Duration = Duration::from_secs(2);
const RESTART_MAX: Duration = Duration::from_secs(60);
/// More than `MAX_FAILURES` abnormal exits within `FAILURE_WINDOW` stops the retrying.
const FAILURE_WINDOW: Duration = Duration::from_secs(600);
const MAX_FAILURES: usize = 5;
/// A run at least this long counts as healthy and clears the failure history.
const HEALTHY_AFTER: Duration = Duration::from_secs(300);
/// Log lines quoted in the error once the retrying is given up.
const ERROR_TAIL_LINES: usize = 5;

/// Default workspace (`~` is the home directory, resolved when the config is written).
const DEFAULT_WORKSPACE: &str = "~/.bantou";
/// Name of the single project handed to the center for the workspace.
const WORKSPACE_PROJECT: &str = "workspace";

/// A center on another host, taken from a pasted connection snippet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterRemote {
    pub url: String,
    /// Bearer token from the snippet. None: the snippet had none (the center will answer 401).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CenterSettings {
    pub enabled: bool,
    pub port: u32,
    /// The IP the connection settings (mcp.json / claude mcp add) name as the URL host. Not what the
    /// center listens on (always `LISTEN_BIND`). Empty: nothing saved, the default IP applies.
    pub bind: String,
    /// The one workspace directory handed to the center as its single project. `~` / `~/x` or absolute.
    pub workspace: String,
    /// Absolute path of the claude executable. Unset: the center resolves it via a login shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
    /// Bearer token the sidecar center requires on `/mcp`. Minted on first load when empty.
    pub token: String,
    /// Center on another host this desktop connects to (used instead of the sidecar when set).
    /// The old `remoteUrl` key of earlier versions is not read: serde drops unknown keys and
    /// the next save writes the new shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<CenterRemote>,
}

impl Default for CenterSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            bind: String::new(),
            workspace: DEFAULT_WORKSPACE.to_string(),
            claude_path: None,
            token: String::new(),
            remote: None,
        }
    }
}

/// A fresh random Bearer token (32-char base62 from the thread CSPRNG, like Cork's `mint_token`).
pub fn mint_token() -> String {
    let mut rng = rand::rng();
    (0..GENERATED_TOKEN_LEN)
        .map(|_| BASE62[rng.random_range(0..BASE62.len())] as char)
        .collect()
}

/// Settings with a usable token: an empty or too-short stored token is replaced by a fresh one.
/// The flag says whether it was replaced (so the caller persists it).
pub fn ensure_token(mut s: CenterSettings) -> (CenterSettings, bool) {
    if s.token.chars().count() >= MIN_TOKEN_LEN {
        return (s, false);
    }
    s.token = mint_token();
    (s, true)
}

/// Reject settings the center would refuse (mirrors `packages/center/src/config.ts`),
/// and normalise empty optionals to `None`.
pub fn validate_settings(mut s: CenterSettings) -> Result<CenterSettings, String> {
    if !(1..=65535).contains(&s.port) {
        return Err(format!("port は 1〜65535: {}", s.port));
    }
    s.bind = s.bind.trim().to_string();
    if s.bind.chars().any(char::is_whitespace) {
        return Err("bind が不正".to_string());
    }
    s.workspace = s.workspace.trim().to_string();
    if s.workspace.is_empty() {
        s.workspace = DEFAULT_WORKSPACE.to_string();
    }
    if !(s.workspace == "~" || s.workspace.starts_with("~/") || Path::new(&s.workspace).is_absolute()) {
        return Err(format!("workspace は絶対パスか ~ 始まりで指定する: {}", s.workspace));
    }
    s.claude_path = s.claude_path.take().map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &s.claude_path {
        if !Path::new(p).is_absolute() {
            return Err("claudePath は絶対パスで指定する".to_string());
        }
    }
    if !s.token.is_empty() && s.token.chars().count() < MIN_TOKEN_LEN {
        return Err(format!("token は {MIN_TOKEN_LEN} 文字以上"));
    }
    if let Some(r) = &mut s.remote {
        r.url = r.url.trim().to_string();
        if !(r.url.starts_with("http://") || r.url.starts_with("https://")) {
            return Err("remote の url は http(s):// で始める".to_string());
        }
        r.token = r.token.take().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    }
    Ok(s)
}

/// `~` / `~/x` against `home`; anything else as is.
pub fn resolve_workspace(workspace: &str, home: &Path) -> PathBuf {
    if workspace == "~" {
        home.to_path_buf()
    } else if let Some(rest) = workspace.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(workspace)
    }
}

/// Config file for the center: the workspace as its single project. It autostarts: remote-control is
/// started by the center when the desktop starts it. spawn / permissionMode are left to the center's defaults.
pub fn build_config(s: &CenterSettings, home: &Path) -> serde_json::Value {
    let projects = vec![serde_json::json!({
        "name": WORKSPACE_PROJECT,
        "path": resolve_workspace(&s.workspace, home).to_string_lossy(),
        "autostart": true,
    })];
    let mut remote_control = serde_json::json!({});
    if let Some(v) = &s.claude_path {
        remote_control["claude"] = v.clone().into();
    }
    let mut cfg = serde_json::json!({ "projects": projects, "remoteControl": remote_control });
    if !s.token.is_empty() {
        cfg["token"] = s.token.clone().into();
    }
    cfg
}

pub fn sidecar_args(s: &CenterSettings, config: &Path) -> Vec<String> {
    vec![
        "--transport".into(),
        "http".into(),
        "--port".into(),
        s.port.to_string(),
        "--bind".into(),
        LISTEN_BIND.into(),
        "--config".into(),
        config.to_string_lossy().into_owned(),
    ]
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| format!("HOME を解決できない: {e}"))?;
    Ok(home.join(".local/share/bantou/center.json"))
}

/// Whether applying `new` needs a stop/start. `running_with` is the settings the live
/// center was started with (None when not running). `remote` is not passed to the
/// center, so it never forces a restart; neither does `bind` (the center always listens on every address). `claude_path` and `token` change what the child
/// gets, so they do.
pub fn needs_restart(running_with: Option<&CenterSettings>, new: &CenterSettings) -> bool {
    match running_with {
        Some(old) => {
            !new.enabled || old.port != new.port
                || old.workspace != new.workspace
                || old.claude_path != new.claude_path
                || old.token != new.token
        }
        None => new.enabled,
    }
}

fn write_config(s: &CenterSettings, path: &Path, home: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let ws = resolve_workspace(&s.workspace, home);
    std::fs::create_dir_all(&ws).map_err(|e| format!("{}: {e}", ws.display()))?;
    let text = serde_json::to_string_pretty(&build_config(s, home)).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Delay before restart number `n` (0-based consecutive failure): 2 s, 4 s, ... capped at 60 s.
pub fn backoff_delay(n: usize) -> Duration {
    let mult = 1u32 << n.min(16);
    RESTART_BASE.saturating_mul(mult).min(RESTART_MAX)
}

#[derive(Debug, PartialEq)]
pub enum ExitDecision {
    Retry(Duration),
    GiveUp,
}

/// Failure bookkeeping for the auto-restart. Pure: time comes in as `Instant` parameters.
#[derive(Debug, Default)]
pub struct Supervisor {
    failures: VecDeque<Instant>,
    started_at: Option<Instant>,
    restart_count: u32,
}

impl Supervisor {
    pub fn on_started(&mut self, now: Instant) {
        self.started_at = Some(now);
    }

    /// Record an abnormal exit at `now` and decide what to do next.
    pub fn on_abnormal_exit(&mut self, now: Instant) -> ExitDecision {
        if let Some(t) = self.started_at.take() {
            if now.saturating_duration_since(t) >= HEALTHY_AFTER {
                self.failures.clear();
            }
        }
        self.failures.retain(|t| now.saturating_duration_since(*t) <= FAILURE_WINDOW);
        self.failures.push_back(now);
        if self.failures.len() > MAX_FAILURES {
            ExitDecision::GiveUp
        } else {
            ExitDecision::Retry(backoff_delay(self.failures.len() - 1))
        }
    }

    pub fn failure_count(&self) -> usize {
        self.failures.len()
    }

    pub fn restart_count(&self) -> u32 {
        self.restart_count
    }

    pub fn note_restart(&mut self) {
        self.restart_count += 1;
    }

    /// A user-driven (re)start or stop starts from a clean slate.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Human-readable exit reason from the sidecar's `Terminated` payload.
pub fn describe_exit(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(c), Some(sg)) => format!("exit code {c}, signal {sg}"),
        (Some(c), None) => format!("exit code {c}"),
        (None, Some(sg)) => format!("signal {sg}"),
        (None, None) => "unknown exit".to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum RunState {
    Stopped,
    Running,
    /// Exited abnormally; a restart is scheduled.
    Restarting,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterStatus {
    state: RunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Automatic restarts performed since the last user-driven start.
    restart_count: u32,
    /// Reason of the last unintended exit (exit code / signal).
    #[serde(skip_serializing_if = "Option::is_none")]
    last_exit: Option<String>,
    /// The center could not listen (address / port unusable), judged from its log. The dialog then
    /// shows the same IP status as for a vanished IP.
    bind_failed: bool,
    logs: Vec<String>,
}

/// Whether the center's log says it could not listen (node's `listen EADDRINUSE` etc.).
pub fn looks_like_bind_failure<'a>(logs: impl IntoIterator<Item = &'a str>) -> bool {
    logs.into_iter().any(|l| ["EADDRNOTAVAIL", "EADDRINUSE", "EACCES"].iter().any(|c| l.contains(c)))
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
    /// Bumped on every stop; a scheduled restart only fires if it still holds the epoch it was
    /// scheduled with (so stop / settings change / app exit cancel it).
    epoch: u64,
    /// Settings to restart with after an abnormal exit.
    desired: Option<CenterSettings>,
    sup: Supervisor,
    last_exit: Option<String>,
}

/// What the `Terminated` handler decided.
#[derive(Debug, PartialEq)]
enum TermOutcome {
    /// Old generation: not ours any more.
    Ignored,
    /// We stopped it on purpose.
    Stopped,
    /// Abnormal: restart after `delay` unless `epoch` is superseded.
    Retry { epoch: u64, delay: Duration },
    /// Too many abnormal exits: stay down with an error.
    GaveUp,
}

impl Inner {
    fn new() -> Self {
        Inner {
            state: RunState::Stopped,
            child: None,
            started_with: None,
            pid: None,
            error: None,
            logs: VecDeque::new(),
            generation: 0,
            stopping: false,
            epoch: 0,
            desired: None,
            sup: Supervisor::default(),
            last_exit: None,
        }
    }

    fn on_terminated(&mut self, generation: u64, code: Option<i32>, signal: Option<i32>, now: Instant) -> TermOutcome {
        if self.generation != generation {
            return TermOutcome::Ignored;
        }
        self.child = None;
        self.started_with = None;
        self.pid = None;
        if self.stopping {
            self.state = RunState::Stopped;
            return TermOutcome::Stopped;
        }
        let reason = describe_exit(code, signal);
        self.last_exit = Some(reason.clone());
        match self.sup.on_abnormal_exit(now) {
            ExitDecision::Retry(delay) => {
                self.state = RunState::Restarting;
                self.error = None;
                TermOutcome::Retry { epoch: self.epoch, delay }
            }
            ExitDecision::GiveUp => {
                self.state = RunState::Error;
                let tail: Vec<&str> = self
                    .logs
                    .iter()
                    .map(String::as_str)
                    .filter(|l| !l.is_empty())
                    .rev()
                    .take(ERROR_TAIL_LINES)
                    .collect();
                let mut msg = format!(
                    "center が {} 回異常終了したため自動再起動を停止 ({} 分以内)。最終: {reason}",
                    self.sup.failure_count(),
                    FAILURE_WINDOW.as_secs() / 60
                );
                if !tail.is_empty() {
                    msg.push_str("\n直近ログ:\n");
                    msg.push_str(&tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
                }
                self.error = Some(msg);
                TermOutcome::GaveUp
            }
        }
    }
}

pub struct Center {
    inner: Mutex<Inner>,
    /// Serialises start / stop / restart.
    lifecycle: tokio::sync::Mutex<()>,
}

impl Default for Center {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::new()),
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
        let failed_state = matches!(g.state, RunState::Restarting | RunState::Error);
        CenterStatus {
            bind_failed: failed_state && looks_like_bind_failure(g.logs.iter().map(String::as_str)),
            state: g.state,
            pid: g.pid,
            error: g.error.clone(),
            restart_count: g.sup.restart_count(),
            last_exit: g.last_exit.clone(),
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
            // Cancels any scheduled restart, whether or not a process is alive.
            g.epoch += 1;
            g.desired = None;
            if g.child.is_none() {
                if g.state == RunState::Restarting {
                    g.state = RunState::Stopped;
                }
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

    fn start_locked(&self, app: &tauri::AppHandle, s: &CenterSettings) -> Result<(), String> {
        let path = config_path(app)?;
        let home = app.path().home_dir().map_err(|e| format!("HOME を解決できない: {e}"))?;
        write_config(s, &path, &home)?;
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
            g.desired = Some(s.clone());
            g.sup.on_started(Instant::now());
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
                let retry = {
                    let mut g = center.inner.lock().unwrap();
                    match ev {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                            push_log(&mut g, String::from_utf8_lossy(&b).trim_end().to_string());
                            None
                        }
                        CommandEvent::Error(e) => {
                            push_log(&mut g, format!("[error] {e}"));
                            None
                        }
                        CommandEvent::Terminated(p) => {
                            match g.on_terminated(generation, p.code, p.signal, Instant::now()) {
                                TermOutcome::Retry { epoch, delay } => Some((epoch, delay)),
                                _ => None,
                            }
                        }
                        _ => None,
                    }
                };
                if let Some((epoch, delay)) = retry {
                    let h = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        h.state::<Center>().restart_after(&h, epoch, delay).await;
                    });
                }
            }
        });
        Ok(())
    }

    /// Scheduled restart after an abnormal exit. Does nothing if a stop / settings change /
    /// app exit bumped the epoch meanwhile.
    async fn restart_after(&self, app: &tauri::AppHandle, epoch: u64, delay: Duration) {
        tokio::time::sleep(delay).await;
        let _l = self.lifecycle.lock().await;
        let settings = {
            let mut g = self.inner.lock().unwrap();
            if g.epoch != epoch || g.state != RunState::Restarting {
                return;
            }
            let Some(s) = g.desired.clone() else { return };
            g.sup.note_restart();
            s
        };
        if let Err(e) = self.start_locked(app, &settings) {
            self.set_error(format!("自動再起動に失敗: {e}"));
        }
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
        {
            // User-driven: start from a clean failure history.
            let mut g = self.inner.lock().unwrap();
            g.sup.reset();
            g.last_exit = None;
        }
        if !s.enabled {
            return;
        }
        if let Err(e) = self.start_locked(app, s) {
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

/// Stored settings, with a token guaranteed: when none is stored a fresh one is minted and saved
/// (so the snippets the user copies stay valid across restarts).
pub(crate) fn load_settings(app: &tauri::AppHandle) -> CmdResult<CenterSettings> {
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    // A stored value that no longer parses falls back to the defaults.
    let stored: CenterSettings = store
        .get(CENTER_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let (s, minted) = ensure_token(stored);
    // A saved IP is kept as is, even when this machine no longer has it (the settings dialog
    // reports that and the user chooses; see `center_ip_status`).
    if minted {
        store.set(CENTER_KEY, serde_json::to_value(&s).map_err(CommandError::other)?);
        store.save().map_err(CommandError::other)?;
    }
    Ok(s)
}

/// One-line reason logged when autostart does nothing. `path` is the resolved settings store.
fn autostart_skip_message(path: &str, loaded: Result<&CenterSettings, &str>) -> String {
    match loaded {
        Err(e) => format!("center autostart skipped: cannot read settings ({path}): {e}"),
        Ok(_) => format!("center autostart skipped: center.enabled=false in settings ({path})"),
    }
}

/// Called from `setup`: start the sidecar if enabled.
pub fn autostart(app: &tauri::AppHandle) {
    let store_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join(SETTINGS_FILE).display().to_string())
        .unwrap_or_else(|e| format!("{SETTINGS_FILE} (app data dir unresolved: {e})"));
    let s = match load_settings(app) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}", autostart_skip_message(&store_path, Err(&e.to_string())));
            return;
        }
    };
    if !s.enabled {
        eprintln!("{}", autostart_skip_message(&store_path, Ok(&s)));
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle.state::<Center>().apply(&handle, &s).await;
    });
}

/// Stored settings for the dialog. With no IP saved, `bind` shows the default IP (it is stored when
/// the dialog saves).
#[tauri::command]
pub fn center_get_settings(app: tauri::AppHandle) -> CmdResult<CenterSettings> {
    let mut s = load_settings(&app)?;
    s.bind = crate::center_snippet::resolve_bind(&s.bind, &crate::center_snippet::local_ips());
    Ok(s)
}

/// The saved IP checked against this machine's addresses now (see `center_snippet::ip_status`).
#[tauri::command]
pub fn center_ip_status(app: tauri::AppHandle) -> CmdResult<crate::center_snippet::IpStatus> {
    let s = load_settings(&app)?;
    Ok(crate::center_snippet::ip_status(&s.bind, &crate::center_snippet::local_ips()))
}

#[tauri::command]
pub async fn center_set_settings(
    app: tauri::AppHandle,
    settings: CenterSettings,
) -> CmdResult<CenterSettings> {
    let (s, _) = ensure_token(validate_settings(settings).map_err(CommandError::Other)?);
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    store.set(CENTER_KEY, serde_json::to_value(&s).map_err(CommandError::other)?);
    store.save().map_err(CommandError::other)?;
    app.state::<Center>().apply(&app, &s).await;
    Ok(s)
}

/// Mint a new token, store it (nothing else in the settings changes) and restart a running
/// center with it. Returns the new token.
#[tauri::command]
pub async fn center_regenerate_token(app: tauri::AppHandle) -> CmdResult<String> {
    let mut s = load_settings(&app)?;
    s.token = mint_token();
    let store = app.store(SETTINGS_FILE).map_err(CommandError::other)?;
    store.set(CENTER_KEY, serde_json::to_value(&s).map_err(CommandError::other)?);
    store.save().map_err(CommandError::other)?;
    app.state::<Center>().apply(&app, &s).await;
    Ok(s.token)
}

#[tauri::command]
pub fn center_status(center: tauri::State<'_, Center>) -> CenterStatus {
    center.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_skip_message_has_path_and_reason() {
        let s = CenterSettings::default();
        let m = autostart_skip_message("/d/settings.json", Ok(&s));
        assert!(m.contains("/d/settings.json") && m.contains("enabled=false"));
        let m = autostart_skip_message("/d/settings.json", Err("boom"));
        assert!(m.contains("/d/settings.json") && m.contains("cannot read settings") && m.contains("boom"));
    }

    #[test]
    fn defaults() {
        let s = CenterSettings::default();
        assert!(!s.enabled);
        assert_eq!(s.port, 7910);
        assert_eq!(s.bind, "");
        assert_eq!(s.workspace, "~/.bantou");
        assert!(validate_settings(s).is_ok());
    }

    #[test]
    fn partial_json_uses_defaults() {
        let s: CenterSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(s.enabled);
        assert_eq!(s.port, 7910);
    }

    #[test]
    fn rejects_bad_port_bind_and_remote() {
        let ok = CenterSettings::default();
        for port in [0, 65536] {
            assert!(validate_settings(CenterSettings { port, ..ok.clone() }).is_err());
        }
        assert!(validate_settings(CenterSettings { bind: "a b".into(), ..ok.clone() }).is_err());
        // empty = nothing saved (the default IP applies)
        assert_eq!(validate_settings(CenterSettings { bind: " ".into(), ..ok.clone() }).unwrap().bind, "");
        let remote = |url: &str, token: Option<&str>| CenterSettings {
            remote: Some(CenterRemote { url: url.into(), token: token.map(str::to_string) }),
            ..ok.clone()
        };
        assert!(validate_settings(remote("ftp://x", None)).is_err());
        // a blank token means "none"; the url is trimmed
        let s = validate_settings(remote(" http://h:1/mcp ", Some("  "))).unwrap();
        assert_eq!(s.remote, Some(CenterRemote { url: "http://h:1/mcp".into(), token: None }));
    }

    #[test]
    fn token_validation_and_minting() {
        let with = |t: &str| validate_settings(CenterSettings { token: t.into(), ..Default::default() });
        // empty is allowed here (it is minted on load); non-empty must reach the minimum
        assert!(with("").is_ok());
        assert!(with(&"x".repeat(MIN_TOKEN_LEN - 1)).is_err());
        assert!(with(&"x".repeat(MIN_TOKEN_LEN)).is_ok());

        let t = mint_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()), "{t}");
        let many: std::collections::HashSet<String> = (0..50).map(|_| mint_token()).collect();
        assert_eq!(many.len(), 50);
    }

    #[test]
    fn ensure_token_mints_only_when_missing_or_short() {
        let (s, minted) = ensure_token(CenterSettings::default());
        assert!(minted && s.token.len() == 32);
        let (kept, minted) = ensure_token(s.clone());
        assert!(!minted);
        assert_eq!(kept.token, s.token);
        let (s2, minted) = ensure_token(CenterSettings { token: "short".into(), ..Default::default() });
        assert!(minted && s2.token != "short");
    }

    #[test]
    fn old_remote_url_key_is_dropped_on_read() {
        let s: CenterSettings =
            serde_json::from_str(r#"{"enabled":true,"remoteUrl":"http://old:7910","token":"abcdefghijkl"}"#).unwrap();
        assert_eq!(s.remote, None);
        assert!(!serde_json::to_string(&s).unwrap().contains("remoteUrl"));
    }

    #[test]
    fn old_connect_host_key_is_dropped_on_read() {
        let old: CenterSettings =
            serde_json::from_str(r#"{"bind":"0.0.0.0","connectHost":"192.168.1.204","token":"abcdefghijkl"}"#).unwrap();
        // no migration: the saved bind is read as is
        assert_eq!(old.bind, "0.0.0.0");
        assert!(!serde_json::to_string(&old).unwrap().contains("connectHost"));
    }

    #[test]
    fn bind_failure_is_read_from_the_log() {
        assert!(looks_like_bind_failure(["x", "Error: listen EADDRINUSE: address already in use 0.0.0.0:7910"]));
        assert!(looks_like_bind_failure(["listen EADDRNOTAVAIL: address not available 192.168.1.50:7910"]));
        assert!(!looks_like_bind_failure(["MCP http 待受: http://0.0.0.0:7910/mcp"]));
        assert!(!looks_like_bind_failure([]));
    }

    #[test]
    fn config_json_writes_token_only_when_set() {
        let s = CenterSettings { token: "abcdefghijkl".into(), ..Default::default() };
        assert_eq!(build_config(&s, Path::new("/h"))["token"], "abcdefghijkl");
        assert!(build_config(&CenterSettings::default(), Path::new("/h")).get("token").is_none());
    }

    #[test]
    fn workspace_validation() {
        let with = |w: &str| validate_settings(CenterSettings { workspace: w.into(), ..Default::default() });
        assert_eq!(with(" /a/ws ").unwrap().workspace, "/a/ws");
        assert_eq!(with("~/x").unwrap().workspace, "~/x");
        assert_eq!(with("~").unwrap().workspace, "~");
        // blank means the default
        assert_eq!(with("  ").unwrap().workspace, "~/.bantou");
        assert!(with("rel/path").is_err());
        assert!(with("~other/x").is_err());
    }

    #[test]
    fn resolves_workspace_against_home() {
        let h = Path::new("/home/u");
        assert_eq!(resolve_workspace("~/.bantou", h), PathBuf::from("/home/u/.bantou"));
        assert_eq!(resolve_workspace("~", h), PathBuf::from("/home/u"));
        assert_eq!(resolve_workspace("/w/x", h), PathBuf::from("/w/x"));
    }

    #[test]
    fn config_json_writes_claude_path_only_when_set() {
        let s = CenterSettings { claude_path: Some("/opt/claude".into()), ..Default::default() };
        assert_eq!(build_config(&s, Path::new("/h"))["remoteControl"], serde_json::json!({ "claude": "/opt/claude" }));
        assert_eq!(build_config(&CenterSettings::default(), Path::new("/h"))["remoteControl"], serde_json::json!({}));
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
    fn config_json_has_the_workspace_as_single_project() {
        let s = CenterSettings { workspace: "~/.bantou".into(), ..Default::default() };
        assert_eq!(
            build_config(&s, Path::new("/home/u")),
            serde_json::json!({
                "projects": [
                    { "name": "workspace", "path": "/home/u/.bantou", "autostart": true },
                ],
                "remoteControl": {},
            })
        );
        let s = CenterSettings { workspace: "/w/x".into(), ..Default::default() };
        assert_eq!(build_config(&s, Path::new("/home/u"))["projects"].as_array().unwrap().len(), 1);
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bantou-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn write_config_creates_the_workspace_directory() {
        let home = tmp_dir("create");
        let cfg = home.join(".local/share/bantou/center.json");
        let s = CenterSettings::default();
        write_config(&s, &cfg, &home).unwrap();
        assert!(home.join(".bantou").is_dir());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["projects"].as_array().unwrap().len(), 1);
        assert_eq!(v["projects"][0]["path"], home.join(".bantou").to_string_lossy().as_ref());
        // existing directory (with content) is left alone, rewrite is the same
        std::fs::write(home.join(".bantou/keep"), "x").unwrap();
        write_config(&s, &cfg, &home).unwrap();
        assert!(home.join(".bantou/keep").is_file());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn old_projects_and_servers_keys_are_ignored_not_errors() {
        // A settings.json still carrying the removed keys (and whatever else) reads without error;
        // the keys are not part of the settings, so they are never written back.
        let s: CenterSettings = serde_json::from_str(
            r#"{"enabled":true,"workspace":"/w/z","projects":[{"name":"a","path":"/w/a","spawn":"worktree"}],
                "servers":[{"name":"a","broker":"http://h:1"}],"somethingElse":1}"#,
        )
        .unwrap();
        assert!(s.enabled);
        assert_eq!(s.workspace, "/w/z");
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("projects").is_none() && v.get("servers").is_none());
        // no workspace stored: the default
        let s: CenterSettings = serde_json::from_str(r#"{"projects":[],"servers":[]}"#).unwrap();
        assert_eq!(s.workspace, "~/.bantou");
        assert!(validate_settings(s).is_ok());
    }

    #[test]
    fn config_json_has_no_servers() {
        assert!(build_config(&CenterSettings::default(), Path::new("/h")).get("servers").is_none());
    }

    #[test]
    fn restart_only_on_effective_change() {
        let on = CenterSettings { enabled: true, workspace: "/x".into(), ..Default::default() };
        // running, identical or remote-only change: no restart
        assert!(!needs_restart(Some(&on), &on));
        let remote = CenterSettings {
            remote: Some(CenterRemote { url: "http://h:1/mcp".into(), token: Some("t".into()) }),
            ..on.clone()
        };
        assert!(!needs_restart(Some(&on), &remote));
        // a new token restarts the center so it picks the token up
        assert!(needs_restart(Some(&on), &CenterSettings { token: "another-token-1".into(), ..on.clone() }));
        // running, effective change: restart
        assert!(needs_restart(Some(&on), &CenterSettings { port: 7911, ..on.clone() }));
        // the picked IP only names the connection settings' host: no restart
        assert!(!needs_restart(Some(&on), &CenterSettings { bind: "192.168.1.50".into(), ..on.clone() }));
        assert!(needs_restart(Some(&on), &CenterSettings { workspace: "/y".into(), ..on.clone() }));
        assert!(needs_restart(Some(&on), &CenterSettings { claude_path: Some("/x/claude".into()), ..on.clone() }));
        // running, disabled: stop
        assert!(needs_restart(Some(&on), &CenterSettings { enabled: false, ..on.clone() }));
        // not running: start only when enabled
        assert!(needs_restart(None, &on));
        assert!(!needs_restart(None, &CenterSettings::default()));
    }

    #[test]
    fn sidecar_args_follow_the_cli_contract() {
        // always every address, whatever IP is picked for the connection settings
        let s = CenterSettings { port: 8000, bind: "192.168.1.50".into(), ..Default::default() };
        assert_eq!(
            sidecar_args(&s, Path::new("/c.json")),
            ["--transport", "http", "--port", "8000", "--bind", "0.0.0.0", "--config", "/c.json"]
        );
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let seq: Vec<u64> = (0..9).map(|n| backoff_delay(n).as_secs()).collect();
        assert_eq!(seq, [2, 4, 8, 16, 32, 60, 60, 60, 60]);
        assert_eq!(backoff_delay(usize::MAX).as_secs(), 60);
    }

    #[test]
    fn supervisor_retries_then_gives_up_after_five() {
        let t0 = Instant::now();
        let mut sup = Supervisor::default();
        let mut got = Vec::new();
        for i in 0..5 {
            let now = t0 + secs(i * 10);
            sup.on_started(now);
            got.push(sup.on_abnormal_exit(now + secs(1)));
        }
        assert_eq!(got, [2, 4, 8, 16, 32].map(|n| ExitDecision::Retry(secs(n))));
        // 6th within 10 minutes
        sup.on_started(t0 + secs(60));
        assert_eq!(sup.on_abnormal_exit(t0 + secs(61)), ExitDecision::GiveUp);
    }

    #[test]
    fn old_failures_fall_out_of_the_window() {
        let t0 = Instant::now();
        let mut sup = Supervisor::default();
        for i in 0..5 {
            sup.on_abnormal_exit(t0 + secs(i));
        }
        // 11 minutes later the old five no longer count (and the run was not "healthy" either)
        assert_eq!(sup.on_abnormal_exit(t0 + secs(660)), ExitDecision::Retry(secs(2)));
        assert_eq!(sup.failure_count(), 1);
    }

    #[test]
    fn healthy_run_resets_failure_count() {
        let t0 = Instant::now();
        let mut sup = Supervisor::default();
        for i in 0..4 {
            sup.on_started(t0 + secs(i));
            sup.on_abnormal_exit(t0 + secs(i) + secs(1));
        }
        assert_eq!(sup.failure_count(), 4);
        // runs 5 minutes, then dies: history cleared, backoff starts over
        sup.on_started(t0 + secs(10));
        assert_eq!(sup.on_abnormal_exit(t0 + secs(10) + HEALTHY_AFTER), ExitDecision::Retry(secs(2)));
        assert_eq!(sup.failure_count(), 1);
        // just under 5 minutes does not reset
        sup.on_started(t0 + secs(320));
        assert_eq!(sup.on_abnormal_exit(t0 + secs(320) + HEALTHY_AFTER - secs(1)), ExitDecision::Retry(secs(4)));
    }

    #[test]
    fn describe_exit_formats_code_and_signal() {
        assert_eq!(describe_exit(Some(1), None), "exit code 1");
        assert_eq!(describe_exit(None, Some(9)), "signal 9");
        assert_eq!(describe_exit(Some(1), Some(15)), "exit code 1, signal 15");
        assert_eq!(describe_exit(None, None), "unknown exit");
    }

    fn running_inner(generation: u64) -> Inner {
        let mut i = Inner::new();
        i.generation = generation;
        i.state = RunState::Running;
        i.pid = Some(1);
        i
    }

    #[test]
    fn terminated_of_old_generation_is_ignored() {
        let mut i = running_inner(2);
        assert_eq!(i.on_terminated(1, Some(1), None, Instant::now()), TermOutcome::Ignored);
        assert_eq!(i.state, RunState::Running);
        assert_eq!(i.pid, Some(1));
        assert_eq!(i.sup.failure_count(), 0);
    }

    #[test]
    fn intentional_stop_is_not_a_failure() {
        let mut i = running_inner(1);
        i.stopping = true;
        // even a non-zero code / signal after our own SIGTERM/SIGKILL
        assert_eq!(i.on_terminated(1, None, Some(9), Instant::now()), TermOutcome::Stopped);
        assert_eq!(i.state, RunState::Stopped);
        assert_eq!(i.sup.failure_count(), 0);
        assert_eq!(i.last_exit, None);
        assert_eq!(i.error, None);
    }

    #[test]
    fn unexpected_exit_schedules_restart_with_current_epoch() {
        let mut i = running_inner(1);
        i.epoch = 7;
        let out = i.on_terminated(1, None, Some(9), Instant::now());
        assert_eq!(out, TermOutcome::Retry { epoch: 7, delay: secs(2) });
        assert_eq!(i.state, RunState::Restarting);
        assert_eq!(i.last_exit.as_deref(), Some("signal 9"));
        assert!(i.child.is_none() && i.pid.is_none());
    }

    #[test]
    fn exit_code_zero_without_stop_is_still_abnormal() {
        let mut i = running_inner(1);
        assert!(matches!(i.on_terminated(1, Some(0), None, Instant::now()), TermOutcome::Retry { .. }));
        assert_eq!(i.last_exit.as_deref(), Some("exit code 0"));
    }

    #[test]
    fn giving_up_sets_error_with_reason_and_last_logs() {
        let t0 = Instant::now();
        let mut i = Inner::new();
        for n in 0..8 {
            push_log(&mut i, format!("line{n}"));
        }
        let mut last = TermOutcome::Ignored;
        for k in 0..6u64 {
            i.generation = k + 1;
            i.state = RunState::Running;
            last = i.on_terminated(k + 1, Some(2), None, t0 + secs(k));
        }
        assert_eq!(last, TermOutcome::GaveUp);
        assert_eq!(i.state, RunState::Error);
        let e = i.error.unwrap();
        assert!(e.contains("exit code 2") && e.contains("6 回"));
        assert!(e.contains("line7") && e.contains("line3") && !e.contains("line2"));
    }

    #[test]
    fn stop_bumps_epoch_so_scheduled_restart_is_stale() {
        // restart_after fires only when epoch matches; stop_locked bumps it.
        let mut i = running_inner(1);
        let TermOutcome::Retry { epoch, .. } = i.on_terminated(1, Some(1), None, Instant::now()) else {
            panic!("expected retry")
        };
        i.epoch += 1; // what stop_locked does
        assert_ne!(i.epoch, epoch);
    }
}
