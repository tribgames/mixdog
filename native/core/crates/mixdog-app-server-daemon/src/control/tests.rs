//! Control listener over real sockets, including the stalled-runtime gate (LR §11.9–11.10).

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures use blocking std")]

use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use serde_json::json;

use super::*;
use crate::lifecycle::ActivityInfo;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::StallConfig;
use crate::lifecycle::StallMonitor;
use crate::lifecycle::StallReporter;
use crate::lifecycle::testing::Fixture;
use crate::lifecycle::testing::fixture;
use crate::lifecycle::tokio_post;

const TEXT: &str = "Update Mixdog.";

fn start(fx: &Fixture) -> (ControlServer, String) {
    let token = new_token();
    let server = ControlServer::start(
        ControlConfig {
            token: token.clone(),
            legacy: Legacy { pid: 4242, version: "1.4.6".into(), update_text: TEXT.into() },
        },
        Arc::clone(&fx.lifecycle),
    )
    .unwrap();
    (server, token)
}

fn call(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    stream.write_all(request.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let status = raw.split(' ').nth(1).unwrap().parse().unwrap();
    let json = raw.split_once("\r\n\r\n").map(|(_, b)| b).filter(|b| !b.is_empty());
    (status, json.map_or(Value::Null, |b| serde_json::from_str(b).unwrap()))
}

fn mgmt(port: u16, token: &str, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    call(port, method, path, &[("Authorization", &format!("Bearer {token}"))], body)
}

fn turn() -> ActivityInfo {
    ActivityInfo { kind: ActivityKind::Turn, thread_id: Some("t".into()), turn_id: Some("u".into()), title: "work".into() }
}

#[test]
fn legacy_clients_get_the_fixed_health_and_a_426_everywhere_else() {
    let fx = fixture();
    let (server, _) = start(&fx);
    let (status, health) = call(server.port(), "GET", "/health", &[], None);
    assert_eq!(status, 200);
    assert_eq!(health["protocol"], 1);
    assert_eq!(health["revision"], 2_147_483_647u64);
    assert_eq!(health["pid"], 4242);
    assert!(health.get("buildHash").is_none());
    assert!(health["packageVersion"].as_str().unwrap().contains(TEXT));
    for (method, path) in [("POST", "/client/register"), ("GET", "/events"), ("POST", "/upgrade"), ("POST", "/stop"), ("POST", "/install-hold"), ("POST", "/shutdown"), ("POST", "/call")] {
        let (status, body) = call(server.port(), method, path, &[], Some(json!({"force": true})));
        assert_eq!(status, 426, "{path}");
        assert_eq!(body["error"], TEXT);
        assert_eq!(body["code"], "clientOutdated");
    }
    assert_eq!(fx.lifecycle.status().state, crate::lifecycle::StateName::Booting, "a forced upgrade stops nothing");
}

#[test]
fn management_needs_the_token_and_refuses_browser_origins() {
    let fx = fixture();
    let (server, token) = start(&fx);
    let port = server.port();
    assert_eq!(call(port, "GET", "/mgmt/status", &[], None).0, 401);
    assert_eq!(call(port, "GET", "/mgmt/status", &[("Authorization", "Bearer nope")], None).0, 401);
    let auth = format!("Bearer {token}");
    assert_eq!(call(port, "GET", "/mgmt/status", &[("Authorization", &auth), ("Origin", "http://x")], None).0, 403);
    assert_eq!(mgmt(port, &token, "GET", "/mgmt/status", None).0, 200);
    assert_eq!(mgmt(port, &token, "GET", "/mgmt/nothing", None).0, 404);
}

#[test]
fn stop_and_abort_run_the_one_procedure_over_the_wire() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _work = fx.lifecycle.begin_activity(turn());
    let (server, token) = start(&fx);
    let port = server.port();

    let (status, reply) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "whenIdle", "reason": "fastDeploy"})));
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["state"], "draining");
    assert_eq!(reply["drain"]["reason"], "fastDeploy");
    assert_eq!(reply["running"][0]["title"], "work");

    // A disconnected client reaches the drain through status alone (LR §5.2).
    let (_, status_reply) = mgmt(port, &token, "GET", "/mgmt/status", None);
    let confirm = status_reply["drain"]["confirmToken"].as_str().unwrap().to_owned();

    let (status, reply) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "abortConfirmed", "reason": "fastDeploy"})));
    assert_eq!((status, reply["code"].as_str()), (409, Some("confirmationInvalid")));
    assert!(fx.recorder.cancelled().is_empty());

    let (status, _) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "abortConfirmed", "reason": "fastDeploy", "confirmToken": confirm})));
    assert_eq!(status, 200);
    assert_eq!(fx.recorder.cancelled().len(), 1);

    let (status, reply) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "whenIdle", "reason": "noClients"})));
    assert_eq!((status, reply["code"].as_str()), (400, Some("badRequest")), "noClients is internal");
    let (status, _) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "whenIdle", "reason": "quit", "extra": 1})));
    assert_eq!(status, 400);
}

