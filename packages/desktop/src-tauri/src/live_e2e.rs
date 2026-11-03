//! Full-path check with a real broker and the real `claude` CLI:
//! work session --ask--> broker --> bantou poller --> thread
//! --> responder supplement --> user chat --> user answer
//! --> bantou --reply--> broker --> work session.
//!
//! `BANTOU_TEST_BROKER=http://127.0.0.1:7911 cargo test -- --ignored live_full_path --nocapture`

use crate::agent::{self, Agents};
use crate::broker::{self, BrokerConfig, Brokers, PollResponse};
use crate::thread;
use std::time::Duration;
use tauri::Manager;

fn wait<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    for _ in 0..secs {
        if let Some(v) = f() {
            return v;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    panic!("timeout waiting for {what}");
}

#[test]
#[ignore]
fn live_full_path() {
    let url = std::env::var("BANTOU_TEST_BROKER").expect("BANTOU_TEST_BROKER");
    let d = tempfile::tempdir().unwrap();
    let ws = d.path().to_path_buf();
    let tag = std::process::id();
    let core = broker::CORE_NAME.to_string();
    let session = format!("careery-e2e-{tag}");

    let app = tauri::test::mock_app();
    app.manage(Agents::default());
    app.manage(Brokers::default());
    app.manage(broker::Pings::default());
    let h = app.handle().clone();

    // bantou poller (same code path as `broker_connect`).
    broker::start_poller(h.clone(), ws.clone(), Some(url.clone()));
    wait("bantou registration", 20, || h.state::<Brokers>().peer_id(&ws));

    // Work session peer.
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let wcfg = BrokerConfig { broker_url: url.clone(), name: session.clone() };
    let worker = rt.block_on(broker::register(&wcfg, &ws, broker::peer_pid())).unwrap();
    let ask = serde_json::json!({
        "bantou": 1, "type": "ask", "task_id": "t-e2e1",
        "title": "xlsx 取込の列マッピング",
        "question": "期間列が「2019/4〜2021/3」と「2019年4月-現在」で混在。取込時どう扱うか。",
        "options": [
            {"label": "両形式をパースする", "description": "取込漏れなし"},
            {"label": "失敗行はスキップして報告", "description": "後で手直し"}
        ]
    })
    .to_string();
    let _: serde_json::Value = rt
        .block_on(broker::post(
            &url,
            "/send-message",
            serde_json::json!({"from_id": worker, "from_name": session, "to": core, "text": ask}),
        ))
        .unwrap();

    // 1. Poller stores it: task md + waiting thread.
    let th = wait("thread from broker", 30, || thread::load(&ws, "t-e2e1").ok().flatten());
    assert_eq!(th.status, "waiting");
    assert_eq!(th.request.from_name, session);
    let task = crate::task::find_task_by_id(&ws, "t-e2e1").unwrap().unwrap();
    assert_eq!(task.tags, vec![session.clone()]);
    println!("[1] task md: {}", task.path);

    // 2. Modal open → responder adds a supplement.
    tauri::async_runtime::block_on(async { agent::ensure_agent(&h, &ws, "t-e2e1").map(|_| ()) }).unwrap();
    let th = wait("bantou supplement", 180, || {
        thread::load(&ws, "t-e2e1").ok().flatten().filter(|t| t.timeline.iter().any(|e| e.role == "bantou"))
    });
    println!("[2] supplement: {}", th.timeline.iter().find(|e| e.role == "bantou").unwrap().text);

    // 3. User consults bantou.
    let before = th.timeline.iter().filter(|e| e.role == "bantou").count();
    tauri::async_runtime::block_on(async { agent::say(&h, &ws, "t-e2e1", "どっちが無難？一言で") }).unwrap();
    let th = wait("bantou chat reply", 180, || {
        thread::load(&ws, "t-e2e1")
            .ok()
            .flatten()
            .filter(|t| t.timeline.iter().filter(|e| e.role == "bantou").count() > before)
    });
    println!("[3] chat reply: {}", th.timeline.iter().rev().find(|e| e.role == "bantou").unwrap().text);

    // 4. User answers with an option → reply relayed to the work session.
    tauri::async_runtime::block_on(async { agent::answer_impl(&h, &ws, "t-e2e1", "両形式をパースする") })
        .unwrap();
    let th = wait("delivery", 180, || {
        thread::load(&ws, "t-e2e1").ok().flatten().filter(|t| t.timeline.iter().any(|e| e.role == "system"))
    });
    let sys = th.timeline.iter().rev().find(|e| e.role == "system").unwrap();
    assert!(sys.text.contains("送信済み"), "{}", sys.text);
    assert_eq!(th.status, "answered");

    let got: PollResponse = rt
        .block_on(broker::post(&url, "/poll-messages", serde_json::json!({"id": worker})))
        .unwrap();
    assert_eq!(got.messages.len(), 1, "{:?}", got.messages);
    let m = &got.messages[0];
    assert_eq!(m.from_name, core);
    assert!(m.text.contains("【ユーザー回答（原文）】\n両形式をパースする"), "{}", m.text);
    assert!(m.text.contains("【bantou 指示】"), "{}", m.text);
    println!("[4] work session received:\n{}", m.text);

    let _: serde_json::Value =
        rt.block_on(broker::post(&url, "/unregister", serde_json::json!({"id": worker}))).unwrap();
}
