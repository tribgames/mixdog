//! One exchange of a group room: the called members speak first, the supervisor then finishes the talk, and the room is tracked,
//! saved and released around it; a save that fails abandons the exchange and ends every call failed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{RoomExchangeHost, SupervisorStep, run_exchange};
use crate::rooms::calls::{Request, RoomCall, Run, Settled};
use crate::rooms::exchange::{Action, Decision};
use crate::rooms::member_turn::{MemberHost, PersistFuture, SubmitOptions};
use crate::rooms::turn_host::{MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use crate::rooms::turn_prompt::RoomPrompt;

struct Host {
    room: Arc<Mutex<RoomRecord>>,
    rows: Vec<Value>,
    snapshot: Value,
    clock: AtomicU64,
    seq: AtomicU64,
    persists: AtomicUsize,
    /// The save with this number (from 1) fails.
    failing_persist: Option<usize>,
    posted: Mutex<Vec<Value>>,
    logs: Mutex<Vec<String>>,
    running: Mutex<Vec<Option<i64>>>,
    relays_failed: Mutex<Vec<String>>,
    decisions: Mutex<Vec<Result<Option<Decision>, String>>>,
    steps: Mutex<Vec<(Vec<String>, usize)>>,
    tracked: AtomicUsize,
}

impl Host {
    fn new(decisions: Vec<Result<Option<Decision>, String>>) -> Self {
        let room = RoomRecord { name: "Design".into(), members: vec!["ann".into(), "bob".into()], ..RoomRecord::default() };
        Self {
            room: Arc::new(Mutex::new(room)),
            rows: vec![json!({ "kind": "user", "id": "u1", "text": "hello team", "at": 1 })],
            snapshot: json!({ "items": [
                { "kind": "user", "id": "x1", "at": 1 },
                { "kind": "assistant", "id": "a1", "text": "hello" },
                { "kind": "turndone", "id": "d1", "at": 5000, "status": "done", "finalAssistantId": "a1" },
            ] }),
            clock: AtomicU64::new(1000),
            seq: AtomicU64::new(0),
            persists: AtomicUsize::new(0),
            failing_persist: None,
            posted: Mutex::default(),
            logs: Mutex::default(),
            running: Mutex::default(),
            relays_failed: Mutex::default(),
            decisions: Mutex::new(decisions),
            steps: Mutex::default(),
            tracked: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl RoomTurnHost for Host {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        1
    }
    fn now(&self) -> i64 {
        i64::try_from(self.clock.fetch_add(1, Ordering::SeqCst) + 1).unwrap()
    }
    fn new_id(&self) -> String {
        format!("n{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn republish(&self) {}
    fn log(&self, line: &str) {
        self.logs.lock().unwrap().push(line.to_owned());
    }
    async fn sleep(&self, _: u64) {}
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.posted.lock().unwrap().extend(rows);
        Ok(())
    }
    async fn read_snapshot(&self, _: &str) -> Result<Value, String> {
        Ok(self.snapshot.clone())
    }
}

#[async_trait]
impl MemberHost for Host {
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String> {
        Ok(self.room.clone())
    }
    async fn rows(&self) -> Result<Vec<Value>, String> {
        Ok(self.rows.clone())
    }
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String> {
        Ok(format!("sess-{}", member.id))
    }
    async fn switched_off(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn submit(&self, _: &str, _: &RoomPrompt, _: &SubmitOptions) -> Result<bool, String> {
        Ok(true)
    }
    async fn abort(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn persist(&self) -> PersistFuture {
        let n = self.persists.fetch_add(1, Ordering::SeqCst) + 1;
        let failing = self.failing_persist == Some(n);
        Box::pin(async move { if failing { Err("disk full".to_owned()) } else { Ok(()) } })
    }
}

#[async_trait]
impl RoomExchangeHost for Host {
    fn exists(&self) -> bool {
        true
    }
    fn track(&self, _: &Arc<TurnState>) {
        self.tracked.fetch_add(1, Ordering::SeqCst);
    }
    fn untrack(&self, _: &Arc<TurnState>) -> bool {
        true
    }
    fn fail_relays(&self, error: &str) {
        self.relays_failed.lock().unwrap().push(error.to_owned());
    }
    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String> {
        Ok(["ann", "bob"]
            .iter()
            .map(|id| {
                (
                    (*id).to_owned(),
                    MemberLabel { id: (*id).into(), name: id.to_uppercase(), route: Value::Null, description: format!("{id} desc"), disabled: false },
                )
            })
            .collect())
    }
    async fn decide_turn(&self, step: &SupervisorStep) -> Result<Option<Decision>, String> {
        self.steps.lock().unwrap().push((step.members.iter().map(|member| member.name.clone()).collect(), step.rows.len()));
        let mut decisions = self.decisions.lock().unwrap();
        if decisions.is_empty() { Ok(Some(Decision { action: Action::Finish, scene: None })) } else { decisions.remove(0) }
    }
    fn republish_catalog(&self) {}
    fn random(&self) -> f64 {
        0.5
    }
    fn max_rounds(&self) -> u32 {
        4
    }
    fn max_messages(&self) -> u32 {
        8
    }
    fn set_running(&self, started_at: Option<i64>) {
        self.running.lock().unwrap().push(started_at);
    }
    fn set_owed(&self, _: Option<Vec<String>>) {}
    async fn cut_off(&self) {}
}

fn request_to_ann() -> (Request, Arc<Run>, tokio::sync::oneshot::Receiver<String>, RoomCall) {
    let (call, status) = RoomCall::new("ann", "call-1", 0, "bob", "", None);
    let run = Arc::new(Run::default());
    run.calls_lock().push(call.clone());
    (Request { to: vec!["ann".into()], waiting: true, calls: vec![call.clone()], ..Request::default() }, run, status, call)
}

#[tokio::test]
async fn the_called_member_speaks_the_supervisor_finishes_and_the_call_ends_done_with_the_posted_words() {
    let host = Arc::new(Host::new(Vec::new()));
    let dynamic: Arc<dyn RoomExchangeHost> = host.clone();
    let (request, run, status, call) = request_to_ann();
    run_exchange(&dynamic, &request, &run).await.unwrap();

    let posted = host.posted.lock().unwrap().clone();
    assert_eq!(
        posted.iter().map(|row| (row["kind"].clone(), row["speaker"].clone(), row["text"].clone())).collect::<Vec<_>>(),
        [(json!("speech"), json!("ann"), json!("hello"))]
    );
    assert_eq!(status.await.unwrap(), "done");
    assert_eq!(call.detail(), Some(Settled { status: "done".into(), error: None, content: Some("hello".into()) }));
    let running = host.running.lock().unwrap().clone();
    assert!(running.len() == 2 && running[0].is_some() && running[1].is_none(), "the room is marked running, then released: {running:?}");
    assert_eq!(host.tracked.load(Ordering::SeqCst), 1);
    assert!(host.persists.load(Ordering::SeqCst) >= 2, "saved at the start and at the end");
    assert!(run.calls().is_empty(), "no call is left waiting");
}

#[tokio::test]
async fn the_supervisor_is_shown_the_room_members_by_name_and_the_rows() {
    let host = Arc::new(Host::new(Vec::new()));
    let dynamic: Arc<dyn RoomExchangeHost> = host.clone();
    let (request, run, _status, _call) = request_to_ann();
    run_exchange(&dynamic, &request, &run).await.unwrap();
    let steps = host.steps.lock().unwrap().clone();
    assert_eq!(steps.len(), 1, "one supervisor step ended the talk");
    assert_eq!(steps[0].0, ["ANN", "BOB"]);
    assert!(steps[0].1 >= 1);
}

#[tokio::test]
async fn a_supervisor_with_no_usable_decision_is_logged_and_the_exchange_still_ends() {
    let host = Arc::new(Host::new(vec![Ok(None), Err("model down".into())]));
    let dynamic: Arc<dyn RoomExchangeHost> = host.clone();
    let (request, run, _status, _call) = request_to_ann();
    run_exchange(&dynamic, &request, &run).await.unwrap();
    let logs = host.logs.lock().unwrap().clone();
    assert!(logs.iter().any(|line| line == "room room01 supervisor gave no usable decision; falling back"), "{logs:?}");
}

#[tokio::test]
async fn a_save_that_fails_at_the_start_abandons_the_exchange_and_ends_every_call_failed() {
    let mut failing = Host::new(Vec::new());
    failing.failing_persist = Some(1);
    let host = Arc::new(failing);
    let dynamic: Arc<dyn RoomExchangeHost> = host.clone();
    let (request, run, status, call) = request_to_ann();
    assert_eq!(run_exchange(&dynamic, &request, &run).await.unwrap_err(), "disk full");
    assert_eq!(status.await.unwrap(), "failed");
    assert_eq!(call.detail(), Some(Settled { status: "failed".into(), error: Some("disk full".into()), content: None }));
    assert_eq!(*host.relays_failed.lock().unwrap(), ["disk full"], "the relays held back for the room end failed too");
    assert!(host.logs.lock().unwrap().iter().any(|line| line == "room room01 exchange stopped: disk full"));
    let running = host.running.lock().unwrap().clone();
    assert_eq!(running.last(), Some(&None), "the room is released");
    assert!(host.posted.lock().unwrap().is_empty(), "no member spoke");
}

#[tokio::test]
async fn a_request_sent_meanwhile_is_left_for_the_scheduler_and_the_calls_nobody_answered_ride_on_to_it() {
    let host = Arc::new(Host::new(Vec::new()));
    let dynamic: Arc<dyn RoomExchangeHost> = host.clone();
    let (request, run, _status, _call) = request_to_ann();
    let (bob_call, _bob_status) = RoomCall::new("bob", "call-2", 0, "ann", "", None);
    run.calls_lock().push(bob_call);
    *run.pending() = Some(Request { to: vec!["ann".into()], waiting: true, ..Request::default() });
    run_exchange(&dynamic, &request, &run).await.unwrap();
    let pending = run.pending().clone().expect("the newer request is left to run next");
    assert!(pending.to.contains(&"bob".to_owned()), "bob, whose call nobody answered, is handed its turn by the next exchange");
    let mut carried: Vec<&str> = pending.calls.iter().map(|call| call.agent_id.as_str()).collect();
    carried.sort();
    assert_eq!(carried, ["ann", "bob"], "ann's turn was cut short by the newer request, so its call rides on with bob's");
}
