//! Image attachments for a center session (master-cap): the image bytes go to the center host
//! (`POST /sessions/<name>/attachments`), then the saved absolute path is typed into the session's
//! pty (` <path> `, no Enter). The webview never talks to the center: it only hands over bytes
//! (clipboard), dropped paths, or asks for the file dialog; the upload and the pty input happen here.
//!
//! The center URL / token are the ones of the MCP target (same as `terminal.rs`).

use crate::center::load_settings;
use crate::center_mcp::select_target;
use crate::error::{CmdResult, CommandError};
use crate::terminal::{clip_body, post, session_url, Terminals};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

/// One image at most 20 MB (the center refuses more).
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const TYPES_HINT: &str = "png / jpeg / gif / webp のみ";

/// What the webview shows: the paths that were typed into the pty, and one short line per refusal.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct AttachOutcome {
    pub saved: Vec<String>,
    pub errors: Vec<String>,
}

/// The center's answer to a saved image.
#[derive(Debug, Deserialize, PartialEq)]
pub struct Saved {
    pub path: String,
    pub bytes: u64,
    #[serde(rename = "type")]
    pub kind: String,
}

/// Image type from the first bytes (the declared type / extension is not trusted).
pub fn sniff_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn mb(n: usize) -> usize {
    n / 1024 / 1024
}

/// `Err(reason)` when a file of `len` bytes is too big or empty.
pub fn check_size(len: u64) -> Result<(), String> {
    if len == 0 {
        Err("空のファイル".to_string())
    } else if len > MAX_BYTES as u64 {
        Err(format!("{}MB を超えている（1 枚 {}MB まで）", mb(MAX_BYTES), mb(MAX_BYTES)))
    } else {
        Ok(())
    }
}

/// The text typed into the pty: every path with one space before and after, joined by spaces.
pub fn input_text(paths: &[String]) -> String {
    format!(" {} ", paths.join(" "))
}

/// Where the images come from.
pub enum Source {
    /// Clipboard: bytes the webview read.
    Bytes { name: String, data: Vec<u8> },
    /// Dropped / picked file.
    File(PathBuf),
}

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().to_string())
}

/// Read one source into `(display name, bytes, type)`; `Err` is the short reason shown to the user.
pub fn load(src: Source) -> Result<(String, Vec<u8>, &'static str), String> {
    let (name, data) = match src {
        Source::Bytes { name, data } => {
            check_size(data.len() as u64).map_err(|e| format!("{name}: {e}"))?;
            (name, data)
        }
        Source::File(path) => {
            let name = file_name(&path);
            let meta = std::fs::metadata(&path).map_err(|e| format!("{name}: 読めない（{e}）"))?;
            if !meta.is_file() {
                return Err(format!("{name}: ファイルではない"));
            }
            check_size(meta.len()).map_err(|e| format!("{name}: {e}"))?;
            let data = std::fs::read(&path).map_err(|e| format!("{name}: 読めない（{e}）"))?;
            (name, data)
        }
    };
    let kind = sniff_type(&data).ok_or_else(|| format!("{name}: 画像の型が違う（{TYPES_HINT}）"))?;
    Ok((name, data, kind))
}

/// The center's error text out of a response body (`{"error": "..."}`), else the clipped body.
pub fn error_reason(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or_else(|| clip_body(body))
        .chars()
        .take(200)
        .collect()
}

