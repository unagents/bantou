//! The center's `GET /events` (SSE, same port and token as `/mcp`): a `sessions` event is sent once on
//! connect and whenever a session is created, deleted or restored in the center. This module keeps one
//! subscription to the connected center and forwards each `sessions` event to the webview as the Tauri
//! event `center-sessions-changed` `{reason, name}`; the webview then reads `session_list` again.
//!
//! The subscription follows the target (own sidecar or pasted remote center): when the settings point
//! elsewhere it reconnects there. A lost connection (sleep, network change, center restart) is reopened
//! with a growing delay; the first event after a reconnect makes the webview re-read the list.

use crate::center::load_settings;
use crate::center_mcp::{select_target, Target};
use crate::terminal::{center_url, http, reconnect_delay, stream_once, SseEvent, StreamEnd};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::Emitter;

pub const CHANGED_EVENT: &str = "center-sessions-changed";

/// A center without `/events` (404) or a refused token (401) is asked again only rarely.
const REJECTED_DELAY: Duration = Duration::from_secs(60);
/// The center sends a keep-alive every 15 s.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// How often the target is compared with the one the subscription was opened for.
const TARGET_POLL: Duration = Duration::from_secs(2);

/// Payload of `center-sessions-changed`. Both fields are empty for the event sent on connect.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Changed {
    pub reason: Option<String>,
    pub name: Option<String>,
}

pub fn events_url(mcp_url: &str) -> Result<reqwest::Url, String> {
    center_url(mcp_url, &["events"])
}

/// The payload to forward for an SSE event, or None for events that are not `sessions`.
pub fn to_changed(ev: &SseEvent) -> Option<Changed> {
    if ev.event != "sessions" {
        return None;
    }
    let v: Value = serde_json::from_str(&ev.data).unwrap_or(Value::Null);
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(Changed { reason: field("reason"), name: field("name") })
}

/// Wait before the next attempt, given how the last one ended.
pub fn retry_delay(last: &Result<StreamEnd, String>, failures: u32) -> Duration {
    match last {
        Ok(StreamEnd::Rejected(_)) => REJECTED_DELAY,
        _ => reconnect_delay(failures),
    }
}

fn current_target(app: &tauri::AppHandle) -> Option<Target> {
    load_settings(app).ok().and_then(|s| select_target(&s))
}

async fn run(app: tauri::AppHandle) {
    let client = http();
    let mut failures = 0u32;
    loop {
        let Some(target) = current_target(&app) else {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };
        let mut got_events = false;
        let result = match events_url(&target.url) {
            Err(e) => Err(e),
            Ok(url) => {
                let watch = async {
                    loop {
                        tokio::time::sleep(TARGET_POLL).await;
                        if current_target(&app).as_ref() != Some(&target) {
                            break;
                        }
                    }
                };
                let stream = stream_once(&client, url, target.token.as_deref(), None, READ_TIMEOUT, |ev| {
                    got_events = true;
                    if let Some(c) = to_changed(&ev) {
                        let _ = app.emit(CHANGED_EVENT, c);
                    }
                    true
                });
                tokio::select! {
                    r = stream => r,
                    _ = watch => {
                        // The target changed: reconnect to the new one at once.
                        failures = 0;
                        continue;
                    }
                }
            }
        };
        if got_events {
            failures = 0;
        }
        tokio::time::sleep(retry_delay(&result, failures)).await;
        failures = failures.saturating_add(1);
    }
}

/// Subscribe to the connected center's events for the life of the app.
pub fn start(app: &tauri::AppHandle) {
    tauri::async_runtime::spawn(run(app.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent { id: None, event: event.into(), data: data.into() }
    }

    #[test]
    fn sessions_event_carries_reason_and_name() {
        let c = to_changed(&ev("sessions", r#"{"reason":"created","name":"pm-a"}"#)).unwrap();
        assert_eq!(c, Changed { reason: Some("created".into()), name: Some("pm-a".into()) });
    }

    #[test]
    fn the_event_sent_on_connect_has_an_empty_payload() {
        let c = to_changed(&ev("sessions", "{}")).unwrap();
        assert_eq!(c, Changed { reason: None, name: None });
    }

    #[test]
    fn unreadable_data_still_triggers_a_refetch() {
        assert_eq!(to_changed(&ev("sessions", "not json")), Some(Changed { reason: None, name: None }));
    }

    #[test]
    fn other_events_are_ignored() {
        assert!(to_changed(&ev("output", "{}")).is_none());
        assert!(to_changed(&ev("message", "{}")).is_none());
    }

    #[test]
    fn changed_serializes_with_the_event_field_names() {
        let c = Changed { reason: Some("deleted".into()), name: Some("x".into()) };
        assert_eq!(serde_json::to_value(c).unwrap(), serde_json::json!({"reason":"deleted","name":"x"}));
    }

    #[test]
    fn events_url_is_on_the_mcp_origin() {
        assert_eq!(events_url("http://127.0.0.1:7910/mcp").unwrap().as_str(), "http://127.0.0.1:7910/events");
        assert_eq!(events_url("http://mac200:7910/mcp?x=1").unwrap().as_str(), "http://mac200:7910/events");
        assert!(events_url("nope").is_err());
    }

    #[test]
    fn retry_delay_backs_off_and_waits_long_after_a_rejection() {
        assert_eq!(retry_delay(&Ok(StreamEnd::Closed), 0), Duration::from_secs(1));
        assert_eq!(retry_delay(&Err("x".into()), 2), Duration::from_secs(4));
        assert_eq!(retry_delay(&Ok(StreamEnd::Rejected(404)), 0), REJECTED_DELAY);
    }

    #[tokio::test]
    async fn events_from_the_stream_are_forwarded_and_keep_alives_are_not() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/mcp", listener.local_addr().unwrap());
        let head = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let h = head.clone();
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = conn.read(&mut buf).unwrap_or(0);
            *h.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            let body = "event: sessions\ndata: {}\n\n: ka\n\nevent: sessions\ndata: {\"reason\":\"created\",\"name\":\"n1\"}\n\n";
            let _ = conn.write_all(
                format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}").as_bytes(),
            );
        });
        let mut got = Vec::new();
        let url = events_url(&base).unwrap();
        let end = stream_once(&http(), url, Some("tok"), None, Duration::from_secs(5), |e| {
            got.extend(to_changed(&e));
            true
        })
        .await
        .unwrap();
        assert_eq!(end, StreamEnd::Closed);
        assert_eq!(
            got,
            vec![
                Changed { reason: None, name: None },
                Changed { reason: Some("created".into()), name: Some("n1".into()) },
            ]
        );
        let head = head.lock().unwrap().clone();
        assert!(head.starts_with("get /events "), "{head}");
        assert!(head.contains("authorization: bearer tok"));
    }
}
