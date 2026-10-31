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
use std::net::{IpAddr, Ipv4Addr};

/// Name the snippets register the server under.
pub const SERVER_NAME: &str = "bantou-center";

/// This machine's addresses: IPv4 first (LAN etc. in interface order, then 127.0.0.1), then IPv6.
/// Unspecified, multicast, link-local IPv6 (`fe80::/10`, unusable in a URL without a zone id)
/// and `::1` are left out. Never empty: 127.0.0.1 is always there.
pub fn order_ips(ips: &[IpAddr]) -> Vec<IpAddr> {
    let usable = |ip: &&IpAddr| match ip {
        IpAddr::V4(a) => !a.is_unspecified() && !a.is_multicast() && !a.is_link_local(),
        IpAddr::V6(a) => {
            !a.is_unspecified()
                && !a.is_multicast()
                && !a.is_loopback()
                && (a.segments()[0] & 0xffc0) != 0xfe80
        }
    };
    let mut v4_lan = Vec::new();
    let mut v6 = Vec::new();
    for ip in ips.iter().filter(usable) {
        let list = match ip {
            IpAddr::V4(a) if a.is_loopback() => continue,
            IpAddr::V4(_) => &mut v4_lan,
            IpAddr::V6(_) => &mut v6,
        };
        if !list.contains(ip) {
            list.push(*ip);
        }
    }
    v4_lan.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    v4_lan.extend(v6);
    v4_lan
}

/// Every address of every NIC, ordered by `order_ips`.
pub fn local_ips() -> Vec<IpAddr> {
    let found: Vec<IpAddr> = if_addrs::get_if_addrs()
        .map(|v| v.into_iter().map(|i| i.ip()).collect())
        .unwrap_or_default();
    order_ips(&found)
}

fn bare(host: &str) -> &str {
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host)
}

/// Addresses of this machine as strings, in `order_ips` order: the choices for the connection settings' host.
pub fn local_ip_strings() -> Vec<String> {
    local_ips().iter().map(ToString::to_string).collect()
}

/// Default host for the connection settings: the first external (non-loopback) IPv4 address,
/// private (LAN) addresses before others (Tailscale etc.). Only when this machine has none,
/// `127.0.0.1`.
pub fn default_ip(ips: &[IpAddr]) -> String {
    let v4: Vec<Ipv4Addr> = order_ips(ips)
        .into_iter()
        .filter_map(|ip| match ip {
            IpAddr::V4(a) if !a.is_loopback() => Some(a),
            _ => None,
        })
        .collect();
    v4.iter()
        .find(|a| a.is_private())
        .or_else(|| v4.first())
        .map_or_else(|| Ipv4Addr::LOCALHOST.to_string(), ToString::to_string)
}

/// The saved IP checked against this machine's current addresses (settings dialog).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpStatus {
    /// This machine's addresses now (the choices).
    pub ips: Vec<String>,
    /// The saved IP; None when nothing is saved.
    pub saved: Option<String>,
    /// `default_ip`: what is used when nothing is saved, and the default of "a new IP".
    pub default_ip: String,
    /// The saved IP is not an address of this machine now. It is kept as is until the user chooses.
    pub missing: bool,
}

/// Check `saved` (the stored IP, empty = none) against `ips`. A saved value is never replaced here.
pub fn ip_status(saved: &str, ips: &[IpAddr]) -> IpStatus {
    let choices: Vec<String> = order_ips(ips).iter().map(ToString::to_string).collect();
    let saved = bare(saved.trim());
    IpStatus {
        missing: !saved.is_empty() && !choices.iter().any(|c| c == saved),
        saved: (!saved.is_empty()).then(|| saved.to_string()),
        default_ip: default_ip(ips),
        ips: choices,
    }
}

/// The IP in effect: the saved one as is (even when it is not on this machine any more), else
/// the default.
pub fn resolve_bind(saved: &str, ips: &[IpAddr]) -> String {
    let st = ip_status(saved, ips);
    st.saved.unwrap_or(st.default_ip)
}

