//! MCP client to the center (`packages/center`, Streamable HTTP at `/mcp`).
//!
//! The webview never talks to the center directly: it goes through the Tauri commands below.
//! JSON-RPC is built by hand on top of `reqwest` (already a dependency) instead of pulling in an
//! MCP SDK crate; the surface needed is `initialize`, `ping` and `tools/call`.
//!
//! The target is chosen on every call from the stored settings (`select_target`), so changing
//! `remote` / port / token / enabled takes effect on the next call. Every request carries
//! `Authorization: Bearer <token>` (the sidecar's own token, or the one pasted with the remote
//! connection snippet). A session is bound to its URL and token; when
//! the center restarts (or drops the session) it answers 404 to our session id and we initialize
//! again once and retry.

use crate::center::{load_settings, CenterSettings};
use crate::error::{CmdResult, CommandError};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const MCP_PATH: &str = "/mcp";
const PROTOCOL_VERSION: &str = "2025-06-18";
const SESSION_HEADER: &str = "mcp-session-id";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// `initialize` / `ping` / the initialized notification.
const SHORT_TIMEOUT: Duration = Duration::from_secs(10);
/// `tools/call`: `cap_kick` / `worker_resume` wait for the agent's result, which can take minutes.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetSource {
    /// `remote` (a pasted connection snippet) from the settings.
    Remote,
    /// The sidecar center this app starts.
    Sidecar,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub url: String,
    /// Bearer token to send. None: send no Authorization header.
    pub token: Option<String>,
    pub source: TargetSource,
}

/// A URL as given; an empty path (`http://host:7910`) gets `/mcp` appended.
pub(crate) fn normalize_remote(u: &str) -> String {
    match reqwest::Url::parse(u) {
        Ok(mut url) if url.path() == "/" || url.path().is_empty() => {
            url.set_path(MCP_PATH);
            url.to_string()
        }
        Ok(url) => url.to_string(),
        Err(_) => u.to_string(),
    }
}

/// Host to dial for the sidecar: always loopback. The center listens on every address, and the IP
/// picked in the settings (`bind`) is only for the connection settings handed to others.
const SIDECAR_HOST: &str = "127.0.0.1";

/// Where to connect: our own sidecar when the center is enabled (a stored `remote` is kept but
/// ignored), else the stored `remote` if any, else nowhere.
pub fn select_target(s: &CenterSettings) -> Option<Target> {
    if s.enabled {
        return Some(Target {
            url: format!("http://{}:{}{MCP_PATH}", SIDECAR_HOST, s.port),
            token: Some(s.token.clone()).filter(|t| !t.is_empty()),
            source: TargetSource::Sidecar,
        });
    }
    s.remote.as_ref().map(|r| Target { url: normalize_remote(&r.url), token: r.token.clone(), source: TargetSource::Remote })
}

#[derive(Debug, PartialEq)]
enum McpError {
    /// The center no longer knows our session id (HTTP 404 on a session request).
    SessionGone,
    /// Anything else, already phrased for the user.
    Failed(String),
}

impl McpError {
    fn failed(msg: impl Into<String>) -> Self {
        Self::Failed(msg.into())
    }

    fn message(self) -> String {
        match self {
            Self::SessionGone => "MCP session が切れた".to_string(),
            Self::Failed(m) => m,
        }
    }
}

#[derive(Clone, Debug)]
struct Session {
    url: String,
    token: Option<String>,
    /// None when the server is stateless (no `mcp-session-id` header issued).
    id: Option<String>,
    protocol: String,
}

struct Reply {
    status: u16,
    content_type: String,
    session_id: Option<String>,
    body: String,
}

/// JSON-RPC messages carried by a response body: a JSON value (object or batch) or an SSE stream.
fn parse_messages(content_type: &str, body: &str) -> Vec<Value> {
    if content_type.contains("text/event-stream") {
        let mut out = Vec::new();
        let mut data: Vec<&str> = Vec::new();
        let flush = |data: &mut Vec<&str>, out: &mut Vec<Value>| {
            if !data.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(&data.join("\n")) {
                    out.push(v);
                }
                data.clear();
            }
        };
        for line in body.lines() {
            if line.is_empty() {
                flush(&mut data, &mut out);
            } else if let Some(rest) = line.strip_prefix("data:") {
                data.push(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
        flush(&mut data, &mut out);
        return out;
    }
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(a)) => a,
        Ok(v) => vec![v],
        Err(_) => Vec::new(),
    }
}

