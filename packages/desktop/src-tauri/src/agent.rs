//! bantou responder: a Claude Code process started when the user opens a
//! waiting thread, stopped when the modal closes.
//!
//! `claude -p --input-format stream-json --output-format stream-json
//! --verbose` keeps one conversation open over stdin/stdout. The process
//! runs with `--strict-mcp-config` and an empty MCP config so it does NOT
//! register a second messenger peer; every broker send goes through the
//! app's own `bantou-core` peer (`broker::send`). A closed thread is
//! resumed with `--resume <session_id>`.

use crate::broker::{self, Brokers};
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use crate::task;
use crate::thread::{self, THREADS_CHANGED_EVENT};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub const AGENT_EVENT: &str = "bantou://agent";

const INSTRUCTION_OPEN: &str = "<<INSTRUCTION>>";
const INSTRUCTION_CLOSE: &str = "<</INSTRUCTION>>";

const ROLE_PROMPT: &str = r#"あなたは bantou（番頭）。ユーザーと各作業セッションの橋渡し役。
作業セッションから返答待ちの問い合わせが届いている。ユーザーの判断を助けるのが役目。
- 返答は日本語、短く。
- 補足が要る場合だけ、問い合わせの要点・判断材料・ユーザーが取るべきアクションを示す。
- ユーザーの質問・相談にはそのまま答える。作業セッションへ直接メッセージを送ってはならない（送信は bantou アプリが行う）。
- 「ユーザーが回答を決定」と伝えられたら、作業セッションへ渡す bantou 指示を <<INSTRUCTION>> と <</INSTRUCTION>> で囲んで1回だけ出力する。ユーザー回答の原文はアプリが別途添えるので、指示には繰り返さなくてよい。"#;

pub(crate) enum Cmd {
    Line(String),
    Stop,
}

#[derive(Default)]
pub struct Agents {
    inner: Mutex<HashMap<(PathBuf, String), mpsc::UnboundedSender<Cmd>>>,
}

impl Agents {
    fn get(&self, ws: &Path, id: &str) -> Option<mpsc::UnboundedSender<Cmd>> {
        self.inner.lock().unwrap().get(&(ws.to_path_buf(), id.to_string())).cloned()
    }
    fn insert(&self, ws: &Path, id: &str, tx: mpsc::UnboundedSender<Cmd>) {
        self.inner.lock().unwrap().insert((ws.to_path_buf(), id.to_string()), tx);
    }
    fn remove(&self, ws: &Path, id: &str) {
        self.inner.lock().unwrap().remove(&(ws.to_path_buf(), id.to_string()));
    }
}

#[derive(Clone, serde::Serialize)]
struct AgentEvent {
    workspace: String,
    task_id: String,
    /// `busy` | `idle` | `exited` | `error`
    state: String,
    message: Option<String>,
}

fn emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ws: &Path, task_id: &str, state: &str, message: Option<String>) {
    let _ = app.emit(
        AGENT_EVENT,
        AgentEvent {
            workspace: ws.to_string_lossy().into(),
            task_id: task_id.into(),
            state: state.into(),
            message,
        },
    );
}

fn user_line(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    })
    .to_string()
}

fn initial_prompt(ws: &Path, t: &thread::Thread) -> String {
    let task = task::find_task_by_id(ws, &t.task_id).ok().flatten();
    let (title, body) = task
        .map(|t| (t.title, t.body))
        .unwrap_or_else(|| (t.task_id.clone(), String::new()));
    let opts = t
        .request
        .options
        .iter()
        .enumerate()
        .map(|(i, o)| format!("{}. {} {}", i + 1, o.label, o.description))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "作業セッション「{}」から返答待ちの問い合わせが届いた。\n\n\
         # タスク: {}\n{}\n\n# 問い合わせ\n{}\n\n# 選択肢\n{}\n\n\
         補足が必要なら、要点とユーザーが取るべきアクションを短く書け。不要なら「補足なし」とだけ返せ。",
        t.request.from_name,
        title,
        body.trim(),
        t.request.question,
        if opts.is_empty() { "（なし・自由回答）".into() } else { opts },
    )
}

