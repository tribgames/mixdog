//! The wait for an answer and the two posts against `fixtures/room-post/golden.json`, recorded from
//! the real desktop `agent-room-turn.ts` driven with a scripted host: every call the host took, in
//! order, and the state left behind.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{HaltFuture, HaltOutcome, Polled, Speech, poll_for_answer, post_failures, post_speech};
use crate::rooms::calls::Run;
use crate::rooms::turn_host::{Failure, MemberLabel, RoomRecord, RoomTurnHost, TurnState};

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-post/golden.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

type Calls = Arc<Mutex<Vec<Value>>>;

/// The scripted host: `now` counts up from 1000 and ids are `n1`, `n2`, ... as the recorder's.
struct Host {
    calls: Calls,
    script: Value,
    clock: AtomicU64,
    seq: AtomicU64,
    reads: AtomicU64,
    on_read: Box<dyn Fn(u64) + Send + Sync>,
}

impl Host {
    fn new(script: &Value, calls: &Calls, on_read: Box<dyn Fn(u64) + Send + Sync>) -> Self {
        Self { calls: calls.clone(), script: script.clone(), clock: AtomicU64::new(1000), seq: AtomicU64::new(0), reads: AtomicU64::new(0), on_read }
    }
}

#[async_trait]
impl RoomTurnHost for Host {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        25
    }
    fn now(&self) -> i64 {
        i64::try_from(self.clock.fetch_add(1, Ordering::SeqCst) + 1).unwrap()
    }
    fn new_id(&self) -> String {
        format!("n{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn republish(&self) {
        self.calls.lock().unwrap().push(json!(["republish"]));
    }
    fn log(&self, line: &str) {
        self.calls.lock().unwrap().push(json!(["log", line]));
    }
    async fn sleep(&self, ms: u64) {
        self.calls.lock().unwrap().push(json!(["sleep", ms]));
    }
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.calls.lock().unwrap().push(json!(["post", rows]));
        match self.script.get("postFails").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }
    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(json!(["readSnapshot", session_id]));
        let list = self.script.get("snapshots").and_then(Value::as_array).cloned().unwrap_or_default();
        let read = usize::try_from(self.reads.fetch_add(1, Ordering::SeqCst)).unwrap();
        let next = list.get(read.min(list.len().saturating_sub(1))).cloned().unwrap_or(Value::Null);
        (self.on_read)(u64::try_from(read).unwrap() + 1);
        match next.get("throw").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(next),
        }
    }
}

fn failures_of(held: &Value) -> Vec<Failure> {
    held.as_array()
        .unwrap()
        .iter()
        .map(|each| Failure { id: each[0].as_str().unwrap().into(), name: each[1].as_str().unwrap().into(), reason: each[2].as_str().unwrap().into() })
        .collect()
}

fn outcome_of(text: &str) -> HaltOutcome {
    match text {
        "stopped" => HaltOutcome::Stopped,
        "unavailable" => HaltOutcome::Unavailable,
        "superseded" => HaltOutcome::Superseded,
        other => panic!("unknown halt {other}"),
    }
}

fn halt_text(outcome: HaltOutcome) -> &'static str {
    match outcome {
        HaltOutcome::Stopped => "stopped",
        HaltOutcome::Unavailable => "unavailable",
        HaltOutcome::Superseded => "superseded",
    }
}

