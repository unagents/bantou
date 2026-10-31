//! Terminal view of a center session (master-cap): the webview never talks to the center, so this
//! module holds the connection.
//!
//! - `session_output_start` opens `GET /sessions/<name>/output` (SSE) and emits the Tauri event
//!   `session-output` `{session, id, data (base64), reset}` for every `output` / `reset` event. A broken
//!   connection is reopened with the last received chunk id (`Last-Event-ID`), so sleep and network
//!   changes are absorbed. The center sends `: ka` every 15 s, so a
//!   connection silent for longer than `READ_TIMEOUT` is dropped and reopened.
//! - `session_input` / `session_resize` POST to `/sessions/<name>/input` and `/resize`.
//!
//! The center URL / token are the ones of the MCP target (same base URL, external Bearer token).

use crate::center::load_settings;
use crate::center_mcp::select_target;
use crate::error::{CmdResult, CommandError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

pub const OUTPUT_EVENT: &str = "session-output";
pub const STATUS_EVENT: &str = "session-output-status";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The center sends a keep-alive every 15 s; three missed ones mean the connection is dead.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
const POST_TIMEOUT: Duration = Duration::from_secs(10);

// -- SSE parsing -------------------------------------------------------------------------

/// One dispatched SSE event.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseEvent {
    pub id: Option<String>,
    /// `message` when the stream gave no `event:` field.
    pub event: String,
    pub data: String,
}

/// Incremental parser for `text/event-stream` (WHATWG rules: `\n`, `\r\n` or `\r` line ends, `:`
/// comment lines, multi-line `data`, an event is dispatched by a blank line).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    id: Option<String>,
    event: Option<String>,
    data: Vec<String>,
    /// A trailing `\r` was the last byte: a following `\n` belongs to it.
    skip_lf: bool,
}

impl SseParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' => self.line(&mut out),
                b'\r' => {
                    self.skip_lf = true;
                    self.line(&mut out);
                }
                _ => self.buf.push(b),
            }
        }
        out
    }

    fn line(&mut self, out: &mut Vec<SseEvent>) {
        let raw = std::mem::take(&mut self.buf);
        let line = String::from_utf8_lossy(&raw);
        if line.is_empty() {
            // Blank line: dispatch (nothing is dispatched without data, per the spec).
            let event = self.event.take();
            let id = self.id.clone();
            if !self.data.is_empty() {
                out.push(SseEvent {
                    id,
                    event: event.filter(|e| !e.is_empty()).unwrap_or_else(|| "message".to_string()),
                    data: self.data.join("\n"),
                });
            }
            self.data.clear();
            return;
        }
        if line.starts_with(':') {
            return; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (&*line, ""),
        };
        match field {
            "id" => {
                if !value.contains('\0') {
                    self.id = Some(value.to_string());
                }
            }
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }
}

/// Payload of the Tauri event `session-output`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutputPayload {
    pub session: String,
    /// Chunk id (0 on a reset: it carries no chunk).
    pub id: u64,
    /// Base64 of the raw pty bytes (empty on a reset).
    pub data: String,
    pub reset: bool,
}

/// Turn an SSE event into the payload to emit, updating the last received chunk id.
/// `reset` forgets the id (the stream restarts from the center's oldest chunk); other events
/// (and `output` with a broken id) are ignored.
pub fn to_payload(session: &str, ev: &SseEvent, last_id: &mut Option<u64>) -> Option<OutputPayload> {
    match ev.event.as_str() {
        "reset" => {
            *last_id = None;
            Some(OutputPayload { session: session.to_string(), id: 0, data: String::new(), reset: true })
        }
        "output" => {
            let id = ev.id.as_deref()?.trim().parse::<u64>().ok()?;
            *last_id = Some(id);
            Some(OutputPayload { session: session.to_string(), id, data: ev.data.clone(), reset: false })
        }
        _ => None,
    }
}

// -- requests ----------------------------------------------------------------------------