fn extract_instruction(text: &str) -> Option<String> {
    let start = text.find(INSTRUCTION_OPEN)? + INSTRUCTION_OPEN.len();
    let end = text[start..].find(INSTRUCTION_CLOSE)? + start;
    Some(text[start..end].trim().to_string())
}

pub fn compose_reply(answer: &str, instruction: &str) -> String {
    format!(
        "【ユーザー回答（原文）】\n{answer}\n\n【bantou 指示】\n{instruction}\n\n\
         ※ これはユーザーの回答を bantou が中継したもの。確認や質問があれば、このセッション上で聞かず、\
         messenger で bantou-core に ask を送ること。"
    )
}

async fn deliver_answer<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ws: &Path, task_id: &str, instruction: &str) {
    let th = match thread::load(ws, task_id) {
        Ok(Some(t)) => t,
        _ => return,
    };
    let answer = th.answer.clone().unwrap_or_default();
    let text = compose_reply(&answer, instruction);
    let brokers = app.state::<Brokers>();
    let result = match (brokers.peer_id(ws), brokers.url(ws)) {
        (Some(id), Some(url)) => broker::send(&url, &id, &th.request.from_name, &text).await,
        _ => Err("broker 未接続".into()),
    };
    match result {
        Ok(()) => {
            let _ = thread::push(ws, task_id, "system", &format!("{} へ送信済み", th.request.from_name));
            let _ = thread::modify(ws, task_id, |t| t.status = "answered".into());
        }
        Err(e) => {
            let _ = thread::push(ws, task_id, "system", &format!("送信失敗: {e}\n送信予定内容:\n{text}"));
        }
    }
    let _ = app.emit(THREADS_CHANGED_EVENT, ws.to_string_lossy().to_string());
    // Delivery attempt done: stop the responder. Further chat from an open
    // modal respawns it with `--resume` via `ensure_agent`.
    if let Some(tx) = app.state::<Agents>().get(ws, task_id) {
        let _ = tx.send(Cmd::Stop);
    }
}

fn spawn_agent<R: tauri::Runtime>(app: tauri::AppHandle<R>, ws: PathBuf, task_id: String) -> CmdResult<mpsc::UnboundedSender<Cmd>> {
    let th = thread::load(&ws, &task_id)?
        .ok_or_else(|| CommandError::other("no thread"))?;
    let bdir = thread::bantou_dir(&ws);
    std::fs::create_dir_all(&bdir)?;
    let mcp = bdir.join("empty-mcp.json");
    if !mcp.exists() {
        std::fs::write(&mcp, "{\"mcpServers\":{}}\n")?;
    }
    let mut cmd = tokio::process::Command::new(claude_bin());
    cmd.arg("-p")
        .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg(&mcp)
        .args(["--append-system-prompt", ROLE_PROMPT])
        .args(["--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"])
        .current_dir(&ws)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(sid) = &th.agent_session_id {
        cmd.args(["--resume", sid]);
    }
    let mut child = cmd.spawn().map_err(|e| CommandError::other(format!("claude 起動失敗: {e}")))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();

    // Fresh thread with no bantou comment yet → ask for the supplement.
    let has_comment = th.timeline.iter().any(|e| e.role == "bantou");
    if !has_comment {
        let _ = tx.send(Cmd::Line(user_line(&initial_prompt(&ws, &th))));
    }

    let (app_w, ws_w, id_w) = (app.clone(), ws.clone(), task_id.clone());
    tauri::async_runtime::spawn(async move {
        while let Some(c) = rx.recv().await {
            match c {
                Cmd::Line(l) => {
                    emit(&app_w, &ws_w, &id_w, "busy", None);
                    if stdin.write_all(format!("{l}\n").as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
                Cmd::Stop => break,
            }
        }
        drop(stdin);
        let _ = child.kill().await;
        app_w.state::<Agents>().remove(&ws_w, &id_w);
        emit(&app_w, &ws_w, &id_w, "exited", None);
    });

    let (app_r, ws_r, id_r) = (app.clone(), ws.clone(), task_id.clone());
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("system") if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        let sid = sid.to_string();
                        let _ = thread::modify(&ws_r, &id_r, |t| t.agent_session_id = Some(sid));
                    }
                }
                Some("assistant") => {
                    let text: String = v["message"]["content"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter(|b| b["type"] == "text")
                                .filter_map(|b| b["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("")
                        })
                        .unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    let shown = text.replace(INSTRUCTION_OPEN, "【作業セッションへの指示】").replace(INSTRUCTION_CLOSE, "");
                    let _ = thread::push(&ws_r, &id_r, "bantou", shown.trim());
                    let _ = app_r.emit(THREADS_CHANGED_EVENT, ws_r.to_string_lossy().to_string());
                    if let Some(instr) = extract_instruction(&text) {
                        deliver_answer(&app_r, &ws_r, &id_r, &instr).await;
                    }
                }
                Some("result") => emit(&app_r, &ws_r, &id_r, "idle", None),
                _ => {}
            }
        }
    });

    Ok(tx)
}

