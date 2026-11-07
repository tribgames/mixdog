//! The host against `fixtures/delegated-host/golden.json`, recorded from the real
//! `delegated-approval-host.mjs`: each scripted step's return value and the offers and
//! withdrawals the fake queues saw, in order.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use mixdog_services::bots::delivery::queue::Handoffs;

use super::{Answer, ApprovalQueue, Delegated, DelegatedApprovalHost, HostHandoffs, QueueHandle, SessionOpener};

struct FakeQueue {
    name: String,
    session: String,
    disposed: AtomicBool,
    events: Arc<Mutex<Vec<Value>>>,
    labels: Arc<Mutex<Vec<(String, Answer)>>>,
}

fn label_of(labels: &Mutex<Vec<(String, Answer)>>, answer: &Answer) -> Value {
    let labels = labels.lock().unwrap();
    labels.iter().find(|(_, held)| Arc::ptr_eq(held, answer)).map_or(Value::Null, |(label, _)| json!(label))
}

fn shape(labels: &Mutex<Vec<(String, Answer)>>, delegated: &Delegated) -> Value {
    json!({ "id": delegated.id, "sessionId": delegated.session_id, "request": delegated.request, "answer": label_of(labels, &delegated.answer) })
}

impl ApprovalQueue for FakeQueue {
    fn session_id(&self) -> String {
        self.session.clone()
    }
    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }
    fn offer(&self, delegated: &Delegated) {
        self.events.lock().unwrap().push(json!({ "queue": self.name, "call": "offer", "delegated": shape(&self.labels, delegated) }));
    }
    fn withdraw(&self, id: &str, result: Option<&Value>) {
        self.events.lock().unwrap().push(json!({ "queue": self.name, "call": "withdraw", "id": id, "result": result.cloned().unwrap_or(Value::Null) }));
    }
}

/// What the opener does when it runs.
#[derive(Clone)]
enum OnOpen {
    Register(String, String),
    Withdraw(String),
}

struct Rig {
    host: Arc<DelegatedApprovalHost>,
    events: Arc<Mutex<Vec<Value>>>,
    labels: Arc<Mutex<Vec<(String, Answer)>>>,
    queues: Mutex<HashMap<String, (Arc<FakeQueue>, QueueHandle)>>,
    reject: AtomicBool,
    on_open: Mutex<Option<OnOpen>>,
}

#[async_trait]
impl SessionOpener for Rig {
    async fn open(&self, session_id: &str) -> Result<(), String> {
        self.events.lock().unwrap().push(json!({ "opener": session_id }));
        let action = self.on_open.lock().unwrap().clone();
        match action {
            Some(OnOpen::Register(name, session)) => self.register(&name, &session),
            Some(OnOpen::Withdraw(id)) => self.host.withdraw_delegated_approval(&id, None),
            None => {}
        }
        if self.reject.load(Ordering::SeqCst) { Err("cannot open".to_owned()) } else { Ok(()) }
    }
}

impl Rig {
    fn register(&self, name: &str, session: &str) {
        let queue = Arc::new(FakeQueue { name: name.into(), session: session.into(), disposed: AtomicBool::new(false), events: self.events.clone(), labels: self.labels.clone() });
        let handle = self.host.register_queue(queue.clone());
        self.queues.lock().unwrap().insert(name.to_owned(), (queue, handle));
    }

    fn answer(&self, label: &str) -> Answer {
        let mut labels = self.labels.lock().unwrap();
        if let Some((_, held)) = labels.iter().find(|(held_label, _)| held_label == label) {
            return held.clone();
        }
        let answer: Answer = Arc::new(|_| true);
        labels.push((label.to_owned(), answer.clone()));
        answer
    }

    fn delegated(&self, spec: &Value) -> Delegated {
        Delegated {
            id: spec["id"].as_str().unwrap().to_owned(),
            session_id: spec["sessionId"].as_str().unwrap().to_owned(),
            request: spec["request"].clone(),
            answer: self.answer(spec["answer"].as_str().unwrap()),
        }
    }
}