/// Host the snippets name for `bind`: the bind itself. An empty or wildcard value names the
/// default IP.
fn snippet_host(bind: &str, ips: &[IpAddr]) -> String {
    let b = bare(bind.trim());
    if ["", "0.0.0.0", "::"].contains(&b) {
        return default_ip(ips);
    }
    b.to_string()
}

/// Host part of a URL: IPv6 literals in brackets.
fn url_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn endpoint_url(host: &str, port: u32) -> String {
    format!("http://{}:{port}/mcp", url_host(host))
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

pub fn build_snippets(host: &str, port: u32, token: &str) -> ConnectSnippets {
    let url = endpoint_url(host, port);
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

/// This machine's addresses: the choices for the host the connection settings name.
#[tauri::command]
pub fn center_local_ips() -> Vec<String> {
    local_ip_strings()
}

/// Snippets for the given draft values. The chosen IP (`bind`) is the host the snippets name; the center itself listens on all addresses.
#[tauri::command]
pub fn center_connect_snippets(bind: String, port: u32, token: String) -> ConnectSnippets {
    build_snippets(&snippet_host(&bind, &local_ips()), port, &token)
}

#[tauri::command]
pub fn center_parse_connect(text: String) -> Result<ParsedConnect, String> {
    parse_connect(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCd1234EfGh5678IjKl9012MnOp3456";

    fn ips(l: &[&str]) -> Vec<IpAddr> {
        l.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn order_puts_ipv4_first_then_loopback_then_ipv6() {
        let got = order_ips(&ips(&[
            "::1", "fe80::1", "fd7a::5", "127.0.0.1", "192.168.1.204", "100.64.0.9", "0.0.0.0", "::", "192.168.1.204", "ff02::1",
        ]));
        assert_eq!(got, ips(&["192.168.1.204", "100.64.0.9", "127.0.0.1", "fd7a::5"]));
    }

    #[test]
    fn order_always_has_loopback() {
        assert_eq!(order_ips(&[]), ips(&["127.0.0.1"]));
        assert_eq!(order_ips(&ips(&["fe80::1"])), ips(&["127.0.0.1"]));
    }

    #[test]
    fn local_ips_lists_this_host_with_loopback() {
        let got = local_ips();
        assert!(got.contains(&IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(got.iter().all(|ip| !ip.is_unspecified()));
        // IPv4 entries all come before IPv6 ones
        let first_v6 = got.iter().position(IpAddr::is_ipv6).unwrap_or(got.len());
        assert!(got[first_v6..].iter().all(IpAddr::is_ipv6));
    }

    #[test]
    fn default_ip_is_the_first_external_ipv4_lan_first() {
        // saved none -> the first external IPv4
        assert_eq!(default_ip(&ips(&["192.168.1.204", "100.64.0.9", "127.0.0.1", "fd7a::5"])), "192.168.1.204");
        // a LAN (private) address wins over an earlier non-LAN one
        assert_eq!(default_ip(&ips(&["100.64.0.9", "10.0.0.7"])), "10.0.0.7");
        // no LAN address: the first external IPv4 as is
        assert_eq!(default_ip(&ips(&["100.64.0.9", "203.0.113.5"])), "100.64.0.9");
    }

    #[test]
    fn default_ip_is_loopback_only_without_an_external_ipv4() {
        assert_eq!(default_ip(&[]), "127.0.0.1");
        assert_eq!(default_ip(&ips(&["127.0.0.1"])), "127.0.0.1");
        // IPv6 and link-local are not "external IPv4"
        assert_eq!(default_ip(&ips(&["fd7a::5", "169.254.1.1", "fe80::1"])), "127.0.0.1");
    }

    #[test]
    fn ip_status_none_saved_uses_the_default() {
        let all = ips(&["192.168.1.204", "100.64.0.9"]);
        let st = ip_status("", &all);
        assert_eq!(st.saved, None);
        assert!(!st.missing);
        assert_eq!(st.default_ip, "192.168.1.204");
        assert_eq!(st.ips, ["192.168.1.204", "100.64.0.9", "127.0.0.1"]);
        assert_eq!(resolve_bind("", &all), "192.168.1.204");
        assert_eq!(resolve_bind("  ", &[]), "127.0.0.1");
    }

    #[test]
    fn ip_status_keeps_a_saved_ip_this_machine_has() {
        let all = ips(&["192.168.1.204", "100.64.0.9", "fd7a::5"]);
        for b in ["100.64.0.9", "127.0.0.1", "fd7a::5", "[fd7a::5]"] {
            let st = ip_status(b, &all);
            assert!(!st.missing, "{b}");
            assert_eq!(resolve_bind(b, &all), b.trim_matches(|c| c == '[' || c == ']'), "{b}");
        }
    }

    #[test]
    fn ip_status_flags_a_saved_ip_not_in_the_list_and_keeps_it() {
        let all = ips(&["192.168.1.204", "100.64.0.9"]);
        for b in ["192.168.1.50", "0.0.0.0", "mac204.local", "localhost"] {
            let st = ip_status(b, &all);
            assert!(st.missing, "{b}");
            assert_eq!(st.saved.as_deref(), Some(b), "{b}");
            // not replaced by the default or by 127.0.0.1
            assert_eq!(resolve_bind(b, &all), b, "{b}");
            assert_eq!(st.default_ip, "192.168.1.204");
        }
    }

    #[test]
    fn snippet_host_is_the_bind() {
        let all = ips(&["192.168.1.204"]);
        assert_eq!(snippet_host("100.64.0.9", &all), "100.64.0.9");
        assert_eq!(snippet_host("[fd7a::5]", &all), "fd7a::5");
        assert_eq!(snippet_host("127.0.0.1", &all), "127.0.0.1");
        // an empty or wildcard value names the default IP
        assert_eq!(snippet_host("0.0.0.0", &all), "192.168.1.204");
        assert_eq!(snippet_host("", &[]), "127.0.0.1");
        assert_eq!(snippet_host("", &ips(&["100.64.0.9", "192.168.1.204"])), "192.168.1.204");
    }

    #[test]
    fn url_brackets_ipv6_only() {
        assert_eq!(endpoint_url("192.168.1.204", 7910), "http://192.168.1.204:7910/mcp");
        assert_eq!(endpoint_url("fd7a::5", 7910), "http://[fd7a::5]:7910/mcp");
        assert_eq!(endpoint_url("mac204.local", 7910), "http://mac204.local:7910/mcp");
    }

    #[test]
    fn mcp_json_has_url_and_bearer() {
        let url = endpoint_url("127.0.0.1", 7910);
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
        let a = build_snippets("10.0.0.2", 7910, "aaaaaaaaaaaaaaaa");
        let b = build_snippets("10.0.0.2", 7910, "bbbbbbbbbbbbbbbb");
        assert_eq!(a.url, "http://10.0.0.2:7910/mcp");
        assert_ne!(a.mcp_json, b.mcp_json);
        assert_ne!(a.claude_code, b.claude_code);
        assert!(b.mcp_json.contains("bbbbbbbbbbbbbbbb") && b.claude_code.contains("bbbbbbbbbbbbbbbb"));
    }

    #[test]
    fn snippets_change_with_the_host() {
        let a = build_snippets("192.168.1.204", 7910, TOKEN);
        let b = build_snippets("fd7a::5", 7910, TOKEN);
        assert_eq!(a.url, "http://192.168.1.204:7910/mcp");
        assert_eq!(b.url, "http://[fd7a::5]:7910/mcp");
        assert!(a.mcp_json.contains("192.168.1.204") && !a.mcp_json.contains("fd7a"));
        assert!(b.mcp_json.contains("[fd7a::5]") && b.claude_code.contains("http://[fd7a::5]:7910/mcp"));
        assert_eq!(parse_connect(&b.claude_code).unwrap().url, "http://[fd7a::5]:7910/mcp");
    }

    #[test]
    fn parses_what_we_generate_in_both_formats() {
        let s = build_snippets("192.168.1.204", 7910, TOKEN);
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