/// Upload one image; `Ok` is what the center saved. Nothing of the body goes to the log.
pub async fn upload(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: Option<&str>,
    data: Vec<u8>,
    kind: &str,
) -> Result<Saved, String> {
    let mut req = client.post(url.clone()).timeout(UPLOAD_TIMEOUT).header("content-type", kind).body(data);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await.map_err(|e| format!("{url} に接続できない: {e}"))?;
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&code) {
        return Err(format!("center が {code} を返した: {}", error_reason(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("center の応答が読めない: {e}"))
}

async fn run(app: &tauri::AppHandle, session: &str, sources: Vec<Source>) -> CmdResult<AttachOutcome> {
    let t = select_target(&load_settings(app)?).ok_or_else(|| CommandError::other("接続先が無い"))?;
    let url = session_url(&t.url, session, "attachments").map_err(CommandError::Other)?;
    let client = app.state::<Terminals>().client();
    let mut out = AttachOutcome::default();
    for src in sources {
        let (name, data, kind) = match load(src) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("attachment [{session}]: refused: {e}");
                out.errors.push(e);
                continue;
            }
        };
        match upload(&client, url.clone(), t.token.as_deref(), data, kind).await {
            Ok(s) => {
                log::info!("attachment [{session}]: saved {} ({} bytes, {})", s.path, s.bytes, s.kind);
                out.saved.push(s.path);
            }
            Err(e) => {
                log::warn!("attachment [{session}]: {name}: {e}");
                out.errors.push(format!("{name}: {e}"));
            }
        }
    }
    if !out.saved.is_empty() {
        let text = input_text(&out.saved);
        if let Err(e) = post(app, session, "input", json!({ "data": b64(text.as_bytes()) })).await {
            log::warn!("attachment [{session}]: paths saved but typing them failed: {e}");
            out.errors.push(format!("path は保存したが入力に書けなかった: {e}"));
        }
    }
    Ok(out)
}

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

/// Clipboard image: the webview passes the raw bytes as the request body (`x-bantou-session` header), so a 20 MB image is not turned into a JSON array.
#[tauri::command]
pub async fn session_attach_bytes(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<AttachOutcome> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(CommandError::other("画像のバイト列が無い"));
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let session = header("x-bantou-session").ok_or_else(|| CommandError::other("session が無い"))?;
    let name = "クリップボードの画像".to_string();
    run(&app, &session, vec![Source::Bytes { name, data: data.clone() }]).await
}

/// Dropped files (paths from the Tauri drag-drop event).
#[tauri::command]
pub async fn session_attach_paths(app: tauri::AppHandle, session: String, paths: Vec<String>) -> CmdResult<AttachOutcome> {
    run(&app, &session, paths.into_iter().map(|p| Source::File(PathBuf::from(p))).collect()).await
}