#[tokio::test]
async fn waiting_for_an_answer_reads_the_session_as_the_node_wait_did() {
    for case in golden()["polls"].as_array().unwrap() {
        let calls = Calls::default();
        let state = Arc::new(TurnState::new(Arc::new(Run::default())));
        if let Some(approval) = case["state"].get("approval") {
            state.set_approval(Some(approval.clone()));
        }
        let stop_at = case["stopAtRead"].as_u64().unwrap();
        let watched = state.clone();
        let host = Host::new(&case["script"], &calls, Box::new(move |read| if stop_at != 0 && read == stop_at { watched.run.set_stopped() }));
        let checks = AtomicU64::new(0);
        let halts = case["halts"].clone();
        let log = calls.clone();
        let halted = move || {
            let n = checks.fetch_add(1, Ordering::SeqCst) + 1;
            let outcome = halts.get(n.to_string()).and_then(Value::as_str).map(outcome_of);
            log.lock().unwrap().push(json!(["halted", n, outcome.map(halt_text)]));
            outcome.map(|outcome| Box::pin(async move { outcome }) as HaltFuture)
        };
        let got = match poll_for_answer(&host, &state, "sess1", 1500.0, &halted).await {
            Ok(Polled::Answered { answer, snapshot }) => json!({ "answer": answer.to_value(), "snapshot": snapshot }),
            Ok(Polled::Halted(outcome)) => json!(halt_text(outcome)),
            Err(error) => json!({ "threw": error }),
        };
        assert_eq!(got, case["result"], "{}", case["name"]);
        assert_eq!(Value::Array(calls.lock().unwrap().clone()), case["calls"], "{} calls", case["name"]);
        assert_eq!(state.approval().unwrap_or(Value::Null), case["approval"], "{} approval", case["name"]);
    }
}

#[tokio::test]
async fn the_failures_held_post_as_one_failed_pass_row() {
    for case in golden()["failures"].as_array().unwrap() {
        let calls = Calls::default();
        let host = Host::new(&case["script"], &calls, Box::new(|_| {}));
        let state = TurnState::new(Arc::new(Run::default()));
        for failure in failures_of(&case["held"]) {
            state.push_failure(failure);
        }
        let threw = post_failures(&host, &state).await.err();
        assert_eq!(json!(threw), case["threw"], "{}", case["name"]);
        assert_eq!(Value::Array(calls.lock().unwrap().clone()), case["calls"], "{} calls", case["name"]);
        assert!(state.failures().is_empty(), "{}", case["name"]);
    }
}

#[tokio::test]
async fn a_speech_row_carries_its_files_mention_and_tools_after_the_failures_held() {
    let members = [("bench", "Bench"), ("alpha", "Alpha"), ("gh", "Git Hub")];
    for case in golden()["speech"].as_array().unwrap() {
        let calls = Calls::default();
        let host = Host::new(&case["script"], &calls, Box::new(|_| {}));
        let state = TurnState::new(Arc::new(Run::default()));
        state.set_member_session(case["memberSession"].as_str().unwrap());
        state.set_waiting(case["waiting"].as_bool().unwrap());
        for failure in failures_of(&case["held"]) {
            state.push_failure(failure);
        }
        let room = Mutex::new(RoomRecord { name: "Release room".into(), members: members.iter().map(|(id, _)| (*id).to_owned()).collect(), ..RoomRecord::default() });
        let labels: HashMap<String, MemberLabel> = if case["labelled"].as_bool().unwrap() {
            members.iter().map(|(id, name)| ((*id).to_owned(), MemberLabel { id: (*id).into(), name: (*name).into(), route: Value::Null, description: String::new(), disabled: false })).collect()
        } else {
            HashMap::new()
        };
        let agent_id = case["agentId"].as_str().unwrap();
        let member = labels.get(agent_id).cloned().unwrap_or(MemberLabel { id: agent_id.into(), name: agent_id.into(), route: Value::Null, description: String::new(), disabled: false });
        let speech = Speech { agent_id, member: &member, text: case["text"].as_str().unwrap(), snapshot: &case["snapshot"], started_at: case["startedAt"].as_f64().unwrap() };
        let got = match post_speech(&host, &state, &room, &labels, &speech).await {
            Ok(Some(mention)) => json!({ "result": "speech", "mention": mention }),
            Ok(None) => json!({ "result": "speech", "mention": "" }),
            Err(error) => json!({ "threw": error }),
        };
        let name = &case["name"];
        assert_eq!(got, case["result"], "{name}");
        assert_eq!(Value::Array(calls.lock().unwrap().clone()), case["calls"], "{name} calls");
        assert_eq!(json!(state.waiting()), case["waitingAfter"], "{name} waiting");
        assert_eq!(json!(state.failures().len()), json!(case["failuresLeft"].as_array().unwrap().len()), "{name} failures left");
        let room = room.lock().unwrap();
        assert_eq!(json!(room.last_speaker), case["lastSpeaker"], "{name} lastSpeaker");
        assert_eq!(json!(room.last_at), case["lastAt"], "{name} lastAt");
    }
}
