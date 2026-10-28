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

const WILDCARD_BINDS: [&str; 3] = ["", "0.0.0.0", "::"];
const LOOPBACK_BINDS: [&str; 4] = ["127.0.0.1", "::1", "[::1]", "localhost"];

/// Hosts a snippet can name, and whether the bind leaves any choice.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostChoices {
    /// Bare addresses (IPv6 without brackets). The first one is the default.
    pub hosts: Vec<String>,
    /// True when the bind pins the host (loopback or one specific address): `hosts` has one entry.
    pub fixed: bool,
}

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

/// Hosts the snippets may name for `bind`. Loopback binds pin `127.0.0.1`. `0.0.0.0` offers the
/// IPv4 addresses (an IPv6 address would not reach an IPv4-only listener); `::` and an empty bind
/// offer all. Any other bind is the address itself.
pub fn host_choices(bind: &str, ips: &[IpAddr]) -> HostChoices {
    let bind = bind.trim();
    if LOOPBACK_BINDS.contains(&bind) {
        return HostChoices { hosts: vec!["127.0.0.1".to_string()], fixed: true };
    }
    if WILDCARD_BINDS.contains(&bind) {
        let hosts = order_ips(ips)
            .into_iter()
            .filter(|ip| bind != "0.0.0.0" || ip.is_ipv4())
            .map(|ip| ip.to_string())
            .collect();
        return HostChoices { hosts, fixed: false };
    }
    HostChoices { hosts: vec![bare(bind).to_string()], fixed: true }
}

/// The saved choice when it is still offered, else the first entry.
pub fn resolve_host(choices: &HostChoices, selected: &str) -> String {
    let selected = bare(selected.trim());
    if choices.hosts.iter().any(|h| h == selected) {
        selected.to_string()
    } else {
        choices.hosts.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string())
    }
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

/// Addresses of this machine the snippets can name for the draft bind.
#[tauri::command]
pub fn center_connect_hosts(bind: String) -> HostChoices {
    host_choices(&bind, &local_ips())
}

/// Snippets for the given draft values (bind / port / token / chosen host). A `host` that is
/// unset or no longer offered gives the first entry.
#[tauri::command]
pub fn center_connect_snippets(bind: String, port: u32, token: String, host: Option<String>) -> ConnectSnippets {
    let choices = host_choices(&bind, &local_ips());
    build_snippets(&resolve_host(&choices, host.as_deref().unwrap_or("")), port, &token)
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

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
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
    fn loopback_bind_pins_127() {
        let all = ips(&["192.168.1.204", "fd7a::5"]);
        for b in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            assert_eq!(host_choices(b, &all), HostChoices { hosts: strs(&["127.0.0.1"]), fixed: true }, "{b}");
        }
    }

    #[test]
    fn wildcard_bind_offers_the_addresses() {
        let all = ips(&["fd7a::5", "192.168.1.204", "fe80::2"]);
        // IPv4-only listener: no IPv6 offered
        assert_eq!(
            host_choices("0.0.0.0", &all),
            HostChoices { hosts: strs(&["192.168.1.204", "127.0.0.1"]), fixed: false }
        );
        for b in ["::", ""] {
            assert_eq!(
                host_choices(b, &all),
                HostChoices { hosts: strs(&["192.168.1.204", "127.0.0.1", "fd7a::5"]), fixed: false },
                "{b:?}"
            );
        }
    }

    #[test]
    fn specific_bind_pins_that_address() {
        let all = ips(&["192.168.1.204"]);
        assert_eq!(host_choices("192.168.1.5", &all), HostChoices { hosts: strs(&["192.168.1.5"]), fixed: true });
        assert_eq!(host_choices("fd7a::5", &all), HostChoices { hosts: strs(&["fd7a::5"]), fixed: true });
        assert_eq!(host_choices("[fd7a::5]", &all), HostChoices { hosts: strs(&["fd7a::5"]), fixed: true });
        assert_eq!(host_choices("mac204.local", &all), HostChoices { hosts: strs(&["mac204.local"]), fixed: true });
    }

    #[test]
    fn resolve_keeps_a_saved_host_that_is_still_offered() {
        let c = host_choices("0.0.0.0", &ips(&["192.168.1.204", "100.64.0.9"]));
        assert_eq!(resolve_host(&c, "100.64.0.9"), "100.64.0.9");
        assert_eq!(resolve_host(&c, "127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn resolve_falls_back_to_the_first_when_unset_or_gone() {
        let c = host_choices("0.0.0.0", &ips(&["192.168.1.204", "100.64.0.9"]));
        assert_eq!(resolve_host(&c, ""), "192.168.1.204");
        assert_eq!(resolve_host(&c, "10.9.9.9"), "192.168.1.204");
        // a saved IPv6 is gone once the bind is IPv4-only
        assert_eq!(resolve_host(&c, "fd7a::5"), "192.168.1.204");
        // a pinned bind ignores the saved host
        let pinned = host_choices("127.0.0.1", &[]);
        assert_eq!(resolve_host(&pinned, "192.168.1.204"), "127.0.0.1");
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
