//! The MXT transport's signalling and media-adapter messages against Node's recorded outcomes
//! (`fixtures/remote-transport-signals/signals.json`, recorded from
//! `apps/desktop/src/shared/remote-transport.ts` at b6f10295a): every valid message, and every field
//! of every message replaced by junk or removed, is accepted or refused with the value and the words
//! Node gave.

use mixdog_remote::transport::signal::Role;
use mixdog_remote::transport::signal::parse_signal;
use mixdog_remote::transport::signal::read_media;
use serde_json::Value;
use serde_json::json;

const RECORDED: &str = include_str!("../../../../fixtures/remote-transport-signals/signals.json");

fn recorded() -> Value {
    serde_json::from_str(RECORDED).expect("the recording is JSON")
}

fn role(case: &Value) -> Role {
    match case["from"].as_str() {
        Some("desktop") => Role::Desktop,
        _ => Role::Client,
    }
}

fn settle(case: &Value, got: Result<Value, String>, what: &str) {
    if case["ok"] == json!(true) {
        assert_eq!(got.as_ref(), Ok(&case["value"]), "{what}: {}", case["input"]);
    } else {
        assert_eq!(got, Err(case["error"].as_str().unwrap().to_owned()), "{what}: {}", case["input"]);
    }
}

#[test]
fn signals_are_accepted_or_refused_as_node_did() {
    let recorded = recorded();
    let cases = recorded["signals"].as_array().unwrap();
    assert!(cases.len() > 1000);
    for case in cases {
        settle(case, parse_signal(&case["input"], role(case)).map(|s| s.to_json()), "signal");
    }
}

#[test]
fn media_messages_are_read_as_node_read_them() {
    let recorded = recorded();
    let cases = recorded["media"].as_array().unwrap();
    assert!(cases.len() > 1000);
    for case in cases {
        settle(case, read_media(&case["input"], role(case)).map(|m| m.map_or(Value::Null, |m| m.to_json())), "media message");
    }
}