async fn settle() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

fn rig() -> Arc<Rig> {
    Arc::new(Rig {
        host: DelegatedApprovalHost::new(),
        events: Arc::default(),
        labels: Arc::default(),
        queues: Mutex::default(),
        reject: AtomicBool::new(false),
        on_open: Mutex::default(),
    })
}

fn step(rig: &Arc<Rig>, call: &[Value]) -> Value {
    let text = |at: usize| call[at].as_str().unwrap();
    match text(0) {
        "register" => rig.register(text(1), text(2)),
        "unregister" => {
            let queues = rig.queues.lock().unwrap();
            return json!(rig.host.unregister_queue(&queues[text(1)].1));
        }
        "dispose" => rig.queues.lock().unwrap()[text(1)].0.disposed.store(true, Ordering::SeqCst),
        "opener" => {
            rig.reject.store(text(1) == "reject", Ordering::SeqCst);
            rig.host.register_opener(rig.clone());
        }
        "registerOnOpen" => *rig.on_open.lock().unwrap() = Some(OnOpen::Register(text(1).to_owned(), text(2).to_owned())),
        "withdrawOnOpen" => *rig.on_open.lock().unwrap() = Some(OnOpen::Withdraw(text(1).to_owned())),
        "note" => rig.host.note_handoff(&call[1]),
        "end" => rig.host.end_handoff(text(1)),
        "chats" => return json!(rig.host.handoff_chats_of(text(1)).into_iter().map(|(chat, title)| json!([chat, { "title": title }])).collect::<Vec<_>>()),
        "toHandoffs" => {
            let asked = rig.delegated(&call[1]);
            let request = call[1]["request"].clone();
            rig.host.delegate_to_handoffs(
                asked,
                Arc::new(move |chat, title| {
                    let mut copy = request.clone();
                    copy["surfaceSessionId"] = json!(chat);
                    copy["handoff"] = json!({ "title": title });
                    copy
                }),
            );
        }
        "approval" => rig.host.delegate_approval(rig.delegated(&call[1])),
        "withdraw" => rig.host.withdraw_delegated_approval(text(1), call.get(2)),
        "open" => return Value::Array(rig.host.delegated_approvals_for(text(1)).iter().map(|delegated| shape(&rig.labels, delegated)).collect()),
        other => panic!("unknown step {other}"),
    }
    Value::Null
}

#[tokio::test]
async fn every_scripted_step_does_what_the_node_host_did() {
    let golden: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/delegated-host/golden.json"))).unwrap();
    let mut failures = Vec::new();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let rig = rig();
        for (index, recorded) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            rig.events.lock().unwrap().clear();
            let call = recorded["call"].as_array().unwrap();
            let returned = step(&rig, call);
            settle().await;
            let events = Value::Array(std::mem::take(&mut *rig.events.lock().unwrap()));
            if returned != recorded["returned"] || events != recorded["events"] {
                failures.push(format!("{} / step {index} {call:?}:\n got  {returned} {events}\n Node {} {}", scenario["name"], recorded["returned"], recorded["events"]));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The report-watch store keeps the host in step through `Handoffs`: a watch added notes its hand-off,
/// a watch gone ends it for good (the host's scripted steps above are `noteHandoff` / `endHandoff`).
#[tokio::test]
async fn the_report_watch_store_notes_and_ends_hand_offs_through_the_adapter() {
    let host = DelegatedApprovalHost::new();
    let handoffs = HostHandoffs::new(host.clone());
    let watch = json!({ "runId": "run1", "taskSessionId": "task", "homeSessionId": "chat", "title": "Bench" });
    handoffs.note(&watch);
    assert_eq!(host.handoff_chats_of("task"), vec![("chat".to_owned(), "Bench".to_owned())]);
    handoffs.end("run1");
    assert!(host.handoff_chats_of("task").is_empty());
    handoffs.note(&watch);
    assert!(host.handoff_chats_of("task").is_empty(), "an ended run is not noted again");
}
