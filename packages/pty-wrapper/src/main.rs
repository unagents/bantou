use std::io::{BufRead, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use bantou_pty_wrapper::proto::{decode_b64, parse_in, In, Out};
use bantou_pty_wrapper::strip::Stripper;
use bantou_pty_wrapper::utf8::Utf8Stream;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

const KILL_GRACE: Duration = Duration::from_secs(3);
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(500);

enum Ev {
    Pty(Vec<u8>),
    PtyEof,
    Line(String),
    StdinEof,
    Exit(portable_pty::ExitStatus),
}

struct Args {
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    program: Vec<String>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args { cols: 120, rows: 40, cwd: None, program: vec![] };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--" => {
                a.program = argv[i + 1..].to_vec();
                break;
            }
            "--cols" | "--rows" | "--cwd" => {
                let v = argv.get(i + 1).ok_or_else(|| format!("{} needs a value", argv[i]))?;
                match argv[i].as_str() {
                    "--cols" => a.cols = v.parse().map_err(|_| format!("bad --cols: {v}"))?,
                    "--rows" => a.rows = v.parse().map_err(|_| format!("bad --rows: {v}"))?,
                    _ => a.cwd = Some(v.clone()),
                }
                i += 2;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if a.program.is_empty() {
        return Err("usage: bantou-pty-wrapper [--cols N] [--rows N] [--cwd DIR] -- <program> [args...]".into());
    }
    Ok(a)
}

fn emit(msg: &Out) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", msg.to_line());
    let _ = out.flush();
}

/// Unix: signal the child (SIGTERM, or SIGKILL when `force`). Elsewhere: portable-pty kill.
fn terminate(pid: Option<u32>, killer: &mut Box<dyn portable_pty::ChildKiller + Send + Sync>, force: bool) {
    #[cfg(unix)]
    {
        let _ = killer;
        if let Some(pid) = pid {
            let pid = pid as i32;
            let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
            // The child is a session/process-group leader (portable-pty calls setsid): signal the group, then the pid.
            unsafe {
                libc::kill(-pid, sig);
                libc::kill(pid, sig);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, force);
        let _ = killer.kill();
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let pair = match native_pty_system().openpty(PtySize { rows: args.rows, cols: args.cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("openpty failed: {e}");
            emit(&Out::Exit { code: None, signal: None });
            std::process::exit(1);
        }
    };

    let mut cmd = CommandBuilder::new(&args.program[0]);
    cmd.args(&args.program[1..]);
    if let Some(cwd) = &args.cwd {
        cmd.cwd(cwd);
    } else if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spawn failed: {e}");
            emit(&Out::Exit { code: None, signal: None });
            std::process::exit(1);
        }
    };
    // Drop the slave so the reader sees EOF once the child side is gone.
    drop(pair.slave);

    let pid = child.process_id();
    emit(&Out::Started { pid });

    let master = pair.master;
    let mut reader = master.try_clone_reader().expect("pty reader");
    let mut writer = master.take_writer().expect("pty writer");
    let mut killer = child.clone_killer();

    let (tx, rx) = mpsc::channel::<Ev>();

    let tx_pty = tx.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx_pty.send(Ev::Pty(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx_pty.send(Ev::PtyEof);
    });

    let tx_in = tx.clone();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx_in.send(Ev::Line(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx_in.send(Ev::StdinEof);
    });

    let tx_wait = tx;
    thread::spawn(move || {
        let status = child.wait().unwrap_or_else(|_| portable_pty::ExitStatus::with_exit_code(1));
        let _ = tx_wait.send(Ev::Exit(status));
    });

    let mut utf8 = Utf8Stream::new();
    let mut strip = Stripper::new();
    let mut stop_deadline: Option<Instant> = None;
    let mut killed = false;
    let mut exit_status: Option<portable_pty::ExitStatus> = None;
    let mut drain_deadline: Option<Instant> = None;
    let mut pty_eof = false;

    let begin_stop = |stop_deadline: &mut Option<Instant>, killer: &mut Box<dyn portable_pty::ChildKiller + Send + Sync>| {
        if stop_deadline.is_none() {
            terminate(pid, killer, false);
            *stop_deadline = Some(Instant::now() + KILL_GRACE);
        }
    };

    loop {
        // Next wake-up: kill deadline (while running) or drain deadline (after exit).
        let now = Instant::now();
        let wake = match (exit_status.is_some(), stop_deadline, drain_deadline) {
            (true, _, Some(d)) => Some(d),
            (false, Some(d), _) if !killed => Some(d),
            _ => None,
        };
        let ev = match wake {
            Some(d) => rx.recv_timeout(d.saturating_duration_since(now)),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match ev {
            Ok(Ev::Pty(bytes)) => {
                emit(&Out::output(&bytes));
                let text = strip.feed(&utf8.decode(&bytes));
                if !text.is_empty() {
                    emit(&Out::Text { data: text });
                }
            }
            Ok(Ev::PtyEof) => {
                pty_eof = true;
            }
            Ok(Ev::Line(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_in(&line) {
                    Ok(In::Input { data }) => match decode_b64(&data) {
                        Ok(bytes) => {
                            if let Err(e) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                                eprintln!("pty write failed: {e}");
                            }
                        }
                        Err(e) => eprintln!("bad base64 in input: {e}"),
                    },
                    Ok(In::Resize { cols, rows }) => {
                        if let Err(e) = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
                            eprintln!("resize failed: {e}");
                        }
                    }
                    Ok(In::Stop) => {
                        if exit_status.is_none() {
                            begin_stop(&mut stop_deadline, &mut killer);
                        }
                    }
                    Err(e) => eprintln!("ignored malformed line ({e}): {line}"),
                }
            }
            Ok(Ev::StdinEof) => {
                if exit_status.is_none() {
                    begin_stop(&mut stop_deadline, &mut killer);
                }
            }
            Ok(Ev::Exit(status)) => {
                exit_status = Some(status);
                drain_deadline = Some(Instant::now() + DRAIN_AFTER_EXIT);
                if pty_eof {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if exit_status.is_some() {
                    break; // drained long enough (a grandchild may still hold the pty open)
                }
                // Grace period over: SIGKILL.
                if !killed {
                    killed = true;
                    terminate(pid, &mut killer, true);
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if exit_status.is_some() && pty_eof {
            break;
        }
    }

    let (code, signal) = match &exit_status {
        Some(s) => match s.signal() {
            Some(sig) => (None, Some(sig.to_string())),
            None => (Some(s.exit_code() as i64), None),
        },
        None => (None, None),
    };
    emit(&Out::Exit { code, signal });
}