#[test]
fn cancel_drain_and_hold_over_the_wire() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _work = fx.lifecycle.begin_activity(turn());
    let (server, token) = start(&fx);
    let port = server.port();
    let (_, reply) = mgmt(port, &token, "POST", "/mgmt/hold", Some(json!({"on": true})));
    assert_eq!(reply["hold"], true);
    let (_, reply) = mgmt(port, &token, "POST", "/mgmt/stop", Some(json!({"mode": "whenIdle", "reason": "update"})));
    assert_eq!(reply["hold"], false);
    let drain_id = reply["drain"]["drainId"].as_str().unwrap().to_owned();
    let (status, reply) = mgmt(port, &token, "POST", "/mgmt/cancelDrain", Some(json!({"drainId": drain_id})));
    assert_eq!((status, reply["state"].as_str()), (200, Some("serving")));
    let (status, reply) = mgmt(port, &token, "POST", "/mgmt/cancelDrain", Some(json!({"drainId": drain_id})));
    assert_eq!((status, reply["code"].as_str()), (409, Some("notDraining")));
}

#[test]
fn an_undecidable_prior_owner_is_released_by_the_user_alone() {
    let fx = fixture();
    fx.lifecycle
        .set_blocked(crate::lifecycle::Blocked::Undecidable {
            pid: 31,
            image: "node".into(),
            command_line: "node daemon.mjs".into(),
            start_time: "t0".into(),
        })
        .unwrap();
    let (server, token) = start(&fx);
    let port = server.port();
    let (_, status) = mgmt(port, &token, "GET", "/mgmt/status", None);
    assert_eq!(status["state"], "blocked");
    assert_eq!(status["blocked"]["kind"], "undecidable");
    assert_eq!(status["blocked"]["commandLine"], "node daemon.mjs");
    let confirm = status["blocked"]["confirmToken"].as_str().unwrap();
    assert_eq!(mgmt(port, &token, "POST", "/mgmt/release", Some(json!({"pid": 31, "confirmToken": "x"}))).0, 409);
    assert_eq!(mgmt(port, &token, "POST", "/mgmt/release", Some(json!({"pid": 31, "confirmToken": confirm}))).0, 200);
    assert!(fx.recorder.events().contains(&"release_decision:31".to_owned()));
}

/// LR §11.9: a core whose every async worker is blocked still answers `status`, reports the
/// stall without acting on it, and honours `terminate`.
#[test]
fn a_tokio_stalled_core_answers_status_and_honours_terminate() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let (server, token) = start(&fx);
    let port = server.port();

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
    let _monitor = StallMonitor::spawn(
        StallConfig { interval: Duration::from_millis(40), report_after: Duration::from_millis(120) },
        tokio_post(runtime.handle().clone()),
        Arc::clone(&fx.lifecycle),
        StallReporter::new(fx.recorder.clone(), fx.runtime_root.path().join("stall.jsonl")),
    );

    // Block both workers (the test hook).
    let (release, blocked) = mpsc::channel::<()>();
    let blocked = Arc::new(std::sync::Mutex::new(blocked));
    let (entered_tx, entered_rx) = mpsc::channel();
    for _ in 0..2 {
        let blocked = Arc::clone(&blocked);
        let entered = entered_tx.clone();
        runtime.spawn(async move {
            entered.send(()).unwrap();
            // Only one holds the receiver; the other spins until it is released.
            loop {
                if let Ok(guard) = blocked.try_lock() {
                    let _ = guard.recv();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let deadline = Instant::now() + Duration::from_secs(15);
    let stalled = loop {
        let (status, reply) = mgmt(port, &token, "GET", "/mgmt/status", None);
        assert_eq!(status, 200, "status answers while the runtime is stalled");
        let ms = reply["stalledMs"].as_u64().unwrap();
        if ms > 0 || Instant::now() > deadline {
            break ms;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    assert!(stalled > 0, "the monitor reports the stall");
    assert!(!fx.recorder.has_exited(), "the monitor only reports; it never acts");
    assert!(fx.recorder.events().contains(&"health:true".to_owned()));

    let terminate = fx.lifecycle.status().terminate_token.clone();
    assert_eq!(mgmt(port, &token, "POST", "/mgmt/terminate", Some(json!({"confirmToken": "bad"}))).0, 409);
    assert!(!fx.recorder.has_exited());
    let (status, _) = mgmt(port, &token, "POST", "/mgmt/terminate", Some(json!({"confirmToken": terminate})));
    assert_eq!(status, 200);
    assert!(fx.recorder.has_exited());
    let exit: Value = serde_json::from_slice(&std::fs::read(fx.runtime_root.path().join("last-exit.json")).unwrap()).unwrap();
    assert_eq!(exit["reason"], "userTerminated");
    assert!(exit["stalledMs"].as_u64().unwrap() > 0);

    drop(release);
    runtime.shutdown_timeout(Duration::from_secs(5));
}

#[test]
fn oversized_and_malformed_requests_are_answered_not_hung() {
    let fx = fixture();
    let (server, token) = start(&fx);
    let port = server.port();
    // The head alone announces the oversize; the body is never sent or read.
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!("POST /mgmt/hold HTTP/1.1\r\nAuthorization: Bearer {token}\r\nContent-Length: 70000\r\n\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    assert!(raw.starts_with("HTTP/1.1 413"), "{raw}");
    assert_eq!(mgmt(port, &token, "POST", "/mgmt/hold", Some(json!("nope"))).0, 400);
}
