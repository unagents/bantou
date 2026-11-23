//! The center process: spawned as a child of this app (#15 = X) and waited for.
//!
//! The center is started the "server" way (docs/design/center-graphql-server.md #24): no `--port`, so it
//! listens on the `port` of its config (default 7910) and nowhere else, on every address (`--bind 0.0.0.0`,
//! 2.4). The config is `center-server.json` in the state dir `~/.local/share/bantou/` (#9). It is a file of its
//! own: `center.json` is the one the desktop rewrites at every start of its own center ((a)).
//!
//! Restarting is launchd's job (#16): when the center ends, the app looks at whether another center uses the
//! configured port now: yes = exit 0 (yield), no = exit 1. launchd's KeepAlive (`SuccessfulExit: false`)
//! restarts the app only after a non-zero end. The center's own end status is not used. The desktop's backoff is not copied.

use crate::log;
use std::fs::{self, OpenOptions};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::AppHandle;

/// The bundled center binary (`externalBin`, placed next to this app's executable).
const SIDECAR: &str = "bantou-center";
pub const CONFIG_NAME: &str = "center-server.json";
/// SIGTERM to SIGKILL. The center's own shutdown waits up to 5 s for its children and hard-exits after another 5 s
/// (`packages/desktop/src-tauri/src/center.rs` `STOP_GRACE` has the same reasoning), so this must outlast that.
const STOP_GRACE: Duration = Duration::from_secs(15);

/// Pid of the running center (0: none).
static PID: AtomicU32 = AtomicU32::new(0);
/// Set once this app is stopping the center on purpose (no "the center ended" exit then).
static STOPPING: AtomicBool = AtomicBool::new(false);
/// `true` once the center has been waited for.
static DONE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

/// The arguments of the center. No `--port`: the port is the config's.
pub fn center_args(config: &str) -> Vec<String> {
    ["--transport", "http", "--bind", "0.0.0.0", "--config", config].iter().map(|s| s.to_string()).collect()
}

/// The port of the center when its config has none.
const DEFAULT_PORT: u16 = 7910;

/// The `port` of the config text (default 7910 when absent, not a valid port, or the text is not JSON).
pub fn port_of(config_text: &str) -> u16 {
    serde_json::from_str::<serde_json::Value>(config_text)
        .ok()
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Whether something accepts connections on the configured port now (another center).
fn port_in_use(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    port != 0 && TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_secs(1)).is_ok()
}

/// The end status of the app after the center ended on its own: 0 when another center uses the
/// configured port now (yield, no restart), 1 otherwise (launchd restarts). The center's own end status is not used.
pub fn exit_code_after_center(port_in_use: bool) -> i32 {
    if port_in_use {
        0
    } else {
        1
    }
}

/// Spawns the center and waits for it in a thread. A failure to start ends the app with 1.
pub fn start(app: AppHandle) {
    let dir = log::state_dir();
    let config = dir.join(CONFIG_NAME);
    if let Err(e) = fs::create_dir_all(&dir) {
        log::line(&format!("state dir を作れない: {} ({e})", dir.display()));
        app.exit(1);
        return;
    }
    // A config of its own, created empty once: every setting has its default (port 7910, no key ranges).
    if !config.exists() {
        match fs::write(&config, "{}\n") {
            Ok(()) => log::line(&format!("config を作った: {}", config.display())),
            Err(e) => {
                log::line(&format!("config を作れない: {} ({e})", config.display()));
                app.exit(1);
                return;
            }
        }
    }
    let sidecar = match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(SIDECAR))) {
        Some(p) => p,
        None => {
            log::line("center の binary の場所を決められない");
            app.exit(1);
            return;
        }
    };
    // The center's own output goes to the app's log too.
    let out = OpenOptions::new().create(true).append(true).open(log::log_path());
    let (stdout, stderr) = match out.and_then(|f| f.try_clone().map(|g| (f, g))) {
        Ok((a, b)) => (Stdio::from(a), Stdio::from(b)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let mut child = match Command::new(&sidecar)
        .args(center_args(&config.to_string_lossy()))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::line(&format!("center を起動できない: {} ({e})", sidecar.display()));
            app.exit(1);
            return;
        }
    };
    PID.store(child.id(), Ordering::SeqCst);
    log::line(&format!("center を起動した: pid={} {}", child.id(), sidecar.display()));

    let waiter = app.clone();
    let config_path = config.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        PID.store(0, Ordering::SeqCst);
        *DONE.0.lock().unwrap() = true;
        DONE.1.notify_all();
        if STOPPING.load(Ordering::SeqCst) {
            return;
        }
        match status {
            Ok(s) => log::line(&format!("center が終わった: {s}")),
            Err(e) => log::line(&format!("center を待てない: {e}")),
        }
        let port = port_of(&fs::read_to_string(&config_path).unwrap_or_default());
        let in_use = port_in_use(port);
        log::line(&format!("port {port} は{}", if in_use { "別の center が使用中: 譲って終わる" } else { "空き: 終わって launchd の再起動を待つ" }));
        waiter.exit(exit_code_after_center(in_use));
    });

    // launchd stops the app with SIGTERM: stop the center first (RunEvent::Exit calls `stop`), then end.
    std::thread::spawn(move || {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) else {
            log::line("signal を受けられない");
            return;
        };
        if let Some(sig) = signals.forever().next() {
            log::line(&format!("signal {sig}: 終了する"));
            app.exit(0);
        }
    });
}

/// Stops the center (SIGTERM, then SIGKILL after `STOP_GRACE`) and returns when it is gone. Does nothing if it is not running.
pub fn stop() {
    STOPPING.store(true, Ordering::SeqCst);
    let pid = PID.load(Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    log::line(&format!("center を止める: pid={pid}"));
    // SAFETY: plain kill(2) on the pid of our own child.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let guard = DONE.0.lock().unwrap();
    let (_guard, res) = DONE.1.wait_timeout_while(guard, STOP_GRACE, |done| !*done).unwrap();
    if res.timed_out() {
        log::line("center が間に合わず SIGKILL");
        // SAFETY: as above.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn center_args_have_no_port() {
        let a = center_args("/c.json");
        assert!(!a.iter().any(|x| x == "--port"));
        assert_eq!(a, ["--transport", "http", "--bind", "0.0.0.0", "--config", "/c.json"]);
    }

    #[test]
    fn exit_code_follows_the_port_not_the_centers_end() {
        // Another center holds the port: yield (0, no restart). Free: 1 (launchd restarts).
        assert_eq!(exit_code_after_center(true), 0);
        assert_eq!(exit_code_after_center(false), 1);
    }

    #[test]
    fn port_comes_from_the_config() {
        assert_eq!(port_of("{}"), 7910);
        assert_eq!(port_of(""), 7910);
        assert_eq!(port_of(r#"{"port": 8123}"#), 8123);
        assert_eq!(port_of(r#"{"port": 70000}"#), 7910);
        assert_eq!(port_of("not json"), 7910);
    }
}
