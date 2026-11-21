//! The `fake` object of a payload asks for what the host does besides answering:
//!
//! - `busy_ms`: works that long before answering, without reading further input (a COM call in flight);
//! - `hang`: never answers this request;
//! - `late_identity`: announces its application (session, ownership, pid) in a message that has no `requestId`
//!   before it answers;
//! - `rpc_gone`: from then on `close_session` fails as it does when the application's RPC server is gone;
//! - `crash`: writes `stderr` and exits with code 3 at once;
//! - `stderr`: text written to stderr when the request arrives;
//! - `on_eof`: `{delay_ms, stderr, exit_code}`, kept until EOF: how the host ends when its stdin closes;
//! - `exit_code` (one-shot): the exit code;
//! - `print` (one-shot): this text is the whole stdout instead of the answer.
//!
//! The arguments it was started with (`office-com-host`, with `--session` for a session host, then `--data-dir <dir>`) are
//! reported as `argv` in a one-shot answer and in an `open_session` answer.

use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;

/// Waits without `std::thread::sleep`: a channel nothing sends on, timing out.
fn pause(millis: u64) {
    let (_keep, never) = mpsc::channel::<()>();
    let _ = never.recv_timeout(Duration::from_millis(millis));
}

fn say(line: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn complain(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{text}");
    let _ = err.flush();
}

fn argv() -> Vec<String> {
    std::env::args().skip(1).collect()
}

fn fake_u64(payload: &Value, key: &str) -> u64 {
    payload["fake"][key].as_u64().unwrap_or(0)
}

fn one_shot() {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({"unparsed": raw}));
    pause(fake_u64(&payload, "busy_ms"));
    if let Some(text) = payload["fake"]["stderr"].as_str() {
        complain(text);
    }
    match payload["fake"]["print"].as_str() {
        Some(text) => {
            let mut out = std::io::stdout().lock();
            let _ = write!(out, "{text}");
            let _ = out.flush();
        }
        None => {
            println!("some noise before the answer");
            say(&json!({"ok": true, "backend": "microsoft-office-com", "echo": payload, "argv": argv()}));
        }
    }
    let code = payload["fake"]["exit_code"].as_i64().unwrap_or(0);
    std::process::exit(i32::try_from(code).unwrap_or(1));
}

fn session() {
    let mut on_eof = Value::Null;
    let mut rpc_gone = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let request_id = request["requestId"].as_str().unwrap_or_default().to_owned();
        let session = request["session"].as_str().unwrap_or_default().to_owned();
        if request["fake"]["crash"] == json!(true) {
            complain(request["fake"]["stderr"].as_str().unwrap_or("host crashed"));
            std::process::exit(3);
        }
        if let Some(text) = request["fake"]["stderr"].as_str() {
            complain(text);
        }
        if !request["fake"]["on_eof"].is_null() {
            on_eof = request["fake"]["on_eof"].clone();
        }
        rpc_gone |= request["fake"]["rpc_gone"] == json!(true);
        pause(fake_u64(&request, "busy_ms"));
        if request["fake"]["late_identity"] == json!(true) {
            say(&json!({"session": session, "ok": true, "ownership": "owned", "ownsApplication": true, "appPid": 101}));
        }
        if request["fake"]["hang"] == json!(true) {
            continue;
        }
        let answer = match request["action"].as_str() {
            Some("open_session") => json!({
                "requestId": request_id, "ok": true, "session": session,
                "ownership": "owned", "ownsApplication": true, "appPid": 101, "lifecycle": "initializing",
                "argv": argv(),
            }),
            Some("close_session") if rpc_gone => json!({
                "requestId": request_id, "ok": false, "session": session,
                "error": "The RPC server is unavailable. (0x800706BA)",
            }),
            Some("close_session") => json!({"requestId": request_id, "ok": true, "session": session, "closed": true}),
            _ => json!({"requestId": request_id, "ok": true, "session": session, "echo": request}),
        };
        say(&answer);
    }
    // EOF: the host's own `finally`.
    pause(on_eof["delay_ms"].as_u64().unwrap_or(0));
    if let Some(text) = on_eof["stderr"].as_str() {
        complain(text);
    }
    let code = on_eof["exit_code"].as_i64().unwrap_or(0);
    std::process::exit(i32::try_from(code).unwrap_or(1));
}

fn main() {
    // The `--session` flag is followed by `--data-dir <dir>`, so it is looked for among the arguments.
    if std::env::args().any(|arg| arg == "--session") {
        session();
    } else {
        one_shot();
    }
}