fn claude_bin() -> String {
    if let Ok(p) = std::env::var("BANTOU_CLAUDE_BIN") {
        return p;
    }
    // GUI apps on macOS do not inherit the shell PATH; try common locations.
    let home = std::env::var("HOME").unwrap_or_default();
    for c in [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
    ] {
        if Path::new(&c).exists() {
            return c;
        }
    }
    "claude".into()
}

pub(crate) fn ensure_agent<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Path,
    task_id: &str,
) -> CmdResult<mpsc::UnboundedSender<Cmd>> {
    let agents = app.state::<Agents>();
    if let Some(tx) = agents.get(ws, task_id) {
        return Ok(tx);
    }
    let tx = spawn_agent(app.clone(), ws.to_path_buf(), task_id.to_string())?;
    agents.insert(ws, task_id, tx.clone());
    Ok(tx)
}

/// Modal opened: start (or resume) the responder.
#[tauri::command]
pub async fn agent_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    ensure_agent(&app, &ws, &task_id).map(|_| ())
}

/// Modal closed without an answer: stop the process, keep the session id.
#[tauri::command]
pub fn agent_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    // An answer already handed to the responder but not yet delivered must
    // not be lost by closing the modal: keep the process alive until
    // `deliver_answer` stops it.
    let pending = thread::load(&ws, &task_id)?
        .map(|t| t.answer.is_some() && t.status == "waiting")
        .unwrap_or(false);
    if pending {
        return Ok(());
    }
    if let Some(tx) = app.state::<Agents>().get(&ws, &task_id) {
        let _ = tx.send(Cmd::Stop);
    }
    Ok(())
}

/// User chat message to bantou (consultation, not the final answer).
#[tauri::command]
pub async fn agent_say(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    task_id: String,
    text: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    say(&app, &ws, &task_id, &text)
}

pub(crate) fn say<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ws: &Path, task_id: &str, text: &str) -> CmdResult<()> {
    thread::push(ws, task_id, "user", text)?;
    let _ = app.emit(THREADS_CHANGED_EVENT, ws.to_string_lossy().to_string());
    let tx = ensure_agent(app, ws, task_id)?;
    tx.send(Cmd::Line(user_line(text))).map_err(|_| CommandError::other("agent stopped"))
}

/// User decided: an option label or free text.
#[tauri::command]
pub async fn agent_answer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    task_id: String,
    answer: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    answer_impl(&app, &ws, &task_id, &answer)
}

