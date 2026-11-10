//! The remote intent against Node b6f10295a (`native/core/fixtures/channel-remote-intent/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-channel-remote-intent.mjs`): every file content `readRemoteIntent` was given,
//! and each transport scenario (boot restore, manual ON/OFF) through `CallDispatch` with the same handler answers.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::call::{CallDispatch, CallRequest, ChannelCallHandler, ChannelClient};
use super::intent::{IntentFile, IntentRead, intent_of_read};
use super::running::RunningWork;
use super::tools::ACTIVATE_TOOL;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/channel-remote-intent/golden.json")).unwrap()
}

fn file_state(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Err(_) => json!({"kind": "absent"}),
        Ok(meta) if meta.is_dir() => json!({"kind": "directory"}),
        Ok(_) => json!({"kind": "file", "text": std::fs::read_to_string(path).unwrap()}),
    }
}

fn set_up(path: &Path, state: &Value) {
    match state["kind"].as_str().unwrap() {
        "absent" => {}
        "directory" => std::fs::create_dir(path).unwrap(),
        _ => std::fs::write(path, state["text"].as_str().unwrap()).unwrap(),
    }
}

/// A log line that ends in the runtime's OS error text is compared up to it (manifest exclusions).
fn without_os_error(line: &str) -> &str {
    const UNREADABLE: &str = "channel remote intent unreadable, starting unpinned: ";
    if line.starts_with(UNREADABLE) { UNREADABLE } else { line }
}

struct Logs(Arc<Mutex<Vec<String>>>);

fn intent_file(root: &Path, frozen: f64) -> (IntentFile, Logs) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let file = IntentFile::with_clock(
        root,
        mixdog_rt::testing::tokens().maintenance_io,
        Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_string())),
        Arc::new(move || frozen),
    );
    (file, Logs(lines))
}

#[tokio::test]
async fn every_recorded_intent_file_reads_as_node_read_it() {
    let gold = golden();
    let frozen = gold["frozenNow"].as_f64().unwrap();
    for case in gold["reads"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::intent::INTENT_FILE);
        set_up(&path, &case["before"]);
        let intent = if let Some(code) = case["threw"].as_str().filter(|_| case["before"]["kind"] == "file") {
            // An injected read failure: what the core makes of that error, with the file left in place.
            let IntentRead::Unreadable(_) = intent_of_read(Err(io::Error::other(code)), frozen) else { panic!("{name}: an I/O error is not unreadable") };
            None
        } else {
            let (file, logs) = intent_file(dir.path(), frozen);
            let intent = file.load().await;
            let logged = logs.0.lock().unwrap().clone();
            assert_eq!(!logged.is_empty(), case.get("threw").is_some(), "{name}: logs {logged:?}");
            intent
        };
        assert_eq!(intent.map_or(Value::Null, |i| i.to_json()), case.get("intent").cloned().unwrap_or(Value::Null), "{name}");
        assert_eq!(file_state(&path), case["after"], "{name}");
    }
}

/// Node's `handleCall` of each scenario: records the call and answers as the recorder's did.
struct Recorded {
    calls: Mutex<Vec<Value>>,
    answer: fn() -> Result<Value, String>,
}

#[async_trait]
impl ChannelCallHandler for Recorded {
    async fn call(&self, name: &str, args: &Value, _client: &ChannelClient) -> Result<Value, String> {
        self.calls.lock().unwrap().push(json!({"name": name, "args": args}));
        (self.answer)()
    }
}

fn activated() -> Result<Value, String> {
    Ok(json!({"content": [{"type": "text", "text": "channel bridge activated"}]}))
}

