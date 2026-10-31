//! agent-messenger broker client.
//!
//! bantou registers itself with the broker as a plain HTTP peer (no MCP, no
//! Claude Code session): `/register`, `/heartbeat`, `/poll-messages`,
//! `/send-message`, `/acknowledge-messages` (agent-hand/messenger
//! `packages/protocol/src/http.ts`). `/poll-messages` marks messages delivered
//! on the broker, so every message is written to disk as soon as it arrives,
//! then acknowledged so the broker drops it.
//!
//! The broker is found with agent-messenger's own discovery order
//! (messenger `packages/client/src/resolve.ts`), so bantou keeps no
//! connection setting of its own:
//!   1. env `AGENT_MESSENGER_HOST` (+ `AGENT_MESSENGER_PORT`)
//!   2. `~/.agent-messenger/config.json` `{"brokers": [...]}`, first healthy
//!   3. UDP broadcast probe on 7902, first broker that answers
//!   4. `127.0.0.1:7901`

use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use crate::task;
use crate::thread::{self, AskOption, Request, Thread, TimelineEntry, THREADS_CHANGED_EVENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_EVERY: u32 = 10; // polls → 20s, well inside the broker's 60s timeout

/// How long one ping keeps a task marked as running.
const PING_TTL: Duration = Duration::from_secs(5 * 60);

pub const PINGS_CHANGED_EVENT: &str = "bantou://pings-changed";

/// bantou's messenger name (fixed by the original requirement).
pub const CORE_NAME: &str = "bantou-core";

const DEFAULT_HTTP_PORT: u16 = 7901;
const DISCOVERY_PORT: u16 = 7902;
const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    pub broker_url: String,
    pub name: String,
}

fn env_port() -> u16 {
    std::env::var("AGENT_MESSENGER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_HTTP_PORT)
}

fn normalize_url(s: &str, port: u16) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let s = if s.starts_with("http://") || s.starts_with("https://") { s.to_string() } else { format!("http://{s}") };
    let u = reqwest::Url::parse(&s).ok()?;
    let host = u.host_str()?;
    Some(format!("{}://{}:{}", u.scheme(), host, u.port().unwrap_or(port)))
}

fn config_brokers(port: u16) -> Vec<String> {
    let path = std::env::var("AGENT_MESSENGER_CONFIG").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".agent-messenger/config.json")
    });
    let Ok(text) = fs::read_to_string(path) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    let list: Vec<serde_json::Value> = match (v.get("brokers"), v.get("broker")) {
        (Some(serde_json::Value::Array(a)), _) => a.clone(),
        (_, Some(b)) => vec![b.clone()],
        _ => vec![],
    };
    list.iter().filter_map(|x| x.as_str()).filter_map(|s| normalize_url(s, port)).collect()
}

async fn healthy(url: &str) -> bool {
    crate::ensure_crypto_provider();
    let Ok(c) = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build() else {
        return false;
    };
    matches!(c.get(format!("{url}/health")).send().await, Ok(r) if r.status().is_success())
}

/// Broadcast targets: 255.255.255.255 plus each IPv4 interface's directed broadcast.
fn probe_targets() -> Vec<std::net::Ipv4Addr> {
    let mut out = vec![std::net::Ipv4Addr::BROADCAST];
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for i in ifs {
            if i.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = i.addr {
                if let Some(b) = v4.broadcast {
                    if !out.contains(&b) {
                        out.push(b);
                    }
                }
            }
        }
    }
    out
}

fn discover() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_broadcast(true).ok()?;
    sock.set_read_timeout(Some(DISCOVERY_TIMEOUT)).ok()?;
    let probe = br#"{"agent-messenger":"probe"}"#;
    for t in probe_targets() {
        let _ = sock.send_to(probe, (t, DISCOVERY_PORT));
    }
    let deadline = std::time::Instant::now() + DISCOVERY_TIMEOUT;
    let mut buf = [0u8; 2048];
    while std::time::Instant::now() < deadline {
        let Ok((n, from)) = sock.recv_from(&mut buf) else { break };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
        if v.get("agent-messenger").and_then(|x| x.as_str()) != Some("broker") {
            continue;
        }
        if let Some(port) = v.get("port").and_then(|p| p.as_u64()) {
            return Some(format!("http://{}:{port}", from.ip()));
        }
    }
    None
}