pub(crate) fn answer_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Path,
    task_id: &str,
    answer: &str,
) -> CmdResult<()> {
    thread::modify(ws, task_id, |t| t.answer = Some(answer.to_string()))?;
    thread::push(ws, task_id, "user", &format!("【回答】{answer}"))?;
    let _ = app.emit(THREADS_CHANGED_EVENT, ws.to_string_lossy().to_string());
    let tx = ensure_agent(app, ws, task_id)?;
    let prompt = format!(
        "ユーザーが回答を決定: {answer}\n作業セッションへ渡す bantou 指示を {INSTRUCTION_OPEN} と {INSTRUCTION_CLOSE} で囲んで出力せよ。"
    );
    tx.send(Cmd::Line(user_line(&prompt))).map_err(|_| CommandError::other("agent stopped"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_instruction_block() {
        let t = "前置き\n<<INSTRUCTION>>\nA 案で進めよ\n<</INSTRUCTION>>\n後書き";
        assert_eq!(extract_instruction(t).as_deref(), Some("A 案で進めよ"));
        assert_eq!(extract_instruction("none"), None);
    }

    #[test]
    fn reply_contains_raw_answer_and_instruction() {
        let r = compose_reply("B で", "B 案で実装を続行");
        assert!(r.contains("B で") && r.contains("B 案で実装を続行"));
        assert!(r.contains("bantou-core に ask"));
    }

    /// Live responder run with the real `claude` CLI (costs one short
    /// conversation). `cargo test -- --ignored live_responder`.
    #[test]
    #[ignore]
    fn live_responder_supplement_and_answer() {
        use crate::thread::{Request, Thread, TimelineEntry};
        let d = tempfile::tempdir().unwrap();
        let ws = d.path().to_path_buf();
        crate::task::create_task_file(&ws, "Live task", "Doing", &["sess".into()], Some("t-live"), "body")
            .unwrap();
        thread::save(
            &ws,
            &Thread {
                task_id: "t-live".into(),
                status: "waiting".into(),
                request: Request {
                    from_name: "sess".into(),
                    from_id: String::new(),
                    question: "A と B どちらで進めるか".into(),
                    options: vec![],
                    received_at: thread::now(),
                },
                timeline: vec![TimelineEntry { role: "session".into(), text: "A と B どちらで進めるか".into(), at: thread::now() }],
                agent_session_id: None,
                answer: None,
            },
        )
        .unwrap();
        let app = tauri::test::mock_app();
        app.manage(Agents::default());
        app.manage(Brokers::default());
        let handle = app.handle().clone();
        let wait = |pred: &dyn Fn(&thread::Thread) -> bool| {
            for _ in 0..120 {
                let t = thread::load(&ws, "t-live").unwrap().unwrap();
                if pred(&t) {
                    return t;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            panic!("timeout: {:?}", thread::load(&ws, "t-live").unwrap().unwrap().timeline);
        };
        tauri::async_runtime::block_on(async { ensure_agent(&handle, &ws, "t-live").map(|_| ()) }).unwrap();
        let t = wait(&|t| t.timeline.iter().any(|e| e.role == "bantou"));
        assert!(t.agent_session_id.is_some());
        // Answer; broker is not connected, so delivery must fail visibly and
        // keep the composed text in the timeline.
        thread::modify(&ws, "t-live", |t| t.answer = Some("A".into())).unwrap();
        let tx = handle.state::<Agents>().get(&ws, "t-live").unwrap();
        tx.send(Cmd::Line(user_line(&format!(
            "ユーザーが回答を決定: A\n作業セッションへ渡す bantou 指示を {INSTRUCTION_OPEN} と {INSTRUCTION_CLOSE} で囲んで出力せよ。"
        ))))
        .unwrap();
        let t = wait(&|t| t.timeline.iter().any(|e| e.role == "system"));
        let sys = t.timeline.iter().find(|e| e.role == "system").unwrap();
        assert!(sys.text.contains("送信失敗"), "{}", sys.text);
        assert!(sys.text.contains("【ユーザー回答（原文）】\nA"), "{}", sys.text);
        let _ = tx.send(Cmd::Stop);
    }
}