/// The `result` of the response with `id`, or its JSON-RPC error.
fn pick_response(messages: &[Value], id: u64) -> Result<Value, McpError> {
    let m = messages
        .iter()
        .find(|m| m.get("id").and_then(Value::as_u64) == Some(id) && (m.get("result").is_some() || m.get("error").is_some()))
        .ok_or_else(|| McpError::failed("応答に該当する JSON-RPC response が無い"))?;
    if let Some(e) = m.get("error") {
        let code = e.get("code").and_then(Value::as_i64).unwrap_or(0);
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("(no message)");
        return Err(McpError::failed(format!("MCP error {code}: {msg}")));
    }
    Ok(m["result"].clone())
}

/// Text of a tool result's `content` blocks.
fn tool_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub struct CenterClient {
    http: reqwest::Client,
    session: tokio::sync::Mutex<Option<Session>>,
    next_id: AtomicU64,
    last_error: Mutex<Option<String>>,
}

impl Default for CenterClient {
    fn default() -> Self {
        crate::ensure_crypto_provider();
        Self {
            http: reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build().expect("reqwest client"),
            session: tokio::sync::Mutex::new(None),
            next_id: AtomicU64::new(1),
            last_error: Mutex::new(None),
        }
    }
}

impl CenterClient {
    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn post(
        &self,
        url: &str,
        token: Option<&str>,
        session: Option<&Session>,
        body: &Value,
        timeout: Duration,
    ) -> Result<Reply, McpError> {
        let mut req = self
            .http
            .post(url)
            .timeout(timeout)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body.to_string());
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if let Some(s) = session {
            if let Some(id) = &s.id {
                req = req.header(SESSION_HEADER, id);
            }
            req = req.header("mcp-protocol-version", &s.protocol);
        }
        let resp = req.send().await.map_err(|e| McpError::failed(format!("{url} に接続できない: {e}")))?;
        let status = resp.status().as_u16();
        let header = |n: &str| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_type = header("content-type").unwrap_or_default();
        let session_id = header(SESSION_HEADER);
        let body = resp.text().await.map_err(|e| McpError::failed(format!("応答の読み取りに失敗: {e}")))?;
        Ok(Reply { status, content_type, session_id, body })
    }

    /// `initialize` + `notifications/initialized`. The new session replaces any previous one.
    async fn initialize(&self, url: &str, token: Option<&str>) -> Result<Session, McpError> {
        let id = self.id();
        let req = json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "bantou-desktop", "version": env!("CARGO_PKG_VERSION") },
            },
        });
        let r = self.post(url, token, None, &req, SHORT_TIMEOUT).await?;
        if r.status == 401 {
            return Err(McpError::failed(unauthorized(url, token)));
        }
        if !(200..300).contains(&r.status) {
            return Err(McpError::failed(format!("initialize が HTTP {} で失敗: {}", r.status, snippet(&r.body))));
        }
        let result = pick_response(&parse_messages(&r.content_type, &r.body), id)?;
        let session = Session {
            url: url.to_string(),
            token: token.map(str::to_string),
            id: r.session_id,
            protocol: result
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION)
                .to_string(),
        };
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let n = self.post(url, token, Some(&session), &note, SHORT_TIMEOUT).await?;
        if !(200..300).contains(&n.status) {
            return Err(McpError::failed(format!("initialized 通知が HTTP {} で失敗: {}", n.status, snippet(&n.body))));
        }
        Ok(session)
    }

    /// The live session for `url` + `token`, initializing when there is none (or it belongs to
    /// another URL or token).
    async fn ensure(&self, url: &str, token: Option<&str>) -> Result<Session, McpError> {
        let mut g = self.session.lock().await;
        if let Some(s) = g.as_ref() {
            if s.url == url && s.token.as_deref() == token {
                return Ok(s.clone());
            }
        }
        *g = None;
        let s = self.initialize(url, token).await?;
        *g = Some(s.clone());
        Ok(s)
    }

    /// Forget `dead` unless a newer session has already replaced it.
    async fn invalidate(&self, dead: &Session) {
        let mut g = self.session.lock().await;
        if g.as_ref().is_some_and(|s| s.url == dead.url && s.id == dead.id) {
            *g = None;
        }
    }

    async fn request_once(
        &self,
        url: &str,
        token: Option<&str>,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, McpError> {
        let session = self.ensure(url, token).await?;
        let id = self.id();
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let r = self.post(url, token, Some(&session), &req, timeout).await?;
        if r.status == 401 {
            return Err(McpError::failed(unauthorized(url, token)));
        }
        if r.status == 404 && session.id.is_some() {
            self.invalidate(&session).await;
            return Err(McpError::SessionGone);
        }
        if !(200..300).contains(&r.status) {
            return Err(McpError::failed(format!("{method} が HTTP {} で失敗: {}", r.status, snippet(&r.body))));
        }
        pick_response(&parse_messages(&r.content_type, &r.body), id)
    }

    /// One JSON-RPC request; a lost session is re-established once.
    async fn request(
        &self,
        url: &str,
        token: Option<&str>,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, McpError> {
        match self.request_once(url, token, method, params, timeout).await {
            Err(McpError::SessionGone) => self.request_once(url, token, method, params, timeout).await,
            other => other,
        }
    }

    fn record<T>(&self, r: Result<T, McpError>) -> Result<T, String> {
        let mut last = self.last_error.lock().unwrap();
        match r {
            Ok(v) => {
                *last = None;
                Ok(v)
            }
            Err(e) => {
                let m = e.message();
                *last = Some(m.clone());
                Err(m)
            }
        }
    }

    /// `tools/call`. Returns the MCP tool result (`content`, `isError`, ...) as is; a result with
    /// `isError: true` becomes an `Err` carrying the tool's text.
    pub async fn call_tool(
        &self,
        url: &str,
        token: Option<&str>,
        name: &str,
        arguments: Option<Value>,
    ) -> Result<Value, String> {
        let params = json!({ "name": name, "arguments": arguments.unwrap_or_else(|| json!({})) });
        let r = self.request(url, token, "tools/call", &params, CALL_TIMEOUT).await;
        let result = self.record(r).map_err(|e| format!("{name}: {e}"))?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            let text = tool_text(&result);
            let msg = format!("{name} が失敗: {}", if text.is_empty() { "(no message)" } else { &text });
            *self.last_error.lock().unwrap() = Some(msg.clone());
            return Err(msg);
        }
        Ok(result)
    }

    /// `ping` against `url` (re-establishing the session if needed): whether the center answers.
    pub async fn probe(&self, url: &str, token: Option<&str>) -> Result<(), String> {
        let r = self.request(url, token, "ping", &json!({}), SHORT_TIMEOUT).await.map(|_| ());
        self.record(r)
    }

    fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
}