/// Find the broker in agent-messenger's order.
pub async fn resolve_broker() -> String {
    let port = env_port();
    if let Ok(host) = std::env::var("AGENT_MESSENGER_HOST") {
        if !host.trim().is_empty() {
            return format!("http://{}:{port}", host.trim());
        }
    }
    for url in config_brokers(port) {
        if healthy(&url).await {
            return url;
        }
    }
    let off = std::env::var("AGENT_MESSENGER_DISCOVERY").map(|v| v.eq_ignore_ascii_case("off")).unwrap_or(false);
    if !off {
        if let Ok(Some(url)) = tokio::task::spawn_blocking(discover).await {
            return url;
        }
    }
    format!("http://127.0.0.1:{port}")
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct BrokerStatus {
    pub connected: bool,
    pub peer_id: Option<String>,
    pub broker_url: String,
    pub name: String,
    pub error: Option<String>,
}

/// One poller per workspace directory.
#[derive(Default)]
pub struct Brokers {
    inner: Mutex<HashMap<PathBuf, BrokerStatus>>,
}

impl Brokers {
    fn set(&self, ws: &Path, s: BrokerStatus) {
        self.inner.lock().unwrap().insert(ws.to_path_buf(), s);
    }
    fn get(&self, ws: &Path) -> Option<BrokerStatus> {
        self.inner.lock().unwrap().get(ws).cloned()
    }
    pub fn peer_id(&self, ws: &Path) -> Option<String> {
        self.get(ws).and_then(|s| s.peer_id)
    }
    /// Broker URL the poller of `ws` is connected to.
    pub fn url(&self, ws: &Path) -> Option<String> {
        self.get(ws).map(|s| s.broker_url).filter(|u| !u.is_empty())
    }
}

/// One live ping timer.
#[derive(Clone, Debug, Serialize)]
pub struct Ping {
    pub task_id: String,
    /// RFC3339, whole seconds.
    pub expires_at: String,
}

/// Ping timers, in memory only: (workspace, task id) → expiry.
#[derive(Default)]
pub struct Pings {
    inner: Mutex<HashMap<(PathBuf, String), time::OffsetDateTime>>,
}

impl Pings {
    /// Start the timer of `task_id`, or reset it when it is running.
    fn touch(&self, ws: &Path, task_id: &str) {
        let at = time::OffsetDateTime::now_utc() + PING_TTL;
        self.inner.lock().unwrap().insert((ws.to_path_buf(), task_id.to_string()), at);
    }
    /// Timers of `ws` that have not expired. Expired ones are dropped.
    pub fn live(&self, ws: &Path) -> Vec<Ping> {
        let now = time::OffsetDateTime::now_utc();
        let mut all = self.inner.lock().unwrap();
        all.retain(|_, at| *at > now);
        all.iter()
            .filter(|((w, _), _)| w == ws)
            .map(|((_, id), at)| Ping {
                task_id: id.clone(),
                expires_at: at
                    .replace_nanosecond(0)
                    .unwrap_or(*at)
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
            })
            .collect()
    }
}

// -- wire types ---------------------------------------------------------------

#[derive(Deserialize)]
struct RegisterResponse {
    id: String,
}

#[derive(Deserialize)]
struct OkResult {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Message {
    /// Broker-assigned id, used for `/acknowledge-messages`.
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub from_id: String,
    #[serde(default)]
    pub from_name: String,
    pub text: String,
    #[serde(default)]
    pub sent_at: String,
    /// "pull" | "push" | "ping" (messenger 0.6). Missing means "pull".
    #[serde(default)]
    pub mode: Option<String>,
    /// Ping payload candidate (see `ping_subject`).
    #[serde(default)]
    pub subject: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PollResponse {
    pub messages: Vec<Message>,
}

/// Work-session → bantou envelope (`docs/protocol.md`).
#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Envelope {
    Ask {
        task_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        session: Option<String>,
        question: String,
        #[serde(default)]
        options: Vec<AskOption>,
    },
    Task {
        task_id: String,
        title: String,
        #[serde(default)]
        session: Option<String>,
        #[serde(default)]
        status: Option<String>,
        /// What the work is (task md body). Replaces the body when given.
        #[serde(default)]
        body: Option<String>,
    },
}

#[derive(Deserialize)]
struct EnvelopeHeader {
    bantou: u32,
}

fn parse_envelope(text: &str) -> Option<Envelope> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let _h: EnvelopeHeader = serde_json::from_value(v.clone()).ok()?;
    serde_json::from_value(v).ok()
}

// -- message handling ---------------------------------------------------------

/// Apply one incoming broker message to the workspace. Returns true when
/// threads or tasks changed.
pub fn handle_message(ws: &Path, msg: &Message) -> CmdResult<bool> {
    // Pings are applied by `handle_ping`: nothing to store.
    if is_ping(msg) {
        return Ok(false);
    }
    // `from_name` is whatever the sender put on `/send-message`; fall back to
    // the peer id so there is always a reply target.
    let sender = if msg.from_name.is_empty() { msg.from_id.clone() } else { msg.from_name.clone() };
    let Some(env) = parse_envelope(&msg.text) else {
        append_inbox(ws, msg)?;
        return Ok(false);
    };
    match env {
        Envelope::Task {
            task_id,
            title,
            session,
            status,
            body,
        } => {
            let session = session.unwrap_or_else(|| sender.clone());
            ensure_task(ws, &task_id, &title, &session, status.as_deref())?;
            if let Some(b) = body.filter(|b| !b.trim().is_empty()) {
                set_body(ws, &task_id, &b)?;
            }
            Ok(true)
        }
        Envelope::Ask {
            task_id,
            title,
            session,
            question,
            options,
        } => {
            let session = session.unwrap_or_else(|| sender.clone());
            let title = title.unwrap_or_else(|| format!("{session} {task_id}"));
            ensure_task(ws, &task_id, &title, &session, None)?;
            let at = if msg.sent_at.is_empty() { thread::now() } else { msg.sent_at.clone() };
            let entry = TimelineEntry {
                role: "session".into(),
                text: question.clone(),
                at: at.clone(),
            };
            let request = Request {
                from_name: sender.clone(),
                from_id: msg.from_id.clone(),
                question,
                options,
                received_at: at,
            };
            let t = match thread::load(ws, &task_id)? {
                Some(mut t) => {
                    t.status = "waiting".into();
                    t.request = request;
                    t.answer = None;
                    t.timeline.push(entry);
                    t
                }
                None => Thread {
                    task_id,
                    status: "waiting".into(),
                    request,
                    timeline: vec![entry],
                    agent_session_id: None,
                    answer: None,
                },
            };
            thread::save(ws, &t)?;
            Ok(true)
        }
    }
}

fn is_ping(msg: &Message) -> bool {
    msg.mode.as_deref() == Some("ping")
}

/// What a ping is about: a task id or a task title. The messenger payload
/// field is not final, so this is the one place that reads it.
fn ping_subject(msg: &Message) -> Option<String> {
    let text = msg.text.trim();
    if !text.is_empty() {
        return Some(text.to_string());
    }
    msg.subject.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Apply one ping: reset the timer of the task it names (by id, then by
/// exact title). Returns true when a timer was set.
pub fn handle_ping(ws: &Path, msg: &Message, pings: &Pings) -> CmdResult<bool> {
    let Some(subject) = ping_subject(msg) else { return Ok(false) };
    let tasks = task::scan_tasks(ws)?;
    // Timers are keyed by task id, so a task without one cannot be tracked.
    let found = tasks
        .iter()
        .find(|t| t.id == subject)
        .or_else(|| tasks.iter().find(|t| t.title == subject && !t.id.is_empty()));
    let Some(t) = found else { return Ok(false) };
    pings.touch(ws, &t.id);
    Ok(true)
}

/// Replace the md body of task `task_id`, keeping its frontmatter.
fn set_body(ws: &Path, task_id: &str, body: &str) -> CmdResult<()> {
    let Some(t) = task::find_task_by_id(ws, task_id)? else { return Ok(()) };
    let content = fs::read_to_string(&t.path)?;
    let fm_end = content
        .strip_prefix("---\n")
        .and_then(|rest| rest.find("\n---\n").map(|i| i + 4 + 5))
        .ok_or_else(|| CommandError::other("task md has no frontmatter"))?;
    let updated = format!("{}\n{}\n", &content[..fm_end], body.trim_end());
    fs::write(&t.path, updated)?;
    Ok(())
}

fn ensure_task(
    ws: &Path,
    task_id: &str,
    title: &str,
    session: &str,
    status: Option<&str>,
) -> CmdResult<()> {
    match task::find_task_by_id(ws, task_id)? {
        Some(t) => {
            if let Some(s) = status {
                if s != t.status {
                    let content = fs::read_to_string(&t.path)?;
                    let updated =
                        crate::frontmatter::update(&content, &[("status", serde_json::json!(s))]);
                    fs::write(&t.path, updated)?;
                }
            }
            Ok(())
        }
        None => {
            let tags = if session.is_empty() { vec![] } else { vec![session.to_string()] };
            let stem = task::encode_title_to_stem(title)?;
            let same_title = ws.join(format!("{stem}.md"));
            if same_title.exists() {
                let existing = task::read_task(&same_title)?;
                if existing.id.is_empty() {
                    // Same title, no id yet: it is this task. Adopt it by
                    // writing the id (and the session tag / status) into it.
                    let content = fs::read_to_string(&same_title)?;
                    let mut new_tags = existing.tags.clone();
                    for t in &tags {
                        if !new_tags.contains(t) {
                            new_tags.push(t.clone());
                        }
                    }
                    let mut updates = vec![("id", serde_json::json!(task_id)), ("tags", serde_json::json!(new_tags))];
                    if let Some(st) = status {
                        updates.push(("status", serde_json::json!(st)));
                    }
                    fs::write(&same_title, crate::frontmatter::update(&content, &updates))?;
                    return Ok(());
                }
                // Same title but another task: keep both, disambiguate by id.
                let title = format!("{title} ({task_id})");
                return task::create_task_file(ws, &title, status.unwrap_or("Todo"), &tags, Some(task_id), "")
                    .map(|_| ());
            }
            task::create_task_file(ws, title, status.unwrap_or("Todo"), &tags, Some(task_id), "")
                .map(|_| ())
        }
    }
}

fn append_inbox(ws: &Path, msg: &Message) -> CmdResult<()> {
    let dir = thread::bantou_dir(ws);
    fs::create_dir_all(&dir)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("inbox.jsonl"))?;
    let line = serde_json::json!({
        "from_name": msg.from_name, "from_id": msg.from_id,
        "text": msg.text, "sent_at": msg.sent_at, "stored_at": thread::now(),
    });
    writeln!(f, "{line}")?;
    Ok(())
}

// -- HTTP -----------------------------------------------------------------------

fn client() -> reqwest::Client {
    crate::ensure_crypto_provider();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

pub(crate) async fn post<T: serde::de::DeserializeOwned>(
    base: &str,
    route: &str,
    body: serde_json::Value,
) -> Result<T, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), route);
    let res = client().post(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    res.json::<T>().await.map_err(|e| e.to_string())
}

/// The broker replaces an existing peer with the same pid + hostname on
/// `/register`. Each poller (one per workspace) therefore registers with its
/// own pseudo pid derived from the process id, so two open workspaces do
/// not evict each other.
static REGISTER_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub(crate) fn peer_pid() -> u32 {
    let n = REGISTER_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::process::id().wrapping_add(n.wrapping_mul(1_000_000))
}

/// Drop leftovers of an earlier bantou process: peers with our name on this
/// host whose pid is not alive. Without this, a restart leaves the old peer
/// for up to 60s and sends to "bantou-core" fail as ambiguous.
async fn unregister_stale(cfg: &BrokerConfig, host: &str) {
    #[derive(Deserialize)]
    struct P {
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        hostname: String,
        #[serde(default)]
        pid: u32,
    }
    let Ok(peers) = post::<Vec<P>>(&cfg.broker_url, "/list-peers", serde_json::json!({ "scope": "all" })).await else {
        return;
    };
    for p in peers {
        if p.name != cfg.name || p.hostname != host {
            continue;
        }
        // pseudo pids (see peer_pid) are process id + n * 1_000_000
        let real = p.pid % 1_000_000;
        let alive = std::process::Command::new("kill")
            .args(["-0", &real.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if real != std::process::id() && !alive {
            let _: Result<serde_json::Value, _> =
                post(&cfg.broker_url, "/unregister", serde_json::json!({ "id": p.id })).await;
        }
    }
}

pub(crate) async fn register(cfg: &BrokerConfig, ws: &Path, pid: u32) -> Result<String, String> {
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    unregister_stale(cfg, &host).await;
    let r: RegisterResponse = post(
        &cfg.broker_url,
        "/register",
        serde_json::json!({
            "pid": pid,
            "hostname": host,
            "cwd": ws.to_string_lossy(),
            "name": cfg.name,
            "summary": "bantou: multi-agent task bridge",
        }),
    )
    .await?;
    Ok(r.id)
}

/// Send `text` to a peer (by name or id) as `bantou-core`.
pub async fn send(url: &str, from_id: &str, to: &str, text: &str) -> Result<(), String> {
    // No `mode`: the broker defaults to "pull" (receiver sees an unread notice), which is intended.
    let r: OkResult = post(
        url,
        "/send-message",
        serde_json::json!({ "from_id": from_id, "from_name": CORE_NAME, "to": to, "text": text }),
    )
    .await?;
    if r.ok {
        Ok(())
    } else {
        Err(r.error.unwrap_or_else(|| "send failed".into()))
    }
}

/// Ids of polled messages to acknowledge (messages without an id are skipped).
fn ack_ids(msgs: &[Message]) -> Vec<u64> {
    msgs.iter().filter_map(|m| m.id).collect()
}

/// Drop handled messages from the broker store (`/poll-messages` only marks them delivered).
async fn acknowledge(url: &str, id: &str, ids: &[u64]) -> Result<(), String> {
    let r: OkResult = post(url, "/acknowledge-messages", serde_json::json!({ "id": id, "message_ids": ids })).await?;
    if r.ok {
        Ok(())
    } else {
        Err(r.error.unwrap_or_else(|| "acknowledge failed".into()))
    }
}

// -- poller ---------------------------------------------------------------------

/// Start the poller for `ws`. `fixed_url` pins the broker (tests); `None`
/// resolves it with the messenger discovery order, again after each failure.
pub(crate) fn start_poller<R: tauri::Runtime>(app: tauri::AppHandle<R>, ws: PathBuf, fixed_url: Option<String>) {
    app.state::<Brokers>().set(&ws, BrokerStatus { name: CORE_NAME.into(), ..Default::default() });
    tauri::async_runtime::spawn(async move {
        let mut peer: Option<String> = None;
        let mut url = String::new();
        let pid = peer_pid();
        let mut tick: u32 = 0;
        loop {
            let brokers = app.state::<Brokers>();
            if peer.is_none() {
                url = match &fixed_url {
                    Some(u) => u.clone(),
                    None => resolve_broker().await,
                };
            }
            let base = BrokerStatus { broker_url: url.clone(), name: CORE_NAME.into(), ..Default::default() };
            let cfg = BrokerConfig { broker_url: url.clone(), name: CORE_NAME.into() };
            let id = match &peer {
                Some(id) => id.clone(),
                None => match register(&cfg, &ws, pid).await {
                    Ok(id) => {
                        brokers.set(&ws, BrokerStatus { connected: true, peer_id: Some(id.clone()), ..base.clone() });
                        peer = Some(id.clone());
                        id
                    }
                    Err(e) => {
                        brokers.set(&ws, BrokerStatus { error: Some(e), ..base.clone() });
                        tokio::time::sleep(Duration::from_secs(10)).await;
                        continue;
                    }
                },
            };
            tick = tick.wrapping_add(1);
            if tick % HEARTBEAT_EVERY == 0 {
                match post::<OkResult>(&url, "/heartbeat", serde_json::json!({ "id": id })).await {
                    Ok(r) if !r.ok => {
                        peer = None;
                        continue;
                    }
                    Err(e) => {
                        // Broker gone: resolve again on the next round.
                        brokers.set(&ws, BrokerStatus { error: Some(e), ..base.clone() });
                        peer = None;
                        tokio::time::sleep(Duration::from_secs(10)).await;
                        continue;
                    }
                    _ => {}
                }
            }
            match post::<PollResponse>(&url, "/poll-messages", serde_json::json!({ "id": id })).await {
                Ok(r) => {
                    let mut changed = false;
                    let mut pinged = false;
                    for m in &r.messages {
                        if is_ping(m) {
                            match handle_ping(&ws, m, &app.state::<Pings>()) {
                                Ok(p) => pinged |= p,
                                Err(e) => eprintln!("bantou: failed to apply ping: {e}"),
                            }
                            continue;
                        }
                        match handle_message(&ws, m) {
                            Ok(c) => changed |= c,
                            Err(e) => {
                                // Already marked read on the broker: never drop it.
                                eprintln!("bantou: failed to apply message, kept in inbox: {e}");
                                let _ = append_inbox(&ws, m);
                            }
                        }
                    }
                    let ids = ack_ids(&r.messages);
                    if !ids.is_empty() {
                        if let Err(e) = acknowledge(&url, &id, &ids).await {
                            eprintln!("bantou: failed to acknowledge messages: {e}");
                        }
                    }
                    if changed {
                        let _ = app.emit(THREADS_CHANGED_EVENT, ws.to_string_lossy().to_string());
                    }
                    if pinged {
                        let _ = app.emit(PINGS_CHANGED_EVENT, ws.to_string_lossy().to_string());
                    }
                    brokers.set(&ws, BrokerStatus { connected: true, peer_id: Some(id.clone()), ..base.clone() });
                }
                Err(e) => {
                    brokers.set(&ws, BrokerStatus { peer_id: Some(id.clone()), error: Some(e), ..base.clone() });
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

/// Start the poller for this window's workspace if not running yet.
#[tauri::command]
pub fn broker_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
) -> CmdResult<BrokerStatus> {
    let ws = state.require_workspace(window.label())?;
    if let Some(s) = brokers.get(&ws) {
        return Ok(s);
    }
    start_poller(app, ws.clone(), None);
    brokers.get(&ws).ok_or_else(|| CommandError::other("broker state missing"))
}

#[tauri::command]
pub fn broker_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
) -> CmdResult<BrokerStatus> {
    let ws = state.require_workspace(window.label())?;
    Ok(brokers.get(&ws).unwrap_or_else(|| BrokerStatus { name: CORE_NAME.into(), ..Default::default() }))
}

/// Live ping timers of this window's workspace.
#[tauri::command]
pub fn list_pings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    pings: tauri::State<'_, Pings>,
) -> CmdResult<Vec<Ping>> {
    let ws = state.require_workspace(window.label())?;
    Ok(pings.live(&ws))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(text: &str) -> Message {
        Message {
            id: None,
            from_id: "p1".into(),
            from_name: "careery".into(),
            text: text.into(),
            sent_at: String::new(),
            mode: None,
            subject: None,
        }
    }

    fn ping(text: &str, subject: Option<&str>) -> Message {
        Message { mode: Some("ping".into()), subject: subject.map(str::to_string), ..msg(text) }
    }

    fn live_ids(p: &Pings, ws: &Path) -> Vec<String> {
        p.live(ws).into_iter().map(|x| x.task_id).collect()
    }

    #[test]
    fn ping_with_task_id_sets_timer() {
        let d = tempfile::tempdir().unwrap();
        task::create_task_file(d.path(), "Build X", "Doing", &[], Some("t-1"), "").unwrap();
        let p = Pings::default();
        assert!(handle_ping(d.path(), &ping(" t-1 ", None), &p).unwrap());
        let live = p.live(d.path());
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].task_id, "t-1");
        let at = time::OffsetDateTime::parse(&live[0].expires_at, &time::format_description::well_known::Rfc3339)
            .unwrap();
        let left = at - time::OffsetDateTime::now_utc();
        assert!(left > time::Duration::seconds(290) && left <= time::Duration::seconds(300), "{left}");
        // other workspaces do not see it
        assert!(p.live(tempfile::tempdir().unwrap().path()).is_empty());
    }

    #[test]
    fn ping_with_title_sets_timer() {
        let d = tempfile::tempdir().unwrap();
        task::create_task_file(d.path(), "Build X", "Doing", &[], Some("t-1"), "").unwrap();
        let p = Pings::default();
        // payload in the `subject` field, text empty
        assert!(handle_ping(d.path(), &ping("", Some("Build X")), &p).unwrap());
        assert_eq!(live_ids(&p, d.path()), vec!["t-1".to_string()]);
    }

    #[test]
    fn ping_with_unknown_subject_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        task::create_task_file(d.path(), "Build X", "Doing", &[], Some("t-1"), "").unwrap();
        let p = Pings::default();
        assert!(!handle_ping(d.path(), &ping("Build", None), &p).unwrap());
        assert!(p.live(d.path()).is_empty());
    }

    #[test]
    fn empty_ping_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        task::create_task_file(d.path(), "Build X", "Doing", &[], Some("t-1"), "").unwrap();
        let p = Pings::default();
        assert!(!handle_ping(d.path(), &ping("", None), &p).unwrap());
        assert!(!handle_ping(d.path(), &ping("  ", Some(" ")), &p).unwrap());
        assert!(p.live(d.path()).is_empty());
    }

    #[test]
    fn expired_timer_is_dropped() {
        let d = tempfile::tempdir().unwrap();
        let p = Pings::default();
        p.inner
            .lock()
            .unwrap()
            .insert((d.path().to_path_buf(), "t-1".into()), time::OffsetDateTime::now_utc() - PING_TTL);
        assert!(p.live(d.path()).is_empty());
        assert!(p.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn ping_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        let m = Message { mode: Some("ping".into()), ..msg("") };
        assert!(!handle_message(d.path(), &m).unwrap());
        assert!(!thread::bantou_dir(d.path()).join("inbox.jsonl").exists());
    }

    #[test]
    fn mode_and_id_deserialize_and_ack_ids_skip_missing() {
        let r: PollResponse = serde_json::from_str(
            r#"{"messages":[{"id":3,"from_id":"a","from_name":"x","text":"","mode":"ping"},{"from_id":"b","text":"hi"}]}"#,
        )
        .unwrap();
        assert_eq!(r.messages[0].mode.as_deref(), Some("ping"));
        assert_eq!(r.messages[1].mode, None);
        assert_eq!(ack_ids(&r.messages), vec![3]);
    }

    #[test]
    fn ask_creates_task_and_thread() {
        let d = tempfile::tempdir().unwrap();
        let text = r#"{"bantou":1,"type":"ask","task_id":"t-abc","title":"Build X","question":"Which?","options":[{"label":"A"},{"label":"B","description":"b"}]}"#;
        assert!(handle_message(d.path(), &msg(text)).unwrap());
        let t = task::find_task_by_id(d.path(), "t-abc").unwrap().unwrap();
        assert_eq!(t.tags, vec!["careery".to_string()]);
        let th = thread::load(d.path(), "t-abc").unwrap().unwrap();
        assert_eq!(th.status, "waiting");
        assert_eq!(th.request.options.len(), 2);
        assert_eq!(th.timeline[0].role, "session");
    }

    #[test]
    fn normalizes_config_urls() {
        assert_eq!(normalize_url("192.168.1.202", 7901).as_deref(), Some("http://192.168.1.202:7901"));
        assert_eq!(normalize_url("http://h:7000", 7901).as_deref(), Some("http://h:7000"));
        assert_eq!(normalize_url("  ", 7901), None);
    }

    /// Prints what the messenger discovery order resolves to on this host.
    /// `cargo test -- --ignored live_resolve --nocapture`
    #[test]
    #[ignore]
    fn live_resolve() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        println!("resolved: {}", rt.block_on(resolve_broker()));
        println!("udp discover: {:?}", discover());
    }

    #[test]
    fn task_with_existing_title_adopts_id_less_md() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("T.md"), "---\nstatus: Todo\ntags:\n  - x\n---\n\nbody\n").unwrap();
        let mk = r#"{"bantou":1,"type":"task","task_id":"t-9","title":"T","status":"Doing"}"#;
        handle_message(d.path(), &msg(mk)).unwrap();
        let t = task::find_task_by_id(d.path(), "t-9").unwrap().unwrap();
        assert!(t.path.ends_with("T.md"));
        assert_eq!(t.status, "Doing");
        assert_eq!(t.tags, vec!["x".to_string(), "careery".to_string()]);
        assert_eq!(t.body.trim(), "body");
    }

    #[test]
    fn task_with_title_of_other_task_gets_suffixed_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("T.md"), "---\nid: other\nstatus: Todo\n---\n").unwrap();
        let mk = r#"{"bantou":1,"type":"task","task_id":"t-9","title":"T","status":"Doing"}"#;
        handle_message(d.path(), &msg(mk)).unwrap();
        let t = task::find_task_by_id(d.path(), "t-9").unwrap().unwrap();
        assert_eq!(t.title, "T (t-9)");
        assert_eq!(task::find_task_by_id(d.path(), "other").unwrap().unwrap().title, "T");
    }

    #[test]
    fn task_body_is_written_and_replaced() {
        let d = tempfile::tempdir().unwrap();
        let a = r#"{"bantou":1,"type":"task","task_id":"t-b","title":"B","status":"Doing","body":"やること1"}"#;
        handle_message(d.path(), &msg(a)).unwrap();
        assert_eq!(task::find_task_by_id(d.path(), "t-b").unwrap().unwrap().body.trim(), "やること1");
        let b = r#"{"bantou":1,"type":"task","task_id":"t-b","title":"B","status":"Done","body":"やること2"}"#;
        handle_message(d.path(), &msg(b)).unwrap();
        let t = task::find_task_by_id(d.path(), "t-b").unwrap().unwrap();
        assert_eq!(t.body.trim(), "やること2");
        assert_eq!(t.status, "Done");
        assert_eq!(t.id, "t-b");
    }

    #[test]
    fn plain_text_goes_to_inbox() {
        let d = tempfile::tempdir().unwrap();
        assert!(!handle_message(d.path(), &msg("hello")).unwrap());
        assert!(thread::bantou_dir(d.path()).join("inbox.jsonl").exists());
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    }

    #[test]
    fn task_envelope_updates_status() {
        let d = tempfile::tempdir().unwrap();
        let mk = r#"{"bantou":1,"type":"task","task_id":"t-1","title":"T","status":"Todo"}"#;
        handle_message(d.path(), &msg(mk)).unwrap();
        let up = r#"{"bantou":1,"type":"task","task_id":"t-1","title":"T","status":"Doing"}"#;
        handle_message(d.path(), &msg(up)).unwrap();
        assert_eq!(task::find_task_by_id(d.path(), "t-1").unwrap().unwrap().status, "Doing");
    }
    /// Live round trip against a real broker. Run with
    /// `BANTOU_TEST_BROKER=http://127.0.0.1:7911 cargo test -- --ignored live_broker`.
    #[test]
    #[ignore]
    fn live_broker_round_trip() {
        let url = std::env::var("BANTOU_TEST_BROKER").expect("BANTOU_TEST_BROKER");
        let d = tempfile::tempdir().unwrap();
        // Unique names per run so stale peers from an aborted run never match.
        let tag = format!("{}-{}", std::process::id(), thread::now().len() + d.path().to_string_lossy().len());
        let me_name = format!("bantou-test-{tag}");
        let other_name = format!("work-session-test-{tag}");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let cfg = BrokerConfig { broker_url: url.clone(), name: me_name.clone() };
            let me = register(&cfg, d.path(), peer_pid()).await.unwrap();
            let other_cfg = BrokerConfig { name: other_name.clone(), ..cfg.clone() };
            let other = register(&other_cfg, d.path(), peer_pid()).await.unwrap();
            // work session -> bantou (ask envelope)
            let ask = r#"{"bantou":1,"type":"ask","task_id":"t-live1","title":"Live","question":"Q?","options":[{"label":"A"}]}"#;
            let _: serde_json::Value = post(
                &url,
                "/send-message",
                serde_json::json!({ "from_id": other, "from_name": other_name, "to": me_name, "text": ask }),
            )
            .await
            .unwrap();
            let r: PollResponse =
                post(&url, "/poll-messages", serde_json::json!({ "id": me })).await.unwrap();
            assert_eq!(r.messages.len(), 1, "{:?}", r.messages);
            assert_eq!(r.messages[0].from_name, other_name, "{:?}", r.messages);
            assert!(handle_message(d.path(), &r.messages[0]).unwrap());
            let th = thread::load(d.path(), "t-live1").unwrap().unwrap();
            assert_eq!(th.request.from_name, other_name);
            // bantou -> work session (reply)
            let _: serde_json::Value = post(
                &url,
                "/send-message",
                serde_json::json!({ "from_id": me, "from_name": me_name, "to": th.request.from_name, "text": "reply" }),
            )
            .await
            .unwrap();
            let r: PollResponse =
                post(&url, "/poll-messages", serde_json::json!({ "id": other })).await.unwrap();
            assert_eq!(r.messages.len(), 1);
            assert_eq!(r.messages[0].text, "reply");
            assert_eq!(r.messages[0].from_name, me_name);
            for id in [me, other] {
                let _: serde_json::Value =
                    post(&url, "/unregister", serde_json::json!({ "id": id })).await.unwrap();
            }
        });
    }
}
