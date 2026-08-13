use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
struct SpawnRequest {
    id: u64,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRequest {
    Spawn(SpawnRequest),
    Cancel { cancel: u64 },
}

struct LiveProc {
    pid: u32,
    cancelled: AtomicBool,
}

fn emit(value: &serde_json::Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut killer = Command::new("taskkill");
        killer
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        killer.creation_flags(CREATE_NO_WINDOW);
        let _ = killer.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
}

fn pump_pipe(id: u64, kind: &str, mut pipe: impl Read) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                emit(&json!({ "id": id, "event": kind, "text": text }));
            }
            Err(_) => break,
        }
    }
}

fn run_spawn(req: SpawnRequest, live: Arc<Mutex<HashMap<u64, Arc<LiveProc>>>>) {
    let id = req.id;
    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = req.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &req.env {
        cmd.env_clear();
        cmd.envs(env);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            emit(&json!({
                "id": id,
                "event": "error",
                "message": err.to_string(),
                "code": err.raw_os_error().map(|code| code.to_string()),
            }));
            return;
        }
    };
    let pid = child.id();
    let handle = Arc::new(LiveProc {
        pid,
        cancelled: AtomicBool::new(false),
    });
    if let Ok(mut map) = live.lock() {
        map.insert(id, Arc::clone(&handle));
    }
    emit(&json!({ "id": id, "event": "spawned", "pid": pid }));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_thread = stdout.map(|pipe| thread::spawn(move || pump_pipe(id, "stdout", pipe)));
    let err_thread = stderr.map(|pipe| thread::spawn(move || pump_pipe(id, "stderr", pipe)));

    if handle.cancelled.load(Ordering::Relaxed) {
        kill_tree(pid);
        let _ = child.kill();
    }
    let status = child.wait();
    if let Some(thread) = out_thread {
        let _ = thread.join();
    }
    if let Some(thread) = err_thread {
        let _ = thread.join();
    }
    if let Ok(mut map) = live.lock() {
        map.remove(&id);
    }
    match status {
        Ok(status) => emit(&json!({
            "id": id,
            "event": "exit",
            "code": status.code(),
            "signal": Option::<String>::None,
        })),
        Err(err) => emit(&json!({
            "id": id,
            "event": "error",
            "message": err.to_string(),
        })),
    }
}

fn main() {
    emit(&json!({ "ready": true }));
    let live: Arc<Mutex<HashMap<u64, Arc<LiveProc>>>> = Arc::new(Mutex::new(HashMap::new()));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::Cancel { cancel }) => {
                if let Some(handle) = live.lock().ok().and_then(|map| map.get(&cancel).cloned()) {
                    handle.cancelled.store(true, Ordering::Relaxed);
                    kill_tree(handle.pid);
                }
            }
            Ok(WireRequest::Spawn(req)) => {
                let live = Arc::clone(&live);
                thread::spawn(move || run_spawn(req, live));
            }
            Err(err) => emit(&json!({ "id": 0, "event": "error", "message": format!("bad request: {err}") })),
        }
    }
}
