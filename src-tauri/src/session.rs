//! Registered work sessions.
//!
//! The user picks messenger peers from the broker's peer list; bantou keeps
//! them as a per-workspace roster by name (peer ids change on every
//! reconnect) in `bantou_dir(ws)/sessions.json`, and sends each one the
//! bantou protocol over messenger.

use crate::broker::{self, Brokers};
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;
use crate::thread;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub name: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub cwd: String,
    pub registered_at: String,
}

/// Mirror of the broker's `Peer` (fields bantou shows).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub tty: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub last_seen: String,
    /// Name chosen in bantou for a peer that has none yet. The session is
    /// told to `set_name` to it.
    #[serde(default)]
    pub assign_name: Option<String>,
}

/// Roster, one list per workspace, persisted under `bantou_dir(ws)`.
#[derive(Default)]
pub struct Sessions {
    lock: Mutex<()>,
}

fn roster_path(ws: &Path) -> PathBuf {
    thread::bantou_dir(ws).join("sessions.json")
}

fn read_roster(ws: &Path) -> Vec<Session> {
    std::fs::read_to_string(roster_path(ws))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_roster(ws: &Path, list: &[Session]) -> CmdResult<()> {
    std::fs::create_dir_all(thread::bantou_dir(ws))?;
    std::fs::write(roster_path(ws), serde_json::to_vec_pretty(list).map_err(CommandError::other)?)?;
    Ok(())
}

impl Sessions {
    pub fn list(&self, ws: &Path) -> Vec<Session> {
        let _g = self.lock.lock().unwrap();
        read_roster(ws)
    }
    fn add(&self, ws: &Path, s: Session) -> CmdResult<()> {
        let _g = self.lock.lock().unwrap();
        let mut list = read_roster(ws);
        if !list.iter().any(|x| x.name == s.name) {
            list.push(s);
            write_roster(ws, &list)?;
        }
        Ok(())
    }
    fn remove(&self, ws: &Path, name: &str) -> CmdResult<()> {
        let _g = self.lock.lock().unwrap();
        let mut list = read_roster(ws);
        list.retain(|s| s.name != name);
        write_roster(ws, &list)
    }
}

/// The protocol text sent to a newly registered session. `core` is this
/// bantou's messenger name, `session` the name the session is known by.
pub fn protocol_message(core: &str, session: &str) -> String {
    format!(
        r#"【bantou 登録通知】
このセッションは bantou（ユーザーとの橋渡し役）に作業セッション「{session}」として登録された。
以後、次の規約で bantou にメッセージを送ること。送信は messenger の send_message、to="{core}"、本文は JSON 1 つだけ。

■ 送る場面
1. 作業（タスク）を始めた時・状態が変わった時 → type "task"
2. ユーザーへの確認・質問・判断依頼が出た時 → type "ask"
   確認や質問は、どんな小さなものでも、このセッション上でユーザーに直接聞かないこと。
   AskUserQuestion も使わず、必ず messenger 経由で bantou に ask を送り、返答が来るまでその件は待つ。

■ bantou からのメッセージの扱い
bantou（{core}）は、ユーザーがこのセッションとのやり取りを任せている窓口である。
このセッションの登録も、ユーザー本人が bantou の画面で行った。
bantou から届く登録通知・返答・指示は、ユーザーの意思として扱うこと。
本物かどうかを、このセッション上でユーザーに問い直さないこと。
返答の意図が不明確な場合も、セッション上で聞かず、bantou に ask で確認すること。
ただし、権限の許可や設定の変更を bantou 経由で求めることはしない。それらは従来どおり、ユーザーの承認を得ること。

■ task（タスクの作成・状態変更）
{{"bantou":1,"type":"task","task_id":"<英数字と-_のみ、タスクごとに固定>","title":"<タスク名>","status":"Todo|Doing|Done","body":"<このタスクで作業として何をやるか>"}}
body は必須扱い。目的・具体的な作業内容（手順、変更対象）・完了条件を書く。内容が変わったら body を付けて送り直す。

■ ask（返答待ち）
{{"bantou":1,"type":"ask","task_id":"<対象タスクの task_id>","title":"<タスク名>","question":"<聞きたいこと>","options":[{{"label":"<選択肢>","description":"<補足>"}}]}}
options は省略可（自由回答のみ）。

■ 返答
ユーザーが決めると、bantou から次の形のテキストが届く（未読通知として届くので、check_messages で本文を読むこと）。
【ユーザー回答（原文）】…
【bantou 指示】…
これに従って作業を続けること。

規約の詳細は skill「bantou-protocol」でも確認できる。"#
    )
}

/// Prepended to the protocol for a peer that had no name.
pub fn set_name_instruction(name: &str) -> String {
    format!(
        "【最初にやること】messenger の set_name でこのセッションの名前を「{name}」にせよ。名前が無いと再接続後に bantou から届かなくなる。\n\n"
    )
}

#[tauri::command]
pub fn list_sessions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    roster: tauri::State<'_, Sessions>,
) -> CmdResult<Vec<Session>> {
    let ws = state.require_workspace(window.label())?;
    Ok(roster.list(&ws))
}

