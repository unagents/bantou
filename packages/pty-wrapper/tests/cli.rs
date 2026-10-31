use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

struct Run {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Value>,
    msgs: Vec<Value>,
}

fn spawn(extra: &[&str], program: &[&str]) -> Run {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bantou-pty-wrapper"))
        .args(extra)
        .arg("--")
        .args(program)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = line.unwrap();
            let v: Value = serde_json::from_str(&line).expect("stdout line must be JSON");
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    Run { child, stdin, rx, msgs: vec![] }
}

impl Run {
    fn send(&mut self, line: &str) {
        let s = self.stdin.as_mut().unwrap();
        writeln!(s, "{line}").unwrap();
        s.flush().unwrap();
    }

    /// Collect messages until `pred` over the accumulated list is true or timeout.
    fn wait_for(&mut self, secs: u64, pred: impl Fn(&[Value]) -> bool) {
        let end = Instant::now() + Duration::from_secs(secs);
        while !pred(&self.msgs) {
            let left = end.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(v) => self.msgs.push(v),
                Err(_) => panic!("timeout; messages so far: {:?}", self.msgs),
            }
        }
    }

    fn wait_exit(&mut self) -> Value {
        self.wait_for(10, |m| m.iter().any(|v| v["t"] == "exit"));
        // wrapper itself must quit with 0
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                assert!(st.success(), "wrapper exit status {st:?}");
                break;
            }
            assert!(Instant::now() < end, "wrapper did not quit");
            thread::sleep(Duration::from_millis(20));
        }
        self.msgs.iter().find(|v| v["t"] == "exit").unwrap().clone()
    }

    fn raw(&self) -> Vec<u8> {
        self.msgs
            .iter()
            .filter(|v| v["t"] == "output")
            .flat_map(|v| STANDARD.decode(v["data"].as_str().unwrap()).unwrap())
            .collect()
    }

    fn text(&self) -> String {
        self.msgs.iter().filter(|v| v["t"] == "text").map(|v| v["data"].as_str().unwrap()).collect()
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn b64(s: &str) -> String {
    STANDARD.encode(s)
}

#[test]
fn started_output_text_exit_code() {
    let mut r = spawn(&[], &["sh", "-c", "printf hello; exit 3"]);
    let exit = r.wait_exit();
    assert_eq!(exit["code"], 3);
    assert!(exit["signal"].is_null());
    assert_eq!(r.msgs[0]["t"], "started");
    assert!(r.msgs[0]["pid"].as_u64().unwrap() > 0);
    assert_eq!(String::from_utf8_lossy(&r.raw()), "hello");
    assert_eq!(r.text(), "hello");
    assert_eq!(r.msgs.last().unwrap()["t"], "exit");
}

#[test]
fn text_is_stripped_but_output_is_raw() {
    let mut r = spawn(&[], &["sh", "-c", "printf '\\033[31mred\\033[0m \\033]8;;http://x\\007link\\033]8;;\\007\\n'"]);
    r.wait_exit();
    let raw = String::from_utf8_lossy(&r.raw()).to_string();
    assert!(raw.contains("\x1b[31m"));
    assert_eq!(r.text(), "red link\n");
}

#[test]
fn input_echo_through_cat() {
    let mut r = spawn(&[], &["cat"]);
    r.wait_for(5, |m| m.iter().any(|v| v["t"] == "started"));
    r.send(&format!(r#"{{"t":"input","data":"{}"}}"#, b64("ping\n")));
    r.wait_for(5, |m| {
        m.iter().filter(|v| v["t"] == "text").map(|v| v["data"].as_str().unwrap()).collect::<String>().contains("ping")
    });
    r.send(r#"{"t":"stop"}"#);
    let exit = r.wait_exit();
    assert!(exit["code"].is_number() || exit["signal"].is_string());
}

#[test]
fn stdin_eof_stops_child() {
    let mut r = spawn(&[], &["sleep", "100"]);
    r.wait_for(5, |m| m.iter().any(|v| v["t"] == "started"));
    let t = Instant::now();
    drop(r.stdin.take());
    let exit = r.wait_exit();
    assert!(t.elapsed() < Duration::from_secs(8));
    assert!(exit["signal"].is_string() || exit["code"].is_number());
}

#[test]
fn stop_kills_term_ignoring_child_after_grace() {
    let mut r = spawn(&[], &["sh", "-c", "trap '' TERM; echo ready; while :; do sleep 1; done"]);
    r.wait_for(5, |m| m.iter().any(|v| v["t"] == "text" && v["data"].as_str().unwrap().contains("ready")));
    let t = Instant::now();
    r.send(r#"{"t":"stop"}"#);
    r.wait_exit();
    let el = t.elapsed();
    assert!(el >= Duration::from_secs(2), "SIGKILL should come after the grace period, got {el:?}");
    assert!(el < Duration::from_secs(8));
}

#[test]
fn resize_reflected_by_stty() {
    let mut r = spawn(&["--cols", "90", "--rows", "30"], &["sh", "-c", "stty size; read x; stty size"]);
    r.wait_for(5, |m| m.iter().any(|v| v["t"] == "text" && v["data"].as_str().unwrap().contains("30 90")));
    r.send(r#"{"t":"resize","cols":100,"rows":50}"#);
    r.send(&format!(r#"{{"t":"input","data":"{}"}}"#, b64("go\n")));
    r.wait_for(5, |m| {
        m.iter().filter(|v| v["t"] == "text").map(|v| v["data"].as_str().unwrap()).collect::<String>().contains("50 100")
    });
    r.wait_exit();
}

#[test]
fn default_size_and_malformed_lines_ignored() {
    let mut r = spawn(&[], &["sh", "-c", "read x; stty size"]);
    r.wait_for(5, |m| m.iter().any(|v| v["t"] == "started"));
    r.send("garbage");
    r.send(r#"{"t":"bogus"}"#);
    r.send(r#"{"t":"input","data":"!!notb64"}"#);
    r.send(&format!(r#"{{"t":"input","data":"{}"}}"#, b64("go\n")));
    let exit = r.wait_exit();
    assert_eq!(exit["code"], 0);
    assert!(r.text().contains("40 120"), "text: {:?}", r.text());
}

#[test]
fn cwd_option_is_applied() {
    let mut cmd_r = {
        let dir = std::env::temp_dir();
        let d = dir.to_str().unwrap().to_string();
        let mut r = spawn(&["--cwd", &d], &["sh", "-c", "pwd; echo \"tok=$BANTOU_TEST_TOKEN\""]);
        r.wait_exit();
        (r, d)
    };
    let (r, d) = &mut cmd_r;
    assert!(r.text().contains(d.trim_end_matches('/')), "text: {:?}", r.text());
}

#[test]
fn utf8_not_broken_in_text() {
    let mut r = spawn(&[], &["sh", "-c", "printf '日本語😀テスト\\n'"]);
    r.wait_exit();
    assert_eq!(r.text(), "日本語😀テスト\n");
}

#[test]
fn spawn_failure_reports_exit() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bantou-pty-wrapper"))
        .args(["--", "/nonexistent/program-xyz"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = child.wait_with_output_helper();
    assert!(out.contains(r#""t":"exit""#), "stdout: {out}");
}

trait WaitOut {
    fn wait_with_output_helper(self) -> String;
}
impl WaitOut for Child {
    fn wait_with_output_helper(self) -> String {
        let o = self.wait_with_output().unwrap();
        String::from_utf8_lossy(&o.stdout).to_string()
    }
}