/// `<origin of the MCP url>/sessions/<name>/<tail>`; the name is percent-encoded as a path segment.
pub fn session_url(mcp_url: &str, session: &str, tail: &str) -> Result<reqwest::Url, String> {
    center_url(mcp_url, &["sessions", session, tail])
}

/// `<origin of the MCP url>/<segments...>` (segments are percent-encoded as path segments).
pub fn center_url(mcp_url: &str, segments: &[&str]) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(mcp_url).map_err(|e| format!("center の URL が不正: {e}"))?;
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| "center の URL が不正".to_string())?
        .clear()
        .extend(segments.iter().copied());
    Ok(url)
}

pub fn input_body(data_b64: &str) -> Value {
    json!({ "data": data_b64 })
}

pub fn resize_body(cols: u16, rows: u16) -> Value {
    json!({ "cols": cols, "rows": rows })
}

/// Wait before reconnect attempt `n` (0-based): 1, 2, 4, 8, then 15 s.
pub fn reconnect_delay(n: u32) -> Duration {
    Duration::from_secs((1u64 << n.min(4)).min(15))
}

pub(crate) fn http() -> reqwest::Client {
    crate::ensure_crypto_provider();
    reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build().expect("reqwest client")
}

/// How one connection ended.
#[derive(Debug, PartialEq)]
pub enum StreamEnd {
    /// The server closed the stream or it went silent: reconnect.
    Closed,
    /// The caller's sink asked to stop.
    Stopped,
    /// The center answered with this status (404: unknown session, 401: bad token): do not retry blindly.
    Rejected(u16),
}

/// Open the output stream once and feed events to `on_event` until it ends. `on_event` returns
/// false to stop. `last_id` is sent as `Last-Event-ID` when known.
pub async fn stream_once<F: FnMut(SseEvent) -> bool>(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: Option<&str>,
    last_id: Option<u64>,
    read_timeout: Duration,
    mut on_event: F,
) -> Result<StreamEnd, String> {
    let mut req = client.get(url.clone()).header("accept", "text/event-stream");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    if let Some(id) = last_id {
        req = req.header("last-event-id", id.to_string());
    }
    let mut resp = req.send().await.map_err(|e| format!("{url} に接続できない: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Ok(StreamEnd::Rejected(status.as_u16()));
    }
    let mut parser = SseParser::default();
    loop {
        match tokio::time::timeout(read_timeout, resp.chunk()).await {
            Err(_) => return Ok(StreamEnd::Closed),
            Ok(Err(e)) => return Err(format!("読み取りに失敗: {e}")),
            Ok(Ok(None)) => return Ok(StreamEnd::Closed),
            Ok(Ok(Some(bytes))) => {
                for ev in parser.feed(&bytes) {
                    if !on_event(ev) {
                        return Ok(StreamEnd::Stopped);
                    }
                }
            }
        }
    }
}

// -- Tauri side --------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    session: String,
    /// `connected` / `retrying` / `rejected`.
    state: &'static str,
    message: Option<String>,
}

/// Running output streams, one per session.
#[derive(Default)]
pub struct Terminals {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    client: Mutex<Option<reqwest::Client>>,
}

impl Terminals {
    fn client(&self) -> reqwest::Client {
        self.client.lock().unwrap().get_or_insert_with(http).clone()
    }

    fn replace(&self, session: &str, task: Option<tauri::async_runtime::JoinHandle<()>>) {
        let mut g = self.tasks.lock().unwrap();
        if let Some(old) = match task {
            Some(t) => g.insert(session.to_string(), t),
            None => g.remove(session),
        } {
            old.abort();
        }
    }
}

fn status(app: &tauri::AppHandle, session: &str, state: &'static str, message: Option<String>) {
    let _ = app.emit(STATUS_EVENT, StatusPayload { session: session.to_string(), state, message });
}