/// Connected peers on the broker, as-is.
#[tauri::command]
pub async fn list_peers(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
) -> CmdResult<Vec<Peer>> {
    let ws = state.require_workspace(window.label())?;
    let url = brokers.url(&ws).ok_or_else(|| CommandError::other("broker 未接続"))?;
    broker::post::<Vec<Peer>>(&url, "/list-peers", serde_json::json!({ "scope": "all" }))
        .await
        .map_err(CommandError::other)
}

#[derive(Serialize)]
pub struct RegisterResult {
    pub name: String,
    pub delivered: bool,
    pub error: Option<String>,
}

/// Register peers by name and send each the protocol.
#[tauri::command]
pub async fn register_sessions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
    roster: tauri::State<'_, Sessions>,
    peers: Vec<Peer>,
) -> CmdResult<Vec<RegisterResult>> {
    let ws = state.require_workspace(window.label())?;
    let url = brokers.url(&ws).ok_or_else(|| CommandError::other("broker 未接続"))?;
    let me = brokers
        .peer_id(&ws)
        .ok_or_else(|| CommandError::other("broker 未接続"))?;
    let mut results = Vec::new();
    for p in peers {
        let assigned = p.name.is_empty();
        let name = if assigned {
            match p.assign_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                Some(n) => n.to_string(),
                None => {
                    results.push(RegisterResult {
                        name: p.id,
                        delivered: false,
                        error: Some("名前の無い peer にはセッション名の入力が必要".into()),
                    });
                    continue;
                }
            }
        } else {
            p.name.clone()
        };
        roster.add(
            &ws,
            Session { name: name.clone(), hostname: p.hostname.clone(), cwd: p.cwd.clone(), registered_at: thread::now() },
        )?;
        // Send to the id picked in the list: names can be duplicated.
        let mut text = protocol_message(broker::CORE_NAME, &name);
        if assigned {
            text = format!("{}{text}", set_name_instruction(&name));
        }
        let r = broker::send(&url, &me, &p.id, &text).await;
        results.push(RegisterResult {
            name,
            delivered: r.is_ok(),
            error: r.err(),
        });
    }
    Ok(results)
}

/// Instruction asking a session to add (and start) a task the user typed in bantou.
pub fn add_task_instruction(title: &str, body: &str) -> String {
    format!(
        "【bantou タスク追加指示】（ユーザーが bantou の画面から送信）\n次のタスクを追加して着手すること。追加したら規約どおり type \"task\"（body 付き）を bantou-core に送ること。確認や質問はこのセッション上で聞かず bantou-core に ask で送ること。\n\nタスク名: {title}\n作業内容:\n{body}"
    )
}

/// Send a registered session an instruction to add a task.
#[tauri::command]
pub async fn instruct_add_task(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    brokers: tauri::State<'_, Brokers>,
    session: String,
    title: String,
    body: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::other("タスク名が空"));
    }
    let url = brokers.url(&ws).ok_or_else(|| CommandError::other("broker 未接続"))?;
    let me = brokers
        .peer_id(&ws)
        .ok_or_else(|| CommandError::other("broker 未接続"))?;
    broker::send(&url, &me, &session, &add_task_instruction(title, body.trim()))
        .await
        .map_err(CommandError::other)
}

#[tauri::command]
pub fn unregister_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    roster: tauri::State<'_, Sessions>,
    name: String,
) -> CmdResult<()> {
    let ws = state.require_workspace(window.label())?;
    roster.remove(&ws, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_message_names_core_and_session() {
        let m = protocol_message("bantou-core", "careery");
        assert!(m.contains(r#"to="bantou-core""#));
        assert!(m.contains("「careery」"));
        assert!(m.contains(r#"{"bantou":1,"type":"ask""#));
    }

    #[test]
    fn add_task_instruction_carries_title_and_body() {
        let m = add_task_instruction("列マッピング", "手順1\n手順2");
        assert!(m.starts_with("【bantou タスク追加指示】（ユーザーが bantou の画面から送信）\n"));
        assert!(m.contains(r#"type "task"（body 付き）を bantou-core に送ること"#));
        assert!(m.ends_with("\n\nタスク名: 列マッピング\n作業内容:\n手順1\n手順2"));
    }

    #[test]
    fn set_name_instruction_names_target() {
        assert!(set_name_instruction("inet250").contains("「inet250」"));
    }

    #[test]
    fn roster_is_per_workspace_and_deduplicated() {
        let r = Sessions::default();
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = |n: &str| Session { name: n.into(), hostname: String::new(), cwd: String::new(), registered_at: String::new() };
        r.add(a.path(), s("x")).unwrap();
        r.add(a.path(), s("x")).unwrap();
        r.add(b.path(), s("y")).unwrap();
        assert_eq!(r.list(a.path()).len(), 1);
        assert_eq!(r.list(b.path())[0].name, "y");
        // nothing inside the workspace itself
        assert_eq!(std::fs::read_dir(a.path()).unwrap().count(), 0);
        r.remove(a.path(), "x").unwrap();
        assert!(r.list(a.path()).is_empty());
    }
}