#[tokio::test]
async fn every_recorded_transport_scenario_pins_and_restores_as_node_did() {
    let gold = golden();
    let frozen = gold["frozenNow"].as_f64().unwrap();
    for case in gold["transport"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let answer: fn() -> Result<Value, String> = match name {
            "boot restore answered with a soft error" => || Ok(json!({"isError": true, "content": [{"type": "text", "text": "bridge unavailable"}]})),
            "boot restore whose call fails" => || Err("boom".into()),
            "manual ON answered with a soft error" => || Ok(json!({"isError": true, "content": [{"type": "text", "text": "no"}]})),
            _ => activated,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::intent::INTENT_FILE);
        set_up(&path, &case["checkpoints"][0]["file"]);
        let handler = Arc::new(Recorded { calls: Mutex::new(Vec::new()), answer });
        let calls = CallDispatch::new(handler.clone(), RunningWork::new());
        let (file, logs) = intent_file(dir.path(), frozen);
        calls.load_intent(file).await;
        let mut checkpoints = Vec::new();
        let checkpoint = |at: &str, checkpoints: &mut Vec<Value>| {
            checkpoints.push(json!({"at": at, "pinnedSession": calls.pinned_session(), "remoteSession": calls.remote_session(), "file": file_state(&path)}));
        };
        checkpoint("boot", &mut checkpoints);
        let client = ChannelClient { token: "connection:1".into(), lead_pid: None };
        let manual = |active: bool, session: &str, transcript: Option<&str>| {
            let mut args = json!({"active": active, "sessionId": session});
            if let Some(t) = transcript {
                args["transcriptPath"] = json!(t);
            }
            calls.dispatch(client.clone(), CallRequest { name: ACTIVATE_TOOL.into(), args, call_id: None })
        };
        let mut restored = Vec::new();
        match name {
            "manual ON then OFF" => {
                manual(true, "sess_on", Some("/work/sess_on.jsonl")).await.unwrap();
                checkpoint("on", &mut checkpoints);
                manual(false, "sess_on", None).await.unwrap();
                checkpoint("off", &mut checkpoints);
            }
            "manual ON over a restored session" => {
                restored.push(calls.restore_intent().await);
                checkpoint("restored", &mut checkpoints);
                manual(true, "sess_on", Some("/work/sess_on.jsonl")).await.unwrap();
                checkpoint("on", &mut checkpoints);
            }
            "manual ON whose transcript names another session" => {
                manual(true, "sess_on", Some("/work/other.jsonl")).await.unwrap();
                checkpoint("on", &mut checkpoints);
            }
            "manual ON without a transcript" => {
                manual(true, "sess_on", None).await.unwrap();
                checkpoint("on", &mut checkpoints);
            }
            "manual ON answered with a soft error" => {
                manual(true, "sess_on", Some("/work/sess_on.jsonl")).await.unwrap();
                checkpoint("on", &mut checkpoints);
            }
            "restore after a manual ON" => {
                manual(true, "sess_on", Some("/work/sess_on.jsonl")).await.unwrap();
                checkpoint("on", &mut checkpoints);
                restored.push(calls.restore_intent().await);
                checkpoint("restored", &mut checkpoints);
            }
            "a second restore after the first" => {
                for _ in 0..2 {
                    restored.push(calls.restore_intent().await);
                    checkpoint("restored", &mut checkpoints);
                }
            }
            _ => {
                restored.push(calls.restore_intent().await);
                checkpoint("restored", &mut checkpoints);
            }
        }
        let expected_restored = match &case["restored"] {
            Value::Array(all) => all.clone(),
            Value::Null => Vec::new(),
            one => vec![one.clone()],
        };
        assert_eq!(restored.into_iter().map(Value::Bool).collect::<Vec<_>>(), expected_restored, "{name}: restored");
        assert_eq!(Value::Array(handler.calls.lock().unwrap().clone()), case["calls"], "{name}: calls");
        let logged: Vec<String> = logs.0.lock().unwrap().iter().map(|l| without_os_error(l).to_string()).collect();
        let recorded: Vec<String> = case["logs"].as_array().unwrap().iter().map(|l| without_os_error(l.as_str().unwrap()).to_string()).collect();
        assert_eq!(logged, recorded, "{name}: logs");
        assert_eq!(Value::Array(checkpoints), case["checkpoints"], "{name}: checkpoints");
    }
}