async fn run_stream(app: tauri::AppHandle, client: reqwest::Client, session: String, after: Option<u64>) {
    let mut last_id = after;
    let mut failures = 0u32;
    loop {
        let result = async {
            let t = select_target(&load_settings(&app).map_err(|e| e.to_string())?)
                .ok_or_else(|| "接続先が無い".to_string())?;
            let url = session_url(&t.url, &session, "output")?;
            let mut announced = false;
            let end = stream_once(&client, url, t.token.as_deref(), last_id, READ_TIMEOUT, |ev| {
                if !announced {
                    announced = true;
                    status(&app, &session, "connected", None);
                }
                if let Some(p) = to_payload(&session, &ev, &mut last_id) {
                    let _ = app.emit(OUTPUT_EVENT, p);
                }
                true
            })
            .await?;
            Ok::<_, String>((end, announced))
        }
        .await;
        match result {
            Ok((StreamEnd::Rejected(code), _)) => {
                status(&app, &session, "rejected", Some(format!("center が {code} を返した")));
                return;
            }
            Ok((_, got_events)) => {
                if got_events {
                    failures = 0;
                }
                status(&app, &session, "retrying", None);
            }
            Err(e) => status(&app, &session, "retrying", Some(e)),
        }
        tokio::time::sleep(reconnect_delay(failures)).await;
        failures = failures.saturating_add(1);
    }
}

/// Start (or restart) the output stream of `session`. `after`: the last chunk id the webview holds.
#[tauri::command]
pub fn session_output_start(
    app: tauri::AppHandle,
    terminals: tauri::State<'_, Terminals>,
    session: String,
    after: Option<u64>,
) {
    let task = tauri::async_runtime::spawn(run_stream(app, terminals.client(), session.clone(), after));
    terminals.replace(&session, Some(task));
}

#[tauri::command]
pub fn session_output_stop(terminals: tauri::State<'_, Terminals>, session: String) {
    terminals.replace(&session, None);
}

async fn post(app: &tauri::AppHandle, session: &str, tail: &str, body: Value) -> CmdResult<()> {
    let t = select_target(&load_settings(app)?).ok_or_else(|| CommandError::other("接続先が無い"))?;
    let url = session_url(&t.url, session, tail).map_err(CommandError::Other)?;
    let client = app.state::<Terminals>().client();
    let mut req = client.post(url.clone()).timeout(POST_TIMEOUT).json(&body);
    if let Some(tok) = &t.token {
        req = req.header("authorization", format!("Bearer {tok}"));
    }
    let resp = req.send().await.map_err(|e| CommandError::other(format!("{url} に接続できない: {e}")))?;
    if resp.status().as_u16() == 204 || resp.status().is_success() {
        return Ok(());
    }
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let reason = if code == 409 { "セッションは動いていない".to_string() } else { text.chars().take(200).collect() };
    Err(CommandError::other(format!("center が {code} を返した: {reason}")))
}

#[tauri::command]
pub async fn session_input(app: tauri::AppHandle, session: String, data_b64: String) -> CmdResult<()> {
    post(&app, &session, "input", input_body(&data_b64)).await
}

