//! Connection snippets for the center (Cork-style): the text a user copies to point an MCP
//! client at this center, and the parser that reads such a text back on the desktop that
//! connects to another host's center.
//!
//! Two formats, both carrying the URL and the Bearer token:
//! - `mcp.json`: `{"mcpServers": {"bantou-center": {"type": "http", "url": ..., "headers": {"Authorization": "Bearer ..."}}}}`
//! - `claude mcp add --transport http bantou-center <url> --header 'Authorization: Bearer ...'`

use crate::center_mcp::normalize_remote;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::{IpAddr, UdpSocket};

/// Name the snippets register the server under.
pub const SERVER_NAME: &str = "bantou-center";

const WILDCARD_BINDS: [&str; 3] = ["", "0.0.0.0", "::"];
const LOOPBACK_BINDS: [&str; 4] = ["127.0.0.1", "::1", "[::1]", "localhost"];

/// Host to put in a snippet. Loopback binds give `127.0.0.1`. A wildcard bind gives the
/// address other hosts reach this machine at (`outbound`, see `outbound_ip`), falling back to
/// `127.0.0.1` when none is known. Any other bind is the address itself.
pub fn snippet_host(bind: &str, outbound: Option<IpAddr>) -> String {
    let bind = bind.trim();
    if LOOPBACK_BINDS.contains(&bind) {
        return "127.0.0.1".to_string();
    }
    if WILDCARD_BINDS.contains(&bind) {
        return match outbound {
            Some(IpAddr::V6(a)) => format!("[{a}]"),
            Some(a) => a.to_string(),
            None => "127.0.0.1".to_string(),
        };
    }
    if bind.contains(':') && !bind.starts_with('[') {
        format!("[{bind}]")
    } else {
        bind.to_string()
    }
}

/// The local address of the default route. Connecting a UDP socket sends nothing; it only makes
/// the OS pick the outgoing interface, whose address `local_addr` then reports.
pub fn outbound_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

pub fn endpoint_url(bind: &str, port: u32, outbound: Option<IpAddr>) -> String {
    format!("http://{}:{port}/mcp", snippet_host(bind, outbound))
}

pub fn build_mcp_json(url: &str, token: &str) -> String {
    let root = json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    });
    serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".to_string())
}

/// One shell argument in single quotes (`'` as `'\''`).
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn build_claude_command(url: &str, token: &str) -> String {
    let auth = shell_single_quote(&format!("Authorization: Bearer {token}"));
    format!("claude mcp add --transport http {SERVER_NAME} {url} \\\n  --header {auth}")
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectSnippets {
    pub url: String,
    pub mcp_json: String,
    pub claude_code: String,
}

pub fn build_snippets(bind: &str, port: u32, token: &str, outbound: Option<IpAddr>) -> ConnectSnippets {
    let url = endpoint_url(bind, port, outbound);
    ConnectSnippets {
        mcp_json: build_mcp_json(&url, token),
        claude_code: build_claude_command(&url, token),
        url,
    }
}

/// What a pasted snippet yields.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConnect {
    pub url: String,
    pub token: Option<String>,
}

/// Split a shell command line into words: single and double quotes, backslash escapes, and
/// backslash-newline continuations. No expansion of any kind.
fn shell_split(s: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("引用符 ' が閉じていない".to_string()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(e @ ('"' | '\\' | '$' | '`')) => cur.push(e),
                            Some('\n') => {}
                            Some(other) => {
                                cur.push('\\');
                                cur.push(other);
                            }
                            None => return Err("引用符 \" が閉じていない".to_string()),
                        },
                        Some(ch) => cur.push(ch),
                        None => return Err("引用符 \" が閉じていない".to_string()),
                    }
                }
            }
            '\\' => match chars.next() {
                Some('\n') => {}
                Some('\r') if chars.peek() == Some(&'\n') => {
                    chars.next();
                }
                Some(e) => {
                    in_word = true;
                    cur.push(e);
                }
                None => {}
            },
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Ok(words)
}

/// `Authorization` header value -> bearer token. `Ok(None)` when the value is empty.
fn bearer_token(value: &str) -> Result<Option<String>, String> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(None);
    }
    let (scheme, rest) = v.split_once(char::is_whitespace).unwrap_or((v, ""));
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err("Authorization が Bearer 形式ではない".to_string());
    }
    let t = rest.trim();
    Ok((!t.is_empty()).then(|| t.to_string()))
}

fn checked_url(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw.trim()).map_err(|e| format!("url を解釈できない ({raw}): {e}"))?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return Err(format!("url は http(s):// で始まるホスト付きのものだけ: {raw}"));
    }
    Ok(normalize_remote(raw.trim()))
}

