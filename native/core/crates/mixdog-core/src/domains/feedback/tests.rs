//! `goldens/feedback.json` is what `normalizeDesktopFeedback` of the desktop answered for each
//! input (`tools/gen-feedback-golden.mjs`); the upload tests run against a local relay.

use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Mutex;

use mixdog_core_api::error::CoreError;
use mixdog_protocol::DomainErrorDetail;

use super::*;
use crate::domains::support::testing::request;
use crate::domains::support::testing::scopes;
use crate::domains::support::testing::value;
use crate::domains::support::testing::with_op;

const GOLDEN: &str = include_str!("../goldens/feedback.json");

#[test]
fn normalization_answers_what_the_desktop_answered() {
    let cases: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert!(cases.len() > 20);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        // JSON.stringify turned the hole of the sparse array into null.
        let got = normalize(&case["input"]);
        match case.get("ok") {
            Some(want) => assert_eq!(got.as_ref().ok(), Some(want), "case {name}"),
            None => assert_eq!(got.err(), case["error"].as_str(), "case {name}"),
        }
    }
}

/// A relay on a loopback port: answers each request with the next scripted response.
struct Relay {
    port: u16,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
}

fn relay(responses: Vec<&'static str>) -> Relay {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            let body_at = loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                raw.extend_from_slice(&chunk[..n]);
                if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
                if n == 0 {
                    break raw.len();
                }
            };
            let head = String::from_utf8_lossy(&raw[..body_at]).to_string();
            let wanted: usize = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            while raw.len() < body_at + wanted {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            let first = head.lines().next().unwrap_or_default().to_owned();
            let content_type = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-type:"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            let body = serde_json::from_slice(&raw[body_at..]).unwrap_or(Value::Null);
            seen.lock().unwrap().push((first, content_type, body));
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    Relay { port, requests }
}

const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn accepted() -> &'static str {
    "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 65\r\nConnection: close\r\n\r\n{\"id\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"status\":\"accepted\"}"
}

fn plain(status: &'static str) -> &'static str {
    match status {
        "429" => "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "500" => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "302" => "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "html" => "HTTP/1.1 202 Accepted\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<html>",
        _ => "HTTP/1.1 202 Accepted\r\nContent-Length: 41\r\nConnection: close\r\n\r\n{\"id\":\"someone-else\",\"status\":\"accepted\"}",
    }
}

fn input() -> Value {
    json!({ "id": ID.to_uppercase(), "kind": "bug", "message": " It broke ", "replyTo": "me@example.com" })
}

async fn service(
    dir: &std::path::Path,
    relay_url: Result<Option<String>, String>,
) -> Arc<FeedbackService> {
    FeedbackService::new(Arc::new(move || relay_url.clone()), scopes(dir, "feedback").await)
}

async fn upload(service: &FeedbackService, op: u64, input: Value) -> Result<Value, CoreError> {
    value(service, request("feedback/upload", with_op(json!({ "input": input }), op), Some(op))).await
}

fn message(error: CoreError) -> String {
    match error {
        CoreError::DomainError { detail: Some(detail), .. } => match *detail {
            DomainErrorDetail::CommandFailed { message } => message,
            other => panic!("unexpected detail {other:?}"),
        },
        other => panic!("unexpected error {other:?}"),
    }
}

#[tokio::test]
async fn the_normalized_feedback_is_posted_and_the_receipt_returned() {
    let dir = tempfile::tempdir().unwrap();
    let relay = relay(vec![accepted()]);
    let service = service(dir.path(), Ok(Some(format!("ws://127.0.0.1:{}/ignored?x=1#y", relay.port)))).await;
    let receipt = upload(&service, 1, input()).await.unwrap();
    assert_eq!(receipt, json!({ "id": ID, "status": "accepted" }));
    let seen = relay.requests.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "POST /feedback HTTP/1.1");
    assert!(seen[0].1.contains("application/json"));
    assert_eq!(seen[0].2, json!({ "id": ID, "kind": "bug", "message": "It broke", "replyTo": "me@example.com" }));
}

#[tokio::test]
async fn a_repeated_op_posts_once() {
    let dir = tempfile::tempdir().unwrap();
    let relay = relay(vec![accepted()]);
    let service = service(dir.path(), Ok(Some(format!("ws://127.0.0.1:{}", relay.port)))).await;
    let first = upload(&service, 7, input()).await.unwrap();
    let again = upload(&service, 7, input()).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(relay.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn every_failure_has_the_sentence_the_desktop_gave() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        ("429", "Too many feedback requests. Please try again later."),
        ("500", "Feedback service is unavailable. Please try again later."),
        ("302", "Unable to submit feedback. Please try again."),
        ("html", "Feedback receipt is invalid. Please try again."),
        ("other", "Feedback receipt is invalid. Please try again."),
    ];
    for (n, (status, want)) in cases.into_iter().enumerate() {
        let relay = relay(vec![plain(status)]);
        let service = service(dir.path(), Ok(Some(format!("ws://127.0.0.1:{}", relay.port)))).await;
        let error = upload(&service, 10 + n as u64, input()).await.unwrap_err();
        assert_eq!(message(error), want, "status {status}");
    }
    // Nothing listens.
    let gone = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let service = service(dir.path(), Ok(Some(format!("ws://127.0.0.1:{gone}")))).await;
    assert_eq!(message(upload(&service, 30, input()).await.unwrap_err()), "Unable to submit feedback. Please try again.");
}

#[tokio::test]
async fn invalid_input_and_a_switched_off_relay_are_refused_before_any_request() {
    let dir = tempfile::tempdir().unwrap();
    let off = service(dir.path(), Ok(None)).await;
    assert_eq!(message(upload(&off, 40, input()).await.unwrap_err()), "Feedback service is unavailable.");
    assert_eq!(message(upload(&off, 41, json!("x")).await.unwrap_err()), "Feedback is invalid.");
    let mut bad_reply = input();
    bad_reply["replyTo"] = json!("nobody");
    assert_eq!(message(upload(&off, 42, bad_reply).await.unwrap_err()), "Reply email is invalid.");
    let wrong = service(dir.path(), Err("MIXDOG_RELAY_URL is invalid.".into())).await;
    assert_eq!(message(upload(&wrong, 43, input()).await.unwrap_err()), "MIXDOG_RELAY_URL is invalid.");
}