#[tauri::command]
pub async fn session_resize(app: tauri::AppHandle, session: String, cols: u16, rows: u16) -> CmdResult<()> {
    post(&app, &session, "resize", resize_body(cols, rows)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn parse_all(chunks: &[&str]) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        chunks.iter().flat_map(|c| p.feed(c.as_bytes())).collect()
    }

    #[test]
    fn parses_output_event_with_id() {
        let evs = parse_all(&["id: 7\nevent: output\ndata: aGVsbG8=\n\n"]);
        assert_eq!(evs, vec![SseEvent { id: Some("7".into()), event: "output".into(), data: "aGVsbG8=".into() }]);
    }

    #[test]
    fn parses_reset_and_ignores_keep_alive_comments() {
        let evs = parse_all(&["event: reset\ndata: {}\n\n: ka\n\n", ": ka\n\nid: 1\nevent: output\ndata: QQ==\n\n"]);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event, "reset");
        assert_eq!(evs[0].data, "{}");
        assert_eq!(evs[1].id.as_deref(), Some("1"));
    }

    #[test]
    fn keep_alive_alone_dispatches_nothing() {
        assert!(parse_all(&[": ka\n\n", ": ka\n\n"]).is_empty());
    }

    #[test]
    fn handles_events_split_across_chunks_and_crlf() {
        let evs = parse_all(&["id: 1\r\neve", "nt: output\r\nda", "ta: QQ==\r", "\n\r\n", "id: 2\nevent: output\ndata: Qg==\n", "\n"]);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0], SseEvent { id: Some("1".into()), event: "output".into(), data: "QQ==".into() });
        assert_eq!(evs[1].id.as_deref(), Some("2"));
    }

    #[test]
    fn multiple_data_lines_join_with_newline_and_default_event_is_message() {
        let evs = parse_all(&["data: a\ndata: b\n\n"]);
        assert_eq!(evs, vec![SseEvent { id: None, event: "message".into(), data: "a\nb".into() }]);
    }

    #[test]
    fn payload_for_output_tracks_last_id() {
        let mut last = None;
        let ev = SseEvent { id: Some("12".into()), event: "output".into(), data: "QQ==".into() };
        let p = to_payload("s", &ev, &mut last).unwrap();
        assert_eq!(p, OutputPayload { session: "s".into(), id: 12, data: "QQ==".into(), reset: false });
        assert_eq!(last, Some(12));
    }

    #[test]
    fn payload_for_reset_forgets_last_id() {
        let mut last = Some(99);
        let ev = SseEvent { id: None, event: "reset".into(), data: "{}".into() };
        let p = to_payload("s", &ev, &mut last).unwrap();
        assert!(p.reset);
        assert_eq!((p.id, p.data.as_str()), (0, ""));
        assert_eq!(last, None);
    }

    #[test]
    fn payload_ignores_unknown_events_and_broken_ids() {
        let mut last = Some(5);
        let other = SseEvent { id: Some("6".into()), event: "message".into(), data: "x".into() };
        assert!(to_payload("s", &other, &mut last).is_none());
        let bad = SseEvent { id: Some("abc".into()), event: "output".into(), data: "x".into() };
        assert!(to_payload("s", &bad, &mut last).is_none());
        let noid = SseEvent { id: None, event: "output".into(), data: "x".into() };
        assert!(to_payload("s", &noid, &mut last).is_none());
        assert_eq!(last, Some(5));
    }

    #[test]
    fn payload_serializes_with_the_event_field_names() {
        let p = OutputPayload { session: "s".into(), id: 3, data: "QQ==".into(), reset: false };
        assert_eq!(serde_json::to_value(p).unwrap(), json!({"session":"s","id":3,"data":"QQ==","reset":false}));
    }

    #[test]
    fn session_url_uses_the_mcp_origin_and_encodes_the_name() {
        let u = session_url("http://127.0.0.1:7910/mcp", "master cap/1", "output").unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:7910/sessions/master%20cap%2F1/output");
        let u = session_url("http://mac200:7910/mcp?x=1", "a", "input").unwrap();
        assert_eq!(u.as_str(), "http://mac200:7910/sessions/a/input");
        assert!(session_url("not a url", "a", "input").is_err());
    }

    #[test]
    fn request_bodies_have_the_contract_shape() {
        assert_eq!(input_body("QQ=="), json!({"data":"QQ=="}));
        assert_eq!(resize_body(120, 40), json!({"cols":120,"rows":40}));
    }

    #[test]
    fn reconnect_delay_backs_off_and_caps() {
        let secs: Vec<u64> = (0..7).map(|n| reconnect_delay(n).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 15, 15, 15]);
    }

    /// Tiny HTTP server: answers each connection with the next canned body and records the request head.
    fn serve(responses: Vec<(&'static str, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let heads = Arc::new(Mutex::new(Vec::new()));
        let h = heads.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((mut conn, _)) = listener.accept() else { return };
                let mut buf = [0u8; 4096];
                let n = conn.read(&mut buf).unwrap_or(0);
                h.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let head = format!("HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n");
                let _ = conn.write_all(head.as_bytes());
                let _ = conn.write_all(body.as_bytes());
            }
        });
        (base, heads)
    }

    #[tokio::test]
    async fn stream_once_delivers_events_and_sends_last_event_id_and_token() {
        let body = "event: reset\ndata: {}\n\n: ka\n\nid: 4\nevent: output\ndata: QQ==\n\n".to_string();
        let (base, heads) = serve(vec![("200 OK", body)]);
        let url = session_url(&format!("{base}/mcp"), "m", "output").unwrap();
        let mut got = Vec::new();
        let end = stream_once(&http(), url, Some("tok"), Some(3), Duration::from_secs(5), |e| {
            got.push(e);
            true
        })
        .await
        .unwrap();
        assert_eq!(end, StreamEnd::Closed);
        assert_eq!(got.iter().map(|e| e.event.as_str()).collect::<Vec<_>>(), ["reset", "output"]);
        let head = heads.lock().unwrap()[0].to_lowercase();
        assert!(head.starts_with("get /sessions/m/output "), "{head}");
        assert!(head.contains("authorization: bearer tok"));
        assert!(head.contains("last-event-id: 3"));
    }

    #[tokio::test]
    async fn stream_once_omits_last_event_id_when_none_and_reports_rejection() {
        let (base, heads) = serve(vec![("404 Not Found", String::new())]);
        let url = session_url(&format!("{base}/mcp"), "gone", "output").unwrap();
        let end = stream_once(&http(), url, None, None, Duration::from_secs(5), |_| true).await.unwrap();
        assert_eq!(end, StreamEnd::Rejected(404));
        let head = heads.lock().unwrap()[0].to_lowercase();
        assert!(!head.contains("last-event-id"));
        assert!(!head.contains("authorization"));
    }

    #[tokio::test]
    async fn reconnect_resumes_from_the_last_received_id() {
        let first = "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n".to_string();
        let second = "id: 3\nevent: output\ndata: Qw==\n\n".to_string();
        let (base, heads) = serve(vec![("200 OK", first), ("200 OK", second)]);
        let mut last = None;
        let mut payloads = Vec::new();
        for _ in 0..2 {
            let url = session_url(&format!("{base}/mcp"), "m", "output").unwrap();
            stream_once(&http(), url, None, last, Duration::from_secs(5), |e| {
                if let Some(p) = to_payload("m", &e, &mut last) {
                    payloads.push(p.id);
                }
                true
            })
            .await
            .unwrap();
        }
        assert_eq!(payloads, [1, 2, 3]);
        let heads = heads.lock().unwrap();
        assert!(!heads[0].to_lowercase().contains("last-event-id"));
        assert!(heads[1].to_lowercase().contains("last-event-id: 2"));
    }

    #[tokio::test]
    async fn stream_once_stops_when_the_sink_says_so() {
        let body = "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n".to_string();
        let (base, _) = serve(vec![("200 OK", body)]);
        let url = session_url(&format!("{base}/mcp"), "m", "output").unwrap();
        let mut n = 0;
        let end = stream_once(&http(), url, None, None, Duration::from_secs(5), |_| {
            n += 1;
            false
        })
        .await
        .unwrap();
        assert_eq!((end, n), (StreamEnd::Stopped, 1));
    }

    #[tokio::test]
    async fn silent_connection_is_dropped_after_the_read_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf);
            let _ = conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n");
            std::thread::sleep(Duration::from_secs(2));
        });
        let url = session_url(&format!("{base}/mcp"), "m", "output").unwrap();
        let end = stream_once(&http(), url, None, None, Duration::from_millis(300), |_| true).await.unwrap();
        assert_eq!(end, StreamEnd::Closed);
    }
}