fn parse_json(text: &str) -> Result<ParsedConnect, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("JSON として読めない: {e}"))?;
    // `{"mcpServers": {...}}` (Claude Desktop / Code), `{"servers": {...}}` (VS Code), or one bare entry.
    let entry = ["mcpServers", "servers"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_object))
        .and_then(|m| {
            m.get(SERVER_NAME)
                .filter(|e| e.get("url").is_some())
                .or_else(|| m.values().find(|e| e.get("url").is_some()))
        })
        .or_else(|| v.get("url").map(|_| &v))
        .ok_or_else(|| "接続設定に url を持つサーバーが見つからない".to_string())?;
    let url = entry
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "url が文字列ではない".to_string())?;
    let auth = entry.get("headers").and_then(Value::as_object).and_then(|h| {
        h.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .and_then(|(_, v)| v.as_str())
    });
    Ok(ParsedConnect {
        url: checked_url(url)?,
        token: auth.map(bearer_token).transpose()?.flatten(),
    })
}

fn parse_claude_command(text: &str) -> Result<ParsedConnect, String> {
    let words = shell_split(text)?;
    let mut url: Option<&String> = None;
    let mut token = None;
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        let header = if w == "--header" || w == "-H" {
            i += 1;
            Some(words.get(i).ok_or_else(|| format!("{w} に値が無い"))?.as_str())
        } else {
            w.strip_prefix("--header=")
        };
        if let Some(h) = header {
            if let Some((name, value)) = h.split_once(':') {
                if name.trim().eq_ignore_ascii_case("authorization") {
                    token = bearer_token(value)?;
                }
            }
        } else if url.is_none() && (w.starts_with("http://") || w.starts_with("https://")) {
            url = Some(w);
        }
        i += 1;
    }
    let url = url.ok_or_else(|| "コマンドに url（http:// か https://）が見つからない".to_string())?;
    Ok(ParsedConnect { url: checked_url(url)?, token })
}

/// Read a pasted connection snippet (either format) into the URL and token.
pub fn parse_connect(text: &str) -> Result<ParsedConnect, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("接続設定が空".to_string());
    }
    if t.starts_with('{') {
        return parse_json(t);
    }
    let first = t.split_whitespace().next().unwrap_or("");
    if first == "claude" || t.contains("mcp add") {
        return parse_claude_command(t);
    }
    Err("mcp.json 形式（{ \"mcpServers\": ... }）か claude mcp add コマンドを貼る".to_string())
}

/// Snippets for the given draft values (port / bind / token), with this host's outbound address
/// for wildcard binds.
#[tauri::command]
pub fn center_connect_snippets(bind: String, port: u32, token: String) -> ConnectSnippets {
    build_snippets(&bind, port, &token, outbound_ip())
}