/// Phrased for the user: the center refused our credentials (HTTP 401).
fn unauthorized(url: &str, token: Option<&str>) -> String {
    match token {
        Some(_) => format!("{url} が token を受け付けない (HTTP 401)。token が違う可能性がある"),
        None => format!("{url} は token が必要 (HTTP 401)。接続設定に Authorization が無い"),
    }
}

fn snippet(body: &str) -> String {
    let t: String = body.chars().take(200).collect();
    if t.is_empty() { "(empty body)".to_string() } else { t }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterConnection {
    /// MCP endpoint in use. None: no target (center disabled and no `remote`).
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<TargetSource>,
    connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

const NO_TARGET: &str = "接続先が無い（center を有効にするか、別ホストの接続設定を貼る）";

fn target(app: &tauri::AppHandle) -> CmdResult<Target> {
    select_target(&load_settings(app)?).ok_or_else(|| CommandError::other(NO_TARGET))
}

/// Call a center tool by name. Returns the MCP tool result as is (`{content: [...], isError?}`).
#[tauri::command]
pub async fn center_call(
    app: tauri::AppHandle,
    name: String,
    arguments: Option<Value>,
) -> CmdResult<Value> {
    let t = target(&app)?;
    app.state::<CenterClient>()
        .call_tool(&t.url, t.token.as_deref(), &name, arguments)
        .await
        .map_err(CommandError::Other)
}

/// Where the desktop is connecting to and whether the center answers right now.
#[tauri::command]
pub async fn center_connection(app: tauri::AppHandle) -> CmdResult<CenterConnection> {
    let client = app.state::<CenterClient>();
    let Some(t) = select_target(&load_settings(&app)?) else {
        return Ok(CenterConnection {
            url: None,
            source: None,
            connected: false,
            last_error: Some(NO_TARGET.to_string()),
        });
    };
    let connected = client.probe(&t.url, t.token.as_deref()).await.is_ok();
    Ok(CenterConnection {
        url: Some(t.url),
        source: Some(t.source),
        connected,
        last_error: client.last_error(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;

    // -- target selection ------------------------------------------------------------

    fn settings(enabled: bool, remote: Option<&str>) -> CenterSettings {
        CenterSettings {
            enabled,
            remote: remote.map(|u| crate::center::CenterRemote { url: u.to_string(), token: Some("remote-token-123".into()) }),
            token: "sidecar-token-123".into(),
            ..CenterSettings::default()
        }
    }

    #[test]
    fn target_none_when_disabled_and_no_remote() {
        assert_eq!(select_target(&settings(false, None)), None);
    }

    #[test]
    fn target_sidecar_when_enabled() {
        let t = select_target(&CenterSettings { port: 7920, ..settings(true, None) }).unwrap();
        assert_eq!(
            t,
            Target { url: "http://127.0.0.1:7920/mcp".into(), token: Some("sidecar-token-123".into()), source: TargetSource::Sidecar }
        );
    }

    #[test]
    fn target_sidecar_wins_over_stored_remote_when_enabled() {
        let s = settings(true, Some("http://mac200:7910/mcp"));
        let t = select_target(&s).unwrap();
        assert_eq!(t.source, TargetSource::Sidecar);
        assert_eq!(t.url, "http://127.0.0.1:7910/mcp");
        assert_eq!(t.token.as_deref(), Some("sidecar-token-123"));
        // the stored remote is untouched, and OFF uses it again
        assert_eq!(s.remote.as_ref().map(|r| r.url.as_str()), Some("http://mac200:7910/mcp"));
        let off = CenterSettings { enabled: false, ..s };
        let t = select_target(&off).unwrap();
        assert_eq!(t.source, TargetSource::Remote);
        assert_eq!(t.url, "http://mac200:7910/mcp");
        assert_eq!(t.token.as_deref(), Some("remote-token-123"));
        assert!(off.remote.is_some());
    }

    #[test]
    fn target_without_any_token_sends_none() {
        let s = CenterSettings { token: String::new(), ..settings(true, None) };
        assert_eq!(select_target(&s).unwrap().token, None);
    }

    #[test]
    fn target_remote_works_when_sidecar_disabled() {
        let t = select_target(&settings(false, Some("http://mac200:7910"))).unwrap();
        assert_eq!(t.url, "http://mac200:7910/mcp");
    }

    #[test]
    fn target_remote_keeps_explicit_path() {
        let t = select_target(&settings(false, Some("http://h:1/custom"))).unwrap();
        assert_eq!(t.url, "http://h:1/custom");
    }

    #[test]
    fn sidecar_is_dialed_on_loopback_whatever_ip_is_picked() {
        for bind in ["", "0.0.0.0", "192.168.1.5", "fe80::1", "10.9.9.9"] {
            let t = select_target(&CenterSettings { bind: bind.into(), ..settings(true, None) }).unwrap();
            assert_eq!(t.url, "http://127.0.0.1:7910/mcp", "{bind}");
        }
    }

    // -- body parsing ----------------------------------------------------------------

    #[test]
    fn parses_sse_and_json_bodies() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"ok\":1}}\n\n";
        let m = parse_messages("text/event-stream", sse);
        assert_eq!(pick_response(&m, 3).unwrap(), json!({"ok": 1}));
        let m = parse_messages("application/json", r#"{"jsonrpc":"2.0","id":4,"result":{}}"#);
        assert_eq!(pick_response(&m, 4).unwrap(), json!({}));
        assert!(pick_response(&m, 5).is_err());
    }

    #[test]
    fn json_rpc_error_is_reported() {
        let m = parse_messages("application/json", r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}"#);
        assert_eq!(pick_response(&m, 1), Err(McpError::failed("MCP error -32602: bad")));
    }

    // -- mock center -----------------------------------------------------------------

    struct MockReq {
        headers: HashMap<String, String>,
        body: Value,
    }

    /// Behaves like the center's Streamable HTTP endpoint: initialize issues a session id, other
    /// requests need a known one (404 otherwise), tools/call answers over SSE.
    #[derive(Default)]
    struct MockState {
        /// When set, every request must carry `Authorization: Bearer <this>` (401 otherwise).
        required_token: Option<String>,
        sessions: HashSet<String>,
        issued: u32,
        log: Vec<MockReq>,
    }

    struct Mock {
        url: String,
        state: Arc<Mutex<MockState>>,
    }

    impl Mock {
        fn start() -> Self {
            Self::start_with(None)
        }

        fn start_with(token: Option<&str>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/mcp", listener.local_addr().unwrap());
            let state = Arc::new(Mutex::new(MockState {
                required_token: token.map(str::to_string),
                ..MockState::default()
            }));
            let st = state.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(conn) = conn else { break };
                    let st = st.clone();
                    std::thread::spawn(move || serve(conn, &st));
                }
            });
            Mock { url, state }
        }

        /// The center restarted: every session id is forgotten.
        fn restart(&self) {
            self.state.lock().unwrap().sessions.clear();
        }

        fn methods(&self) -> Vec<String> {
            self.state
                .lock()
                .unwrap()
                .log
                .iter()
                .map(|r| r.body["method"].as_str().unwrap_or("").to_string())
                .collect()
        }

        fn count(&self, method: &str) -> usize {
            self.methods().iter().filter(|m| *m == method).count()
        }
    }

    fn read_request(conn: &mut TcpStream) -> Option<MockReq> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            let n = conn.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let headers: HashMap<String, String> = head
            .lines()
            .skip(1)
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while buf.len() < head_end + len {
            let n = conn.read(&mut chunk).ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
        Some(MockReq { headers, body })
    }

    fn respond(conn: &mut TcpStream, status: u16, headers: &[(&str, String)], body: &str) {
        let mut out = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        out.push_str(body);
        let _ = conn.write_all(out.as_bytes());
    }

    fn serve(mut conn: TcpStream, state: &Mutex<MockState>) {
        let Some(req) = read_request(&mut conn) else { return };
        let method = req.body["method"].as_str().unwrap_or("").to_string();
        let id = req.body["id"].clone();
        let sid = req.headers.get(SESSION_HEADER).cloned();
        let mut g = state.lock().unwrap();
        let authorized = match &g.required_token {
            Some(t) => req.headers.get("authorization").map(String::as_str) == Some(format!("Bearer {t}").as_str()),
            None => true,
        };
        if !authorized {
            g.log.push(req);
            drop(g);
            respond(&mut conn, 401, &[("www-authenticate", "Bearer".into())], "unauthorized");
            return;
        }
        let known = sid.as_ref().is_some_and(|s| g.sessions.contains(s));
        let params = req.body["params"].clone();
        g.log.push(req);
        let rpc = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
        if method == "initialize" {
            g.issued += 1;
            let new = format!("s{}", g.issued);
            g.sessions.insert(new.clone());
            let body = rpc(json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name": "mock", "version": "0"}}));
            drop(g);
            respond(&mut conn, 200, &[("content-type", "application/json".into()), (SESSION_HEADER, new)], &body);
            return;
        }
        if !known {
            drop(g);
            respond(&mut conn, 404, &[("content-type", "application/json".into())], r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"session が存在しない"},"id":null}"#);
            return;
        }
        drop(g);
        match method.as_str() {
            "notifications/initialized" => respond(&mut conn, 202, &[], ""),
            "ping" => respond(&mut conn, 200, &[("content-type", "application/json".into())], &rpc(json!({}))),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or("");
                let result = if name == "boom" {
                    json!({"content": [{"type": "text", "text": "{\"error\":\"kaboom\"}"}], "isError": true})
                } else {
                    json!({"content": [{"type": "text", "text": format!("{{\"tool\":\"{name}\",\"args\":{}}}", params["arguments"])}]})
                };
                let sse = format!("event: message\ndata: {}\n\n", rpc(result));
                respond(&mut conn, 200, &[("content-type", "text/event-stream".into())], &sse);
            }
            _ => respond(&mut conn, 400, &[], "unknown"),
        }
    }

    // -- client behaviour ------------------------------------------------------------

    #[tokio::test]
    async fn initialize_then_tools_call_returns_result_as_is() {
        let mock = Mock::start();
        let client = CenterClient::default();
        let r = client.call_tool(&mock.url, None, "rc_list", Some(json!({"project": "p"}))).await.unwrap();
        assert_eq!(r["content"][0]["text"], r#"{"tool":"rc_list","args":{"project":"p"}}"#);
        assert_eq!(mock.methods(), ["initialize", "notifications/initialized", "tools/call"]);
        let g = mock.state.lock().unwrap();
        assert_eq!(g.log[1].headers.get(SESSION_HEADER).map(String::as_str), Some("s1"));
        assert_eq!(g.log[2].headers.get(SESSION_HEADER).map(String::as_str), Some("s1"));
        assert_eq!(g.log[2].headers.get("mcp-protocol-version").map(String::as_str), Some(PROTOCOL_VERSION));
        assert!(g.log[2].headers["accept"].contains("text/event-stream"));
    }

    #[tokio::test]
    async fn session_is_reused_across_calls() {
        let mock = Mock::start();
        let client = CenterClient::default();
        client.call_tool(&mock.url, None, "rc_list", None).await.unwrap();
        client.call_tool(&mock.url, None, "server_list", None).await.unwrap();
        assert_eq!(mock.count("initialize"), 1);
        assert_eq!(mock.count("tools/call"), 2);
        // no arguments are sent as an empty object
        assert_eq!(mock.state.lock().unwrap().log.last().unwrap().body["params"]["arguments"], json!({}));
    }

    #[tokio::test]
    async fn lost_session_is_reestablished_on_the_next_call() {
        let mock = Mock::start();
        let client = CenterClient::default();
        client.call_tool(&mock.url, None, "rc_list", None).await.unwrap();
        mock.restart();
        let r = client.call_tool(&mock.url, None, "rc_list", None).await.unwrap();
        assert_eq!(r["content"][0]["text"], r#"{"tool":"rc_list","args":{}}"#);
        assert_eq!(mock.count("initialize"), 2);
        // the failed attempt, then the retry on the new session
        assert_eq!(mock.count("tools/call"), 3);
        // and the new session is kept
        client.call_tool(&mock.url, None, "rc_list", None).await.unwrap();
        assert_eq!(mock.count("initialize"), 2);
    }

    #[tokio::test]
    async fn changing_the_url_opens_a_new_session() {
        let (a, b) = (Mock::start(), Mock::start());
        let client = CenterClient::default();
        client.call_tool(&a.url, None, "rc_list", None).await.unwrap();
        client.call_tool(&b.url, None, "rc_list", None).await.unwrap();
        client.call_tool(&a.url, None, "rc_list", None).await.unwrap();
        assert_eq!((a.count("initialize"), b.count("initialize")), (2, 1));
    }

    #[tokio::test]
    async fn tool_error_result_becomes_an_error_with_its_text() {
        let mock = Mock::start();
        let client = CenterClient::default();
        let e = client.call_tool(&mock.url, None, "boom", None).await.unwrap_err();
        assert!(e.contains("boom") && e.contains("kaboom"), "{e}");
        assert_eq!(client.last_error(), Some(e));
    }

    #[tokio::test]
    async fn unreachable_center_is_an_error_and_probe_recovers() {
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/mcp", l.local_addr().unwrap())
        };
        let client = CenterClient::default();
        let e = client.call_tool(&dead, None, "rc_list", None).await.unwrap_err();
        assert!(e.contains("接続できない"), "{e}");
        assert!(client.probe(&dead, None).await.is_err());
        assert!(client.last_error().is_some());
        let mock = Mock::start();
        client.probe(&mock.url, None).await.unwrap();
        assert_eq!(client.last_error(), None);
    }

    #[tokio::test]
    async fn probe_after_center_restart_reconnects() {
        let mock = Mock::start();
        let client = CenterClient::default();
        client.probe(&mock.url, None).await.unwrap();
        mock.restart();
        client.probe(&mock.url, None).await.unwrap();
        assert_eq!(mock.count("initialize"), 2);
    }

    #[tokio::test]
    async fn every_request_carries_the_bearer_token() {
        let mock = Mock::start_with(Some("tok-abcdefghij"));
        let client = CenterClient::default();
        client.call_tool(&mock.url, Some("tok-abcdefghij"), "rc_list", None).await.unwrap();
        let g = mock.state.lock().unwrap();
        let methods: Vec<_> = g.log.iter().map(|r| r.body["method"].as_str().unwrap_or("")).collect();
        assert_eq!(methods, ["initialize", "notifications/initialized", "tools/call"]);
        for r in &g.log {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer tok-abcdefghij"));
        }
    }

    #[tokio::test]
    async fn wrong_or_missing_token_is_a_readable_401() {
        let mock = Mock::start_with(Some("tok-abcdefghij"));
        let client = CenterClient::default();
        let e = client.call_tool(&mock.url, Some("wrong-token-xyz"), "rc_list", None).await.unwrap_err();
        assert!(e.contains("401") && e.contains("token が違う"), "{e}");
        let e = client.call_tool(&mock.url, None, "rc_list", None).await.unwrap_err();
        assert!(e.contains("401") && e.contains("token が必要"), "{e}");
        assert!(client.probe(&mock.url, None).await.is_err());
        assert!(client.last_error().unwrap().contains("401"));
        // the right token still works afterwards
        client.probe(&mock.url, Some("tok-abcdefghij")).await.unwrap();
        assert_eq!(client.last_error(), None);
    }

    #[tokio::test]
    async fn changing_the_token_opens_a_new_session() {
        let mock = Mock::start();
        let client = CenterClient::default();
        client.call_tool(&mock.url, Some("first-token-123"), "rc_list", None).await.unwrap();
        client.call_tool(&mock.url, Some("first-token-123"), "rc_list", None).await.unwrap();
        assert_eq!(mock.count("initialize"), 1);
        client.call_tool(&mock.url, Some("second-token-45"), "rc_list", None).await.unwrap();
        assert_eq!(mock.count("initialize"), 2);
    }

    /// Against a real center: `BANTOU_CENTER_URL=http://127.0.0.1:<port>/mcp BANTOU_CENTER_TOKEN=<token> cargo test live_center -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_center() {
        let url = std::env::var("BANTOU_CENTER_URL").expect("BANTOU_CENTER_URL");
        let token = std::env::var("BANTOU_CENTER_TOKEN").ok();
        let token = token.as_deref();
        let client = CenterClient::default();
        client.probe(&url, token).await.unwrap();
        let r = client.call_tool(&url, token, "rc_list", None).await.unwrap();
        println!("rc_list: {}", tool_text(&r));
        let r = client.call_tool(&url, token, "server_list", None).await.unwrap();
        println!("server_list: {}", tool_text(&r));
        let e = client.call_tool(&url, token, "rc_status", Some(json!({"project": "nope"}))).await.unwrap_err();
        println!("rc_status(nope): {e}");
    }
}