/// The file dialog (several files); cancel = nothing happens.
#[tauri::command]
pub async fn session_attach_pick(app: tauri::AppHandle, session: String) -> CmdResult<AttachOutcome> {
    let picked = rfd::AsyncFileDialog::new()
        .add_filter("画像", &["png", "jpg", "jpeg", "gif", "webp"])
        .pick_files()
        .await
        .unwrap_or_default();
    if picked.is_empty() {
        return Ok(AttachOutcome::default());
    }
    run(&app, &session, picked.into_iter().map(|f| Source::File(f.path().to_path_buf())).collect()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    #[test]
    fn sniffs_the_four_types_and_refuses_the_rest() {
        assert_eq!(sniff_type(PNG), Some("image/png"));
        assert_eq!(sniff_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_type(b"GIF87a.."), Some("image/gif"));
        assert_eq!(sniff_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_type(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_type(b"<svg></svg>"), None);
        assert_eq!(sniff_type(b""), None);
    }

    #[test]
    fn size_limit_is_20mb_inclusive() {
        assert!(check_size(1).is_ok());
        assert!(check_size(MAX_BYTES as u64).is_ok());
        assert!(check_size(MAX_BYTES as u64 + 1).unwrap_err().contains("20MB"));
        assert!(check_size(0).is_err());
    }

    #[test]
    fn input_text_has_one_space_before_and_after_and_no_enter() {
        assert_eq!(input_text(&["/a/1.png".into()]), " /a/1.png ");
        assert_eq!(input_text(&["/a/1.png".into(), "/a/2.jpg".into()]), " /a/1.png /a/2.jpg ");
        assert!(!input_text(&["/a".into()]).contains('\r') && !input_text(&["/a".into()]).contains('\n'));
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(" /a b ".as_bytes()), "IC9hIGIg");
    }

    #[test]
    fn attachments_url_uses_the_mcp_origin_and_encodes_the_name() {
        let u = session_url("http://mac200:7910/mcp", "a b", "attachments").unwrap();
        assert_eq!(u.as_str(), "http://mac200:7910/sessions/a%20b/attachments");
    }

    #[test]
    fn load_reads_a_file_and_refuses_bad_ones_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("a.png");
        std::fs::write(&ok, PNG).unwrap();
        let (name, data, kind) = load(Source::File(ok)).unwrap();
        assert_eq!((name.as_str(), data.len(), kind), ("a.png", PNG.len(), "image/png"));

        // the extension does not decide: a .png that is text is refused
        let fake = dir.path().join("b.png");
        std::fs::write(&fake, b"hello").unwrap();
        assert!(load(Source::File(fake)).unwrap_err().contains("画像の型が違う"));

        // too big is refused from the metadata, before reading (sparse file)
        let big = dir.path().join("big.png");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(load(Source::File(big)).unwrap_err().contains("20MB"));

        assert!(load(Source::File(dir.path().join("none.png"))).unwrap_err().contains("読めない"));
        assert!(load(Source::File(dir.path().to_path_buf())).unwrap_err().contains("ファイルではない"));
    }

    #[test]
    fn load_checks_clipboard_bytes_too() {
        assert!(load(Source::Bytes { name: "c".into(), data: PNG.to_vec() }).is_ok());
        assert!(load(Source::Bytes { name: "c".into(), data: b"nope".to_vec() }).is_err());
        assert!(load(Source::Bytes { name: "c".into(), data: vec![] }).is_err());
    }

    #[test]
    fn error_reason_takes_the_center_error_field() {
        assert_eq!(error_reason(r#"{"error":"未対応の型: text/plain"}"#), "未対応の型: text/plain");
        assert_eq!(error_reason("plain\ntext"), "plain text");
    }

    /// One-shot HTTP server: records head+body of the request, answers with `status` / `body`.
    fn serve(status: &'static str, body: String) -> (String, Arc<Mutex<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = conn.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_lowercase();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text.split("content-length: ").nth(1).and_then(|s| s.split("\r\n").next()).and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            *g.lock().unwrap() = buf;
            let head = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(body.as_bytes());
        });
        (base, got)
    }

    #[tokio::test]
    async fn upload_posts_the_bytes_with_type_and_token_and_parses_the_answer() {
        let (base, got) = serve("201 Created", r#"{"path":"/ws/m/attachments/x.png","bytes":11,"type":"image/png"}"#.to_string());
        let url = session_url(&format!("{base}/mcp"), "m", "attachments").unwrap();
        let saved = upload(&crate::terminal::http(), url, Some("tok"), PNG.to_vec(), "image/png").await.unwrap();
        assert_eq!(saved, Saved { path: "/ws/m/attachments/x.png".into(), bytes: 11, kind: "image/png".into() });
        let req = got.lock().unwrap().clone();
        let head = String::from_utf8_lossy(&req).to_lowercase();
        assert!(head.starts_with("post /sessions/m/attachments "), "{head}");
        assert!(head.contains("content-type: image/png"));
        assert!(head.contains("authorization: bearer tok"));
        assert!(req.ends_with(PNG), "body is the raw bytes");
    }

    #[tokio::test]
    async fn upload_reports_the_center_refusal_reason() {
        let (base, _) = serve("415 Unsupported Media Type", r#"{"error":"未対応の型: image/svg+xml"}"#.to_string());
        let url = session_url(&format!("{base}/mcp"), "m", "attachments").unwrap();
        let e = upload(&crate::terminal::http(), url, None, PNG.to_vec(), "image/png").await.unwrap_err();
        assert!(e.contains("415") && e.contains("未対応の型"), "{e}");
    }
}