#[tauri::command]
pub fn center_parse_connect(text: String) -> Result<ParsedConnect, String> {
    parse_connect(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCd1234EfGh5678IjKl9012MnOp3456";

    #[test]
    fn host_follows_the_bind() {
        let lan: Option<IpAddr> = Some("192.168.1.204".parse().unwrap());
        for b in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            assert_eq!(snippet_host(b, lan), "127.0.0.1", "{b}");
        }
        // wildcard: the address other hosts reach us at
        assert_eq!(snippet_host("0.0.0.0", lan), "192.168.1.204");
        assert_eq!(snippet_host("::", lan), "192.168.1.204");
        assert_eq!(snippet_host("0.0.0.0", Some("fd00::5".parse().unwrap())), "[fd00::5]");
        // wildcard with no known address: loopback is all we can say
        assert_eq!(snippet_host("0.0.0.0", None), "127.0.0.1");
        // a specific bind is used as is
        assert_eq!(snippet_host("192.168.1.5", lan), "192.168.1.5");
        assert_eq!(snippet_host("fe80::1", lan), "[fe80::1]");
        assert_eq!(snippet_host("mac204.local", lan), "mac204.local");
    }

    #[test]
    fn outbound_ip_is_never_loopback_or_unspecified() {
        if let Some(ip) = outbound_ip() {
            assert!(!ip.is_loopback() && !ip.is_unspecified(), "{ip}");
        }
    }

    #[test]
    fn mcp_json_has_url_and_bearer() {
        let url = endpoint_url("127.0.0.1", 7910, None);
        assert_eq!(url, "http://127.0.0.1:7910/mcp");
        let v: Value = serde_json::from_str(&build_mcp_json(&url, TOKEN)).unwrap();
        let e = &v["mcpServers"][SERVER_NAME];
        assert_eq!(e["type"], "http");
        assert_eq!(e["url"], url);
        assert_eq!(e["headers"]["Authorization"], format!("Bearer {TOKEN}"));
    }

    #[test]
    fn claude_command_has_url_and_quoted_header() {
        let c = build_claude_command("http://192.168.1.204:7910/mcp", TOKEN);
        assert_eq!(
            c,
            format!(
                "claude mcp add --transport http bantou-center http://192.168.1.204:7910/mcp \\\n  --header 'Authorization: Bearer {TOKEN}'"
            )
        );
    }

    #[test]
    fn snippets_change_with_the_token() {
        let a = build_snippets("0.0.0.0", 7910, "aaaaaaaaaaaaaaaa", Some("10.0.0.2".parse().unwrap()));
        let b = build_snippets("0.0.0.0", 7910, "bbbbbbbbbbbbbbbb", Some("10.0.0.2".parse().unwrap()));
        assert_eq!(a.url, "http://10.0.0.2:7910/mcp");
        assert_ne!(a.mcp_json, b.mcp_json);
        assert_ne!(a.claude_code, b.claude_code);
        assert!(b.mcp_json.contains("bbbbbbbbbbbbbbbb") && b.claude_code.contains("bbbbbbbbbbbbbbbb"));
    }

    #[test]
    fn parses_what_we_generate_in_both_formats() {
        let s = build_snippets("0.0.0.0", 7910, TOKEN, Some("192.168.1.204".parse().unwrap()));
        let want = ParsedConnect { url: "http://192.168.1.204:7910/mcp".into(), token: Some(TOKEN.into()) };
        assert_eq!(parse_connect(&s.mcp_json).unwrap(), want);
        assert_eq!(parse_connect(&s.claude_code).unwrap(), want);
    }

    #[test]
    fn json_variants() {
        let want = Some("tok-0123456789".to_string());
        // bare entry, lowercase header name, lowercase scheme
        let p = parse_connect(r#"{"type":"http","url":"http://h:1/mcp","headers":{"authorization":"bearer tok-0123456789"}}"#).unwrap();
        assert_eq!(p, ParsedConnect { url: "http://h:1/mcp".into(), token: want.clone() });
        // VS Code style `servers`
        let p = parse_connect(r#"{"servers":{"x":{"url":"http://h:1/mcp","headers":{"Authorization":"Bearer tok-0123456789"}}}}"#).unwrap();
        assert_eq!(p.token, want);
        // our server name wins over others
        let p = parse_connect(r#"{"mcpServers":{"other":{"url":"http://o:1/mcp"},"bantou-center":{"url":"http://b:1/mcp"}}}"#).unwrap();
        assert_eq!(p.url, "http://b:1/mcp");
        // no headers: no token
        assert_eq!(parse_connect(r#"{"mcpServers":{"x":{"url":"http://h:1/mcp"}}}"#).unwrap().token, None);
        // path-less url gets /mcp
        assert_eq!(parse_connect(r#"{"url":"http://mac200:7910"}"#).unwrap().url, "http://mac200:7910/mcp");
    }

    #[test]
    fn command_variants() {
        // single line, double quotes, --header=, and -H
        let p = parse_connect(r#"claude mcp add --transport http c http://h:1/mcp --header "Authorization: Bearer tokentoken123""#).unwrap();
        assert_eq!(p, ParsedConnect { url: "http://h:1/mcp".into(), token: Some("tokentoken123".into()) });
        let p = parse_connect("claude mcp add -t http c http://h:1/mcp --header='Authorization: Bearer tokentoken123'").unwrap();
        assert_eq!(p.token.as_deref(), Some("tokentoken123"));
        let p = parse_connect("claude mcp add --transport http c http://h:1/mcp -H 'authorization: Bearer tokentoken123'").unwrap();
        assert_eq!(p.token.as_deref(), Some("tokentoken123"));
        // other headers are ignored; no Authorization means no token
        let p = parse_connect("claude mcp add --transport http c http://h:1 --header 'X-A: b'").unwrap();
        assert_eq!(p, ParsedConnect { url: "http://h:1/mcp".into(), token: None });
        // a token with a single quote survives the '\'' escape
        let s = build_claude_command("http://h:1/mcp", "ab'cd");
        assert_eq!(parse_connect(&s).unwrap().token.as_deref(), Some("ab'cd"));
    }

    #[test]
    fn broken_input_gives_a_readable_error() {
        let err = |t: &str| parse_connect(t).unwrap_err();
        assert!(err("").contains("空"));
        assert!(err("hello world").contains("貼る"));
        assert!(err("{ not json").contains("JSON"));
        assert!(err("{}").contains("url を持つ"));
        assert!(err(r#"{"mcpServers":{"x":{"command":"npx"}}}"#).contains("url を持つ"));
        assert!(err(r#"{"url":42}"#).contains("文字列"));
        assert!(err(r#"{"url":"ftp://h/mcp"}"#).contains("http"));
        assert!(err(r#"{"url":"not a url"}"#).contains("url"));
        assert!(err(r#"{"url":"http://h:1/mcp","headers":{"Authorization":"Basic abc"}}"#).contains("Bearer"));
        assert!(err("claude mcp add --transport http c").contains("url"));
        assert!(err("claude mcp add --header 'Authorization: Bearer x").contains("閉じていない"));
        assert!(err("claude mcp add c http://h:1/mcp --header").contains("値が無い"));
    }

    #[test]
    fn shell_split_handles_quotes_and_continuations() {
        assert_eq!(
            shell_split("a 'b c' \"d \\\"e\\\"\" f\\ g \\\n h").unwrap(),
            ["a", "b c", "d \"e\"", "f g", "h"]
        );
        assert_eq!(shell_split("''").unwrap(), [""]);
    }
}
